// Manual CSV upload — auto-detects: standard template, Bulgarian Betano export,
// and English Betano/Thunderbit exports for football, tennis, basketball, darts, snooker.
import { db, upsertFixture, upsertOdd, setOutcome, markFinal, gradePick, q } from "./db.js";
import { isPickCorrect } from "./settle.js";

function splitRows(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length);
  // auto-detect delimiter: European Excel exports "CSV" with semicolons; also handle tabs
  const probe = lines.slice(0, 5).join("\n");
  const count = (ch) => (probe.match(new RegExp("\\" + ch, "g")) || []).length;
  const DELIM = count(";") > count(",") ? ";" : (count("\t") > count(",") ? "\t" : ",");
  const parse = (line) => {
    const out = []; let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
      else if (c === '"') inQ = true;
      else if (c === DELIM) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur); return out.map((s) => s.trim());
  };
  return lines.map(parse);
}

export function parseCSV(text) {
  const rows = splitRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  return rows.slice(1).map((cells) => { const r = {}; header.forEach((h, j) => (r[h] = cells[j] ?? "")); return r; });
}

const slug = (s) => String(s).trim().replace(/[^\p{L}\p{N}.-]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

// —— IDENTITY SLUG ————————————————————————————————————————
// The fixture id must be stable across the spelling drift between uploads:
// "Gian Van Veen" / "Gian van Veen", "Querétaro FC" / "Queretaro FC".
// Case, accents, punctuation and club suffixes are all stripped for the ID only —
// the display name stays exactly as it was uploaded.
const CLUB_WORDS = /\b(fc|cf|sc|ac|afc|cd|ud|sv|bk|if|fk|club|deportivo)\b/g;
export const idSlug = (s) => String(s == null ? "" : s)
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")     // Querétaro → Queretaro
  .toLowerCase()                                        // Van → van
  .replace(/[^a-z0-9 ]+/g, " ")
  .replace(CLUB_WORDS, " ")                             // Queretaro FC → Queretaro
  .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
export const manualId = (r) => `manual:${idSlug(r.sport)}:${idSlug(r.home)}_v_${idSlug(r.away)}`;

// —— MERGE EXISTING DUPLICATES ————————————————————————————
// Fixtures stored before the identity fix (or from a source that spells a name
// differently) sit in the DB as separate rows. Fold them into one: the survivor
// is the row with the most picks, and its odds/picks absorb the others'.
// —— RECLASSIFY EXISTING ROWS ————————————————————————————
// Two kinds of legacy mess the ingest guards can only stop going forward:
//   1. outright fields stored as head-to-heads under the wrong sport
//      (the "Podium Finish" pair sitting under Darts)
//   2. the same sport under two keys (nba + basketball) — two sidebar rows
// This fixes what is already in the database.
const OUTRIGHT_COMP_RX = /podium|top ?\d|outright|race winner|to win (the )?(race|title|tournament)/i;
export function reclassifyFixtures() {
  const out = { deletedOutright: 0, resportedRows: 0, merged: 0, examples: [] };
  const all = db.prepare("SELECT id, sport, comp, home, away FROM fixtures").all();

  // 1) an outright market stored as a matchup can never settle — remove it
  for (const f of all) {
    const looksOutright = OUTRIGHT_COMP_RX.test(String(f.comp || ""));
    const isH2H = f.away && String(f.away).trim() !== "";
    if (!looksOutright || !isH2H) continue;
    db.transaction(() => {
      db.prepare("DELETE FROM picks WHERE fixture_id=?").run(f.id);
      db.prepare("DELETE FROM odds WHERE fixture_id=?").run(f.id);
      db.prepare("DELETE FROM fixtures WHERE id=?").run(f.id);
    })();
    out.deletedOutright++;
    if (out.examples.length < 6) out.examples.push(`${f.sport}/${f.comp}: ${f.home} v ${f.away}`);
  }

  // 2) fold sport aliases so one sport is one row in the sidebar
  for (const f of db.prepare("SELECT id, sport FROM fixtures").all()) {
    const canon = canonSport(f.sport);
    if (canon && canon !== f.sport) {
      db.prepare("UPDATE fixtures SET sport=? WHERE id=?").run(canon, f.id);
      out.resportedRows++;
    }
  }

  // 3) renaming can create twins — fold them
  out.merged = mergeDuplicateFixtures().merged;
  console.log("[reclassify]", out);
  return out;
}

export function mergeDuplicateFixtures() {
  const all = db.prepare("SELECT id, sport, home, away, kickoff, status FROM fixtures").all();
  const groups = {};
  for (const f of all) {
    const day = String(f.kickoff || "").slice(0, 10);
    const key = `${idSlug(f.sport)}|${idSlug(f.home)}|${idSlug(f.away)}|${day}`;
    (groups[key] = groups[key] || []).push(f);
  }
  let merged = 0; const examples = [];
  const nPicks = db.prepare("SELECT COUNT(*) n FROM picks WHERE fixture_id=?");
  for (const key in groups) {
    const g = groups[key];
    if (g.length < 2) continue;
    g.sort((a, b) => nPicks.get(b.id).n - nPicks.get(a.id).n || String(a.id).localeCompare(String(b.id)));
    const keep = g[0];
    for (const dupe of g.slice(1)) {
      db.transaction(() => {
        // move anything the survivor doesn't already have, then drop the duplicate
        db.prepare("UPDATE OR IGNORE odds SET fixture_id=? WHERE fixture_id=?").run(keep.id, dupe.id);
        db.prepare("UPDATE OR IGNORE picks SET fixture_id=? WHERE fixture_id=?").run(keep.id, dupe.id);
        db.prepare("UPDATE OR IGNORE outcomes SET fixture_id=? WHERE fixture_id=?").run(keep.id, dupe.id);
        db.prepare("DELETE FROM odds WHERE fixture_id=?").run(dupe.id);
        db.prepare("DELETE FROM picks WHERE fixture_id=?").run(dupe.id);
        db.prepare("DELETE FROM fixtures WHERE id=?").run(dupe.id);
      })();
      merged++;
      if (examples.length < 5) examples.push(`${dupe.home} v ${dupe.away} → ${keep.home} v ${keep.away}`);
    }
  }
  if (merged) console.log(`[dedupe] merged ${merged} duplicate fixtures`);
  return { merged, examples };
}

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const YEAR = new Date().getFullYear();
const today = () => new Date().toISOString().slice(0, 10);
const futureSlot = () => {                       // 20:00 today, or tomorrow if that already passed
  const now = new Date(); const t = new Date(now.toISOString().slice(0,10)+"T20:00:00");
  if (t.getTime() < now.getTime() + 30*60e3) { const d = new Date(now.getTime()+24*3600e3); return d.toISOString().slice(0,10)+" 20:00"; }
  return now.toISOString().slice(0,10)+" 20:00";
};
const pad = (n) => String(n).padStart(2, "0");
function dateFrom(dstr, tstr) {
  const t = (tstr || "").trim() || "20:00";
  if (!dstr) {
    // time-only rows (darts/snooker/F1 scrapes): if that time already passed today,
    // the game is tomorrow — otherwise it would be hidden as "already started".
    const cand = new Date(`${today()}T${t.length === 4 ? "0" + t : t}:00`);
    if (!Number.isNaN(cand.getTime()) && cand.getTime() < Date.now() - 30 * 60e3) {
      const tm = new Date(Date.now() + 24 * 3600e3).toISOString().slice(0, 10);
      return `${tm} ${t}`;
    }
    return `${today()} ${t}`;
  }
  const d = dstr.trim();
  let m = d.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${YEAR}-${pad(m[2])}-${pad(m[1])} ${t}`;
  m = d.match(/^(\d{1,2})\s+([A-Za-z]{3})/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${YEAR}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])} ${t}`;
  return `${today()} ${t}`;
}
// ————————————————————————————————————————————————————————————————
// DATA-INTEGRITY HELPERS (shared by every upload path)
// A fixture without two real NAMES is not a fixture. A fixture without a
// parseable kickoff is not schedulable. Both are rejected at the door so
// junk can never reach the DB, the model, or the feed.
// ————————————————————————————————————————————————————————————————
const ODDS_LIKE = /^[+-]?\d{1,4}([.,]\d+)?$/;                 // "2.25", "1,615", "-110"
const RESERVED_RX = /^(home|away|draw|over|under|yes|no|x|1|2|tbd|tba|n\/a|null|undefined|-|—)$/i;
const LEAGUE_RX = /\b(division|eurobasket|euroleague|champions? league|premier league|la liga|serie [abc]|bundesliga|ligue ?1|conference|group [a-h]|round of|qualifier|regional|matchday|standings|matches tod)\b/i;

export function isBadName(x) {
  const v = String(x == null ? "" : x).trim();
  if (!v) return true;                       // empty
  if (ODDS_LIKE.test(v)) return true;        // a PRICE landed in a name column
  if (!/[\p{L}]/u.test(v)) return true;      // no letters at all → not a name
  if (v.replace(/[^\p{L}]/gu, "").length < 2) return true;  // "A." etc
  if (RESERVED_RX.test(v)) return true;      // market label, not a competitor
  if (LEAGUE_RX.test(v)) return true;        // league/section header row
  if (v.length > 42) return true;
  return false;
}

const KO_RX = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/;
// Normalise anything we were given into "YYYY-MM-DD HH:MM", or null if unusable.
export function normalizeKickoff(k) {
  if (k == null || k === "") return null;
  let s = String(k).trim();
  let m = s.match(KO_RX);
  if (!m) {
    // last-resort formats: "18/07 20:00", "18/07/2026 20:00", "18 Jul 20:00"
    const parts = s.split(/\s+/);
    const guess = dateFrom(parts[0] || "", parts[1] || "");
    m = String(guess).match(KO_RX);
    if (!m) return null;
  }
  const out = `${m[1]}-${m[2]}-${m[3]} ${pad(m[4])}:${m[5]}`;
  const t = Date.parse(out.replace(" ", "T"));
  if (Number.isNaN(t)) return null;
  // sanity window — a "fixture" 3 years ago or 3 years out is a parse error
  const now = Date.now();
  if (t < now - 30 * 24 * 3600e3 || t > now + 365 * 24 * 3600e3) return null;
  return out;
}
const num = (x) => { const n = parseFloat(String(x).replace(",", ".")); return Number.isNaN(n) ? null : n; };
const lineFrom = (label) => { const m = String(label).match(/-?\d+(\.\d+)?/); return m ? m[0] : ""; };

function normBG(rows) {
  if (!rows.length) return null;
  const head = rows[0].map((c) => c.toLowerCase());
  if (!(head.some((c) => c.includes("мач")) && head.some((c) => c.includes("коефициент")))) return null;
  const iM = head.findIndex((c) => c.includes("мач"));
  const iT = head.findIndex((c) => c.includes("час"));
  const i1 = head.findIndex((c) => c.includes("коефициент 1"));
  const iX = head.findIndex((c) => c.includes("коефициент x"));
  const i2 = head.findIndex((c) => c.includes("коефициент 2"));
  const out = [];
  for (const r of rows.slice(1)) {
    const match = (r[iM] || "").trim(); const o1 = num(r[i1]), o2 = num(r[i2]), ox = num(r[iX]);
    const idx = match.indexOf(" - "); if (idx < 0 || o1 == null || o2 == null) continue;
    const base = { sport: "soccer", kickoff: dateFrom(null, r[iT]), competition: "Betano", home: match.slice(0, idx).trim(), away: match.slice(idx + 3).trim() };
    out.push({ ...base, market: "x12", option: "home", odds: o1 });
    if (ox != null) out.push({ ...base, market: "x12", option: "draw", odds: ox });
    out.push({ ...base, market: "x12", option: "away", odds: o2 });
  }
  return out.length ? out : null;
}

function normEN(rows) {
  if (rows.length < 2) return null;
  const n = rows[0].length;
  const url = (c) => typeof c === "string" && c.startsWith("http");
  const data = rows.slice(1);
  const out = [];
  const push = (o) => { if (o.odds != null) out.push(o); };

  if (n === 6 && data.some((r) => url(r[1]))) {
    for (const r of data) { if (!url(r[1])) continue;
      const base = { sport: "darts", kickoff: dateFrom(null, r[0]), competition: "Darts", home: r[2], away: r[3] };
      push({ ...base, market: "ml", option: r[2], odds: num(r[4]) });
      push({ ...base, market: "ml", option: r[3], odds: num(r[5]) }); }
    return out.length ? out : null;
  }
  if (n === 7 && data.some((r) => url(r[1]))) {
    for (const r of data) { if (!url(r[1])) continue;
      const base = { sport: "snooker", kickoff: dateFrom(null, r[0]), competition: "Snooker", home: r[2], away: r[3] };
      push({ ...base, market: "result", option: "home", odds: num(r[4]) });
      push({ ...base, market: "result", option: "draw", odds: num(r[5]) });
      push({ ...base, market: "result", option: "away", odds: num(r[6]) }); }
    return out.length ? out : null;
  }
  if (n === 12 && data.some((r) => url(r[3]))) {
    for (const r of data) { if (!url(r[3])) continue;
      const base = { sport: "soccer", kickoff: dateFrom(r[1], r[2]), competition: r[0] || "Betano", home: r[4], away: r[5] };
      push({ ...base, market: "x12", option: "home", odds: num(r[7]) });
      push({ ...base, market: "x12", option: "draw", odds: num(r[9]) });
      push({ ...base, market: "x12", option: "away", odds: num(r[11]) }); }
    return out.length ? out : null;
  }
  if (n === 19) {
    for (const r of data) {
      for (const off of [3, 12]) {
        if (!url(r[off])) continue;
        const base = { sport: "tennis", kickoff: dateFrom(r[off - 2], r[off - 1]), competition: r[0] || "Tennis", home: r[off + 1], away: r[off + 2] };
        push({ ...base, market: "ml", option: r[off + 1], odds: num(r[off + 4]) });
        push({ ...base, market: "ml", option: r[off + 2], odds: num(r[off + 6]) });
      }
    }
    return out.length ? out : null;
  }
  if (n === 20 && data.some((r) => url(r[7]))) {
    for (const r of data) { if (!url(r[7])) continue;
      const home = r[8], away = r[9];
      const base = { sport: "nba", kickoff: dateFrom(r[2], r[6]), competition: r[1] || "Basketball", home, away };
      push({ ...base, market: "ml", option: home, odds: num(r[10]) });
      push({ ...base, market: "ml", option: away, odds: num(r[11]) });
      push({ ...base, market: "spread", option: `${home} ${r[12]}`, line: lineFrom(r[12]), odds: num(r[13]) });
      push({ ...base, market: "spread", option: `${away} ${r[14]}`, line: lineFrom(r[14]), odds: num(r[15]) });
      push({ ...base, market: "total", option: `Over ${lineFrom(r[16])}`, line: lineFrom(r[16]), odds: num(r[17]) });
      push({ ...base, market: "total", option: `Under ${lineFrom(r[18])}`, line: lineFrom(r[18]), odds: num(r[19]) }); }
    return out.length ? out : null;
  }
  return null;
}

function normSpreadex(rows) {
  if (rows.length < 3) return null;
  const looks = rows[0].some((c) => String(c).toLowerCase().includes("p-panel")) || rows.some((r) => r[1] === "View Coupons");
  if (!looks) return null;
  const mr = rows.find((r) => r[0] === "Match Result");
  if (!mr) return null;
  const home = mr[2], away = mr[6] || mr[4];
  if (!home || !away) return null;
  const kickoff = futureSlot();
  const NAME = { "match result": "x12", "both teams to score": "btts", "double chance": "dc",
    "draw no bet": "dnb", "half time result": "htr", "first team to score": "fts",
    "to qualify": "qualify", "goalscorer markets": "ags", "correct score": "cs", "asian handicap": "ah", "handicap": "ah" };
  const out = [];
  for (const r of rows) {
    const name = (r[0] || "").trim();
    if (!name) continue;
    const id = NAME[name.toLowerCase()] || slug(name).toLowerCase();
    [[2, 3], [4, 5], [6, 7]].forEach(([ci, pi], k) => {
      const label = (r[ci] || "").trim(); const price = num(r[pi]);
      if (!label || price == null) return;
      const option = id === "x12" ? (k === 0 ? "home" : k === 1 ? "draw" : "away") : label;
      out.push({ sport: "soccer", kickoff, competition: "SpreaDex", home, away, market: id, option, odds: price });
    });
  }
  return out.some((o) => o.market === "x12") ? out : null;
}

function normBetanoMatch(rows) {
  if (rows.length < 3) return null;
  const head = rows[0].map((c) => String(c).toLowerCase());
  if (!(head.some((c) => c.includes("s-name")) && head.some((c) => c.includes("tw-text-s")))) return null;
  let home, away;
  const teamRow = rows.find((r) => ["to qualify", "draw no bet"].includes((r[0] || "").toLowerCase()));
  if (teamRow) { home = teamRow[1]; away = teamRow[3]; }
  if (!home || !away) {
    const dc = rows.find((r) => (r[0] || "").toLowerCase() === "double chance");
    if (dc) { home = (dc[1] || "").split(" or ")[0]; const m2 = (dc[3] || "").split(" or "); away = m2[0] === home ? m2[1] : m2[0]; }
  }
  if (!home || !away) return null;
  const NAME = { "match result": "x12", "both teams to score": "btts", "double chance": "dc",
    "draw no bet": "dnb", "half time result": "htr", "to qualify": "qualify",
    "over/under total goals": "goals_ou", "goalscorer markets": "ags", "anytime goalscorer": "ags", "correct score": "cs", "asian handicap": "ah", "handicap": "ah" };
  const kickoff = futureSlot();
  const out = [];
  for (const r of rows.slice(1)) {
    const name = (r[0] || "").trim(); if (!name) continue;
    const id = NAME[name.toLowerCase()] || slug(name).toLowerCase();
    const seen = new Set();
    [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]].forEach(([ci, pi]) => {
      const label = (r[ci] || "").trim(); const price = num(r[pi]);
      if (!label || price == null) return;
      let option = label;
      if (id === "x12") option = label === "1" ? "home" : label === "X" ? "draw" : label === "2" ? "away" : label;
      if (seen.has(option)) return;                 // keep the primary (first) line only
      seen.add(option);
      out.push({ sport: "soccer", kickoff, competition: "Betano", home, away, market: id, option, odds: price });
    });
  }
  return out.some((o) => o.market === "x12") ? out : null;
}

const RACE_SPORTS = new Set(["f1", "motogp", "nascar", "golf", "cycling", "horse_racing"]);
// bookmakers and screenshots spell the same sport a dozen ways
const SPORT_ALIASES = {
  "formula 1": "f1", "formula1": "f1", "formula one": "f1", "f1 racing": "f1",
  auto: "f1", motor: "f1", motorsport: "f1", "motor racing": "f1", racing: "f1",
  "moto gp": "motogp", motorcycle: "motogp",
  "horse racing": "horse_racing", horses: "horse_racing",
  // one sport, one sidebar entry — these all used to arrive as separate keys
  football: "soccer", futbol: "soccer", "association football": "soccer",
  "american football": "american_football", nfl: "american_football", "am football": "american_football",
  basket: "basketball", nba: "basketball", "basket ball": "basketball",
  mlb: "baseball", "base ball": "baseball",
  nhl: "ice_hockey", hockey: "ice_hockey", "ice hockey": "ice_hockey",
  "table tennis": "table_tennis", "ping pong": "table_tennis", tabletennis: "table_tennis",
  ufc: "mma", "mixed martial arts": "mma",
};
export function canonSport(x) {
  const v = String(x == null ? "" : x).trim().toLowerCase().replace(/[_-]+/g, " ");
  return SPORT_ALIASES[v] || v.replace(/\s+/g, "_");
}
// Shared text→sport heuristics. Used by every parser that has to guess a
// sport from free text (competition name, market name, matchup string)
// instead of trusting an explicit "sport" column. IMPORTANT: order matters —
// race/outright markets are checked first so an F1/MotoGP "Podium Finish",
// "Winner", "Top 6" etc. board never gets swallowed by a h2h-sport keyword
// that happens to also appear in the same text.
const SPORT_HINTS = [
  [/\bf1\b|formula ?1|formula ?one|grand prix|\bgp\b|pole position|podium finish/i, "f1"],
  [/moto ?gp/i, "motogp"],
  [/nascar/i, "nascar"],
  [/\bpga\b|masters golf|the open\b/i, "golf"],
  [/atp|wta|wimbledon|challenger|us open|roland|australian open/i, "tennis"],
  [/nba|eurobasket|\bbasket\b|fiba/i, "nba"],
  [/volley/i, "volleyball"],
  [/darts|\bpdc\b|world matchplay/i, "darts"],
  [/snooker/i, "snooker"],
  [/ufc|\bmma\b|\bcage\b/i, "mma"],
  [/boxing|heavyweight|\bwbc\b|\bwba\b|\bibf\b/i, "boxing"],
  [/table tennis|tt cup|liga pro/i, "tabletennis"],
  [/esport|cs2|counter.strike|\bdota\b|league of legends|valorant/i, "esports"],
  [/nhl|hockey|khl/i, "nhl"],
  [/mlb|baseball/i, "mlb"],
  [/cricket|t20|\bipl\b|\bodi\b/i, "cricket"],
  [/handball/i, "handball"],
];
// Try every hint against a blob of free text; null if nothing matches.
// Never used to override an explicit sport column — only to fill one in.
function sniffSport(text) {
  for (const [rx, sp] of SPORT_HINTS) if (rx.test(text)) return sp;
  return null;
}
// how many runners a market pays out on — the implied probabilities of a
// complete field sum to roughly this number, not to 1.
const RACE_PLACES = { winner: 1, outright: 1, pole: 1, fastestlap: 1, podium: 3, top3: 3, top6: 6, top10: 10 };


const WD = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
function whenToKickoff(when) {
  const parts = String(when || "").split(",").map((x) => x.trim());
  const day = (parts[0] || "").toLowerCase(); const time = parts[1] || parts[0] || "00:00";
  const now = new Date(); let d = new Date(now);
  if (day.startsWith("tomorrow")) d.setDate(d.getDate() + 1);
  else if (WD[day.slice(0, 3)] != null) {
    const ahead = (WD[day.slice(0, 3)] - now.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + ahead);
  } else if (!day.startsWith("today")) { /* unknown → today */ }
  const iso = d.toISOString().slice(0, 10);
  // if today's time already passed, roll to tomorrow (upcoming lists only)
  if (iso === now.toISOString().slice(0, 10)) return dateFrom(null, time);
  return `${iso} ${time}`;
}
function normSimplePlayers(rows, defSport){
  if(rows.length<2)return null;
  var head=rows[0].map(function(c){return String(c).toLowerCase().trim();});
  var iP1=head.findIndex(function(c){return /player ?1|home|p1/.test(c);});
  var iP2=head.findIndex(function(c){return /player ?2|away|p2/.test(c);});
  var iO1=head.findIndex(function(c){return /odds ?1|price ?1|o1/.test(c);});
  var iO2=head.findIndex(function(c){return /odds ?2|price ?2|o2/.test(c);});
  if(iP1<0||iP2<0||iO1<0||iO2<0)return null;
  var iSport=head.findIndex(function(c){return c==="sport";});
  var iComp=head.findIndex(function(c){return /competition|league|event|tournament/.test(c);});
  var iTime=head.findIndex(function(c){return /time|kickoff|date|start/.test(c);});
  var out=[];
  for(var i=1;i<rows.length;i++){
    var r=rows[i]; var h=(r[iP1]||"").trim(), a=(r[iP2]||"").trim();
    var o1=num(r[iO1]), o2=num(r[iO2]);
    if(!h||!a||o1==null||o2==null)continue;
    var comp=(iComp>=0&&r[iComp])?String(r[iComp]).trim():"";
    // Never hard-default an unlabeled row to an arbitrary sport (that's how an
    // F1 "Podium Finish" outright board with no sport column ended up filed
    // under Darts). Priority: explicit sport column > sniff from competition
    // + matchup text > caller-supplied defSport > drop the row entirely.
    var sport=(iSport>=0&&r[iSport])?String(r[iSport]).toLowerCase().trim():null;
    if(!sport)sport=sniffSport(comp+" "+h+" "+a);
    if(!sport&&defSport)sport=defSport;
    if(!sport)continue; // unknown sport — reject rather than guess
    if(!comp)comp=sport.charAt(0).toUpperCase()+sport.slice(1);
    var kickoff=(iTime>=0&&r[iTime])?whenToKickoff(r[iTime]):futureSlot();
    out.push({sport:sport,kickoff:kickoff,competition:comp,home:h,away:a,market:"ml",option:h,odds:o1});
    out.push({sport:sport,kickoff:kickoff,competition:comp,home:h,away:a,market:"ml",option:a,odds:o2});
  }
  return out.length?out:null;
}

function normSpreadexList(rows) {
  if (rows.length < 2) return null;
  const head = rows[0].map((c) => String(c).toLowerCase());
  const looks = head.some((c) => c.includes("min-w-0")) || head.some((c) => c.includes("truncate"));
  if (!looks) return null;
  const out = [];
  // odds may sit in cols 2/3 OR 4/5 depending on the export; auto-pick the numeric pair
  for (const r of rows.slice(1)) {
    const match = (r[0] || "").trim();
    if (!match.includes(" v ") || /outright/i.test(match)) continue;
    let o1 = num(r[2]), o2 = num(r[3]);
    if (o1 == null || o2 == null) { o1 = num(r[4]); o2 = num(r[5]); }
    if (o1 == null || o2 == null) continue;
    const comp = "";
    const [home, away] = match.split(" v ").map((x) => x.trim());
    const sport = sniffSport(comp + " " + match);
    if (!sport) continue;
    const kickoff = whenToKickoff(r[1]);
    out.push({ sport, kickoff, competition: comp, home, away, market: "ml", option: home, odds: o1 });
    out.push({ sport, kickoff, competition: comp, home, away, market: "ml", option: away, odds: o2 });
  }
  return out.length ? out : null;
}


// —— Web Scraper (webscraper.io) Betano export ——
// headers: web_scraper_order,web_scraper_start_url,data(home),data2(away),data3(o1),data4(o2),data5(time),name,name2,data6(DD/MM)
// sport + competition come straight from the start URL (…/sport/darts/pdc/world-matchplay/…)
function slugTeams(url){
  var m=String(url).match(/\/([a-z0-9-]+)-vs-([a-z0-9-]+)(?:[\/#]|$)/i);
  if(!m)return null;
  var tidy=function(x){return x.replace(/-/g," ").replace(/\b\w/g,function(c){return c.toUpperCase();}).trim();};
  return {home:tidy(m[1]),away:tidy(m[2])};
}
function marketIdFromTitle(t){
  var x=String(t).toLowerCase();
  if(/team total/.test(x))return null;                               // team totals = noise, drop
  if(/corner/.test(x)){return /total/.test(x)?"corners_ou":null;}     // match Over/Under corners only
  if(/card|booking/.test(x)){return /total/.test(x)?"cards_ou":null;} // match Over/Under cards only
  if(/money\s*line|match result|1x2|full time result/.test(x))return "x12";
  if(/to qualify/.test(x))return "qualify";
  if(/both teams|btts/.test(x))return "btts";
  if(/correct score/.test(x))return "cs";
  if(/team total/.test(x))return "team_total";
  if(/total/.test(x))return "goals_ou";
  if(/handicap|spread|asian/.test(x))return "ah";
  if(/half/.test(x))return "htr";
  return slug(x).toLowerCase();
}
function normWebScraperBasket(rows){
  // webscraper.io basketball/matchups: data2(home),data3(away),data4/5(spread lines),data6(time),price3/4(spread odds)
  if(rows.length<2)return null;
  var head=rows[0].map(function(c){return String(c).toLowerCase();});
  if(!head.some(function(c){return c.indexOf("web_scraper")>=0;}))return null;
  if(head.indexOf("data2")<0||head.indexOf("data3")<0||head.indexOf("price3")<0)return null;
  var iUrl=head.findIndex(function(c){return c.indexOf("start_url")>=0;});
  var iH=head.indexOf("data2"),iA=head.indexOf("data3"),iHL=head.indexOf("data4"),iAL=head.indexOf("data5"),iTime=head.indexOf("data6");
  var iHP=head.indexOf("price3"),iAP=head.indexOf("price4");
  var sm=(rows[1][iUrl]||"").match(/pinnacle\.com\/en\/([a-z-]+)\//i)||(rows[1][iUrl]||"").match(/\/en\/([a-z-]+)\//i);
  var SPORT_MAP={basketball:"nba","ice-hockey":"nhl",baseball:"mlb",handball:"handball",volleyball:"volleyball"};
  var sport=sm?(SPORT_MAP[sm[1].toLowerCase()]||sm[1].toLowerCase()):null;
  if(!sport)return null;
  var out=[];
  for(var i=1;i<rows.length;i++){
    var r=rows[i]; var home=(r[iH]||"").trim(), away=(r[iA]||"").trim();
    if(!home||!away)continue;
    if(/league|liga\b|euroleague|summer|wnba\b|- nba|serie\b|division/i.test(home)||/league|liga\b|euroleague|summer|division/i.test(away))continue; // league header rows are not teams
    var rawTime=(r[iTime]||"").replace(/\+\d+$/,"").trim();   // strip "+3" tz suffix
    var kickoff=whenToKickoff(rawTime);
    var base={sport:sport,kickoff:kickoff,competition:sport==="nba"?"Basketball":sport.charAt(0).toUpperCase()+sport.slice(1),home:home,away:away};
    var hp=num(r[iHP]), ap=num(r[iAP]);
    var hl=(r[iHL]||"").trim(), al=(r[iAL]||"").trim();
    if(hp!=null)out.push({sport:sport,kickoff:kickoff,competition:base.competition,home:home,away:away,market:"spread",option:home+" "+hl,line:hl,odds:hp});
    if(ap!=null)out.push({sport:sport,kickoff:kickoff,competition:base.competition,home:home,away:away,market:"spread",option:away+" "+al,line:al,odds:ap});
  }
  return out.length?out:null;
}

function normWebScraperPlayers(rows){
  // webscraper.io variant: data(p1),data2(p2),data3(time),price,price2 ; sport from URL, no title/name cols
  if(rows.length<2)return null;
  var head=rows[0].map(function(c){return String(c).toLowerCase();});
  if(!head.some(function(c){return c.indexOf("web_scraper")>=0;}))return null;
  if(head.indexOf("title")>=0||head.indexOf("name")>=0)return null;      // handled by other detectors
  var iUrl=head.findIndex(function(c){return c.indexOf("start_url")>=0;});
  var iA=head.indexOf("data"),iB=head.indexOf("data2"),iT=head.indexOf("data3"),iP=head.indexOf("price"),iP2=head.indexOf("price2");
  if(iA<0||iB<0||iP<0)return null;
  var SPORT_MAP={darts:"darts",snooker:"snooker",tennis:"tennis","table-tennis":"tabletennis",volleyball:"volleyball",basketball:"nba",football:"soccer",soccer:"soccer","ice-hockey":"nhl",hockey:"nhl",handball:"handball",baseball:"mlb",boxing:"boxing",mma:"mma",cricket:"cricket"};
  var clean=function(x){return String(x).replace(/\s*\((sets|games|maps|frames|legs|match)\)\s*/ig,"").trim();};
  var out=[];
  for(var i=1;i<rows.length;i++){
    var r=rows[i]; var url=r[iUrl]||"";
    var sm=url.match(/\/(?:en\/)?([a-z-]+)(?:\/|$)/i);
    var sport=sm?(SPORT_MAP[sm[1].toLowerCase()]||null):null;
    if(!sport)continue;
    var raw1=String(r[iA]||""), raw2=String(r[iB]||"");
    // skip the secondary "(Games)"-type lines (no primary winner price / duplicate)
    if(/\((games|maps|frames|legs)\)/i.test(raw1))continue;
    var home=clean(raw1), away=clean(raw2);
    var o1=num(r[iP]), o2=num(r[iP2]);
    if(!home||!away||o1==null||o2==null)continue;
    var comp=sport.charAt(0).toUpperCase()+sport.slice(1);
    var kickoff=whenToKickoff(r[iT]||"");
    out.push({sport:sport,kickoff:kickoff,competition:comp,home:home,away:away,market:"ml",option:home,odds:o1});
    out.push({sport:sport,kickoff:kickoff,competition:comp,home:home,away:away,market:"ml",option:away,odds:o2});
  }
  return out.length?out:null;
}

function normWebScraperMarkets(rows){
  if(rows.length<2)return null;
  var head=rows[0].map(function(c){return String(c).toLowerCase();});
  if(!head.some(function(c){return c.indexOf("web_scraper")>=0;}))return null;
  if(head.indexOf("title")<0||head.indexOf("price")<0||head.indexOf("name")<0)return null;
  var iUrl=head.findIndex(function(c){return c.indexOf("start_url")>=0;});
  var iT=head.indexOf("title"),iP=head.indexOf("price"),iP2=head.indexOf("price2");
  var iN=head.indexOf("name"),iN2=head.indexOf("name2");
  var SPORT_MAP={darts:"darts",snooker:"snooker",tennis:"tennis","table-tennis":"tabletennis",volleyball:"volleyball",basketball:"nba",football:"soccer",soccer:"soccer","ice-hockey":"nhl",hockey:"nhl",handball:"handball",baseball:"mlb",boxing:"boxing",mma:"mma",esports:"esports","e-sports":"esports",cricket:"cricket"};
  var out=[];
  for(var i=1;i<rows.length;i++){
    var r=rows[i]; var url=r[iUrl]||"";
    var sm=url.match(/\/(?:en\/)?([a-z-]+)\//i);
    var sport=sm?(SPORT_MAP[sm[1].toLowerCase()]||null):null;
    var teams=slugTeams(url);
    if(!sport||!teams)continue;
    var compM=url.match(new RegExp("/"+(sm?sm[1]:"")+"/([a-z0-9-]+)/","i"));
    var comp=compM?compM[1].replace(/-/g," ").replace(/\b\w/g,function(c){return c.toUpperCase();}):"";
    var market=marketIdFromTitle(r[iT]); if(!market)continue;
    var base={sport:sport,kickoff:futureSlot(),competition:comp,home:teams.home,away:teams.away};
    var pairs=[[iN,iP],[iN2,iP2]];
    pairs.forEach(function(pr){
      var label=(r[pr[0]]||"").trim(); var price=num(r[pr[1]]);
      if(!label||price==null)return;
      var opt=label.replace(/\s*\((corners|cards|bookings|shots)\)\s*/ig," ").replace(/\b(corners|cards|bookings|shots)\b/ig,"").replace(/\s+/g," ").trim();
      if(market==="x12"){var L=opt.toLowerCase();opt=(L===teams.home.toLowerCase())?"home":(L==="draw")?"draw":(L===teams.away.toLowerCase())?"away":opt;}
      else if(/_ou$/.test(market)){var mo=opt.match(/(over|under)\s*([\d.]+)/i);if(mo)opt=mo[1].charAt(0).toUpperCase()+mo[1].slice(1).toLowerCase()+" "+mo[2];}
      if(market==="ah" && /^[+-]?\d+(\.\d+)?$/.test(opt)) return;   // skip bare handicap-line labels
      out.push({sport:sport,kickoff:base.kickoff,competition:comp,home:base.home,away:base.away,market:market,option:opt,odds:price});
    });
  }
  return out.length?out:null;
}

function normWebScraper(rows) {
  if (rows.length < 2) return null;
  const head = rows[0].map((c) => String(c).toLowerCase());
  if (!head.includes("web_scraper_order") && !head.some((c) => c.includes("web_scraper"))) return null;
  const iUrl = head.findIndex((c) => c.includes("start_url"));
  // locate the two odds columns = first two numeric-looking columns after the url
  const SPORT_MAP = { darts: "darts", snooker: "snooker", tennis: "tennis", "table-tennis": "tabletennis",
    volleyball: "volleyball", basketball: "nba", football: "soccer", soccer: "soccer", "ice-hockey": "nhl",
    handball: "handball", baseball: "mlb", boxing: "boxing", mma: "mma", "esports": "esports", "e-sports": "esports" };
  const out = [];
  for (const r of rows.slice(1)) {
    const url = r[iUrl] || "";
    const m = url.match(/\/sport\/([a-z-]+)\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?/i);
    const sport = m ? (SPORT_MAP[m[1].toLowerCase()] || m[1].toLowerCase()) : null;
    if (!sport) continue;
    var compRaw = m ? (m[3] && !/^\d+$/.test(m[3]) ? m[3] : m[2]) : "";
    const comp = compRaw ? compRaw.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Betano";
    // find home/away (first two non-url, non-numeric text cells) and their two odds
    const cells = r.slice(0, iUrl).concat(r.slice(iUrl + 1));
    const texts = [], nums = [];
    for (const c of cells) {
      const v = String(c).trim(); if (!v) continue;
      if (/^\d{1,3}([.,]\d+)?$/.test(v) && parseFloat(v) >= 1.01 && parseFloat(v) <= 200) nums.push(parseFloat(v.replace(",", ".")));
      else if (!/^https?:/i.test(v) && !/^\d+$/.test(v) && !/^\d{1,2}[:\/]\d/.test(v)) texts.push(v);
    }
    const home = r[2] || texts[0], away = r[3] || texts[1];
    const o1 = num(r[4]) ?? nums[0], o2 = num(r[5]) ?? nums[1];
    const time = r[6] || "";
    const dstr = r[9] || "";
    if (!home || !away || o1 == null || o2 == null) continue;
    const kickoff = /\d{1,2}\/\d{1,2}/.test(dstr) ? dateFrom(dstr, time) : whenToKickoff(time);
    out.push({ sport, kickoff, competition: comp, home, away, market: "ml", option: home, odds: o1 });
    out.push({ sport, kickoff, competition: comp, home, away, market: "ml", option: away, odds: o2 });
  }
  return out.length ? out : null;
}

// —— canonical 3-way / 2-way option labels ————————————————————————
// Sources label the same selection five different ways ("1", "Palmeiras",
// "Home", "HOME WIN"). The model answers in home/draw/away, so if the stored
// label is a team name the price can never be matched back to the pick and the
// card renders "Bookmaker line —" with no edge. Canonicalise at ingest.
const THREE_WAY = new Set(["x12", "result", "corners_3way", "htr", "1x2"]);
const nrmLbl = (x) => String(x == null ? "" : x).trim().toLowerCase();
export function canonOption(market, option, home, away) {
  const m = nrmLbl(market), o = nrmLbl(option);
  if (!THREE_WAY.has(m)) return option;
  const h = nrmLbl(home), a = nrmLbl(away);
  if (o === "1" || o === "home" || o === "home win" || (h && o === h)) return "home";
  if (o === "2" || o === "away" || o === "away win" || (a && o === a)) return "away";
  if (o === "x" || o === "draw" || o === "tie" || o === "empate") return "draw";
  return option;
}

export function ingestEvents(csvText) {
  const raw = splitRows(csvText);
  let rows = normWebScraperMarkets(raw) || normWebScraperBasket(raw) || normWebScraperPlayers(raw) || normWebScraper(raw) || normBG(raw) || normSpreadexList(raw) || normSpreadex(raw) || normBetanoMatch(raw) || normSimplePlayers(raw) || normEN(raw);
  // scraped soccer files: keep only the big-turnover markets (rest is noise)
  const KEEP_SOCCER = new Set(["x12", "goals_ou", "ou25", "goals_ou_1h", "btts", "dc", "corners_3way", "corners_ou"]);
  if (rows) rows = rows.filter((r) => String(r.sport).toLowerCase() !== "soccer" || KEEP_SOCCER.has(r.market));
  if (!rows) rows = parseCSV(csvText);
  // ---- GLOBAL DATA-INTEGRITY GATES (protect every upload source) ----
  const rejected = { noName: 0, badDate: 0, alreadyPlayed: 0, noOdds: 0, badMargin: 0, outrightAsH2H: 0 };
  const assumed = { date: 0, dupOptions: 0 };
  const STALE_MS = (Number(process.env.UPLOAD_GRACE_HOURS) || 6) * 3600e3;
  if (rows) {
    // 1) NAMES: both competitors must be real names. A row whose "home"/"away"
    //    is a price ("2.25"), a market label ("away") or a league header is a
    //    column-misalignment in the source file — drop it, never store it.
    for (const r of rows) if (r.sport) r.sport = canonSport(r.sport);
    rows = rows.filter((r) => {
      const race = RACE_SPORTS.has(String(r.sport).toLowerCase());
      const bad = isBadName(r.home) || (!race && isBadName(r.away));
      if (bad) rejected.noName++;
      return !bad;
    });

    // 2) DATES: every row gets a real, sane kickoff or it is dropped.
    //    No more "Invalid Date" cards and no more games that can never expire.
    rows = rows.filter((r) => {
      const ko = normalizeKickoff(r.kickoff);
      if (!ko) {
        // No readable date. A bookmaker screenshot often shows only players and
        // prices — dropping those would throw the whole upload away, which is
        // worse than scheduling them for the next slot today. They are flagged,
        // reported back to the uploader, and age out of the feed normally.
        r.kickoff = futureSlot();
        r.dateAssumed = true;
        assumed.date++;
        return true;
      }
      // an EVENTS upload is for games that have not finished. Anything that
      // kicked off more than the grace window ago is history — it belongs in a
      // results upload, not on the live feed.
      if (Date.parse(ko.replace(" ", "T")) < Date.now() - STALE_MS) { rejected.alreadyPlayed++; return false; }
      r.kickoff = ko;
      return true;
    });

    // 3) ODDS: a row with no usable price cannot produce an edge — it would create
    //    a fixture that renders as "—" everywhere. Reject it here instead.
    rows = rows.filter((r) => {
      const price = typeof r.odds === "number" ? r.odds : num(r.odds);
      if (price == null || !(price >= 1.01)) { rejected.noOdds++; return false; }
      return true;
    });

    // 4) DUPLICATE SELECTIONS: the same fixture+market+option listed twice (the
    //    usual cause is one screenshot read twice, or two spellings of a name).
    //    Keep the last price. Left in place they double-count in the margin check
    //    below and would get the whole market rejected as an "impossible book".
    const bySel = new Map();
    for (const r of rows) bySel.set(`${manualId(r)}|${r.market}|${String(r.option).toLowerCase().trim()}`, r);
    if (bySel.size !== rows.length) {
      assumed.dupOptions = rows.length - bySel.size;
      rows = [...bySel.values()];
    }

    // 5) MARGIN sanity: reject impossible 2-way markets (e.g. 1.10 vs 1.10 → 182% book).
    //    Group a fixture+market's options, check implied-probability sum.
    const groups = {};
    for (const r of rows) { const k = manualId(r) + "|" + r.market; (groups[k] = groups[k] || []).push(r); }
    const bad = new Set();
    for (const k in groups) {
      const g = groups[k]; if (g.length < 2) continue;
      let sum = 0, ok = true;
      for (const r of g) { const o = typeof r.odds === "number" ? r.odds : num(r.odds); if (o == null || o < 1.01) { ok = false; break; } sum += 1 / o; }
      // sum ~1.0 = fair; real books run 1.02–1.25. An absurd margin (>1.35) is always
      // a parse error. A sum BELOW 1 only means "typo" when the book is complete —
      // a 1X2 upload missing the draw leg legitimately sums under 1, so only apply
      // the lower bound when we have the full set of options for the market.
      const mkt = String(g[0].market || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const places = RACE_PLACES[mkt];
      if (places) {
        // OUTRIGHT FIELD (race winner, podium, top6, top10). The implied
        // probabilities of an N-place market sum to about N, not to 1 — a 20-car
        // podium market legitimately sums near 3.0. Judging it against a 1.35
        // two-way ceiling is what rejected every Formula 1 upload.
        // Only the per-runner price and a generous ceiling are meaningful here,
        // and a partial field (screenshot cut off) must still be accepted.
        if (!ok || sum > places * 2.2) bad.add(k);
        continue;
      }
      const expected = THREE_WAY.has(mkt) ? 3 : 2;
      const complete = g.length >= expected;
      if (!ok || sum > 1.35 || (complete && sum < 0.90)) bad.add(k);
    }
    if (bad.size) { const before = rows.length; rows = rows.filter((r) => !bad.has(manualId(r) + "|" + r.market)); rejected.badMargin = before - rows.length; }
  }
  // OUTRIGHT MISREAD: a podium/top-N/outright field that arrived as head-to-heads.
  // Two competitors in the same race are not opponents, and storing them as a
  // matchup produces a fake fixture that can never settle. Reject with a reason
  // rather than let it into the feed.
  if (rows) {
    const OUTRIGHT_RX = /podium|top ?\d|outright|race winner|to win (the )?(race|title|tournament)|winner without/i;
    const before = rows.length;
    rows = rows.filter((r) => {
      const looksOutright = OUTRIGHT_RX.test(String(r.comp || r.competition || "")) || OUTRIGHT_RX.test(String(r.market || "")) || OUTRIGHT_RX.test(String(r.option || ""));
      const isH2H = r.away && String(r.away).trim() !== "";
      return !(looksOutright && isH2H);
    });
    rejected.outrightAsH2H = before - rows.length;
  }
  const rejectedTotal = rejected.noName + rejected.badDate + rejected.alreadyPlayed + (rejected.outrightAsH2H || 0) + rejected.noOdds + rejected.badMargin;
  if (rejectedTotal) console.log(`[upload] rejected ${rejectedTotal} rows —`, rejected);
  if (assumed.date) console.log(`[upload] ${assumed.date} rows had no readable date — scheduled for ${futureSlot()}`);
  const seen = new Set(); let fixtures = 0, odds = 0;
  // pre-pass: collect entrants for race events (drivers/riders = the options)
  const entrantsMap = {};
  for (const r of rows) {
    const sp = String(r.sport || "").toLowerCase();
    if (!RACE_SPORTS.has(sp) || !r.home || !r.option) continue;
    if (r.away == null || r.away === undefined) r.away = "";
    const id = manualId(r);
    (entrantsMap[id] = entrantsMap[id] || new Set()).add(String(r.option).replace(/\s+(over|under).*$/i, ""));
  }
  const tx = db.transaction(() => {
    for (const r of rows) {
      const sp = String(r.sport || "").toLowerCase();
      const isRaceSport = RACE_SPORTS.has(sp);
      if (isRaceSport && (r.away == null || r.away === "")) r.away = "";
      if (!r.sport || !r.home || (!isRaceSport && !r.away) || !r.market) continue;
      const id = manualId(r);
      if (!seen.has(id)) {
        const ent = entrantsMap[id] ? JSON.stringify([...entrantsMap[id]]) : null;
        upsertFixture.run({ id, sport: sp, comp: r.competition || "Manual",
          home: r.home, away: r.away || "", entrants: ent, kickoff: r.kickoff || null, status: "upcoming",
          score: null, raw: JSON.stringify({ source: "manual" }) });
        seen.add(id); fixtures++;
      }
      let option = r.line && !String(r.option).includes(String(r.line)) ? `${r.option} ${r.line}`.trim() : r.option;
      option = canonOption(r.market, option, r.home, r.away);
      const price = typeof r.odds === "number" ? r.odds : num(r.odds);
      if (option && price != null) { upsertOdd.run({ fixture_id: id, market: r.market, option, price }); odds++; }
    }
  });
  tx();
  const dedupe = mergeDuplicateFixtures();      // an upload never leaves twins behind
  return { fixtures, odds, rows: rows.length, rejected, rejectedTotal, assumed, merged: dedupe.merged };
}

const norm = (x) => String(x).trim().toLowerCase();
export function ingestResults(csvText) {
  const raw = splitRows(csvText);
  const rows = normBG(raw) || parseCSV(csvText);
  let settled = 0, graded = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const sp = String(r.sport || "").toLowerCase();
      if (RACE_SPORTS.has(sp) && (r.away == null)) r.away = "";
      if (!r.sport || !r.home || (!RACE_SPORTS.has(sp) && !r.away) || !r.market || r.outcome === "" || r.outcome == null) continue;
      const id = manualId(r);
      setOutcome.run({ fixture_id: id, market: r.market, outcome: JSON.stringify(r.outcome) });
      markFinal.run({ id, score: r.score || null });
      settled++;
      for (const p of q.picksFor.all(id)) {
        if (p.market !== r.market) continue;
        let c = isPickCorrect(p.market, p.pick, r.outcome);
        if (c == null) c = norm(p.pick) === norm(r.outcome) ? 1 : 0;
        gradePick.run({ correct: c, fixture_id: id, model: p.model, market: p.market }); graded++;
      }
    }
  });
  tx();
  return { settled, graded, rows: rows.length };
}

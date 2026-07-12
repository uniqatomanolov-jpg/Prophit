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
export const manualId = (r) => `manual:${slug(r.sport)}:${slug(r.kickoff)}:${slug(r.home)}_v_${slug(r.away)}`;

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const YEAR = new Date().getFullYear();
const today = () => new Date().toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, "0");
function dateFrom(dstr, tstr) {
  const t = (tstr || "").trim() || "00:00";
  if (!dstr) return `${today()} ${t}`;
  const d = dstr.trim();
  let m = d.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${YEAR}-${pad(m[2])}-${pad(m[1])} ${t}`;
  m = d.match(/^(\d{1,2})\s+([A-Za-z]{3})/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${YEAR}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])} ${t}`;
  return `${today()} ${t}`;
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
  const kickoff = `${today()} 20:00`;
  const NAME = { "match result": "x12", "both teams to score": "btts", "double chance": "dc",
    "draw no bet": "dnb", "half time result": "htr", "first team to score": "fts",
    "to qualify": "qualify", "goalscorer markets": "ags" };
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
    "over/under total goals": "goals_ou", "goalscorer markets": "ags", "anytime goalscorer": "ags" };
  const kickoff = `${today()} 20:00`;
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

const RACE_SPORTS = new Set(["f1", "motogp", "nascar", "golf", "cycling"]);

export function ingestEvents(csvText) {
  const raw = splitRows(csvText);
  let rows = normBG(raw) || normSpreadex(raw) || normBetanoMatch(raw) || normEN(raw);
  if (!rows) rows = parseCSV(csvText);
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
      const option = r.line && !String(r.option).includes(String(r.line)) ? `${r.option} ${r.line}`.trim() : r.option;
      const price = typeof r.odds === "number" ? r.odds : num(r.odds);
      if (option && price != null) { upsertOdd.run({ fixture_id: id, market: r.market, option, price }); odds++; }
    }
  });
  tx();
  return { fixtures, odds, rows: rows.length };
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

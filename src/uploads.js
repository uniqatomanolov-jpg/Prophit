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
function normSpreadexList(rows) {
  if (rows.length < 2) return null;
  const head = rows[0].map((c) => String(c).toLowerCase());
  const looks = head.some((c) => c.includes("min-w-0")) || head.some((c) => c.includes("truncate"));
  if (!looks) return null;
  const out = [];
  for (const r of rows.slice(1)) {
    const comp = (r[0] || "").trim(), match = (r[1] || "").trim();
    const o1 = num(r[2]), o2 = num(r[3]);
    if (!match.includes(" v ") || o1 == null || o2 == null) continue;
    if (/outright/i.test(match)) continue;
    const [home, away] = match.split(" v ").map((x) => x.trim());
    const SPORT_HINTS = [
      [/atp|wta|wimbledon|challenger|us open|roland|australian/i, "tennis"],
      [/nba|eurobasket|basket|fiba/i, "nba"],
      [/volley/i, "volleyball"],
      [/darts|pdc/i, "darts"],
      [/snooker/i, "snooker"],
      [/ufc|mma|cage/i, "mma"],
      [/boxing|heavyweight|wbc|wba|ibf/i, "boxing"],
      [/table tennis|tt cup|liga pro/i, "tabletennis"],
      [/esport|cs2|counter.strike|dota|league of legends|valorant/i, "esports"],
      [/nhl|hockey|khl/i, "nhl"],
      [/mlb|baseball/i, "mlb"],
      [/cricket|t20|ipl|odi/i, "cricket"],
      [/handball/i, "handball"],
    ];
    let sport = null;
    for (const [rx, sp] of SPORT_HINTS) { if (rx.test(comp)) { sport = sp; break; } }
    if (!sport) continue;
    const kickoff = whenToKickoff(r[4]);
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
  if(/corner|card|booking/.test(x))return null;          // dropped by soccer whitelist anyway
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
    var base={sport:sport,kickoff:`${today()} 20:00`,competition:comp,home:teams.home,away:teams.away};
    var pairs=[[iN,iP],[iN2,iP2]];
    pairs.forEach(function(pr){
      var label=(r[pr[0]]||"").trim(); var price=num(r[pr[1]]);
      if(!label||price==null)return;
      var opt=label;
      if(market==="x12"){var L=label.toLowerCase();opt=(L===teams.home.toLowerCase())?"home":(L==="draw")?"draw":(L===teams.away.toLowerCase())?"away":label;}
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

export function ingestEvents(csvText) {
  const raw = splitRows(csvText);
  let rows = normWebScraperMarkets(raw) || normWebScraper(raw) || normBG(raw) || normSpreadexList(raw) || normSpreadex(raw) || normBetanoMatch(raw) || normEN(raw);
  // scraped soccer files: keep only the big-turnover markets (rest is noise)
  const KEEP_SOCCER = new Set(["x12", "goals_ou", "ou25", "btts", "cs", "ah"]);
  if (rows) rows = rows.filter((r) => String(r.sport).toLowerCase() !== "soccer" || KEEP_SOCCER.has(r.market));
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

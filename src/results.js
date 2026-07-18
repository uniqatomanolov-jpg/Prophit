// ————————————————————————————————————————————————————————————————
// AUTO-SETTLE — pulls final scores from a results feed and grades every
// pick it can, so the track record stops depending on manual typing.
//
// WHY NOT FLASHSCORE / SOFASCORE:
//   Neither offers a public API. Both prohibit automated collection in their
//   terms, serve JS-rendered pages behind bot protection, and change their
//   internal endpoints without notice — a scraper there is both legally
//   exposed and permanently broken. The feeds below are documented, keyed and
//   free-tier friendly, and they return exactly the same final scores.
//
// Configure ONE (or both) in .env:
//   THE_ODDS_API_KEY=...   → the-odds-api.com  /scores  (soccer, tennis, NBA, NFL, MLB, NHL, MMA)
//   APIFOOTBALL_KEY=...    → api-sports.io     /fixtures (football only, deepest coverage)
//
// Matching is by NAME + DATE, because manual uploads have no provider ids.
// ————————————————————————————————————————————————————————————————
import { db, q, markFinal, gradePick } from "./db.js";
import { correctFromScore } from "./jobs.js";

// —— name normalisation ————————————————————————————————
// "Man Utd" / "Manchester United FC" / "Atlético Madrid" must collide.
const STOP = /\b(fc|cf|sc|ac|afc|cd|ud|club|deportivo|de|futbol|football|calcio|sv|bk|if|fk|county|city\b(?=.*\bcity\b))\b/g;
const ALIAS = {
  "man utd": "manchester united", "man united": "manchester united",
  "man city": "manchester city", "spurs": "tottenham", "tottenham hotspur": "tottenham",
  "wolves": "wolverhampton", "psg": "paris saint germain", "inter": "internazionale",
  "atletico madrid": "atletico de madrid", "bayern": "bayern munich",
  "usa": "united states", "us": "united states", "korea republic": "south korea",
};
export function nrmName(x) {
  let v = String(x == null ? "" : x)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\butd\b/g, "united")
    .replace(/\bhotspur\b/g, "")
    .replace(/\s+/g, " ").trim();
  if (ALIAS[v]) v = ALIAS[v];
  v = v.replace(STOP, " ").replace(/\s+/g, " ").trim();
  return ALIAS[v] || v;
}
// token-overlap similarity so "Nottingham Forest" ↔ "Nott m Forest" still matches
function similar(a, b) {
  const A = nrmName(a).split(" ").filter(Boolean), B = nrmName(b).split(" ").filter(Boolean);
  if (!A.length || !B.length) return 0;
  if (A.join(" ") === B.join(" ")) return 1;
  const shared = A.filter((t) => B.some((u) => u === t || (t.length > 3 && u.startsWith(t.slice(0, 4)))));
  return shared.length / Math.max(A.length, B.length);
}

// —— feed: The Odds API /scores ————————————————————————
const ODDS_SPORT_KEYS = {
  soccer: (process.env.ODDS_SOCCER || "soccer_epl,soccer_spain_la_liga,soccer_italy_serie_a,soccer_germany_bundesliga,soccer_france_ligue_one,soccer_uefa_champs_league,soccer_uefa_european_championship,soccer_fifa_world_cup,soccer_brazil_campeonato,soccer_conmebol_copa_libertadores").split(",").filter(Boolean),
  tennis: (process.env.ODDS_TENNIS || "").split(",").filter(Boolean),
  nba: (process.env.ODDS_BASKETBALL || "basketball_nba").split(",").filter(Boolean),
  nfl: (process.env.ODDS_NFL || "americanfootball_nfl").split(",").filter(Boolean),
  mlb: (process.env.ODDS_MLB || "baseball_mlb").split(",").filter(Boolean),
  nhl: (process.env.ODDS_NHL || "icehockey_nhl").split(",").filter(Boolean),
  mma: (process.env.ODDS_MMA || "mma_mixed_martial_arts").split(",").filter(Boolean),
};
async function oddsApiScores(sport, daysFrom) {
  const key = process.env.THE_ODDS_API_KEY;
  if (!key) return [];
  const out = [];
  for (const sk of ODDS_SPORT_KEYS[sport] || []) {
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sk}/scores`);
    url.searchParams.set("apiKey", key);
    url.searchParams.set("daysFrom", String(Math.min(3, Math.max(1, daysFrom))));
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[results:theoddsapi:${sk}] ${res.status}`); continue; }
      for (const m of await res.json()) {
        if (!m.completed || !m.scores) continue;
        const by = Object.fromEntries(m.scores.map((x) => [x.name, Number(x.score)]));
        const hs = by[m.home_team], as = by[m.away_team];
        if (hs == null || as == null || Number.isNaN(hs) || Number.isNaN(as)) continue;
        out.push({ home: m.home_team, away: m.away_team, hs, as, when: m.commence_time, src: "the-odds-api" });
      }
    } catch (e) { console.warn(`[results:theoddsapi:${sk}] ${e.message}`); }
  }
  return out;
}

// —— feed: API-Football /fixtures (football only) ————————
async function apiFootballScores(daysFrom) {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) return [];
  const out = [];
  for (let d = 0; d <= daysFrom; d++) {
    const day = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
    try {
      const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${day}&status=FT-AET-PEN`,
        { headers: { "x-apisports-key": key } });
      if (!res.ok) { console.warn(`[results:apifootball] ${res.status}`); continue; }
      const json = await res.json();
      for (const r of json.response || []) {
        if (r.goals?.home == null || r.goals?.away == null) continue;
        out.push({ home: r.teams.home.name, away: r.teams.away.name, hs: r.goals.home, as: r.goals.away,
                   when: r.fixture.date, src: "api-football" });
      }
    } catch (e) { console.warn(`[results:apifootball] ${e.message}`); }
  }
  return out;
}

export function resultsFeedStatus() {
  return {
    theOddsApi: !!process.env.THE_ODDS_API_KEY,
    apiFootball: !!process.env.APIFOOTBALL_KEY,
    enabled: !!(process.env.THE_ODDS_API_KEY || process.env.APIFOOTBALL_KEY),
  };
}

// —— the job ————————————————————————————————————————————
// Grades every unsettled fixture that kicked off > GRACE hours ago and whose
// home/away pair can be matched confidently against the feed.
export async function autoSettle({ daysFrom = 3, dryRun = false } = {}) {
  const feeds = resultsFeedStatus();
  if (!feeds.enabled) {
    return { ok: false, reason: "no results feed configured — set THE_ODDS_API_KEY and/or APIFOOTBALL_KEY", settled: 0, graded: 0 };
  }
  const GRACE = Number(process.env.SETTLE_GRACE_HOURS) || 2.5;
  const pending = db.prepare(`
    SELECT * FROM fixtures WHERE status='upcoming' AND kickoff IS NOT NULL
      AND datetime(replace(kickoff,' ','T')) < datetime('now', ?)
    ORDER BY kickoff DESC LIMIT 300`).all(`-${GRACE} hours`);
  if (!pending.length) return { ok: true, settled: 0, graded: 0, checked: 0, note: "nothing pending" };

  const sports = [...new Set(pending.map((f) => f.sport))];
  const feed = [];
  for (const sp of sports) {
    if (sp === "soccer") feed.push(...await apiFootballScores(daysFrom));
    feed.push(...await oddsApiScores(sp, daysFrom));
  }
  if (!feed.length) return { ok: true, settled: 0, graded: 0, checked: pending.length, note: "feed returned no finished games" };

  let settled = 0, graded = 0;
  const unmatched = [];
  for (const f of pending) {
    const koMs = Date.parse(String(f.kickoff).replace(" ", "T"));
    let best = null, bestScore = 0;
    for (const m of feed) {
      // same day (±36h) — protects against settling a rematch with the wrong score
      if (m.when && Math.abs(Date.parse(m.when) - koMs) > 36 * 3600e3) continue;
      const direct = Math.min(similar(f.home, m.home), similar(f.away, m.away));
      const flipped = Math.min(similar(f.home, m.away), similar(f.away, m.home));
      const score = Math.max(direct, flipped);
      if (score > bestScore) { bestScore = score; best = { m, flip: flipped > direct }; }
    }
    if (!best || bestScore < 0.75) { unmatched.push(`${f.home} v ${f.away}`); continue; }
    const hs = best.flip ? best.m.as : best.m.hs;
    const as = best.flip ? best.m.hs : best.m.as;
    if (dryRun) { settled++; continue; }
    markFinal.run({ id: f.id, score: `${hs}-${as}` });
    settled++;
    for (const pk of q.picksFor.all(f.id)) {
      const c = correctFromScore(pk.market, pk.pick, hs, as, f.home, f.away);
      if (c == null) continue;
      gradePick.run({ correct: c, fixture_id: f.id, model: pk.model, market: pk.market });
      graded++;
      const run = q.cmpActiveRun.get();
      if (run) for (const cb of q.cmpPendingForFixture.all({ fid: f.id })) {
        if (cb.market === pk.market) {
          const { settleCompoundingBet } = await import("./compounding.js");
          settleCompoundingBet(cb.id, c ? "win" : "loss", run);
        }
      }
    }
    console.log(`[auto-settle] ${f.home} ${hs}-${as} ${f.away} (${best.m.src})`);
  }
  return { ok: true, checked: pending.length, feedRows: feed.length, settled, graded,
           unmatched: unmatched.slice(0, 20), unmatchedCount: unmatched.length, dryRun };
}

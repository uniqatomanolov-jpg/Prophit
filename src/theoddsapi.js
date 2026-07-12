// ————————————————————————————————————————————————————————
// The Odds API (the-odds-api.com) — REAL bookmaker odds + fixtures + results.
// Legal, licensed feed. One free key (no card) at the-odds-api.com.
// Docs: https://the-odds-api.com/liveapi/guides/v4/
//
// Cost note: each /odds request consumes quota = (regions) × (markets). Keep the
// sport-key list and markets tight on the free tier. Fixtures + odds arrive in the
// SAME response, so fetchOdds parses the cached raw instead of making a 2nd call.
// ————————————————————————————————————————————————————————
const BASE = "https://api.the-odds-api.com/v4";
const KEY = () => process.env.THE_ODDS_API_KEY;
const REGIONS = process.env.ODDS_REGIONS || "eu,uk";
const ODDS_FORMAT = "decimal";

// which The Odds API sport keys feed each of our sport buckets (env-overridable).
// More keys = more games (but more quota). Trim on the free tier.
const SPORT_KEYS = {
  soccer: (process.env.ODDS_SOCCER || "soccer_epl,soccer_uefa_champs_league,soccer_spain_la_liga,soccer_italy_serie_a,soccer_germany_bundesliga").split(",").filter(Boolean),
  tennis: (process.env.ODDS_TENNIS || "tennis_atp_wimbledon,tennis_wta_wimbledon,tennis_atp_canadian_open,tennis_wta_canadian_open").split(",").filter(Boolean),
  nba: (process.env.ODDS_BASKETBALL || "basketball_nba").split(",").filter(Boolean),
  nfl: (process.env.ODDS_NFL || "americanfootball_nfl").split(",").filter(Boolean),
  mlb: (process.env.ODDS_MLB || "baseball_mlb").split(",").filter(Boolean),
  nhl: (process.env.ODDS_NHL || "icehockey_nhl").split(",").filter(Boolean),
  mma: (process.env.ODDS_MMA || "mma_mixed_martial_arts").split(",").filter(Boolean),
  cricket: (process.env.ODDS_CRICKET || "cricket_t20,cricket_odi").split(",").filter(Boolean),
};

// markets we request per sport — ONLY what we grade, to save quota.
const MARKETS = { soccer: "h2h,totals", tennis: "h2h", nba: "h2h", nfl: "h2h", mlb: "h2h", nhl: "h2h", mma: "h2h", cricket: "h2h" };

async function api(path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set("apiKey", KEY());
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TheOddsAPI ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// —— fixtures + odds (one call) ——
export async function fetchFixtures(cfg) {
  const sport = cfg.sport;
  const keys = SPORT_KEYS[sport] || [];
  const markets = MARKETS[sport] || "h2h";
  const out = [];
  for (const sk of keys) {
    let events;
    try { events = await api(`/sports/${sk}/odds`, { regions: REGIONS, markets, oddsFormat: ODDS_FORMAT }); }
    catch (e) { console.warn(`[theoddsapi:${sport}] ${sk} odds failed: ${e.message}`); continue; }
    for (const ev of events) {
      const started = new Date(ev.commence_time) <= new Date();
      out.push({
        id: ev.id,
        sport,
        comp: ev.sport_title,
        home: ev.home_team,
        away: ev.away_team,
        kickoff: ev.commence_time,
        status: started ? "live" : "upcoming",
        score: null,
        raw: JSON.stringify(ev), // bookmakers cached here for fetchOdds
        sportKey: sk,
      });
    }
  }
  return out;
}

// —— odds (parse from cached raw; no extra request) ——
// prefer Pinnacle, else the first bookmaker with data
function chooseBook(ev) {
  const books = ev.bookmakers || [];
  return books.find((b) => b.key === "pinnacle") || books[0] || null;
}

export async function fetchOdds(fixture) {
  const ev = typeof fixture.raw === "string" ? JSON.parse(fixture.raw) : fixture.raw;
  const sport = fixture.sport;
  const book = chooseBook(ev);
  if (!book) return [];
  const out = [];
  const home = ev.home_team, away = ev.away_team;

  for (const m of book.markets || []) {
    if (m.key === "h2h") {
      // soccer → x12 (home/draw/away); others → ml (home/away)
      for (const o of m.outcomes) {
        if (sport === "soccer") {
          const opt = o.name === home ? "home" : o.name === away ? "away" : "draw";
          out.push({ market: "x12", option: opt, price: o.price });
        } else {
          out.push({ market: "ml", option: o.name, price: o.price });
        }
      }
    } else if (m.key === "totals") {
      // soccer O/U 2.5 → ou25 ; tennis game totals → totalGames ; basket → total
      const marketId = sport === "soccer" ? "ou25" : sport === "tennis" ? "totalGames" : "total";
      for (const o of m.outcomes) {
        if (sport === "soccer" && String(o.point) !== "2.5") continue; // canonical line only
        out.push({ market: marketId, option: `${o.name} ${o.point}`, price: o.price, line: o.point });
      }
    } else if (m.key === "spreads") {
      for (const o of m.outcomes) {
        out.push({ market: "spread", option: `${o.name} ${o.point}`, price: o.price, line: o.point });
      }
    }
  }
  return out;
}

// —— results (for grading) ——
export async function fetchResult(fixture) {
  const ev = typeof fixture.raw === "string" ? JSON.parse(fixture.raw) : fixture.raw;
  const sk = fixture.sportKey || ev.sport_key;
  let scores;
  try { scores = await api(`/sports/${sk}/scores`, { daysFrom: 3 }); }
  catch (e) { console.warn(`[theoddsapi] scores failed: ${e.message}`); return null; }

  const match = scores.find((s) => s.id === fixture.id);
  if (!match || !match.completed || !match.scores) return null;

  const byName = Object.fromEntries(match.scores.map((s) => [s.name, Number(s.score)]));
  const h = byName[match.home_team], a = byName[match.away_team];
  if (h == null || a == null) return null;
  const winner = h > a ? "home" : a > h ? "away" : "draw";

  // shape fields so settle.js grades the right markets per sport
  const base = { home: match.home_team, away: match.away_team, winner, winnerName: h > a ? match.home_team : match.away_team, rawScore: `${h} – ${a}` };
  if (fixture.sport === "soccer") return { ...base, goalsHome: h, goalsAway: a };
  if (fixture.sport === "nba" || fixture.sport === "nfl") return { ...base, ptsHome: h, ptsAway: a };
  if (fixture.sport === "tennis") return { ...base, setsHome: h, setsAway: a };
  return base;
}

export const theoddsapi = { fetchFixtures, fetchOdds, fetchResult };

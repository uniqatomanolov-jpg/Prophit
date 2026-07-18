// API-Football (api-sports.io) client.
// Free tier covers every endpoint used here (100 req/day cap — budget accordingly).
const BASE = "https://v3.football.api-sports.io";

async function api(path, params = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { "x-apisports-key": process.env.APIFOOTBALL_KEY } });
  if (!res.ok) throw new Error(`API-Football ${path} → ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) throw new Error(JSON.stringify(json.errors));
  return json.response;
}

// —— fixtures ————————————————————————————————
async function fetchFixtures(cfg) {
  const rows = await api("/fixtures", { league: cfg.leagueId, season: cfg.season });
  return rows.map((r) => ({
    id: r.fixture.id,
    sport: "soccer",
    comp: `${r.league.name} — ${r.league.round}`,
    home: r.teams.home.name,
    away: r.teams.away.name,
    kickoff: r.fixture.date,
    status: ["FT", "AET", "PEN"].includes(r.fixture.status.short) ? "final"
      : ["NS", "TBD", "PST"].includes(r.fixture.status.short) ? "upcoming" : "live",
    score: r.goals.home != null ? `${r.goals.home} – ${r.goals.away}` : null,
    raw: JSON.stringify(r),
  }));
}

// —— odds ————————————————————————————————————
// API-Football bet-type ids → our market ids. Verify ids via GET /odds/bets once;
// they are stable but worth confirming against your plan.
const BET_MAP = {
  "Match Winner": "x12",
  "Double Chance": "dc",
  "Asian Handicap": "ah",
  "Goals Over/Under": "ou25",        // keep only the 2.5 line below
  "Both Teams Score": "btts",
  "Cards Over/Under": "cards45",     // keep 4.5 line
  "Corners Over Under": "corners95", // keep 9.5 line
  "Exact Score": "cs",
  "First Goal Scorer": "fgs",        // availability varies by bookmaker/plan
};

async function fetchOdds(fixture) {
  const rows = await api("/odds", { fixture: fixture.id });
  const out = []; // { market, option, price }
  for (const row of rows) {
    for (const bm of row.bookmakers ?? []) {
      for (const bet of bm.bets ?? []) {
        const market = BET_MAP[bet.name];
        if (!market) continue;
        for (const v of bet.values ?? []) {
          const label = String(v.value);
          // line filters so O/U markets stay on one canonical line
          if (market === "ou25" && !label.includes("2.5")) continue;
          if (market === "cards45" && !label.includes("4.5")) continue;
          if (market === "corners95" && !label.includes("9.5")) continue;
          out.push({ market, option: label, price: parseFloat(v.odd) });
        }
      }
      break; // first bookmaker with data is enough for v1
    }
  }
  return out;
}

// —— result + stats for grading ————————————————
async function fetchResult(fixture) {
  const fixtureId = fixture.id;
  const [fx] = await api("/fixtures", { id: fixtureId });
  if (!fx || !["FT", "AET", "PEN"].includes(fx.fixture.status.short)) return null;

  const gh = fx.goals.home, ga = fx.goals.away;

  // statistics → corners & cards
  const stats = await api("/fixtures/statistics", { fixture: fixtureId });
  const stat = (team, name) =>
    stats.find((s) => s.team.id === team)?.statistics.find((x) => x.type === name)?.value ?? 0;
  const corners = stat(fx.teams.home.id, "Corner Kicks") + stat(fx.teams.away.id, "Corner Kicks");
  const cards =
    stat(fx.teams.home.id, "Yellow Cards") + stat(fx.teams.away.id, "Yellow Cards") +
    stat(fx.teams.home.id, "Red Cards") + stat(fx.teams.away.id, "Red Cards");

  // events → first goalscorer
  const events = await api("/fixtures/events", { fixture: fixtureId });
  const firstGoal = events.find((e) => e.type === "Goal" && e.detail !== "Missed Penalty");

  return {
    home: fx.teams.home.name, away: fx.teams.away.name,
    goalsHome: gh, goalsAway: ga,
    winner: gh > ga ? "home" : ga > gh ? "away" : "draw", // 90-min result basis for 1X2
    corners, cards,
    firstScorer: firstGoal?.player?.name ?? null,
    events, // kept for player-prop grading extensions
  };
}

// named adapter interface consumed by providers/index.js
export const apifootball = { fetchFixtures, fetchOdds, fetchResult };

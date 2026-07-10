// ————————————————————————————————————————————————————————
// Provider adapter interface.
// Every sport's data feed implements the same three functions so jobs.js
// can treat all 11 sports identically. Swap the body for your chosen feed
// (Goalserve / SportsDataIO / Sportradar / a motorsport feed for race sports).
//
//   fetchFixtures(cfg)      → [{ id, sport, comp, home, away, entrants?, kickoff, status, score, raw }]
//   fetchOdds(fixture)      → [{ market, option, price }]
//   fetchResult(fixture)    → h2h:  { winner, ...statsForMarkets }
//                             race: { order: [name, ...] }  (finishing order, index 0 = winner)
//
// h2h fixtures set home/away; race fixtures set entrants (grid/field) and leave home/away null.
// ————————————————————————————————————————————————————————

import { apifootball } from "./apifootball.js";
import { theoddsapi } from "./theoddsapi.js";

// ---- generic HEAD-TO-HEAD stub (tennis, nba, nhl, nfl, volleyball, darts, snooker, euroleague) ----
// Point BASE at your feed and map its payloads into the shapes above.
const genericH2H = {
  async fetchFixtures(cfg) {
    // TODO: GET {FEED}/fixtures?sport={cfg.feedSport}&date=...
    // Map each row to { id, sport: cfg.sport, comp, home, away, kickoff, status, score, raw }
    console.warn(`[genericH2H:${cfg.sport}] fetchFixtures not wired — returning []`);
    return [];
  },
  async fetchOdds(fixture) {
    // TODO: GET {FEED}/odds?fixture={fixture.id}
    // Map bookmaker markets → our market ids (see MARKET_DEFS). Keep one canonical line per O/U.
    return [];
  },
  async fetchResult(fixture) {
    // TODO: GET {FEED}/result?fixture={fixture.id}
    // Return { winner: '<name>', totalPoints, sets, tiebreak, ... } — only the fields your markets need.
    return null;
  },
};

// ---- generic RACE stub (F1, MotoGP) ----
const genericRace = {
  async fetchFixtures(cfg) {
    // TODO: GET {RACING_FEED}/events?series={cfg.feedSeries}
    // Map each event to { id, sport: cfg.sport, comp, entrants: [names...], kickoff, status, raw }
    console.warn(`[genericRace:${cfg.sport}] fetchFixtures not wired — returning []`);
    return [];
  },
  async fetchOdds(fixture) {
    // Outright markets: winner/podium/top6/top10 priced per entrant.
    // Return [{ market:'winner', option:'Verstappen', price:2.1 }, ...]
    return [];
  },
  async fetchResult(fixture) {
    // TODO: GET {RACING_FEED}/classification?event={fixture.id}
    // Return { order: ['Norris','Verstappen', ...] } — full finishing order.
    return null;
  },
};

// registry: sports.js `provider` field → adapter
export const ADAPTERS = {
  theoddsapi,    // real odds + fixtures + results (soccer, tennis, nba, ...)
  apifootball,   // soccer (fixtures/lineups/cards/corners) — pair with theoddsapi for player data
  genericH2H,
  genericRace,
};

export function adapterFor(providerName) {
  const a = ADAPTERS[providerName];
  if (!a) throw new Error(`No adapter registered for "${providerName}"`);
  return a;
}

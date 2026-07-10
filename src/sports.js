// Central sport registry. Each sport declares its family and the markets AI models must pick.
// family "h2h"  → two competitors; markets settle from a match result + stats
// family "race" → many entrants; markets settle from a finishing order (winner/podium/topN)
//
// `provider` names which adapter in src/providers/ fetches fixtures/odds/results for this sport.
// Start with soccer (fully implemented). Others share the same interface — wire an adapter per feed.

// Only sports/markets with REAL, gradeable data from The Odds API are kept.
// Every market here settles cleanly from the final score:
//   soccer  → 1X2 (winner) + Over/Under 2.5 goals
//   tennis  → match winner
//   nba/nfl → match winner (moneyline)
// (Player props, cards, corners, spreads/other totals need extra feeds — removed
//  until wired, so nothing shows a market it can't grade.)
export const SPORTS = {
  soccer: { family: "h2h", provider: "theoddsapi", label: "Football", markets: ["x12", "ou25"] },
  tennis: { family: "h2h", provider: "theoddsapi", label: "Tennis",   markets: ["ml"] },
  nba:    { family: "h2h", provider: "theoddsapi", label: "NBA",      markets: ["ml"] },
  nfl:    { family: "h2h", provider: "theoddsapi", label: "NFL",      markets: ["ml"] },
};

// Human-readable market metadata used to build the AI prompt per sport.
export const MARKET_DEFS = {
  // soccer
  x12: "match result 1X2 (home/draw/away, 90-min basis)",
  dc: "double chance (1X/12/X2)",
  ah: "asian handicap — state the line you take",
  ou25: "total goals over/under 2.5",
  btts: "both teams to score (yes/no)",
  cards45: "total cards over/under 4.5",
  corners95: "total corners over/under 9.5",
  cs: "correct score (e.g. 2-1)",
  fgs: "first goalscorer (player name)",
  // generic h2h
  ml: "match winner (no draw)",
  spread: "points spread — state the line",
  total: "total points over/under — state the line",
  puckline: "puck line ±1.5",
  total55: "total goals over/under 5.5",
  setHcp: "set handicap ±1.5",
  totalGames: "total games over/under — state the line",
  totalPoints: "total points over/under — state the line",
  correctSets: "correct set score (e.g. 3-1 / 2-0)",
  anyTiebreak: "any set decided by tiebreak (yes/no)",
  total180s: "total 180s over/under — state the line",
  most180s: "player with most 180s",
  frameHcp: "frame handicap — state the line",
  totalFrames: "total frames over/under — state the line",
  century: "a 100+ break in the match (yes/no)",
  anytimeTD: "anytime touchdown scorer (player name)",
  props: "best-value player prop you rate (state it precisely)",
  // race
  winner: "race winner (driver/rider name)",
  podium: "one driver/rider you back for a top-3 finish",
  top6: "one driver/rider you back for a top-6 finish",
  top10: "one driver/rider you back for a top-10 finish",
  pole: "pole position (driver name)",
  fastestLap: "fastest lap (driver name)",
};

export const marketList = (sportKey) => SPORTS[sportKey].markets;
export const isRace = (sportKey) => SPORTS[sportKey].family === "race";

// Turns a raw provider result into { marketId: outcome } maps, per family.
// outcome may be a string, or an array (any-of, e.g. double chance / podium).
// jobs.js compares each model's pick against these to grade.

export function settleH2H(sport, r) {
  // r fields depend on sport; only compute markets that sport declares.
  const o = {};
  if (r.winner != null) { o.x12 = r.winner; o.ml = r.winnerName ?? r.winner; }

  // soccer
  if (r.goalsHome != null) {
    const total = r.goalsHome + r.goalsAway;
    o.x12 = r.winner;
    o.dc = r.winner === "home" ? ["1X", "12"] : r.winner === "away" ? ["12", "X2"] : ["1X", "X2"];
    o.ou25 = total > 2.5 ? "over" : "under";
    o.btts = r.goalsHome > 0 && r.goalsAway > 0 ? "yes" : "no";
    if (r.cards != null) o.cards45 = r.cards > 4.5 ? "over" : "under";
    if (r.corners != null) o.corners95 = r.corners > 9.5 ? "over" : "under";
    o.cs = `${r.goalsHome}-${r.goalsAway}`;
    if (r.firstScorer) o.fgs = r.firstScorer;
  }

  // points-based sports (nba, euroleague, nfl): expect r.ptsHome/ptsAway + r.line snapshots optional
  if (r.ptsHome != null) {
    const total = r.ptsHome + r.ptsAway;
    o.ml = r.ptsHome > r.ptsAway ? r.home : r.away;
    if (r.totalLine != null) o.total = total > r.totalLine ? "over" : "under";
    if (r.spreadLine != null) o.spread = (r.ptsHome + r.spreadLine) > r.ptsAway ? "home" : "away";
  }

  // tennis / volleyball (sets)
  if (r.setsHome != null) {
    o.ml = r.setsHome > r.setsAway ? r.home : r.away;
    o.correctSets = `${r.setsHome}-${r.setsAway}`;
    if (r.anyTiebreak != null) o.anyTiebreak = r.anyTiebreak ? "yes" : "no";
    if (r.totalGames != null && r.gamesLine != null) o.totalGames = r.totalGames > r.gamesLine ? "over" : "under";
    if (r.totalPoints != null && r.pointsLine != null) o.totalPoints = r.totalPoints > r.pointsLine ? "over" : "under";
  }

  return o;
}

export function settleRace(order) {
  // order = finishing order, index 0 = winner
  return {
    winner: order[0],
    podium: order.slice(0, 3),
    top6: order.slice(0, 6),
    top10: order.slice(0, 10),
  };
}

// Compare one pick to an outcome. Handles any-of arrays, substring match for player names.
export function isPickCorrect(marketId, pick, outcome) {
  if (outcome == null) return null;
  const p = String(pick).toLowerCase();
  if (Array.isArray(outcome)) return outcome.some((x) => String(x).toLowerCase() === p) ? 1 : 0;
  const o = String(outcome).toLowerCase();
  // player-name markets: allow partial (surname) matches
  if (["fgs", "anytimeTD", "most180s", "winner", "pole", "fastestLap"].includes(marketId)) {
    return o.includes(p) || p.includes(o) ? 1 : 0;
  }
  return o === p ? 1 : 0;
}

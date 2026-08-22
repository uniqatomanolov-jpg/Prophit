import test from "node:test";
import assert from "node:assert/strict";

import {
  payoutFor,
  settlementPatch,
  standingFor,
  standings,
  challengeProgress,
  sharpeRatio,
  maxDrawdown,
  marketConsensus,
  validatePick,
  expectedValue,
  round2,
  dayKey,
  STARTING_BANKROLL,
  DAILY_LIMIT,
} from "../src/lib/engine.js";

import {
  SPORTS,
  outcomesFor,
  composeEventName,
  marketsFor,
  usesRoster,
  getMarket,
} from "../src/lib/sports.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let seq = 0;
function bet(overrides = {}) {
  seq += 1;
  const base = {
    id: `bet-${seq}`,
    event_id: "evt-1",
    model: "Claude",
    market: "1X2",
    pick: "Arsenal",
    odds: 2.0,
    stake: 50,
    reasoning: "A thesis long enough to satisfy validation.",
    result: null,
    payout: null,
    profit: null,
    round: 1,
    logged_at: "2026-08-20T10:00:00.000Z",
    settled_at: null,
  };
  const merged = { ...base, ...overrides };
  // Keep payout/profit consistent with the result unless explicitly given.
  if (merged.result && overrides.profit === undefined) {
    const p = payoutFor(merged, merged.result);
    merged.payout = p.payout;
    merged.profit = p.profit;
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Settlement maths                                                    */
/* ------------------------------------------------------------------ */

test("WIN pays stake x odds and profits stake x (odds - 1)", () => {
  const b = bet({ stake: 50, odds: 2.5 });
  const r = payoutFor(b, "win");
  assert.equal(r.payout, 125);
  assert.equal(r.profit, 75);
});

test("LOSS pays nothing and costs the whole stake", () => {
  const r = payoutFor(bet({ stake: 40, odds: 3.1 }), "loss");
  assert.equal(r.payout, 0);
  assert.equal(r.profit, -40);
});

test("VOID refunds the stake for exactly zero profit", () => {
  const r = payoutFor(bet({ stake: 37.5, odds: 1.9 }), "void");
  assert.equal(r.payout, 37.5);
  assert.equal(r.profit, 0);
});

test("an ungraded bet reports no payout, not a zero one", () => {
  const r = payoutFor(bet(), null);
  assert.equal(r.payout, null);
  assert.equal(r.settled, false);
});

test("payouts round to cents rather than carrying float noise", () => {
  // 33.33 * 2.07 = 68.9931 in exact decimal.
  const r = payoutFor(bet({ stake: 33.33, odds: 2.07 }), "win");
  assert.equal(r.payout, 68.99);
  assert.equal(r.profit, round2(68.99 - 33.33));
});

/* ------------------------------------------------------------------ */
/* Grading is correctable -- the property that matters most             */
/* ------------------------------------------------------------------ */

test("re-grading lands on the same bankroll as grading right first time", () => {
  const b = bet({ stake: 60, odds: 1.75 });

  // The wrong way round, twice, then back.
  let current = { ...b, ...settlementPatch(b, "win") };
  current = { ...current, ...settlementPatch(current, "loss") };
  current = { ...current, ...settlementPatch(current, "void") };
  current = { ...current, ...settlementPatch(current, "win") };

  const straight = { ...b, ...settlementPatch(b, "win") };

  assert.equal(current.profit, straight.profit);
  assert.equal(current.payout, straight.payout);
  assert.equal(
    standingFor("Claude", [current]).bankroll,
    standingFor("Claude", [straight]).bankroll
  );
});

test("un-grading returns a bet to pending and restores the bankroll", () => {
  const b = bet({ stake: 100, odds: 3 });
  const won = { ...b, ...settlementPatch(b, "win") };
  assert.equal(standingFor("Claude", [won]).bankroll, STARTING_BANKROLL + 200);

  const cleared = { ...won, ...settlementPatch(won, null) };
  assert.equal(cleared.result, null);
  assert.equal(cleared.payout, null);
  assert.equal(standingFor("Claude", [cleared]).bankroll, STARTING_BANKROLL);
});

/* ------------------------------------------------------------------ */
/* Standings                                                           */
/* ------------------------------------------------------------------ */

test("bankroll is starting capital plus settled profit only", () => {
  const s = standingFor("Claude", [
    bet({ stake: 50, odds: 2.0, result: "win" }), // +50
    bet({ stake: 30, odds: 4.0, result: "loss" }), // -30
    bet({ stake: 20, odds: 1.8, result: "void" }), // 0
    bet({ stake: 40, odds: 2.2 }), // pending: excluded
  ]);
  assert.equal(s.bankroll, STARTING_BANKROLL + 20);
  assert.equal(s.profit, 20);
  assert.equal(s.turnover, 100); // pending stake is not turnover
  assert.equal(s.pendingStake, 40);
});

test("pending stake is reserved out of available funds but not the bankroll", () => {
  const s = standingFor("Claude", [bet({ stake: 75, odds: 2 })]);
  assert.equal(s.bankroll, STARTING_BANKROLL);
  assert.equal(s.available, STARTING_BANKROLL - 75);
});

test("void bets are excluded from win rate", () => {
  const s = standingFor("Claude", [
    bet({ result: "win" }),
    bet({ result: "loss" }),
    bet({ result: "void" }),
    bet({ result: "void" }),
  ]);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.voids, 2);
});

test("ROI is undefined before the first settled bet, not zero", () => {
  const s = standingFor("Claude", [bet()]);
  assert.equal(s.roi, null);
  assert.equal(s.winRate, null);
});

test("a wiped-out fighter is liquidated and stamped with the round", () => {
  const s = standingFor("Claude", [
    bet({ stake: 100, odds: 2, result: "loss", round: 3, logged_at: "2026-08-01T10:00:00Z" }),
    bet({ stake: 900, odds: 2, result: "loss", round: 4, logged_at: "2026-08-02T10:00:00Z" }),
  ]);
  assert.equal(s.bankroll, 0);
  assert.equal(s.liquidated, true);
  assert.equal(s.liquidatedRound, 4);
  assert.equal(s.dailyRemaining, 0, "a liquidated fighter has no budget left");
});

test("the daily budget counts only today's stakes, in the arena timezone", () => {
  const today = dayKey(new Date());
  const s = standingFor(
    "Claude",
    [
      bet({ stake: 30, logged_at: new Date().toISOString() }),
      bet({ stake: 25, logged_at: "2020-01-01T10:00:00.000Z" }),
    ],
    { today }
  );
  assert.equal(s.stakedToday, 30);
  assert.equal(s.dailyRemaining, DAILY_LIMIT - 30);
});

test("standings rank the living above the liquidated", () => {
  const bets = [
    bet({ model: "Claude", stake: 1000, odds: 2, result: "loss" }), // liquidated
    bet({ model: "Grok", stake: 10, odds: 2, result: "win" }), // +10
  ];
  const rows = standings(bets);
  assert.equal(rows[0].model, "Grok");
  assert.equal(rows.at(-1).model, "Claude");
  assert.equal(rows.at(-1).liquidated, true);
  assert.equal(rows[0].rank, 1);
});

test("challenge progress totals every fighter against the target", () => {
  const c = challengeProgress([bet({ model: "Grok", stake: 100, odds: 2, result: "win" })]);
  assert.equal(c.total, STARTING_BANKROLL * 5 + 100);
  assert.equal(c.startedFrom, 5000);
  assert.equal(c.alive, 5);
});

/* ------------------------------------------------------------------ */
/* Risk metrics                                                        */
/* ------------------------------------------------------------------ */

test("Sharpe is withheld below five settled bets", () => {
  const few = [1, 2, 3, 4].map(() => bet({ result: "win" }));
  assert.equal(sharpeRatio(few), null);
});

test("Sharpe is null when every return is identical (no dispersion)", () => {
  const same = [1, 2, 3, 4, 5].map(() => bet({ stake: 10, odds: 2, result: "win" }));
  assert.equal(sharpeRatio(same), null);
});

test("Sharpe is positive for a profitable mixed record", () => {
  const mixed = [
    bet({ stake: 10, odds: 3, result: "win" }),
    bet({ stake: 10, odds: 3, result: "win" }),
    bet({ stake: 10, odds: 3, result: "win" }),
    bet({ stake: 10, odds: 3, result: "loss" }),
    bet({ stake: 10, odds: 3, result: "loss" }),
  ];
  const s = sharpeRatio(mixed);
  assert.ok(s > 0, `expected a positive Sharpe, got ${s}`);
});

test("max drawdown measures from the running peak, not the start", () => {
  // Up to 3000, back to 1500. That is a 50% drawdown even though the
  // fighter is still ahead of the 1000 they began with.
  assert.equal(maxDrawdown([1000, 2000, 3000, 1500]), 0.5);
  assert.equal(maxDrawdown([1000, 1100, 1200]), 0);
});

/* ------------------------------------------------------------------ */
/* Consensus                                                           */
/* ------------------------------------------------------------------ */

test("unanimous agreement reports full consensus and no clash", () => {
  const c = marketConsensus([
    bet({ model: "Claude", pick: "Arsenal" }),
    bet({ model: "Grok", pick: "Arsenal" }),
    bet({ model: "Kimi", pick: "Arsenal" }),
  ]);
  assert.equal(c.consensus, 1);
  assert.equal(c.clash, false);
  assert.equal(c.leader, "Arsenal");
});

test("a split reports a clash and ranks the tally", () => {
  const c = marketConsensus([
    bet({ model: "Claude", pick: "Arsenal" }),
    bet({ model: "Grok", pick: "Arsenal" }),
    bet({ model: "Kimi", pick: "Chelsea" }),
  ]);
  assert.equal(c.clash, true);
  assert.equal(c.leader, "Arsenal");
  assert.equal(c.tally[0].count, 2);
  assert.deepEqual(c.tally[1].models, ["Kimi"]);
});

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const validDraft = {
  model: "Claude",
  event_id: "evt-1",
  market: "1X2",
  pick: "Arsenal",
  odds: "2.10",
  stake: "40",
  fair_prob: "0.55",
  reasoning: "Arsenal press high and Chelsea concede from turnovers in their own half.",
};

test("a well-formed pick passes", () => {
  const standing = standingFor("Claude", []);
  assert.deepEqual(validatePick(validDraft, { standing, existingBets: [] }), []);
});

test("a stake above the daily limit is refused", () => {
  const standing = standingFor("Claude", []);
  const problems = validatePick({ ...validDraft, stake: "150" }, { standing });
  assert.ok(problems.some((p) => p.includes("daily limit")));
});

test("a stake beyond what is left today is refused", () => {
  const standing = standingFor("Claude", [
    bet({ stake: 80, logged_at: new Date().toISOString() }),
  ]);
  const problems = validatePick({ ...validDraft, stake: "50" }, { standing });
  assert.ok(problems.some((p) => p.includes("left in")));
});

test("a liquidated fighter cannot bet", () => {
  const standing = standingFor("Claude", [bet({ stake: 1000, odds: 2, result: "loss" })]);
  const problems = validatePick(validDraft, { standing });
  assert.ok(problems.some((p) => p.includes("liquidated")));
});

test("an empty thesis is refused -- it is what the public drawer shows", () => {
  const standing = standingFor("Claude", []);
  const problems = validatePick({ ...validDraft, reasoning: "gut" }, { standing });
  assert.ok(problems.some((p) => p.includes("rationale drawer")));
});

test("the same fighter cannot log the same selection twice", () => {
  const standing = standingFor("Claude", []);
  const existing = [bet({ model: "Claude", event_id: "evt-1", market: "1X2", pick: "Arsenal" })];
  const problems = validatePick(validDraft, { standing, existingBets: existing });
  assert.ok(problems.some((p) => p.includes("already has this exact bet")));
});

test("odds of 1.00 or below are refused", () => {
  const standing = standingFor("Claude", []);
  assert.ok(validatePick({ ...validDraft, odds: "1" }, { standing }).length > 0);
  assert.ok(validatePick({ ...validDraft, odds: "0.5" }, { standing }).length > 0);
});

test("probability is accepted as either a fraction or a percentage", () => {
  const standing = standingFor("Claude", []);
  assert.deepEqual(validatePick({ ...validDraft, fair_prob: "55" }, { standing }), []);
  assert.deepEqual(validatePick({ ...validDraft, fair_prob: "0.55" }, { standing }), []);
});

test("expected value is positive only when the price beats the model's probability", () => {
  // 55% at 2.10 is +EV; 40% at 2.10 is not.
  assert.ok(expectedValue(2.1, 0.55) > 0);
  assert.ok(expectedValue(2.1, 0.4) < 0);
  assert.equal(expectedValue(2.1, 55), expectedValue(2.1, 0.55), "percentages are accepted");
  assert.equal(expectedValue(1, 0.5), null, "odds of 1.00 have no EV");
});

/* ------------------------------------------------------------------ */
/* The sport registry                                                  */
/* ------------------------------------------------------------------ */

test("all seven sports are registered", () => {
  assert.deepEqual(
    SPORTS.map((s) => s.key),
    ["soccer", "nba", "nfl", "nhl", "darts", "snooker", "f1"]
  );
});

test("every sport has at least one priceable market", () => {
  for (const sport of SPORTS) {
    assert.ok(marketsFor(sport.key).length > 0, `${sport.key} has no markets`);
  }
});

test("every market resolves outcomes without throwing", () => {
  const ctx = { home: "Arsenal", away: "Chelsea", entrants: ["Alpha", "Bravo", "Charlie"] };
  for (const sport of SPORTS) {
    for (const market of marketsFor(sport.key)) {
      const outcomes = outcomesFor(sport.key, market.key, {
        ...ctx,
        line: market.defaultLine,
      });
      assert.ok(
        Array.isArray(outcomes) && outcomes.length > 0,
        `${sport.key}/${market.key} produced no outcomes`
      );
      for (const o of outcomes) {
        assert.equal(typeof o, "string");
        assert.ok(o.trim().length > 0);
        assert.ok(!o.includes("{"), `${sport.key}/${market.key} leaked a placeholder: ${o}`);
      }
    }
  }
});

test("soccer 1X2 is three-way with a real draw", () => {
  assert.deepEqual(outcomesFor("soccer", "1X2", { home: "Arsenal", away: "Chelsea" }), [
    "Arsenal",
    "Draw",
    "Chelsea",
  ]);
});

test("NBA moneyline is two-way -- overtime removes the draw", () => {
  const o = outcomesFor("nba", "ml", { home: "Celtics", away: "Heat" });
  assert.deepEqual(o, ["Celtics", "Heat"]);
});

test("a spread mirrors the line onto the away side", () => {
  const o = outcomesFor("nfl", "spread", { home: "Chiefs", away: "Bills", line: -3.5 });
  assert.deepEqual(o, ["Chiefs -3.5", "Bills +3.5"]);
});

test("a positive home spread keeps its plus sign on both sides", () => {
  const o = outcomesFor("nba", "spread", { home: "Heat", away: "Celtics", line: 6.5 });
  assert.deepEqual(o, ["Heat +6.5", "Celtics -6.5"]);
});

test("totals read as Over/Under with the noun attached", () => {
  assert.deepEqual(outcomesFor("soccer", "goals_ou", { line: 2.5 }), [
    "Over 2.5 Goals",
    "Under 2.5 Goals",
  ]);
  assert.deepEqual(outcomesFor("nhl", "totals", { line: 5.5 }), [
    "Over 5.5 Goals",
    "Under 5.5 Goals",
  ]);
});

test("roster markets read from the operator's entrant list", () => {
  const drivers = ["Max Verstappen", "Lando Norris"];
  assert.deepEqual(outcomesFor("f1", "winner", { entrants: drivers }), drivers);
  assert.deepEqual(outcomesFor("f1", "podium", { entrants: drivers }), drivers);
});

test("an empty roster yields no outcomes rather than fake ones", () => {
  assert.deepEqual(outcomesFor("f1", "winner", { entrants: [] }), []);
});

test("F1 events compose without an away side, and the session disambiguates", () => {
  assert.equal(composeEventName("f1", { home: "Monaco Grand Prix" }), "Monaco Grand Prix");
  assert.equal(
    composeEventName("f1", { home: "Monaco Grand Prix", session: "Qualifying" }),
    "Monaco Grand Prix - Qualifying"
  );
  // Two sessions at one Grand Prix are distinct events, not a duplicate.
  assert.notEqual(
    composeEventName("f1", { home: "Monaco Grand Prix", session: "Race" }),
    composeEventName("f1", { home: "Monaco Grand Prix", session: "Qualifying" })
  );
});

test("fixture sports compose as home v away", () => {
  for (const key of ["soccer", "nba", "nfl", "nhl", "darts", "snooker"]) {
    assert.equal(composeEventName(key, { home: "A", away: "B" }), "A v B");
  }
});

test("only sports with roster markets ask for an entrant list", () => {
  assert.equal(usesRoster("f1"), true);
  assert.equal(usesRoster("soccer"), true, "correct score is a roster market");
  assert.equal(usesRoster("nba"), false);
  assert.equal(usesRoster("nfl"), false);
  assert.equal(usesRoster("nhl"), false);
});

test("market keys are unique within a sport", () => {
  for (const sport of SPORTS) {
    const keys = marketsFor(sport.key).map((m) => m.key);
    assert.equal(new Set(keys).size, keys.length, `${sport.key} has duplicate market keys`);
  }
});

test("every line market declares a default line and a step", () => {
  for (const sport of SPORTS) {
    for (const m of marketsFor(sport.key)) {
      if (m.shape !== "line") continue;
      assert.equal(typeof m.defaultLine, "number", `${sport.key}/${m.key} has no default line`);
      assert.ok(m.lineStep > 0, `${sport.key}/${m.key} has no line step`);
      assert.ok(m.lineLabel, `${sport.key}/${m.key} has no line label`);
    }
  }
});

test("every roster market declares what an entrant is called", () => {
  for (const sport of SPORTS) {
    for (const m of marketsFor(sport.key)) {
      if (m.shape !== "roster") continue;
      assert.ok(m.entrantLabel, `${sport.key}/${m.key} has no entrant label`);
    }
  }
});

test("an unknown sport or market degrades to empty rather than throwing", () => {
  assert.deepEqual(outcomesFor("cricket", "ml", {}), []);
  assert.deepEqual(outcomesFor("soccer", "not_a_market", {}), []);
  assert.equal(getMarket("soccer", "nope"), null);
  assert.equal(composeEventName("cricket", { home: "A" }), "");
});

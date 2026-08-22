/**
 * Tests for the performance mathematics.
 *
 * These guard the numbers the leaderboard publishes. A silent error here does
 * not crash anything — it just publishes a false record, which is the worst
 * failure this site can have.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  betProfit,
  brierScore,
  calibration,
  closingLineValue,
  computeWindow,
  rollingWindows,
} from "../dist-test/metrics.js";

const day = (n) => new Date(Date.UTC(2026, 6, n)).toISOString();

const bet = (over) => ({
  id: Math.random(),
  model: "AXIOM",
  stake: 100,
  odds: 2.0,
  result: "win",
  settled_at: day(1),
  ...over,
});

test("profit is stake x (odds - 1) on a win", () => {
  assert.equal(betProfit(bet({ stake: 100, odds: 2.5, result: "win" })), 150);
  assert.equal(betProfit(bet({ stake: 100, result: "loss" })), -100);
  assert.equal(betProfit(bet({ stake: 100, result: "void" })), 0);
  assert.equal(betProfit(bet({ stake: 100, result: "pending" })), 0);
});

test("a void is neither a win nor a loss and leaves turnover alone", () => {
  const w = computeWindow([
    bet({ result: "win", stake: 100, odds: 2.0 }),
    bet({ result: "loss", stake: 100 }),
    bet({ result: "void", stake: 100 }),
  ]);
  assert.equal(w.wins, 1);
  assert.equal(w.losses, 1);
  assert.equal(w.voids, 1);
  assert.equal(w.staked, 200, "a returned stake is not turnover");
  assert.equal(w.winRate, 50, "voids must not enter the win-rate denominator");
  assert.equal(w.profit, 0);
});

test("yield is profit over turnover", () => {
  // Three at 2.50: two lose, one wins. Staked 300, profit +150 -200 = -50.
  const w = computeWindow([
    bet({ result: "win", stake: 100, odds: 2.5 }),
    bet({ result: "loss", stake: 100, odds: 2.5 }),
    bet({ result: "loss", stake: 100, odds: 2.5 }),
  ]);
  assert.equal(w.staked, 300);
  assert.equal(w.profit, -50);
  assert.ok(Math.abs(w.yield - -16.667) < 0.01, `yield ${w.yield}`);
});

test("a high win rate at short odds still loses money", () => {
  // The reason win rate alone is not a credibility metric.
  const bets = [];
  for (let i = 0; i < 9; i += 1) bets.push(bet({ result: "win", stake: 100, odds: 1.1 }));
  bets.push(bet({ result: "loss", stake: 100, odds: 1.1 }));

  const w = computeWindow(bets);
  assert.equal(w.winRate, 90);
  assert.ok(w.profit < 0, `90% win rate, profit ${w.profit}`);
  assert.ok(w.yield < 0);
});

test("max drawdown measures peak to trough", () => {
  const w = computeWindow(
    [
      bet({ result: "win", stake: 100, odds: 3.0, settled_at: day(1) }), // 1000 -> 1200
      bet({ result: "loss", stake: 100, settled_at: day(2) }), // -> 1100
      bet({ result: "loss", stake: 100, settled_at: day(3) }), // -> 1000
      bet({ result: "loss", stake: 100, settled_at: day(4) }), // -> 900
    ],
    { startingBankroll: 1000 },
  );
  assert.ok(Math.abs(w.maxDrawdown - 25) < 0.01, `drawdown ${w.maxDrawdown}`);
  assert.equal(w.longestLosingStreak, 3);
});

test("a void does not break a losing streak", () => {
  const w = computeWindow([
    bet({ result: "loss", settled_at: day(1) }),
    bet({ result: "void", settled_at: day(2) }),
    bet({ result: "loss", settled_at: day(3) }),
  ]);
  assert.equal(w.longestLosingStreak, 2);
});

test("CLV is positive when the price shortened after the bet", () => {
  assert.ok(closingLineValue(bet({ odds: 2.2, closing_odds: 2.0 })) > 0);
  assert.ok(closingLineValue(bet({ odds: 1.9, closing_odds: 2.0 })) < 0);
  assert.equal(closingLineValue(bet({ odds: 2.0, closing_odds: null })), null);

  const w = computeWindow([
    bet({ odds: 2.2, closing_odds: 2.0, result: "loss" }),
    bet({ odds: 2.1, closing_odds: 2.0, result: "loss" }),
  ]);
  assert.ok(w.clv > 0, "a losing bettor can still have positive CLV");
  assert.equal(w.clvBeatRate, 100);
});

test("a yield confidence interval appears only with enough sample", () => {
  const few = computeWindow(Array.from({ length: 10 }, () => bet({ result: "win" })));
  assert.equal(few.yieldCI, null, "10 bets is not a record");
  assert.equal(few.significant, false);

  const many = computeWindow(
    Array.from({ length: 60 }, (_, i) =>
      bet({ result: i % 2 === 0 ? "win" : "loss", settled_at: day((i % 28) + 1) }),
    ),
  );
  assert.notEqual(many.yieldCI, null);
  assert.ok(many.yieldCI.low < many.yieldCI.high);
});

test("rolling windows exclude bets outside their cutoff", () => {
  const now = new Date(Date.UTC(2026, 6, 1));
  const iso = (daysAgo) =>
    new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

  const bets = [
    bet({ result: "win", settled_at: iso(5) }),
    bet({ result: "win", settled_at: iso(45) }),
    bet({ result: "win", settled_at: iso(75) }),
    bet({ result: "win", settled_at: iso(200) }),
  ];

  const w = rollingWindows(bets, { now });
  assert.equal(w.d30.bets, 1);
  assert.equal(w.d60.bets, 2);
  assert.equal(w.d90.bets, 3);
  assert.equal(w.all.bets, 4);
});

test("calibration buckets a model's stated probabilities", () => {
  const bets = [
    bet({ true_prob: 0.55, result: "win" }),
    bet({ true_prob: 0.58, result: "win" }),
    bet({ true_prob: 0.52, result: "loss" }),
    bet({ true_prob: 0.51, result: "loss" }),
  ];
  const buckets = calibration(bets);
  const band = buckets.find((b) => b.from === 0.5);
  assert.equal(band.count, 4);
  assert.equal(band.actual, 50);
  assert.ok(band.predicted > 50 && band.predicted < 60);
});

test("Brier score rewards a calibrated forecaster", () => {
  const confidentAndRight = brierScore([
    bet({ true_prob: 0.9, result: "win" }),
    bet({ true_prob: 0.9, result: "win" }),
  ]);
  const confidentAndWrong = brierScore([
    bet({ true_prob: 0.9, result: "loss" }),
    bet({ true_prob: 0.9, result: "loss" }),
  ]);
  assert.ok(confidentAndRight < confidentAndWrong);
  assert.ok(Math.abs(confidentAndRight - 0.01) < 1e-9);

  const coinFlip = brierScore([
    bet({ true_prob: 0.5, result: "win" }),
    bet({ true_prob: 0.5, result: "loss" }),
  ]);
  assert.ok(Math.abs(coinFlip - 0.25) < 1e-9, "always saying 50% scores 0.25");
});

test("an empty record is zeroed, not NaN", () => {
  const w = computeWindow([]);
  assert.equal(w.bets, 0);
  assert.equal(w.yield, 0);
  assert.equal(w.winRate, 0);
  assert.equal(w.sharpe, null);
  assert.equal(w.clv, null);
  assert.equal(brierScore([]), null);
});

test("pending bets never enter the record", () => {
  const w = computeWindow([bet({ result: "pending" }), bet({ result: "win" })]);
  assert.equal(w.bets, 1);
});

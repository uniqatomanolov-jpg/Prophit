/**
 * Ledger tests.
 *
 * These guard the money and the audit chain. A silent error here does not
 * crash anything — it publishes a false bankroll, which is the worst failure
 * this site can have.
 *
 * The hash vectors are pinned against the SHIPPED client implementation
 * (assets/localArena-CHR0Gahc.js). If a change here breaks them, the server
 * and the browser have forked and the site will report its own ledger as
 * tampered.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DAILY_LIMIT,
  GENESIS_HASH,
  MODELS,
  STARTING_BANKROLL,
  appendPick,
  betProfit,
  buildArena,
  deriveFighters,
  eventCode,
  hashBet,
  hashPreimage,
  pickId,
  removePick,
  validatePick,
  thesisCoverage,
  verifyChain,
} from "../api/_lib/ledger.js";

/* ------------------------------------------------------------------ */
/* The shipped client's implementation, reproduced verbatim            */
/* ------------------------------------------------------------------ */

function clientPreimage(e, t) {
  return [
    t, e.id, e.model, e.event, e.market, e.pick,
    e.odds.toFixed(3), e.stake.toFixed(2),
    e.fair_prob == null ? "-" : e.fair_prob.toFixed(5),
    e.logged_at,
  ].join("|");
}
const clientHash = (e, t) =>
  createHash("sha256").update(clientPreimage(e, t), "utf8").digest("hex");

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const at = (h, m = 0) => `2026-08-21T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const NOW = new Date(at(20));

const bet = (over = {}) => ({
  id: 1,
  model: "Claude",
  event: "Arsenal v Chelsea",
  market: "1X2",
  pick: "Arsenal",
  odds: 2.1,
  stake: 45,
  fair_prob: 0.55,
  result: "pending",
  logged_at: at(10),
  ...over,
});

const form = (over = {}) => ({
  model: "Claude",
  event: "Arsenal v Chelsea",
  market: "1X2",
  pick: "Arsenal",
  odds: 2.1,
  stake: 45,
  fair_prob: 0.55,
  reasoning: "Price implies 47.6%. Model says 55%.",
  ...over,
});

const validate = (input, opts = {}) =>
  validatePick(input, { bets: [], round: 1, timeZone: "UTC", now: NOW, ...opts });

/* ================================================================== */
/* Hash chain — parity with the shipped client                        */
/* ================================================================== */

test("hash matches the shipped client byte for byte", () => {
  const cases = [
    bet({}),
    bet({ id: 2, model: "Kimi", market: "goals_ou", pick: "Over 2.5", odds: 1.95, stake: 30, fair_prob: null }),
    bet({ id: 3, model: "Grok", odds: 1.8333, stake: 12.5, fair_prob: 0.611111 }),
  ];
  let prev = GENESIS_HASH;
  for (const c of cases) {
    assert.equal(hashPreimage(c, prev), clientPreimage(c, prev), "preimage must match exactly");
    assert.equal(hashBet(c, prev), clientHash(c, prev));
    prev = hashBet(c, prev);
  }
});

test("a null probability hashes as '-', not 'null'", () => {
  const withNull = bet({ fair_prob: null });
  const withUndef = bet({ fair_prob: undefined });
  assert.ok(hashPreimage(withNull, GENESIS_HASH).includes("|-|"));
  assert.equal(hashBet(withNull, GENESIS_HASH), hashBet(withUndef, GENESIS_HASH));
});

test("verifyChain accepts an intact chain and locates a break", () => {
  let bets = [];
  for (const model of ["Claude", "Grok", "ChatGPT"]) {
    const v = validate(form({ model }), { bets });
    assert.ok(v.ok, v.errors.join("; "));
    bets = appendPick(bets, v.normalised, { now: NOW });
  }
  assert.equal(verifyChain(bets).ok, true);

  // Tamper with a stake — the classic silent edit.
  const tampered = bets.map((b, i) => (i === 1 ? { ...b, stake: 999 } : b));
  const result = verifyChain(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, tampered[1].id);
});

test("pick_id matches the client's format", () => {
  assert.equal(pickId(1, "Claude", "Arsenal v Chelsea", "1X2"), "R1-CLA-ARSvsCHE-1X2");
  assert.equal(pickId(3, "ChatGPT", "Real Madrid vs Barcelona", null), "R3-GPT-REAvsBAR");
  assert.equal(pickId(2, "Kimi", "Spurs - Everton", "btts"), "R2-KMI-SPUvsEVE-BTTS");
  assert.match(pickId(4, "Grok", "Monaco Grand Prix — Race", "winner"), /^R4-GRK-MONACOGR-[0-9A-F]{4}-WINNER$/);
});

test("eventCode keeps two-sided fixtures byte-identical", () => {
  // These must never change: pick_id embeds this code and is the duplicate
  // key, so a different result would un-block a previously refused duplicate.
  assert.equal(eventCode("Arsenal vs Chelsea"), "ARSvsCHE");
  assert.equal(eventCode("Arsenal v Chelsea"), "ARSvsCHE");
  assert.equal(eventCode("Arsenal - Chelsea"), "ARSvsCHE", "hyphen is still a separator");
  assert.equal(eventCode("Spurs - Everton"), "SPUvsEVE");
  assert.equal(eventCode("St. Pauli vs 1. FC Köln"), "STvs1");
});

test("single-name events get a collision-proof code", () => {
  /*
   * The F1 fix. The old fallback took the first two words, so "Monaco Grand
   * Prix" and "Monza Grand Prix" both became MONvsGRA — the second race was
   * then rejected as a duplicate of the first and could not be logged at all.
   */
  const monaco = eventCode("Monaco Grand Prix");
  const monza = eventCode("Monza Grand Prix");
  assert.notEqual(monaco, monza, "two different Grands Prix must not collide");
  assert.match(monaco, /^MONACOGR-[0-9A-F]{4}$/);

  // An em dash separates a race from its session, not two sides.
  const race = eventCode("Monaco Grand Prix — Race");
  const quali = eventCode("Monaco Grand Prix — Qualifying");
  assert.notEqual(race, quali, "sessions at one Grand Prix must be distinct");
  assert.notEqual(race, eventCode("Monza Grand Prix — Race"));

  // Deterministic: the same name always yields the same code.
  assert.equal(eventCode("Monaco Grand Prix"), monaco);
});

/* ================================================================== */
/* Money                                                              */
/* ================================================================== */

test("profit: win pays odds-1, loss costs the stake, void is zero", () => {
  assert.equal(betProfit(bet({ result: "win", stake: 100, odds: 2.5 })), 150);
  assert.equal(betProfit(bet({ result: "loss", stake: 100 })), -100);
  assert.equal(betProfit(bet({ result: "void", stake: 100 })), 0);
  assert.equal(betProfit(bet({ result: "pending", stake: 100 })), 0);
});

test("fighters derive from bets alone", () => {
  const bets = [
    bet({ id: 1, model: "Claude", result: "win", stake: 100, odds: 2.0 }),
    bet({ id: 2, model: "Claude", result: "loss", stake: 50 }),
    bet({ id: 3, model: "Claude", result: "pending", stake: 25 }),
    bet({ id: 4, model: "Grok", result: "void", stake: 40 }),
  ];
  const f = deriveFighters(bets, { timeZone: "UTC", now: NOW });

  assert.equal(f.Claude.wins, 1);
  assert.equal(f.Claude.losses, 1);
  assert.equal(f.Claude.profit, 50, "+100 -50");
  assert.equal(f.Claude.current_bankroll, STARTING_BANKROLL + 50);
  assert.equal(f.Claude.pending, 25);
  assert.equal(f.Claude.open_positions, 1);

  assert.equal(f.Grok.voids, 1);
  assert.equal(f.Grok.current_bankroll, STARTING_BANKROLL, "a void moves nothing");

  // Every model always present, even with no bets.
  for (const m of MODELS) assert.ok(f[m], `${m} missing`);
});

test("remaining budget counts only today's stakes", () => {
  const bets = [
    bet({ id: 1, model: "Claude", stake: 30, logged_at: at(10) }),
    bet({ id: 2, model: "Claude", stake: 20, logged_at: at(14) }),
    bet({ id: 3, model: "Claude", stake: 60, logged_at: "2026-08-20T10:00:00.000Z" }),
  ];
  const f = deriveFighters(bets, { timeZone: "UTC", now: NOW });
  assert.equal(f.Claude.deployed_today, 50, "yesterday's 60 must not count");
  assert.equal(f.Claude.remaining_today, DAILY_LIMIT - 50);
});

test("float dust never reaches a displayed figure", () => {
  const bets = [
    bet({ id: 1, model: "Claude", result: "win", stake: 0.1, odds: 3.0 }),
    bet({ id: 2, model: "Claude", result: "win", stake: 0.2, odds: 2.0 }),
  ];
  const f = deriveFighters(bets, { timeZone: "UTC", now: NOW });
  assert.equal(String(f.Claude.profit).length <= 6, true, `got ${f.Claude.profit}`);
  assert.equal(f.Claude.profit, 0.4);
});

/* ================================================================== */
/* Validation                                                         */
/* ================================================================== */

test("a clean pick validates and normalises", () => {
  const v = validate(form());
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(v.normalised.model, "Claude");
  assert.equal(v.normalised.stake, 45);
  assert.equal(v.normalised.fair_prob, 0.55);
  assert.equal(v.normalised.pick_id, "R1-CLA-ARSvsCHE-1X2");
  assert.equal(v.normalised.reasoning, "Price implies 47.6%. Model says 55%.");
});

test("unknown fighter is rejected", () => {
  const v = validate(form({ model: "DeepSeek" }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Fighter must be one of/.test(e)));
});

test("every missing field is reported at once, not one per submit", () => {
  const v = validate({ model: "Claude" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 4, `only got ${v.errors.length}: ${v.errors.join("; ")}`);
});

test("odds must be a real price", () => {
  assert.equal(validate(form({ odds: 1 })).ok, false);
  assert.equal(validate(form({ odds: 0.5 })).ok, false);
  assert.equal(validate(form({ odds: "abc" })).ok, false);
  assert.equal(validate(form({ odds: 1.01 })).ok, true);
});

test("stake must be positive", () => {
  assert.equal(validate(form({ stake: 0 })).ok, false);
  assert.equal(validate(form({ stake: -5 })).ok, false);
  assert.equal(validate(form({ stake: "" })).ok, false);
});

test("a percentage probability is coerced, with a warning", () => {
  const v = validate(form({ fair_prob: 55 }));
  assert.ok(v.ok);
  assert.equal(v.normalised.fair_prob, 0.55);
  assert.ok(v.warnings.some((w) => /read as/.test(w)));
});

test("probability is optional", () => {
  const v = validate(form({ fair_prob: "" }));
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(v.normalised.fair_prob, null);
});

test("an impossible probability is rejected", () => {
  assert.equal(validate(form({ fair_prob: 0 })).ok, false);
  assert.equal(validate(form({ fair_prob: 150 })).ok, false);
  assert.equal(validate(form({ fair_prob: -0.5 })).ok, false);
});

test("the same fighter cannot log the same fixture twice in a round", () => {
  const first = validate(form());
  const bets = appendPick([], first.normalised, { now: NOW });

  const dup = validate(form(), { bets });
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => /already has a pick/.test(e)));

  // A different market on the same fixture IS allowed.
  const other = validate(form({ market: "btts", pick: "Yes" }), { bets });
  assert.ok(other.ok, other.errors.join("; "));

  // And a different fighter is always allowed.
  const grok = validate(form({ model: "Grok" }), { bets });
  assert.ok(grok.ok, grok.errors.join("; "));
});

test("a stake over the remaining daily budget is refused", () => {
  const bets = [bet({ id: 1, model: "Claude", stake: 80, logged_at: at(9) })];
  const v = validate(form({ stake: 30 }), { bets });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /remaining budget/.test(e)), v.errors.join("; "));

  // Exactly the remainder is fine.
  const exact = validate(form({ stake: 20 }), { bets });
  assert.ok(exact.ok, exact.errors.join("; "));
});

test("a stake at exactly 10% of bankroll does not warn", () => {
  // 100 of a 1000 bankroll is AT the threshold, not over it.
  const v = validate(form({ stake: 100 }));
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(v.warnings.some((w) => /over 10%/.test(w)), false);
});

test("the 10%-of-bankroll warning fires once a fighter is drawn down", () => {
  /*
   * On a full 1000 bankroll this warning can never fire: 10% is 100, and the
   * 100-unit daily budget blocks at exactly the same number. It only becomes
   * meaningful after losses — which is precisely when over-staking matters.
   */
  const bets = [
    bet({ id: 1, model: "Claude", result: "loss", stake: 100, logged_at: "2026-08-19T10:00:00.000Z" }),
    bet({ id: 2, model: "Claude", result: "loss", stake: 100, logged_at: "2026-08-19T11:00:00.000Z" }),
    bet({ id: 3, model: "Claude", result: "loss", stake: 100, logged_at: "2026-08-20T10:00:00.000Z" }),
    bet({ id: 4, model: "Claude", result: "loss", stake: 100, logged_at: "2026-08-20T11:00:00.000Z" }),
    bet({ id: 5, model: "Claude", result: "loss", stake: 100, logged_at: "2026-08-20T12:00:00.000Z" }),
  ];
  const f = deriveFighters(bets, { timeZone: "UTC", now: NOW });
  assert.equal(f.Claude.current_bankroll, 500);
  assert.equal(f.Claude.remaining_today, DAILY_LIMIT, "none of those were today");

  const v = validate(form({ stake: 60 }), { bets });
  assert.ok(v.ok, v.errors.join("; "));
  assert.ok(
    v.warnings.some((w) => /over 10%/.test(w)),
    `60 is over 10% of 500 — warnings were: ${JSON.stringify(v.warnings)}`,
  );
});

test("a stake above the drawn-down bankroll is blocked outright", () => {
  const bets = Array.from({ length: 9 }, (_, i) =>
    bet({ id: i + 1, model: "Claude", result: "loss", stake: 100, logged_at: `2026-08-${10 + i}T10:00:00.000Z` }),
  );
  const f = deriveFighters(bets, { timeZone: "UTC", now: NOW });
  assert.equal(f.Claude.current_bankroll, 100);

  const v = validate(form({ stake: 100 }), { bets });
  assert.ok(v.ok, "exactly the bankroll is allowed");

  const over = validate(form({ stake: 101 }), { bets });
  assert.equal(over.ok, false);
  assert.ok(over.errors.some((e) => /exceeds .* bankroll/.test(e)), over.errors.join("; "));
});

test("negative EV warns but does not block", () => {
  const v = validate(form({ fair_prob: 0.3, odds: 2.0 }));
  assert.ok(v.ok);
  assert.ok(v.warnings.some((w) => /Negative expected value/.test(w)));
});

test("oversized text is rejected", () => {
  assert.equal(validate(form({ reasoning: "x".repeat(4001) })).ok, false);
  assert.equal(validate(form({ event: "x".repeat(201) })).ok, false);
});

test("whitespace-only strings do not pass as present", () => {
  assert.equal(validate(form({ pick: "   " })).ok, false);
  assert.equal(validate(form({ market: "\t\n" })).ok, false);
});

/* ================================================================== */
/* Append and remove                                                  */
/* ================================================================== */

test("appendPick builds a correct, chained record", () => {
  const v = validate(form());
  const bets = appendPick([], v.normalised, { now: NOW });

  assert.equal(bets.length, 1);
  const b = bets[0];
  assert.equal(b.id, 1);
  assert.equal(b.result, "pending");
  assert.equal(b.prev_hash, GENESIS_HASH);
  assert.equal(b.hash, clientHash(b, GENESIS_HASH));
  assert.equal(b.odds_at_pick, 2.1);
  assert.equal(b.source, "manual");
  assert.equal(b.reasoning, "Price implies 47.6%. Model says 55%.");
  assert.equal(b.core_thesis, b.reasoning, "thesis mirrors reasoning for the drawer");
  assert.ok(typeof b.edge === "number");
});

test("appendPick does not mutate its input", () => {
  const v = validate(form());
  const original = [];
  const next = appendPick(original, v.normalised, { now: NOW });
  assert.equal(original.length, 0);
  assert.equal(next.length, 1);
});

test("ids increment past the highest existing id, not the array length", () => {
  const bets = [bet({ id: 7 }), bet({ id: 3 })];
  const v = validate(form({ model: "Grok" }), { bets });
  const next = appendPick(bets, v.normalised, { now: NOW });
  assert.equal(next[next.length - 1].id, 8);
});

test("removePick rebuilds the chain so it still verifies", () => {
  let bets = [];
  for (const model of ["Claude", "Grok", "ChatGPT", "Gemini"]) {
    const v = validate(form({ model }), { bets });
    bets = appendPick(bets, v.normalised, { now: NOW });
  }
  assert.equal(verifyChain(bets).ok, true);

  const out = removePick(bets, 2);
  assert.equal(out.ok, true);
  assert.equal(out.bets.length, 3);
  assert.equal(out.removed.model, "Grok");
  assert.equal(verifyChain(out.bets).ok, true, "chain must re-verify after a delete");
  assert.equal(out.bets[0].prev_hash, GENESIS_HASH);
});

test("removing a pick that does not exist is reported, not thrown", () => {
  const out = removePick([bet()], 999);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "not-found");
});

test("removing a pick frees its budget again", () => {
  const v = validate(form({ stake: 60 }));
  const bets = appendPick([], v.normalised, { now: NOW });
  assert.equal(deriveFighters(bets, { timeZone: "UTC", now: NOW }).Claude.remaining_today, 40);

  const out = removePick(bets, bets[0].id);
  assert.equal(deriveFighters(out.bets, { timeZone: "UTC", now: NOW }).Claude.remaining_today, DAILY_LIMIT);
});

/* ================================================================== */
/* Full arena                                                         */
/* ================================================================== */

test("buildArena derives standings and never trusts a stored copy", () => {
  const v = validate(form({ stake: 40 }));
  const bets = appendPick([], v.normalised, { now: NOW });
  const arena = buildArena(bets, { round: 1, timeZone: "UTC", now: NOW });

  assert.equal(arena.bets.length, 1);
  assert.equal(arena.round.round, 1);
  assert.equal(arena.leaderboard.length, MODELS.length);
  assert.equal(arena.integrity.ok, true);
  assert.equal(arena.fighters.Claude.pending, 40);
  assert.equal(arena.fighters.Claude.remaining_today, DAILY_LIMIT - 40);
});

test("the leaderboard sorts by bankroll", () => {
  const bets = [
    bet({ id: 1, model: "Grok", result: "win", stake: 100, odds: 3.0 }),
    bet({ id: 2, model: "Claude", result: "loss", stake: 50 }),
  ];
  const arena = buildArena(bets, { timeZone: "UTC", now: NOW });
  assert.equal(arena.leaderboard[0].name, "Grok");
  assert.equal(arena.leaderboard[arena.leaderboard.length - 1].name, "Claude");
});

test("a bet for an unknown model does not invent a fighter", () => {
  const bets = [bet({ model: "Mystery" })];
  const f = deriveFighters(bets, { timeZone: "UTC", now: NOW });
  assert.equal(Object.keys(f).length, MODELS.length);
  assert.equal(f.Mystery, undefined);
});

test("an empty arena is valid, not an error", () => {
  const arena = buildArena([], { timeZone: "UTC", now: NOW });
  assert.equal(arena.bets.length, 0);
  assert.equal(arena.integrity.ok, true);
  for (const m of MODELS) {
    assert.equal(arena.fighters[m].current_bankroll, STARTING_BANKROLL);
    assert.equal(arena.fighters[m].remaining_today, DAILY_LIMIT);
  }
});

/* ================================================================== */
/* Thesis capture — what feeds the public rationale drawer            */
/* ================================================================== */

test("a pick with no thesis is refused", () => {
  const v = validate(form({ reasoning: "" }));
  assert.equal(v.ok, false);
  assert.ok(
    v.errors.some((e) => /Thesis is required/.test(e)),
    v.errors.join("; "),
  );
});

test("a token thesis is refused", () => {
  const v = validate(form({ reasoning: "value" }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /too short/.test(e)), v.errors.join("; "));
});

test("the thesis requirement can be waived for imports", () => {
  // The bulk-import path may legitimately carry picks whose model wrote no
  // rationale; those are flagged by coverage rather than rejected outright.
  const v = validate(form({ reasoning: "" }), { requireReasoning: false });
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(v.normalised.reasoning, null);
});

test("the thesis reaches both fields the frontend reads", () => {
  const thesis = "Arsenal press against a back three with no natural width.";
  const v = validate(form({ reasoning: thesis }));
  const bets = appendPick([], v.normalised, { now: NOW });
  assert.equal(bets[0].reasoning, thesis, "the bundle's drawer reads .reasoning");
  assert.equal(bets[0].core_thesis, thesis, "the schema parser reads .core_thesis");
});

test("risk factors and confidence survive to the record", () => {
  const v = validate(form({ risk_factors: "Rotation before Europe.", confidence: 72 }));
  const bets = appendPick([], v.normalised, { now: NOW });
  assert.equal(bets[0].risk_factors, "Rotation before Europe.");
  assert.equal(bets[0].confidence, 72);
});

test("thesisCoverage counts what will actually render a drawer", () => {
  const bets = [
    bet({ id: 1, reasoning: "A real thesis that a visitor can read." }),
    bet({ id: 2, reasoning: "   " }),
    bet({ id: 3 }),
  ];
  const c = thesisCoverage(bets);
  assert.equal(c.total, 3);
  assert.equal(c.withThesis, 1);
  assert.equal(c.missing, 2);
  assert.equal(c.percent, 33);
  assert.deepEqual(c.missingIds, [2, 3]);
});

test("thesisCoverage on an empty arena is 100%, not NaN", () => {
  const c = thesisCoverage([]);
  assert.equal(c.percent, 100);
  assert.equal(c.missing, 0);
});

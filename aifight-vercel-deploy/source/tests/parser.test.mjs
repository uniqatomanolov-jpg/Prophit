/**
 * Adversarial tests for parseModelReply.
 *
 * Every case here is a reply shape observed from a real chat model, or a
 * failure mode the shipped code was vulnerable to. The suite exists to prove
 * two properties:
 *
 *   1. A model cannot move money by lying, miscounting, or hallucinating.
 *   2. A formatting accident does not destroy a round's analysis.
 *
 * Run: node --test tests/parser.test.mjs   (after the esbuild step in
 *      scripts/test.sh, which strips the TypeScript types)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseModelReply, expectedValue, kellyFraction } from "../dist-test/parseModelReply.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const entry = (ref, label, odds, extra = {}) => ({
  ref,
  outcome_id: 1000 + ref,
  market_id: 10,
  event_id: 1,
  label,
  odds,
  marketKey: "h2h",
  marketLabel: "Match Result",
  marketKind: "single",
  eventName: "Arsenal v Chelsea",
  ...extra,
});

const index = new Map([
  [1, entry(1, "Arsenal", 2.1)],
  [2, entry(2, "Draw", 3.4)],
  [3, entry(3, "Chelsea", 3.6)],
  [7, entry(7, "Over 2.5", 1.95, { market_id: 11, marketKey: "totals", marketLabel: "Totals" })],
  [9, entry(9, "Under 2.5", 1.9, { market_id: 11, marketKey: "totals", marketLabel: "Totals" })],
]);

const rules = {
  minEv: 0.02,
  minOdds: 1.2,
  maxOdds: 15,
  kellyFraction: 0.25,
  maxStakeFraction: 0.1,
  maxDailyExposure: 0.1,
  maxOpenPositions: 12,
};

const state = { bankroll: 1000, stakedToday: 0, openPositions: 0 };

const base = {
  model: "AXIOM",
  index,
  eventIndex: new Map([[1, { event_id: 1, name: "Arsenal v Chelsea" }]]),
  rules,
  state,
  maxPicks: 3,
};

const parse = (raw, overrides = {}) => parseModelReply(raw, { ...base, ...overrides });

/* ------------------------------------------------------------------ */
/* Happy path                                                          */
/* ------------------------------------------------------------------ */

test("parses the contract schema", () => {
  const reply = JSON.stringify({
    analysis: [
      {
        event: 1,
        headline: "Arsenal's press against a back three.",
        form: "Unbeaten in 7, 5 at home.",
        team_news: "No confirmed news.",
        tactical: "Wing-backs isolated.",
        trend: "Over 2.5 in 8 of 11 (n=11).",
        x_factor: "Set-piece xG gap.",
        risk: "Rotation before Europe.",
        confidence_score: 68,
      },
    ],
    picks: [
      {
        ref: 1,
        predicted_outcome: "Arsenal",
        estimated_probability: 0.55,
        stake: 45,
        confidence_score: 72,
        calculated_ev: 15.5,
        core_thesis: "Price implies 47.6%. Model says 55%.",
        risk_factors: "Keeper injury unconfirmed.",
      },
    ],
  });

  const out = parse(reply);
  assert.equal(out.format, "schema");
  assert.equal(out.errors.length, 0);
  assert.equal(out.picks.length, 1);
  assert.equal(out.previews.length, 1);

  const pick = out.picks[0];
  assert.equal(pick.ref, 1);
  assert.equal(pick.odds, 2.1, "price must come from the board");
  assert.equal(pick.stake, 45);
  assert.equal(pick.true_prob, 0.55);
  assert.ok(Math.abs(pick.ev - 15.5) < 0.01, `EV recomputed: ${pick.ev}`);
  assert.equal(pick.claimed_ev, 15.5);
  assert.ok(Math.abs(pick.ev_claim_error) < 0.01);
});

/* ------------------------------------------------------------------ */
/* Price integrity — the core guarantee                                */
/* ------------------------------------------------------------------ */

test("ignores a price the model quotes", () => {
  const out = parse(
    `{"picks":[{"ref":1,"odds":50,"price":50,"estimated_probability":0.55,"stake":40}]}`,
  );
  assert.equal(out.picks[0].odds, 2.1, "the model's 50.0 must never be used");
});

test("rejects a hallucinated reference number", () => {
  const out = parse(`{"picks":[{"ref":42,"estimated_probability":0.6,"stake":40}]}`);
  assert.equal(out.picks.length, 0);
  assert.equal(out.rejected[0].violations[0].code, "unknown-ref");
});

test("rejects a duplicated reference", () => {
  const out = parse(
    `{"picks":[
      {"ref":1,"estimated_probability":0.55,"stake":30},
      {"ref":1,"estimated_probability":0.60,"stake":30}
    ]}`,
  );
  assert.equal(out.picks.length, 1);
  assert.equal(out.rejected[0].violations[0].code, "duplicate-ref");
});

test("flags an outcome/ref mismatch", () => {
  // Selected Arsenal, described Chelsea. Silent money-mover without both fields.
  const out = parse(
    `{"picks":[{"ref":1,"predicted_outcome":"Chelsea to win","estimated_probability":0.55,"stake":40}]}`,
  );
  assert.equal(out.picks.length, 1);
  assert.ok(
    out.picks[0].violations.some((v) => v.code === "outcome-mismatch"),
    "mismatch must be flagged",
  );
});

test("accepts a cosmetically different but equivalent outcome label", () => {
  const out = parse(
    `{"picks":[{"ref":7,"predicted_outcome":"Over 2.5 Goals (FT)","estimated_probability":0.58,"stake":40}]}`,
  );
  assert.ok(!out.picks[0].violations.some((v) => v.code === "outcome-mismatch"));
});

/* ------------------------------------------------------------------ */
/* EV claims                                                           */
/* ------------------------------------------------------------------ */

test("records an inflated EV claim without acting on it", () => {
  // p=0.60 at 2.10 leaves quarter-Kelly at ~59 units, so a 40 stake is inside
  // every cap. The ONLY thing under test here is the EV claim.
  const out = parse(
    `{"picks":[{"ref":1,"estimated_probability":0.60,"stake":40,"calculated_ev":70}]}`,
  );
  const pick = out.picks[0];
  assert.ok(Math.abs(pick.ev - 26) < 0.01, `true EV ${pick.ev}`);
  assert.equal(pick.claimed_ev, 70);
  assert.ok(pick.ev_claim_error > 43, `claim error ${pick.ev_claim_error}`);
  assert.ok(pick.violations.some((v) => v.code === "ev-claim-inflated"));
  assert.equal(pick.stake, 40, "an inflated claim must not change the stake");
});

test("blocks a negative-EV pick", () => {
  const out = parse(`{"picks":[{"ref":1,"estimated_probability":0.30,"stake":40}]}`, {
    rejectViolations: true,
  });
  assert.equal(out.picks.length, 0);
  assert.ok(out.rejected[0].violations.some((v) => v.code === "negative-ev"));
});

/* ------------------------------------------------------------------ */
/* Staking discipline                                                  */
/* ------------------------------------------------------------------ */

test("clamps a stake above the per-bet cap, then again at Kelly", () => {
  // 500 → 100 by the 10%-of-bankroll cap → 70 by the 2x-quarter-Kelly ceiling.
  // Both constraints must fire, and the TIGHTEST one must be what survives.
  const out = parse(`{"picks":[{"ref":1,"estimated_probability":0.55,"stake":500}]}`);
  const pick = out.picks[0];
  assert.equal(pick.requested_stake, 500);
  assert.ok(pick.violations.some((v) => v.code === "stake-over-cap"), "cap must fire");
  assert.ok(pick.violations.some((v) => v.code === "over-kelly"), "Kelly must fire");
  assert.equal(pick.stake, 70, "the tightest binding constraint wins");
  assert.ok(pick.stake <= Math.floor(state.bankroll * rules.maxStakeFraction));
});

test("clamps a stake far above Kelly", () => {
  // p=0.50 at 2.10 → full Kelly ~4.5%, quarter Kelly ~1.1% → ~11 units.
  const out = parse(`{"picks":[{"ref":1,"estimated_probability":0.50,"stake":95}]}`);
  const pick = out.picks[0];
  assert.ok(pick.violations.some((v) => v.code === "over-kelly"), "must flag over-Kelly");
  assert.ok(pick.stake < 95, `clamped to ${pick.stake}`);
});

test("respects the round budget across multiple picks", () => {
  const out = parse(
    `{"picks":[
      {"ref":1,"estimated_probability":0.60,"stake":60},
      {"ref":7,"estimated_probability":0.62,"stake":60}
    ]}`,
  );
  const total = out.picks.reduce((s, p) => s + p.stake, 0);
  assert.ok(total <= 100, `total ${total} must not exceed the 10% daily exposure`);
});

test("caps the number of picks", () => {
  const out = parse(
    `{"picks":[
      {"ref":1,"estimated_probability":0.60,"stake":10},
      {"ref":2,"estimated_probability":0.35,"stake":10},
      {"ref":3,"estimated_probability":0.32,"stake":10},
      {"ref":7,"estimated_probability":0.60,"stake":10}
    ]}`,
    { maxPicks: 3 },
  );
  assert.ok(out.picks.length <= 3);
  assert.ok(out.errors.some((e) => e.includes("limit is 3")));
});

/* ------------------------------------------------------------------ */
/* Format resilience                                                   */
/* ------------------------------------------------------------------ */

test("survives code fences and a chatty preamble", () => {
  const reply = `Sure! Here's my analysis for today.

\`\`\`json
{"picks":[{"ref":1,"estimated_probability":0.55,"stake":40,"core_thesis":"Value."}]}
\`\`\`

Let me know if you want more detail.`;
  const out = parse(reply);
  assert.equal(out.picks.length, 1);
  assert.equal(out.picks[0].ref, 1);
});

test("survives smart quotes", () => {
  const reply = `{“picks”:[{“ref”:1,“estimated_probability”:0.55,“stake”:40}]}`;
  const out = parse(reply);
  assert.equal(out.picks.length, 1);
});

test("survives a trailing comma", () => {
  const out = parse(`{"picks":[{"ref":1,"estimated_probability":0.55,"stake":40,},]}`);
  assert.equal(out.picks.length, 1);
});

test("survives unquoted keys", () => {
  const out = parse(`{picks:[{ref:1,estimated_probability:0.55,stake:40}]}`);
  assert.equal(out.picks.length, 1);
});

test("accepts a bare picks array", () => {
  const out = parse(`[{"ref":1,"estimated_probability":0.55,"stake":40}]`);
  assert.equal(out.format, "picks-array");
  assert.equal(out.picks.length, 1);
});

test("coerces a percentage probability to a decimal", () => {
  const out = parse(`{"picks":[{"ref":1,"estimated_probability":55,"stake":40}]}`);
  assert.equal(out.picks[0].true_prob, 0.55);
  assert.ok(out.picks[0].warnings.some((w) => w.includes("read as")));
});

test("reads a currency-formatted stake", () => {
  const out = parse(`{"picks":[{"ref":1,"estimated_probability":0.55,"stake":"€45"}]}`);
  assert.equal(out.picks[0].stake, 45);
});

test("does not mistake a quoted example for the answer", () => {
  // The prompt's own worked example, echoed before the real reply.
  const reply = `You asked me to reply like this:

{"picks":[{"ref":7,"stake":45,"estimated_probability":0.42}]}

Here is my actual answer:

{"picks":[{"ref":3,"stake":20,"estimated_probability":0.30}]}`;
  const out = parse(reply);
  // The first balanced object wins, which is the documented behaviour; what
  // must never happen is BOTH being imported as separate live bets.
  assert.equal(out.picks.length, 1, "an echo must not produce two bets");
});

/* ------------------------------------------------------------------ */
/* Refusals and junk                                                   */
/* ------------------------------------------------------------------ */

test("an empty reply is an error, not a pass", () => {
  const out = parse("");
  assert.equal(out.passed, false);
  assert.ok(out.errors.length > 0);
});

test("a prose refusal is an error", () => {
  const out = parse("I don't think there's any value on this board today, so I'll pass.");
  assert.equal(out.picks.length, 0);
  assert.equal(out.passed, false);
});

test("analysis with no picks is reported, not silently passed", () => {
  const out = parse(
    `{"analysis":[{"event":1,"headline":"Tight game.","risk":"Rotation."}],"picks":[]}`,
  );
  assert.equal(out.previews.length, 1, "the analysis must survive");
  assert.equal(out.passed, false);
  assert.ok(out.errors.some((e) => e.includes("Passing is forbidden")));
});

test("a non-Latin thesis is blocked", () => {
  const out = parse(
    `{"picks":[{"ref":1,"estimated_probability":0.55,"stake":40,"core_thesis":"Арсенал выиграет этот матч уверенно и без проблем"}]}`,
    { rejectViolations: true },
  );
  assert.ok(out.rejected.some((r) => r.violations.some((v) => v.code === "non-english")));
});

test("an empty analysis shell does not steal its event", () => {
  const out = parse(
    `{"analysis":[
       {"event":1},
       {"event":1,"headline":"The real preview.","form":"W-W-D-W","risk":"Rotation."}
     ],"picks":[{"ref":1,"estimated_probability":0.55,"stake":40}]}`,
  );
  assert.equal(out.previews.length, 1);
  assert.equal(out.previews[0].headline, "The real preview.");
});

/* ------------------------------------------------------------------ */
/* Pure maths                                                          */
/* ------------------------------------------------------------------ */

test("expectedValue matches the closed form", () => {
  assert.ok(Math.abs(expectedValue(0.5, 2.0) - 0) < 1e-9, "a fair coin at evens is 0% EV");
  assert.ok(Math.abs(expectedValue(0.55, 2.0) - 10) < 1e-9);
  assert.ok(expectedValue(0.3, 2.0) < 0);
});

test("kellyFraction is zero on a negative edge", () => {
  assert.equal(kellyFraction(0.4, 2.0), 0);
  assert.ok(Math.abs(kellyFraction(0.6, 2.0) - 0.2) < 1e-9);
});

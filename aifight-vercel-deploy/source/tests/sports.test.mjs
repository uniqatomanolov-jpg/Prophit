/**
 * Sport registry tests.
 *
 * These guard the contract between the admin matrix and the server validator:
 * both call `outcomesFor()`, so if it drifts, the label the operator priced
 * and the label the server stores diverge — and the duplicate check silently
 * stops matching.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SPORTS, composeEventName, eventShape, isSport,
  marketFor, marketsFor, outcomesFor, registry, sportLabel,
} from "../api/_lib/sports.js";

const CTX = { home: "Arsenal", away: "Chelsea" };

test("all four sports are registered", () => {
  assert.deepEqual(SPORTS, ["soccer", "nba", "nfl", "f1"]);
  for (const s of SPORTS) {
    assert.ok(isSport(s));
    assert.ok(eventShape(s), `${s} has no event shape`);
    assert.ok(marketsFor(s).length > 0, `${s} has no markets`);
  }
  assert.equal(isSport("cricket"), false);
});

test("soccer prices every market the brief asked for", () => {
  const keys = marketsFor("soccer").map((m) => m.key);
  for (const k of ["1X2", "dc", "btts", "goals_ou", "corners_ou", "cards_ou"]) {
    assert.ok(keys.includes(k), `soccer is missing ${k}`);
  }
});

test("soccer match result is three-way, including the draw", () => {
  assert.deepEqual(outcomesFor("soccer", "1X2", CTX), ["Arsenal", "Draw", "Chelsea"]);
});

test("basketball and football moneylines are two-way", () => {
  assert.deepEqual(outcomesFor("nba", "ml", CTX), ["Arsenal", "Chelsea"]);
  assert.deepEqual(outcomesFor("nfl", "ml", CTX), ["Arsenal", "Chelsea"]);
});

test("a spread mirrors the line onto the away side", () => {
  assert.deepEqual(outcomesFor("nba", "spread", { ...CTX, line: -4.5 }),
    ["Arsenal -4.5", "Chelsea +4.5"]);
  // Sign flips both ways — the away favourite case.
  assert.deepEqual(outcomesFor("nba", "spread", { ...CTX, line: 6.5 }),
    ["Arsenal +6.5", "Chelsea -6.5"]);
});

test("totals carry the line into the label", () => {
  assert.deepEqual(outcomesFor("soccer", "goals_ou", { ...CTX, line: 2.5 }), ["Over 2.5", "Under 2.5"]);
  assert.deepEqual(outcomesFor("nfl", "totals", { ...CTX, line: 44.5 }), ["Over 44.5", "Under 44.5"]);
  // A whole line renders without a trailing .0 — it can push, and VOID is the
  // settlement for that.
  assert.deepEqual(outcomesFor("soccer", "goals_ou", { ...CTX, line: 3 }), ["Over 3", "Under 3"]);
});

test("an omitted line falls back to the market default", () => {
  assert.deepEqual(outcomesFor("soccer", "goals_ou", CTX), ["Over 2.5", "Under 2.5"]);
});

test("F1 outcomes come from the entrant roster", () => {
  const drivers = ["Verstappen", "Norris", "Leclerc"];
  assert.deepEqual(outcomesFor("f1", "winner", { entrants: drivers }), drivers);
  // Objects with a label work too — that is what the matrix posts.
  assert.deepEqual(
    outcomesFor("f1", "podium", { entrants: [{ label: "Hamilton" }, { label: "Russell" }] }),
    ["Hamilton", "Russell"],
  );
  // Blank rows are skipped rather than becoming empty outcomes.
  assert.deepEqual(outcomesFor("f1", "winner", { entrants: ["Alonso", "", "   ", null] }), ["Alonso"]);
});

test("an F1 event has no away side", () => {
  const keys = eventShape("f1").fields.map((f) => f.key);
  assert.ok(!keys.includes("away"), "a Grand Prix has no away team");
  assert.ok(keys.includes("home"));
  assert.ok(keys.includes("session"));
});

test("event names compose per sport", () => {
  assert.equal(composeEventName("soccer", { home: "Arsenal", away: "Chelsea" }), "Arsenal v Chelsea");
  assert.equal(composeEventName("nba", { home: "Celtics", away: "Heat" }), "Celtics v Heat");
  assert.equal(composeEventName("f1", { home: "Monaco Grand Prix", session: "Race" }),
    "Monaco Grand Prix — Race");
  // Without a session the race name stands alone.
  assert.equal(composeEventName("f1", { home: "Monaco Grand Prix" }), "Monaco Grand Prix");
});

test("an unknown market resolves to nothing rather than throwing", () => {
  assert.deepEqual(outcomesFor("soccer", "moneyline", CTX), []);
  assert.equal(marketFor("soccer", "ml"), null, "ml belongs to nba/nfl, not soccer");
  assert.equal(marketFor("nba", "btts"), null);
});

test("the browser registry carries everything the matrix needs", () => {
  const reg = registry();
  assert.equal(reg.length, 4);
  for (const sport of reg) {
    assert.ok(sport.label && sport.kind && Array.isArray(sport.fields));
    for (const m of sport.markets) {
      assert.ok(m.key && m.label && m.shape);
      if (m.shape === "line") {
        assert.equal(typeof m.defaultLine, "number");
        assert.ok(Array.isArray(m.outcomeTemplates));
      }
      if (m.shape === "roster") assert.ok(m.entrantLabel);
    }
  }
  assert.equal(sportLabel("f1"), "Formula 1");
});

test("missing team names degrade to placeholders, not undefined", () => {
  const out = outcomesFor("soccer", "1X2", {});
  assert.deepEqual(out, ["Home", "Draw", "Away"]);
  assert.ok(!out.join("").includes("undefined"));
});

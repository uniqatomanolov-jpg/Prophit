/**
 * The arena ledger — pure functions, no I/O.
 *
 * WHY THIS EXISTS
 * ---------------
 * Logging a pick is not "append a row". It has to:
 *
 *   - refuse a duplicate (one model, one fixture, one round)
 *   - extend a tamper-evident hash chain
 *   - respect the daily budget and the per-bet cap
 *   - recompute every fighter's bankroll, profit and exposure
 *
 * The shipped build does all of that inside `localArena.ts`, in the browser,
 * against localStorage. That is why manual logging is fragile: the rules live
 * on the client, so anything that writes from anywhere else — a server route,
 * a script, a second tab — either reimplements them or silently breaks them.
 *
 * These functions are extracted so the SAME logic runs on the server, and the
 * server becomes the thing that decides. Pure and I/O-free so every rule below
 * is unit-testable without a database, a blob store, or a browser.
 *
 * COMPATIBILITY IS NOT OPTIONAL
 * -----------------------------
 * Every constant here was read out of the deployed bundle, not invented:
 *
 *   MODELS, INITIALS       assets/localArena-CHR0Gahc.js
 *   STARTING_BANKROLL      1000
 *   DAILY_LIMIT            100
 *   the hash preimage      [prev, id, model, event, market, pick,
 *                           odds.toFixed(3), stake.toFixed(2),
 *                           fair_prob?.toFixed(5) ?? '-', logged_at].join('|')
 *   the pick_id shape      R{round}-{INITIALS}-{HOMvsAWY}[-{MARKET}]
 *
 * A server that hashed differently would produce a ledger the site reports as
 * broken. `tests/ledger.test.mjs` pins the preimage against a vector taken
 * from the shipped implementation.
 */

import { createHash } from "node:crypto";

export const MODELS = ["Claude", "Grok", "ChatGPT", "Gemini", "Kimi"];

/** Short codes used inside pick_id. From the bundle — do not "improve" these. */
const INITIALS = {
  Claude: "CLA",
  Grok: "GRK",
  ChatGPT: "GPT",
  Gemini: "GEM",
  Kimi: "KMI",
};

export const STARTING_BANKROLL = 1000;
export const DAILY_LIMIT = 100;
export const TOTAL_ROUNDS = 12;

/** The first link. 64 zeroes, matching the client. */
export const GENESIS_HASH = "0".repeat(64);

export const OUTCOMES = new Set(["pending", "win", "loss", "void", "push"]);

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

const modelCode = (model) => INITIALS[model] ?? model.slice(0, 3).toUpperCase();

/** First word of a team name, alphanumerics only, three characters. */
function teamCode(name) {
  const word = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return word.replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase() || "UNK";
}

/**
 * "Arsenal v Chelsea" → "ARSvsCHE".
 *
 * TWO-SIDED FIXTURES — unchanged, and deliberately so
 * ---------------------------------------------------
 * Every football, NBA and NFL event is "A v B", and this branch produces
 * exactly what it always has. `pick_id` embeds this code and is the
 * duplicate-detection key, so altering it for existing data would silently
 * un-block a duplicate that had previously been refused.
 *
 * SINGLE-NAME EVENTS — the F1 fix
 * -------------------------------
 * A Grand Prix has no two sides, and the old fallback took the first two
 * words: "Monaco Grand Prix" and "Monza Grand Prix" both became MONvsGRA.
 * Two different races sharing a pick_id means the second is rejected as a
 * duplicate of the first — a whole race silently unloggable.
 *
 * Adding the session made it worse rather than better: "Monaco GP — Race" hit
 * the dash branch and became MONvsRAC, colliding with every other GP's race.
 *
 * THE DISCRIMINATOR
 * -----------------
 * A HYPHEN still separates two sides — "Spurs - Everton" is a fixture someone
 * typed, and it must keep producing SPUvsEVE or an existing pick_id changes
 * and a duplicate slips through. An EN or EM dash does not: that is what
 * `composeEventName` puts between a Grand Prix and its session, so those fall
 * through to the single-name branch and get a digest.
 *
 * The distinction is narrow but it is the one the data actually makes, and it
 * leaves every stored football pick_id byte-identical.
 */
export function eventCode(event) {
  const raw = String(event ?? "").trim();

  const byVs = raw.split(/\s+(?:vs?|v)\s+/i);
  if (byVs.length >= 2) return `${teamCode(byVs[0])}vs${teamCode(byVs[1])}`;

  // Hyphen: still a two-sided fixture. Unchanged from the original.
  const byHyphen = raw.split(/\s+-\s+/);
  if (byHyphen.length >= 2) return `${teamCode(byHyphen[0])}vs${teamCode(byHyphen[1])}`;

  // Single-name event: compact prefix for legibility, digest for uniqueness.
  const compact = raw.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase() || "EVENT";
  const digest = createHash("sha256")
    .update(raw.toLowerCase().replace(/\s+/g, " "))
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
  return `${compact}-${digest}`;
}

/**
 * The uniqueness key: one model, one fixture, one market, one round.
 *
 * This is what makes double-logging impossible rather than merely discouraged
 * — the same click twice produces the same key and the second is refused.
 */
export function pickId(round, model, event, market) {
  const base = `R${round}-${modelCode(model)}-${eventCode(event)}`;
  return market ? `${base}-${String(market).toUpperCase()}` : base;
}

/* ------------------------------------------------------------------ */
/* Hash chain                                                          */
/* ------------------------------------------------------------------ */

/**
 * The exact preimage the client hashes. Field order is load-bearing.
 *
 * `fair_prob` becomes "-" when absent rather than "null" or "": a null that
 * stringifies differently on two implementations silently forks the chain,
 * and the fork is only discovered when a visitor's integrity check fails.
 */
export function hashPreimage(bet, prevHash) {
  return [
    prevHash,
    bet.id,
    bet.model,
    bet.event,
    bet.market,
    bet.pick,
    Number(bet.odds).toFixed(3),
    Number(bet.stake).toFixed(2),
    bet.fair_prob == null ? "-" : Number(bet.fair_prob).toFixed(5),
    bet.logged_at,
  ].join("|");
}

export function hashBet(bet, prevHash) {
  return createHash("sha256").update(hashPreimage(bet, prevHash), "utf8").digest("hex");
}

/**
 * Walk the chain and report the first break.
 *
 * Returns `{ ok, brokenAt, expected, found }`. Bets without a stored hash are
 * skipped rather than failed — rows predating the chain are legitimate
 * history, and refusing to verify them would make the check permanently red.
 */
export function verifyChain(bets) {
  let prev = GENESIS_HASH;
  for (const bet of bets) {
    if (!bet.hash) {
      prev = bet.hash ?? prev;
      continue;
    }
    const expected = hashBet(bet, bet.prev_hash ?? prev);
    if (expected !== bet.hash) {
      return { ok: false, brokenAt: bet.id, expected, found: bet.hash };
    }
    prev = bet.hash;
  }
  return { ok: true, brokenAt: null };
}

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

/**
 * Profit on one settled bet.
 *
 * A void returns the stake: zero profit, not a loss. Mirrors
 * `src/lib/metrics.ts` and `003_performance.sql` exactly — three
 * implementations of this arithmetic exist and they must never disagree.
 */
export function betProfit(bet) {
  if (bet.result === "win") return Number(bet.stake) * (Number(bet.odds) - 1);
  if (bet.result === "loss") return -Number(bet.stake);
  return 0;
}

/** Local calendar day of an ISO timestamp, for the daily budget. */
function dayKey(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}

/**
 * Rebuild every fighter from the bets. Bets are the only source of truth.
 *
 * Storing a running bankroll alongside the bets means two numbers that can
 * disagree, and when they do there is no way to tell which is right. Deriving
 * it means a wrong bankroll is impossible by construction — fix the bet and
 * the standings follow.
 */
export function deriveFighters(bets, { round = 1, timeZone = "Europe/Sofia", now = new Date() } = {}) {
  const today = dayKey(now.toISOString(), timeZone);

  const fighters = {};
  for (const model of MODELS) {
    fighters[model] = {
      name: model,
      current_bankroll: STARTING_BANKROLL,
      starting_bankroll: STARTING_BANKROLL,
      profit: 0,
      wins: 0,
      losses: 0,
      voids: 0,
      daily_limit: DAILY_LIMIT,
      deployed_today: 0,
      pending: 0,
      open_positions: 0,
      remaining_today: DAILY_LIMIT,
    };
  }

  for (const bet of bets) {
    const f = fighters[bet.model];
    // A bet for an unknown model is data corruption, not a new fighter. It is
    // skipped here and surfaced by validation on the way in.
    if (!f) continue;

    const stake = Number(bet.stake) || 0;

    if (bet.result === "pending") {
      f.pending += stake;
      f.open_positions += 1;
    } else if (bet.result === "win") {
      f.wins += 1;
    } else if (bet.result === "loss") {
      f.losses += 1;
    } else if (bet.result === "void" || bet.result === "push") {
      f.voids += 1;
    }

    f.profit += betProfit(bet);

    /*
     * Budget is per DAY, not per round. A round can span days, and a round
     * that does spans two budgets — using the round here would let a model
     * stake 200 in a single 100-unit day without tripping anything.
     */
    if (dayKey(bet.logged_at, timeZone) === today) {
      f.deployed_today += stake;
    }
  }

  for (const model of MODELS) {
    const f = fighters[model];
    f.current_bankroll = round2(STARTING_BANKROLL + f.profit);
    f.profit = round2(f.profit);
    f.pending = round2(f.pending);
    f.deployed_today = round2(f.deployed_today);
    f.remaining_today = round2(Math.max(0, f.daily_limit - f.deployed_today));
  }

  return fighters;
}

/** Two decimals, without the float dust that makes 0.1+0.2 render as 0.30000000000000004. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export { round2 };

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Check one proposed pick against the arena's rules.
 *
 * Returns `{ ok, errors, warnings, normalised }`. Every problem is collected
 * rather than the first — an admin fixing a form one error per submit is an
 * admin who stops using the form.
 *
 * `normalised` is the cleaned input: trimmed strings, coerced numbers,
 * rounded stake. The caller writes THAT, never the raw body, so a value that
 * passed validation is guaranteed to be the value that lands.
 */
export function validatePick(input, options = {}) {
  const {
    bets = [],
    round = 1,
    timeZone = "Europe/Sofia",
    now = new Date(),
  } = options;

  const errors = [];
  const warnings = [];

  const model = typeof input?.model === "string" ? input.model.trim() : "";
  if (!MODELS.includes(model)) {
    errors.push(`Fighter must be one of: ${MODELS.join(", ")}.`);
  }

  const event = typeof input?.event === "string" ? input.event.trim() : "";
  if (event.length < 3) errors.push("Event is required.");
  if (event.length > 200) errors.push("Event is too long (max 200 characters).");

  const market = typeof input?.market === "string" ? input.market.trim() : "";
  if (!market) errors.push("Market is required.");
  if (market.length > 80) errors.push("Market is too long (max 80 characters).");

  const pick = typeof input?.pick === "string" ? input.pick.trim() : "";
  if (!pick) errors.push("Selection is required.");
  if (pick.length > 200) errors.push("Selection is too long (max 200 characters).");

  const odds = Number(input?.odds);
  if (!Number.isFinite(odds)) errors.push("Odds must be a number.");
  else if (odds <= 1) errors.push("Odds must be greater than 1.00.");
  else if (odds > 1000) errors.push("Odds above 1000 are not accepted.");

  const stakeRaw = Number(input?.stake);
  if (!Number.isFinite(stakeRaw)) errors.push("Stake must be a number.");
  else if (stakeRaw <= 0) errors.push("Stake must be greater than zero.");
  else if (stakeRaw > 100000) errors.push("Stake is implausibly large.");
  const stake = Number.isFinite(stakeRaw) ? round2(stakeRaw) : 0;

  /*
   * Probability accepts a decimal or a percentage.
   *
   * A human typing "58" means 58%, and a value above 1 cannot be a
   * probability, so the coercion is unambiguous rather than a guess. Getting
   * this wrong silently is how a 58% edge becomes a 5800% one.
   */
  let fairProb = null;
  if (input?.fair_prob !== undefined && input?.fair_prob !== null && input?.fair_prob !== "") {
    const raw = Number(input.fair_prob);
    if (!Number.isFinite(raw)) {
      errors.push("Probability must be a number.");
    } else if (raw > 1 && raw <= 100) {
      fairProb = raw / 100;
      warnings.push(`Probability ${raw} read as ${(raw / 100).toFixed(4)}.`);
    } else if (raw > 0 && raw < 1) {
      fairProb = raw;
    } else {
      errors.push("Probability must be between 0 and 1 (or 1–100 as a percentage).");
    }
  }

  /*
   * The thesis is required, and that is a product decision rather than a
   * validation reflex.
   *
   * The public site already ships a rationale drawer — a slide-in panel that
   * typewriter-reveals `bet.reasoning` — and an inline "Quant breakdown"
   * expander on every bet card. BOTH are gated on `bet.reasoning &&` in the
   * compiled bundle. A pick logged without a thesis therefore renders as a
   * card with no explanation and no way to open one, which reads to a visitor
   * as a broken feature rather than as a missing field.
   *
   * The whole claim of this site is that you can see WHY each model played
   * what it played. Letting a pick through without that quietly falsifies the
   * claim, so it is refused at the point of entry.
   *
   * MIN_THESIS is 20 characters — long enough to exclude "value" and "good
   * price", short enough not to obstruct a genuinely terse note.
   */
  const MIN_THESIS = 20;
  const reasoning = typeof input?.reasoning === "string" ? input.reasoning.trim() : "";
  const requireReasoning = options.requireReasoning !== false;

  if (reasoning.length > 4000) {
    errors.push("Thesis is too long (max 4000 characters).");
  } else if (requireReasoning && reasoning.length === 0) {
    errors.push(
      "Thesis is required — it is what the public rationale drawer publishes. " +
        "A pick without one shows visitors no explanation at all.",
    );
  } else if (requireReasoning && reasoning.length < MIN_THESIS) {
    errors.push(
      `Thesis is too short (${reasoning.length} characters, minimum ${MIN_THESIS}). ` +
        "Say what the edge is and what would make the read wrong.",
    );
  }

  const riskFactors = typeof input?.risk_factors === "string" ? input.risk_factors.trim() : "";
  if (riskFactors.length > 2000) errors.push("Risk factors are too long (max 2000 characters).");

  const confidenceRaw = input?.confidence;
  let confidence = null;
  if (confidenceRaw !== undefined && confidenceRaw !== null && confidenceRaw !== "") {
    const c = Number(confidenceRaw);
    if (!Number.isFinite(c) || c < 0 || c > 100) errors.push("Confidence must be 0–100.");
    else confidence = Math.round(c);
  }

  const ref = input?.ref === undefined || input?.ref === null || input?.ref === "" ? null : Number(input.ref);
  if (ref !== null && (!Number.isInteger(ref) || ref < 1)) {
    errors.push("Board reference must be a positive whole number.");
  }

  // Nothing below this point can run without the fields above.
  if (errors.length) return { ok: false, errors, warnings, normalised: null };

  /* ---- duplicate ---- */
  const id = pickId(round, model, event, market);
  if (bets.some((b) => b.pick_id === id)) {
    errors.push(
      `${model} already has a pick on this fixture and market in round ${round} (${id}). ` +
        `Delete the existing pick first if you meant to replace it.`,
    );
  }

  /* ---- budget ---- */
  const fighters = deriveFighters(bets, { round, timeZone, now });
  const f = fighters[model];

  if (f) {
    if (stake > f.remaining_today) {
      errors.push(
        `Stake ${stake} exceeds ${model}'s remaining budget today ` +
          `(${f.remaining_today} of ${f.daily_limit}).`,
      );
    }
    if (stake > f.current_bankroll) {
      errors.push(`Stake ${stake} exceeds ${model}'s bankroll (${f.current_bankroll}).`);
    }
    // A warning, not a block: a deliberate large play is the admin's call.
    if (stake > f.current_bankroll * 0.1) {
      warnings.push(
        `Stake ${stake} is over 10% of ${model}'s bankroll (${f.current_bankroll}).`,
      );
    }
  }

  /* ---- edge, for information ---- */
  if (fairProb !== null) {
    const ev = (fairProb * (odds - 1) - (1 - fairProb)) * 100;
    if (ev < 0) {
      warnings.push(
        `Negative expected value (${ev.toFixed(1)}%) — the stated probability is below the price.`,
      );
    }
  }

  if (errors.length) return { ok: false, errors, warnings, normalised: null };

  return {
    ok: true,
    errors: [],
    warnings,
    normalised: {
      model,
      event,
      market,
      pick,
      odds,
      stake,
      fair_prob: fairProb,
      reasoning: reasoning || null,
      risk_factors: riskFactors || null,
      confidence,
      ref,
      round,
      pick_id: id,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Append                                                              */
/* ------------------------------------------------------------------ */

/**
 * Append a validated pick, extending the hash chain.
 *
 * Takes the whole bets array and returns a NEW one — no mutation. That makes
 * the caller's read-modify-write explicit, which matters because the write is
 * guarded by an ETag and a mutated array would make a retry non-idempotent.
 */
export function appendPick(bets, normalised, { now = new Date() } = {}) {
  const loggedAt = now.toISOString();
  const nextId = bets.reduce((max, b) => Math.max(max, Number(b.id) || 0), 0) + 1;
  const prevHash = bets.length ? (bets[bets.length - 1].hash ?? GENESIS_HASH) : GENESIS_HASH;

  const bet = {
    id: nextId,
    model: normalised.model,
    event: normalised.event,
    market: normalised.market,
    pick: normalised.pick,
    odds: normalised.odds,
    stake: normalised.stake,
    fair_prob: normalised.fair_prob,
    result: "pending",
    created_at: loggedAt,
    logged_at: loggedAt,
    odds_at_pick: normalised.odds,
    prev_hash: prevHash,
    pick_id: normalised.pick_id,
    round: normalised.round,
    source: "manual",
  };

  // Edge in percentage points, matching the client's derivation.
  if (normalised.fair_prob != null) {
    bet.edge = round2((normalised.fair_prob - 1 / normalised.odds) * 100);
  }

  /*
   * The thesis fields. `reasoning` is what the existing UI already reads, so
   * it is written unconditionally; `core_thesis` carries the same text under
   * the schema name so the drawer and the parser agree on one field.
   */
  if (normalised.reasoning) {
    bet.reasoning = normalised.reasoning;
    bet.core_thesis = normalised.reasoning;
  }
  if (normalised.risk_factors) bet.risk_factors = normalised.risk_factors;
  if (normalised.confidence != null) bet.confidence = normalised.confidence;
  if (normalised.ref != null) bet.ref = normalised.ref;

  bet.hash = hashBet(bet, prevHash);

  return [...bets, bet];
}

/**
 * Remove a pick by id and REBUILD the chain from that point.
 *
 * Deleting a link without rehashing what follows leaves a ledger that reports
 * itself as tampered — which is exactly the alarm the chain exists to raise,
 * fired by our own correction. Rehashing keeps the guarantee meaningful: the
 * chain proves nothing was altered *silently*, not that nothing was ever
 * corrected.
 */
export function removePick(bets, id) {
  const target = Number(id);
  const index = bets.findIndex((b) => Number(b.id) === target);
  if (index === -1) return { ok: false, reason: "not-found", bets };

  const kept = bets.filter((b) => Number(b.id) !== target);

  let prev = GENESIS_HASH;
  const rebuilt = kept.map((bet) => {
    const next = { ...bet, prev_hash: prev };
    next.hash = hashBet(next, prev);
    prev = next.hash;
    return next;
  });

  return { ok: true, bets: rebuilt, removed: bets[index] };
}

/**
 * The full arena payload, ready to store.
 *
 * Fighters are always derived here rather than carried through, so a caller
 * cannot accidentally persist a stale standings object alongside fresh bets.
 */
export function buildArena(bets, options = {}) {
  const {
    round = 1,
    status = "open",
    timeZone = "Europe/Sofia",
    now = new Date(),
    events = null,
  } = options;

  const fighters = deriveFighters(bets, { round, timeZone, now });

  /*
   * `events` must be threaded through explicitly.
   *
   * This function rebuilds the WHOLE arena object, so anything it does not
   * carry forward is destroyed. An earlier version omitted the match board,
   * which meant every logged pick and every settlement silently wiped every
   * fixture the admin had priced — the board vanished and nothing said why.
   *
   * Defaulting to null rather than [] is the safer failure: a caller that
   * forgets leaves `events` absent, and `eventsOf()` reads absent as empty,
   * rather than an explicit empty array that looks like a deliberate wipe.
   */
  return {
    bets,
    ...(events === null ? {} : { events }),
    fighters,
    round: { round, status },
    total_rounds: TOTAL_ROUNDS,
    leaderboard: MODELS.map((m) => fighters[m]).sort(
      (a, b) => b.current_bankroll - a.current_bankroll,
    ),
    integrity: verifyChain(bets),
  };
}

/* ------------------------------------------------------------------ */
/* Thesis coverage                                                     */
/* ------------------------------------------------------------------ */

/**
 * How many picks would actually render a rationale drawer.
 *
 * The public bundle gates both the drawer and the inline "Quant breakdown"
 * expander on `bet.reasoning &&`. Anything without it is invisible to a
 * visitor looking for the WHY, so this counts the gap and names the picks
 * responsible — a number the admin can act on instead of discovering the
 * omission from the live site.
 */
export function thesisCoverage(bets) {
  const total = bets.length;
  const withThesis = bets.filter(
    (b) => typeof b.reasoning === "string" && b.reasoning.trim().length > 0,
  ).length;

  return {
    total,
    withThesis,
    missing: total - withThesis,
    percent: total === 0 ? 100 : Math.round((withThesis / total) * 100),
    /** Capped: the admin needs the first few to act, not a wall of ids. */
    missingIds: bets
      .filter((b) => !(typeof b.reasoning === "string" && b.reasoning.trim().length > 0))
      .map((b) => b.id)
      .slice(0, 20),
  };
}

/* ------------------------------------------------------------------ */
/* Settlement                                                          */
/* ------------------------------------------------------------------ */

/**
 * What one result pays.
 *
 *   win        payout = stake x odds      profit = stake x (odds - 1)
 *   loss       payout = 0                 profit = -stake
 *   void/push  payout = stake             profit = 0        (100% refund)
 *
 * `payout` is the gross return including the stake; `profit` is what moves the
 * bankroll. Keeping both explicit matters because they are easy to conflate,
 * and conflating them double-counts the stake on every winner.
 */
export function payoutFor(bet, result = bet.result) {
  const stake = Number(bet.stake) || 0;
  const odds = Number(bet.odds) || 0;

  if (result === "win") {
    const payout = round2(stake * odds);
    return { payout, profit: round2(payout - stake), stakeReturned: true };
  }
  if (result === "loss") {
    return { payout: 0, profit: round2(-stake), stakeReturned: false };
  }
  if (result === "void" || result === "push") {
    return { payout: round2(stake), profit: 0, stakeReturned: true };
  }
  // Still pending: nothing has moved.
  return { payout: null, profit: 0, stakeReturned: null };
}

/**
 * Settle one bet, returning a NEW bets array.
 *
 * The hash chain is untouched, and that is by design rather than an oversight:
 * the preimage covers id, model, event, market, pick, odds, stake, fair_prob
 * and logged_at — everything chosen BEFORE the event ran. A result is not part
 * of the commitment, so grading a bet cannot invalidate the chain, and the
 * chain still proves the pick was not edited after the fact. That is exactly
 * the property worth having.
 *
 * Re-grading an already-settled bet is allowed — results get corrected — but
 * the previous result is returned so the caller can record what changed.
 */
export function settleBet(bets, id, result, { now = new Date() } = {}) {
  if (!OUTCOMES.has(result)) {
    return { ok: false, reason: "bad-result", bets };
  }

  const target = Number(id);
  const index = bets.findIndex((b) => Number(b.id) === target);
  if (index === -1) return { ok: false, reason: "not-found", bets };

  const before = bets[index];
  const previousResult = before.result ?? "pending";
  if (previousResult === result) {
    return { ok: false, reason: "no-change", bets, bet: before };
  }

  const money = payoutFor(before, result);

  const settled = {
    ...before,
    result,
    // A bet returned to pending must lose its settlement stamp, or it reads
    // as graded-and-open at the same time.
    settled_at: result === "pending" ? null : now.toISOString(),
    payout: money.payout,
    profit: money.profit,
  };
  if (result === "pending") {
    delete settled.payout;
    delete settled.profit;
  }

  const next = bets.slice();
  next[index] = settled;

  return { ok: true, bets: next, bet: settled, previousResult, money };
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/** Events out of whatever shape the stored arena is in. Never throws. */
export function eventsOf(data) {
  return Array.isArray(data?.events) ? data.events : [];
}

/**
 * A stable id for an event, so a pick can reference it without a join.
 *
 * Derived from the same code `pick_id` uses, which means an event and the
 * picks on it agree by construction rather than by a foreign key someone has
 * to maintain.
 */
export function eventIdFor(sport, name, startsAt) {
  const day = String(startsAt ?? "").slice(0, 10) || "nodate";
  return `${sport}-${eventCode(name)}-${day}`;
}

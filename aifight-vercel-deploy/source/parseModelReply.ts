/**
 * The unified reply parser.
 *
 * WHAT IT DOES
 * ------------
 * Takes whatever a model actually sent and returns rows the arena can trust.
 * Three input formats are accepted, in priority order:
 *
 *   1. The schema object   `{ analysis: [...], picks: [...] }`  — what
 *                          PERSONA_CONTRACT asks for.
 *   2. A bare picks array  `[ { ref: 7, ... } ]`                — what models
 *                          send when they skip the wrapper.
 *   3. Labelled plain text `PICK 1 / ref: 7 / stake: 45`        — the previous
 *                          format, kept because a round's analysis is too
 *                          expensive to lose to a formatting slip.
 *
 * WHY THE FALLBACK CHAIN EXISTS
 * -----------------------------
 * A prompt asking for JSON gets JSON roughly nine times in ten. The tenth is
 * a smart quote, a trailing comma, an apology before the brace, or a model
 * that decided a markdown table was clearer. Each of those is a whole round's
 * work destroyed by a syntax error. The recovery ladder below is not
 * defensive programming for its own sake — it is the difference between an
 * arena that runs unattended and one that needs a human to re-prompt.
 *
 * THE TRUST MODEL — this is the important part
 * --------------------------------------------
 * Exactly three things the model sends are load-bearing:
 *
 *   ref                     which outcome (validated against the board)
 *   estimated_probability   its belief (used for Kelly and for scoring)
 *   stake                   its conviction (clamped by the rules)
 *
 * Everything else is either derived by us or recorded as a claim to be scored
 * later:
 *
 *   odds                the BOARD's price, always. The model's is discarded.
 *   ev                  RECOMPUTED from probability and board odds.
 *   calculated_ev       stored as `claimed_ev`, never used for sizing. The
 *                       gap between claim and truth is a calibration metric.
 *   predicted_outcome   cross-checked against the board label. A mismatch is
 *                       flagged, because a model that typed one outcome and
 *                       selected another is the failure a text-only schema
 *                       cannot detect at all.
 *
 * A model therefore cannot move a bankroll by lying, miscounting, or
 * hallucinating a price. The worst it can do is be wrong, which is the entire
 * point of the contest.
 */

import type { BoardIndexEntry } from "@/lib/promptBoard";
import type { ChallengeRules } from "@/lib/challenge";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Severity = "block" | "warn";

export type Violation = {
  code: ViolationCode;
  severity: Severity;
  message: string;
};

export type ViolationCode =
  | "unknown-ref"
  | "duplicate-ref"
  | "no-price"
  | "odds-out-of-range"
  | "probability-missing"
  | "probability-invalid"
  | "stake-missing"
  | "stake-over-cap"
  | "stake-over-budget"
  | "stake-below-floor"
  | "negative-ev"
  | "below-min-ev"
  | "over-kelly"
  | "outcome-mismatch"
  | "ev-claim-inflated"
  | "too-many-picks"
  | "non-english";

export type ResolvedPick = {
  model: string;

  /** Board coordinates. Resolved, never taken from the model. */
  ref: number;
  outcome_id: number;
  market_id: number;
  event_id: number;

  /** Denormalised for display and for the legacy `bets` columns. */
  event: string;
  market: string;
  pick: string;

  /** ALWAYS from the board. */
  odds: number;

  /** After clamping. `requested_stake` preserves what was asked for. */
  stake: number;
  requested_stake: number;

  /** The model's probability, validated. */
  true_prob: number;

  /** Recomputed by us from `true_prob` and `odds`. Percentage points. */
  ev: number;

  /** What the model claimed its EV was. Scored, never trusted. */
  claimed_ev: number | null;
  /** claimed_ev − ev. Positive means the model oversold its own edge. */
  ev_claim_error: number | null;

  /** Full-Kelly and fractional-Kelly stakes at the board price. */
  kelly_full: number;
  kelly_fraction: number;

  confidence?: number | undefined;
  /** The model's own words for the outcome, kept for audit. */
  predicted_outcome?: string | undefined;
  core_thesis?: string | undefined;
  risk_factors?: string | undefined;
  reasoning?: string | undefined;

  warnings: string[];
  violations: Violation[];
};

export type ResolvedPreview = {
  model: string;
  event_id: number;
  eventName: string;
  headline?: string | undefined;
  form?: string | undefined;
  team_news?: string | undefined;
  tactical?: string | undefined;
  trend?: string | undefined;
  x_factor?: string | undefined;
  risk?: string | undefined;
  confidence?: number | undefined;
  missing: string[];
};

export type ParseResult = {
  picks: ResolvedPick[];
  /** Picks dropped for a blocking violation, with the reason. */
  rejected: { ref: number | null; violations: Violation[] }[];
  previews: ResolvedPreview[];
  errors: string[];
  passed: boolean;
  totalStake: number;
  /** Which of the three input formats was actually used. */
  format: "schema" | "picks-array" | "text" | "none";
};

export type BankrollState = {
  bankroll: number;
  stakedToday: number;
  openPositions: number;
};

export type ParseOptions = {
  model: string;
  index: Map<number, BoardIndexEntry>;
  eventIndex?: Map<number, { event_id: number; name: string }> | undefined;
  rules?: ChallengeRules | undefined;
  state?: BankrollState | undefined;
  /** Drop picks with a blocking violation rather than importing them flagged. */
  rejectViolations?: boolean | undefined;
  maxPicks?: number | undefined;
  /** Treat a zero-pick reply as a failure. Default true — passing is banned. */
  requirePicks?: boolean | undefined;
};

/* ------------------------------------------------------------------ */
/* JSON recovery                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normalise the characters chat UIs substitute behind a model's back.
 *
 * Smart quotes are the single most common cause of a valid-looking reply that
 * `JSON.parse` refuses. Non-breaking spaces and minus signs are rarer but fail
 * the same way, silently, and are equally cheap to fix.
 */
function normaliseGlyphs(text: string): string {
  return text
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/−/g, "-")
    .replace(/ /g, " ")
    .replace(/﻿/g, "");
}

/**
 * Find the outermost balanced JSON value in a blob of text.
 *
 * A regex cannot do this — `/\{.*\}/s` matches from the first brace to the
 * last, which spans two separate objects when a model emits a preamble
 * example followed by the real answer. This walks the string tracking depth
 * and string state, so braces inside string literals are ignored, and returns
 * the first genuinely balanced value.
 */
function extractBalanced(text: string, open: "{" | "["): string | null {
  const close = open === "{" ? "}" : "]";
  const start = text.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse JSON, repairing the two errors models actually make.
 *
 * Trailing commas and unquoted keys are both syntactically invalid and both
 * unambiguous to repair. The repair pass runs only after a clean parse has
 * already failed, so well-formed input is never touched.
 */
function parseLenient(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through to repair */
  }

  const repaired = candidate
    // Trailing comma before a closing brace or bracket.
    .replace(/,(\s*[}\]])/g, "$1")
    // Unquoted object keys: `{ ref: 7 }` → `{ "ref": 7 }`.
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

type RawPayload = { picks: unknown[]; analysis: unknown[]; format: ParseResult["format"] };

/**
 * Pull a payload out of a reply, whatever wrapper it arrived in.
 *
 * Ordered by confidence. Code fences first because a fenced block is an
 * explicit "this is the data" marker and is never ambiguous; free-floating
 * braces last because those are where a quoted example can be mistaken for
 * the answer.
 */
function extractJsonPayload(raw: string): RawPayload | null {
  const text = normaliseGlyphs(raw);
  const candidates: string[] = [];

  // 1. Fenced blocks, in order of appearance.
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (m[1]?.trim()) candidates.push(m[1].trim());
  }

  // 2. The first balanced object, then the first balanced array.
  const obj = extractBalanced(text, "{");
  if (obj) candidates.push(obj);
  const arr = extractBalanced(text, "[");
  if (arr) candidates.push(arr);

  // 3. The whole reply, in case it is already clean JSON.
  candidates.push(text.trim());

  for (const candidate of candidates) {
    const value = parseLenient(candidate);
    if (value === null || typeof value !== "object") continue;

    if (Array.isArray(value)) {
      // A bare array is only a picks array if its members look like picks.
      const looksLikePicks = value.some(
        (row) => row && typeof row === "object" && ("ref" in row || "stake" in row),
      );
      if (looksLikePicks) return { picks: value, analysis: [], format: "picks-array" };
      continue;
    }

    const record = value as Record<string, unknown>;
    const picks = Array.isArray(record.picks)
      ? record.picks
      : Array.isArray(record.selections)
        ? record.selections
        : Array.isArray(record.bets)
          ? record.bets
          : null;
    const analysis = Array.isArray(record.analysis)
      ? record.analysis
      : Array.isArray(record.previews)
        ? record.previews
        : [];

    // An object carrying analysis but no picks is still a valid schema reply —
    // it means the model wrote previews and staked nothing, which is a real
    // (if forbidden) answer and must be reported as such, not as a parse fail.
    if (picks || analysis.length) {
      return { picks: picks ?? [], analysis, format: "schema" };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Field readers                                                       */
/* ------------------------------------------------------------------ */

function firstNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  // Handles "€45", "45 units", "+8.4%", "8,5" (comma decimal).
  const match = value.replace(/,(\d{1,2})\b/, ".$1").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function readString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    // Some models emit an array of bullet strings for a prose field.
    if (Array.isArray(value)) {
      const joined = value.filter((v) => typeof v === "string").join(" ").trim();
      if (joined) return joined;
    }
  }
  return undefined;
}

function readNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (key in row) {
      const n = firstNumber(row[key]);
      if (n !== null) return n;
    }
  }
  return null;
}

/**
 * Read a probability, coercing the two forms models mix up.
 *
 * The contract asks for a decimal. Models send percentages anyway — roughly
 * one reply in six. A value above 1 is unambiguously a percentage (a
 * probability cannot exceed 1), so dividing by 100 is a safe repair rather
 * than a guess. Below 1 it is taken at face value, and a note records the
 * coercion so the admin can see it happened.
 */
function readProbability(row: Record<string, unknown>): {
  value: number | null;
  note?: string;
} {
  const raw = readNumber(row, [
    "estimated_probability",
    "probability",
    "prob",
    "true_prob",
    "p",
    "my_probability",
  ]);
  if (raw === null) return { value: null };

  if (raw > 1 && raw <= 100) {
    return { value: raw / 100, note: `probability ${raw} read as ${(raw / 100).toFixed(4)}` };
  }
  if (raw > 0 && raw < 1) return { value: raw };
  return { value: null, note: `probability ${raw} is outside 0-1` };
}

/**
 * Normalise a label for comparison.
 *
 * Used to decide whether `predicted_outcome` agrees with the board. Strips
 * punctuation, case and the filler words models add ("to win", "Full Time"),
 * so "Arsenal" and "Arsenal to win (FT)" compare equal while "Arsenal" and
 * "Chelsea" do not.
 */
function normaliseLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/\((?:ft|full ?time|90 ?min[a-z]*)\)/g, " ")
    .replace(/\b(?:to win|win|wins|the|match|result|outright|ft|full ?time)\b/g, " ")
    .replace(/[^a-z0-9.+-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Do the model's words and the board's label describe the same outcome?
 *
 * Tolerant on purpose. The check exists to catch a model selecting ref 7 while
 * describing ref 9 — a real, silent, money-moving error. It is not there to
 * police phrasing, so containment in either direction counts as agreement.
 */
function outcomeAgrees(predicted: string, boardLabel: string): boolean {
  const a = normaliseLabel(predicted);
  const b = normaliseLabel(boardLabel);
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  // Token overlap, for "Over 2.5 Goals" vs "Over 2.5".
  const tokensA = new Set(a.split(" ").filter((t) => t.length > 1));
  const tokensB = new Set(b.split(" ").filter((t) => t.length > 1));
  if (tokensA.size === 0 || tokensB.size === 0) return true;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  return shared / Math.min(tokensA.size, tokensB.size) >= 0.5;
}

/** Latin-script check. The five previews publish side by side in English. */
const NON_LATIN = /[Ѐ-ӿ֐-׿؀-ۿऀ-ॿ぀-ヿ一-鿿가-힯]/;

export function looksNonEnglish(text: string): boolean {
  if (!text) return false;
  const matches = text.match(new RegExp(NON_LATIN, "g"));
  // A single stray character is a name, not a language. 3% is a reply.
  return (matches?.length ?? 0) / text.length > 0.03;
}

/* ------------------------------------------------------------------ */
/* Financial maths                                                     */
/* ------------------------------------------------------------------ */

/**
 * Expected value as a percentage of stake.
 *
 *   EV% = (p × (odds − 1) − (1 − p)) × 100
 *
 * Computed from OUR odds and the model's stated probability. The model's own
 * `calculated_ev` never enters this, which is what makes the leaderboard
 * honest: a model cannot buy a better-looking position by inflating a number.
 */
export function expectedValue(probability: number, odds: number): number {
  return (probability * (odds - 1) - (1 - probability)) * 100;
}

/**
 * Full-Kelly stake as a fraction of bankroll.
 *
 *   f* = (p × (b) − (1 − p)) / b,  where b = odds − 1
 *
 * Clamped at zero: a negative Kelly means "lay this", and the arena has no lay
 * market, so the correct stake is nothing.
 */
export function kellyFraction(probability: number, odds: number): number {
  const b = odds - 1;
  if (b <= 0) return 0;
  return Math.max(0, (probability * b - (1 - probability)) / b);
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

const PREVIEW_FIELDS = [
  "headline",
  "form",
  "team_news",
  "tactical",
  "trend",
  "x_factor",
  "risk",
] as const;

const PREVIEW_ALIASES: Record<(typeof PREVIEW_FIELDS)[number], string[]> = {
  headline: ["headline", "summary", "one_liner", "thesis"],
  form: ["form", "recent_form", "results"],
  team_news: ["team_news", "teamnews", "news", "injuries", "availability"],
  tactical: ["tactical", "tactics", "matchup", "setup"],
  trend: ["trend", "trends", "pattern", "statistical_trend"],
  x_factor: ["x_factor", "xfactor", "edge", "market_blind_spot"],
  risk: ["risk", "risks", "risk_factors", "downside", "failure_mode"],
};

function resolvePick(
  row: Record<string, unknown>,
  options: ParseOptions,
  seenRefs: Set<number>,
  budget: { remaining: number },
): { pick: ResolvedPick | null; violations: Violation[]; ref: number | null } {
  const violations: Violation[] = [];
  const warnings: string[] = [];
  const add = (code: ViolationCode, severity: Severity, message: string) =>
    violations.push({ code, severity, message });

  /* --- ref: the only thing that selects a bet --- */
  const ref = readNumber(row, ["ref", "reference", "selection", "board_ref", "number", "id"]);
  if (ref === null) {
    add("unknown-ref", "block", "No reference number in this pick.");
    return { pick: null, violations, ref: null };
  }

  const entry = options.index.get(ref);
  if (!entry) {
    add("unknown-ref", "block", `Reference [${ref}] is not on the board. The model invented it.`);
    return { pick: null, violations, ref };
  }
  if (seenRefs.has(ref)) {
    add("duplicate-ref", "block", `Reference [${ref}] was selected twice.`);
    return { pick: null, violations, ref };
  }

  /* --- price: ours, always --- */
  const odds = entry.odds;
  if (odds === null || !Number.isFinite(odds) || odds <= 1) {
    add("no-price", "block", `Reference [${ref}] has no usable price on the board.`);
    return { pick: null, violations, ref };
  }
  if (options.rules) {
    if (odds < options.rules.minOdds || odds > options.rules.maxOdds) {
      add(
        "odds-out-of-range",
        "block",
        `Price ${odds.toFixed(2)} is outside the permitted ${options.rules.minOdds.toFixed(2)}–${options.rules.maxOdds.toFixed(2)}.`,
      );
    }
  }

  /* --- probability --- */
  const prob = readProbability(row);
  if (prob.note) warnings.push(prob.note);
  if (prob.value === null) {
    add(
      "probability-missing",
      "block",
      "No usable probability. Without it the pick cannot be sized or scored.",
    );
    return { pick: null, violations, ref };
  }
  const probability = prob.value;
  if (probability <= 0.01 || probability >= 0.99) {
    add("probability-invalid", "warn", `Probability ${probability} is implausibly extreme.`);
  }

  /* --- outcome cross-check: the reason both fields exist --- */
  const predicted = readString(row, ["predicted_outcome", "outcome", "pick", "selection_label"]);
  if (predicted && !outcomeAgrees(predicted, entry.label)) {
    add(
      "outcome-mismatch",
      "warn",
      `Model selected [${ref}] "${entry.label}" but described it as "${predicted}". ` +
        `The board reference is authoritative — verify this was the intended selection.`,
    );
  }

  /* --- EV: recomputed, then compared against the claim --- */
  const ev = expectedValue(probability, odds);
  const claimedEv = readNumber(row, ["calculated_ev", "ev", "expected_value", "edge"]);
  const evClaimError = claimedEv === null ? null : claimedEv - ev;

  if (evClaimError !== null && evClaimError > 5) {
    add(
      "ev-claim-inflated",
      "warn",
      `Model claimed +${claimedEv!.toFixed(1)}% EV; the board price gives +${ev.toFixed(1)}%. ` +
        `Overstated by ${evClaimError.toFixed(1)} points.`,
    );
  }
  if (ev < 0) {
    add("negative-ev", "block", `Negative expected value (${ev.toFixed(1)}%) at the board price.`);
  } else if (options.rules && ev < options.rules.minEv * 100) {
    add(
      "below-min-ev",
      "warn",
      `EV ${ev.toFixed(1)}% is under the ${(options.rules.minEv * 100).toFixed(0)}% floor.`,
    );
  }

  /* --- staking --- */
  const requested = readNumber(row, ["stake", "amount", "size", "units"]);
  if (requested === null || requested <= 0) {
    add("stake-missing", "block", "No stake. A pick with no money behind it is not a position.");
    return { pick: null, violations, ref };
  }

  const kFull = kellyFraction(probability, odds);
  const kFrac = kFull * (options.rules?.kellyFraction ?? 0.25);

  let stake = Math.round(requested);
  const bankroll = options.state?.bankroll ?? 0;

  if (options.rules && bankroll > 0) {
    const cap = Math.floor(bankroll * options.rules.maxStakeFraction);
    if (stake > cap) {
      add(
        "stake-over-cap",
        "warn",
        `Stake ${requested} exceeds the ${(options.rules.maxStakeFraction * 100).toFixed(0)}% cap; clamped to ${cap}.`,
      );
      stake = cap;
    }

    const floor = Math.max(1, Math.round(bankroll * 0.01));
    if (stake < floor) {
      add("stake-below-floor", "warn", `Stake ${stake} is below the ${floor} minimum.`);
    }

    /*
     * Kelly ceiling.
     *
     * A model that states p = 0.52 and then stakes 40% of its bankroll has
     * contradicted its own number. Kelly is the arithmetic link between belief
     * and size, so a stake far above it is not aggression, it is an
     * inconsistency — and left unclamped it is also the fastest route to a
     * bust bankroll that tells the audience nothing.
     */
    const kellyStake = Math.floor(bankroll * kFrac);
    if (kellyStake > 0 && stake > kellyStake * 2) {
      add(
        "over-kelly",
        "warn",
        `Stake ${stake} is more than double the ${(options.rules.kellyFraction * 100).toFixed(0)}% Kelly stake of ${kellyStake}; clamped.`,
      );
      stake = Math.max(1, kellyStake * 2);
    }
  }

  if (stake > budget.remaining) {
    add(
      "stake-over-budget",
      "warn",
      `Stake ${stake} exceeds the ${budget.remaining} left in this round's budget; clamped.`,
    );
    stake = Math.max(0, Math.floor(budget.remaining));
  }
  if (stake <= 0) {
    add("stake-over-budget", "block", "No budget remaining for this pick.");
    return { pick: null, violations, ref };
  }
  budget.remaining -= stake;
  seenRefs.add(ref);

  const thesis = readString(row, ["core_thesis", "thesis", "reasoning", "rationale", "why"]);
  const risk = readString(row, ["risk_factors", "risks", "risk", "downside"]);
  const confidence = readNumber(row, ["confidence_score", "confidence", "conviction"]);

  if (thesis && looksNonEnglish(thesis)) {
    add("non-english", "block", "The thesis is not in English.");
  }

  return {
    ref,
    violations,
    pick: {
      model: options.model,
      ref,
      outcome_id: entry.outcome_id,
      market_id: entry.market_id,
      event_id: entry.event_id,
      event: entry.eventName,
      market: entry.marketLabel,
      pick: entry.label,
      odds,
      stake,
      requested_stake: Math.round(requested),
      true_prob: probability,
      ev,
      claimed_ev: claimedEv,
      ev_claim_error: evClaimError,
      kelly_full: kFull,
      kelly_fraction: kFrac,
      confidence: confidence ?? undefined,
      predicted_outcome: predicted,
      core_thesis: thesis,
      risk_factors: risk,
      reasoning: thesis,
      warnings,
      violations,
    },
  };
}

function resolvePreview(
  row: Record<string, unknown>,
  options: ParseOptions,
): ResolvedPreview | null {
  const eventNo = readNumber(row, ["event", "event_no", "event_number", "fixture"]);
  if (eventNo === null) return null;

  const target = options.eventIndex?.get(eventNo);
  if (!target) return null;

  const preview: ResolvedPreview = {
    model: options.model,
    event_id: target.event_id,
    eventName: target.name,
    confidence: readNumber(row, ["confidence_score", "confidence"]) ?? undefined,
    missing: [],
  };

  for (const field of PREVIEW_FIELDS) {
    const value = readString(row, PREVIEW_ALIASES[field]);
    if (value) preview[field] = value;
    else preview.missing.push(field);
  }

  // An entirely empty shell must not claim its event — the real preview may
  // arrive later in the reply and would then be discarded as a duplicate.
  if (preview.missing.length === PREVIEW_FIELDS.length) return null;
  return preview;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Parse a model's reply into arena rows.
 *
 * `textFallback` is injected rather than imported so this module stays free of
 * the legacy parser's dependencies and can be unit-tested in isolation. In the
 * app it is wired to `parseBoardReply` from `parseBoardReply.ts`.
 */
export function parseModelReply(
  raw: string,
  options: ParseOptions,
  textFallback?: (raw: string, options: ParseOptions) => ParseResult | null,
): ParseResult {
  const errors: string[] = [];
  const requirePicks = options.requirePicks ?? true;
  const maxPicks = options.maxPicks ?? 3;

  if (typeof raw !== "string" || !raw.trim()) {
    return {
      picks: [],
      rejected: [],
      previews: [],
      errors: ["Empty reply."],
      passed: false,
      totalStake: 0,
      format: "none",
    };
  }

  const payload = extractJsonPayload(raw);

  if (!payload) {
    const recovered = textFallback?.(raw, options);
    if (recovered) return recovered;
    return {
      picks: [],
      rejected: [],
      previews: [],
      errors: [
        "Could not read this reply. Expected a JSON object with `analysis` and `picks`. " +
          "Re-prompt the model and paste the reply again.",
      ],
      passed: false,
      totalStake: 0,
      format: "none",
    };
  }

  /* --- previews --- */
  const previews: ResolvedPreview[] = [];
  const claimedEvents = new Set<number>();
  for (const row of payload.analysis) {
    if (!row || typeof row !== "object") continue;
    const preview = resolvePreview(row as Record<string, unknown>, options);
    if (!preview) continue;
    if (claimedEvents.has(preview.event_id)) continue;
    claimedEvents.add(preview.event_id);
    previews.push(preview);
  }

  /* --- picks --- */
  const budget = {
    remaining:
      options.state && options.rules
        ? Math.max(
            0,
            Math.round(options.state.bankroll * options.rules.maxDailyExposure) -
              options.state.stakedToday,
          )
        : Number.POSITIVE_INFINITY,
  };

  const seenRefs = new Set<number>();
  const picks: ResolvedPick[] = [];
  const rejected: ParseResult["rejected"] = [];

  const rows = payload.picks.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
  );

  if (rows.length > maxPicks) {
    errors.push(
      `Model returned ${rows.length} picks; the limit is ${maxPicks}. ` +
        `The first ${maxPicks} were taken in the order sent.`,
    );
  }

  for (const row of rows.slice(0, maxPicks)) {
    const result = resolvePick(row, options, seenRefs, budget);
    const blocking = result.violations.filter((v) => v.severity === "block");

    if (!result.pick || (blocking.length > 0 && options.rejectViolations)) {
      rejected.push({ ref: result.ref, violations: result.violations });
      for (const violation of blocking) {
        errors.push(`[ref ${result.ref ?? "?"}] ${violation.message}`);
      }
      continue;
    }
    picks.push(result.pick);
  }

  if (picks.length === 0 && requirePicks) {
    errors.push(
      "No usable picks. Passing is forbidden in this arena — every model commits, every round. " +
        "Send the packet back and record a refusal to compete if it happens again.",
    );
  }

  return {
    picks,
    rejected,
    previews,
    errors,
    passed: picks.length === 0 && !requirePicks,
    totalStake: picks.reduce((sum, p) => sum + p.stake, 0),
    format: payload.format,
  };
}

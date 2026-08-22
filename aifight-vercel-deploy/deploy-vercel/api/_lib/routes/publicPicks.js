/**
 * GET /api/public/picks — the flat, public pick feed.
 *
 * WHAT THIS IS FOR
 * ----------------
 * One array. No auth, no joins, no nesting, no cross-table lookups. Every
 * pick the arena holds, each row carrying everything needed to render it.
 *
 * A note on the premise: the arena's records were ALREADY flat. A stored bet
 * is `{ model, event, market, pick, odds, stake, reasoning, result, ... }` —
 * there is no `events`/`markets`/`outcomes` join anywhere in the public read
 * path, and the board's only filter is `result === 'pending'`. So this route
 * is not undoing a relational tangle that existed.
 *
 * What it IS worth having, and the reason it exists: the site currently has
 * two live sources — the blob behind `/api/arena` and a Supabase project —
 * and `useArena` silently prefers Supabase whenever `config.js` declares it,
 * via an early return rather than a fallback. That is how a board can show
 * "no picks" while the blob holds twenty-five. One endpoint, one source,
 * one answer removes that whole class of confusion.
 *
 *   ?status=active     pending only (default)
 *   ?status=settled    graded only
 *   ?status=all        everything
 *   ?model=Claude      one fighter
 *   ?round=3           one round
 *   ?limit=200         cap (default 200, max 1000)
 *
 * FIELD NAMING
 * ------------
 * Each row carries BOTH vocabularies:
 *
 *   fighter_model / event_name / selection_name / probability / status
 *   model / event / pick / fair_prob / result
 *
 * The first set is the flat schema requested; the second is what the shipped
 * bundle already reads. Emitting both means a new consumer gets clean names
 * and the existing one keeps working — nothing has to be migrated to make
 * this useful today.
 */

import { applyCors, clientIp, fail, handlePreflight, json } from "../http.js";
import { enforce } from "../ratelimit.js";
import { isConfigured, readArenaJson } from "../store.js";
import { DAILY_LIMIT, MODELS, STARTING_BANKROLL, deriveFighters } from "../ledger.js";

const ARENA_TZ = process.env.ARENA_TZ || "Europe/Sofia";

/** Settled outcomes. Everything else counts as still live. */
const SETTLED = new Set(["win", "loss", "void", "push"]);

/**
 * One stored bet → one flat public row.
 *
 * Every field is defensive. These records come from a blob that has been
 * written by several generations of this codebase, so a row missing `market`
 * or carrying `odds` as a string is normal history, not corruption — and a
 * renderer that throws on one bad row loses the whole board.
 */
function toRow(bet, index) {
  const status = typeof bet.result === "string" && bet.result ? bet.result : "pending";
  const odds = Number(bet.odds);
  const stake = Number(bet.stake);
  const prob = bet.fair_prob == null ? null : Number(bet.fair_prob);

  const thesis =
    (typeof bet.reasoning === "string" && bet.reasoning.trim()) ||
    (typeof bet.core_thesis === "string" && bet.core_thesis.trim()) ||
    null;

  return {
    /* ---- identity ---- */
    id: bet.id ?? index + 1,
    pick_id: bet.pick_id ?? null,
    round: Number.isFinite(Number(bet.round)) ? Number(bet.round) : 1,

    /* ---- flat schema ---- */
    fighter_model: bet.model ?? null,
    event_name: bet.event ?? null,
    selection_ref: bet.ref ?? null,
    selection_name: bet.pick ?? null,
    market_key: bet.market ?? null,
    odds: Number.isFinite(odds) ? odds : null,
    stake: Number.isFinite(stake) ? stake : null,
    probability: Number.isFinite(prob) ? prob : null,
    status,

    /* ---- the shipped bundle's names, so nothing has to migrate ---- */
    model: bet.model ?? null,
    event: bet.event ?? null,
    market: bet.market ?? null,
    pick: bet.pick ?? null,
    fair_prob: Number.isFinite(prob) ? prob : null,
    result: status,

    /* ---- rationale: what the drawer publishes ---- */
    reasoning: thesis,
    core_thesis: thesis,
    risk_factors: bet.risk_factors ?? null,
    confidence: bet.confidence ?? null,
    /** True when this pick will actually render a rationale drawer. */
    has_thesis: Boolean(thesis),

    /* ---- derived, so no consumer has to recompute ---- */
    is_active: !SETTLED.has(status),
    is_settled: SETTLED.has(status),
    /** Profit if settled, else null. Never a silent zero — those differ. */
    profit:
      status === "win" && Number.isFinite(odds) && Number.isFinite(stake)
        ? Math.round(stake * (odds - 1) * 100) / 100
        : status === "loss" && Number.isFinite(stake)
          ? -stake
          : SETTLED.has(status)
            ? 0
            : null,
    /** EV at the taken price, from the model's own probability. */
    ev:
      Number.isFinite(prob) && Number.isFinite(odds) && odds > 1
        ? Math.round((prob * (odds - 1) - (1 - prob)) * 10000) / 100
        : null,

    /* ---- timing ---- */
    logged_at: bet.logged_at ?? bet.created_at ?? null,
    settled_at: bet.settled_at ?? null,
    kickoff_at: bet.kickoff_at ?? null,
  };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res, { methods: "GET, OPTIONS" })) return;
  applyCors(req, res, { methods: "GET, OPTIONS" });

  if (req.method !== "GET") return fail(res, 405, "method-not-allowed");

  /*
   * A short shared cache, not no-store.
   *
   * This is a public read that changes only when the admin logs or settles.
   * Ten seconds of CDN caching absorbs a traffic spike without anyone seeing
   * a stale board, and `stale-while-revalidate` means a cache miss never
   * makes a visitor wait on the blob.
   */
  res.setHeader("Cache-Control", "public, max-age=10, s-maxage=10, stale-while-revalidate=60");

  if (await enforce(res, `public-picks:${clientIp(req)}`, { max: 240, windowSeconds: 60 })) return;

  if (!isConfigured()) {
    /*
     * Not an error. A deployment with no blob store is a valid state, and
     * answering 200 with an empty array lets a consumer render "no picks"
     * without special-casing a failure — while `reason` still says why.
     */
    return json(res, 200, {
      ok: true,
      source: "none",
      reason: "no-blob-store",
      count: 0,
      picks: [],
      fighters: {},
    });
  }

  const q = req.query ?? {};
  const statusFilter = typeof q.status === "string" ? q.status.toLowerCase() : "active";
  const modelFilter = typeof q.model === "string" ? q.model : null;
  const roundFilter = q.round === undefined ? null : Number(q.round);
  const limit = Math.min(1000, Math.max(1, Number(q.limit) || 200));

  try {
    const { data } = await readArenaJson();
    const bets = Array.isArray(data?.bets) ? data.bets : [];

    let rows = bets.map(toRow);

    if (modelFilter) rows = rows.filter((r) => r.fighter_model === modelFilter);
    if (Number.isFinite(roundFilter)) rows = rows.filter((r) => r.round === roundFilter);

    if (statusFilter === "active") rows = rows.filter((r) => r.is_active);
    else if (statusFilter === "settled") rows = rows.filter((r) => r.is_settled);
    // "all" and anything unrecognised fall through unfiltered — a typo in the
    // query string must not silently hide every pick.

    // Newest first; a pick with no timestamp sorts by id rather than vanishing.
    rows.sort((a, b) => {
      const at = new Date(a.logged_at ?? 0).getTime() || 0;
      const bt = new Date(b.logged_at ?? 0).getTime() || 0;
      if (at !== bt) return bt - at;
      return (b.id ?? 0) - (a.id ?? 0);
    });

    const round =
      typeof data?.round === "object" && data.round
        ? data.round
        : { round: Number(data?.round) || 1, status: "open" };

    const fighters = deriveFighters(bets, { round: round.round, timeZone: ARENA_TZ });

    const total = bets.length;
    const activeTotal = bets.filter((b) => !SETTLED.has(b.result ?? "pending")).length;

    return json(res, 200, {
      ok: true,
      source: "blob",
      generatedAt: new Date().toISOString(),
      round,
      filter: { status: statusFilter, model: modelFilter, round: roundFilter, limit },

      count: Math.min(rows.length, limit),
      picks: rows.slice(0, limit),

      /*
       * Totals for the WHOLE arena, before filtering.
       *
       * This is what stops "no picks yet" being ambiguous: a consumer can say
       * "no active picks — 25 settled" instead of "no picks", which is the
       * difference between an explanation and a dead end.
       */
      totals: {
        all: total,
        active: activeTotal,
        settled: total - activeTotal,
        byStatus: bets.reduce((acc, b) => {
          const s = b.result ?? "pending";
          acc[s] = (acc[s] ?? 0) + 1;
          return acc;
        }, {}),
      },

      fighters,
      models: MODELS,
      startingBankroll: STARTING_BANKROLL,
      dailyLimit: DAILY_LIMIT,
    });
  } catch (err) {
    return fail(res, 502, "read-failed", String(err?.message ?? err));
  }
}

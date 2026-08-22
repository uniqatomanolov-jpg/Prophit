/**
 * /api/picks — manual pick logging.
 *
 * WHY THIS ROUTE EXISTS
 * ---------------------
 * Every pick currently reaches the arena by being pasted into a text box and
 * run through a parser. That parser is good — it recovers from smart quotes,
 * markdown damage and echoed prompts — but it is the wrong tool when a human
 * already knows exactly what they want to log. Parsing a reply you wrote
 * yourself is a round trip through a lossy channel for no reason.
 *
 * This is the direct path: a form posts structured fields, the server
 * validates them against the arena's real rules, appends to the hash chain,
 * recomputes every fighter, and writes atomically.
 *
 *   POST   /api/picks         log one pick
 *   DELETE /api/picks?id=12   remove one pick and rebuild the chain
 *   GET    /api/picks         current state: bets, fighters, budgets
 *
 * THE GUARANTEE
 * -------------
 * Validation and the write happen against the SAME read of the arena, inside
 * `mutate()`. A budget check that passed against a stale snapshot would let
 * two concurrent logs both pass and jointly overspend; re-running the check
 * inside the retry loop makes that impossible.
 */

import { authorise } from "./_lib/auth.js";
import { applyCors, clientIp, fail, handlePreflight, json, noStore, readJson } from "./_lib/http.js";
import { enforce } from "./_lib/ratelimit.js";
import { isConfigured, mutate, readArenaJson } from "./_lib/store.js";
import { acceptsPicks } from "./_lib/routes/round.js";
import {
  DAILY_LIMIT,
  MODELS,
  STARTING_BANKROLL,
  appendPick,
  buildArena,
  eventsOf,
  deriveFighters,
  payoutFor,
  removePick,
  settleBet,
  thesisCoverage,
  validatePick,
  verifyChain,
} from "./_lib/ledger.js";

import roundHandler from "./_lib/routes/round.js";
import publicPicksHandler from "./_lib/routes/publicPicks.js";
import eventsHandler from "./_lib/routes/events.js";

const ARENA_TZ = process.env.ARENA_TZ || "Europe/Sofia";

/** Direct-hit fallbacks, for a request that arrives without the rewrite. */
const PATH_ROUTES = {
  "/api/round": "round",
  "/api/public/picks": "public",
  "/api/events": "events",
};

/**
 * ROUTE DISPATCH — why this file serves more than one URL
 * -------------------------------------------------------
 * Vercel's Hobby plan allows 12 Serverless Functions per deployment, and every
 * `.js` under `api/` (except `_`-prefixed paths) becomes one. A 13th file made
 * the whole deploy fail during function enumeration, ~10s in, with no code
 * error to point at.
 *
 * So closely-related routes share a function. The handlers themselves are
 * untouched in `api/_lib/routes/`; `vercel.json` rewrites the public URL here
 * with a `__route` marker, and this file picks the handler. Every public URL,
 * method and response is exactly as before — only the file count changed.
 *
 * Dispatch reads BOTH the marker and the raw path, so a direct request that
 * bypasses the rewrite still lands on the right handler.
 */
function routeOf(req) {
  const marked = req.query?.__route;
  if (typeof marked === "string" && marked) return marked;
  const path = String(req.url || "").split("?")[0];
  return PATH_ROUTES[path] ?? null;
}



/** Bets out of whatever shape the stored arena is in. Never throws. */
function betsOf(data) {
  if (!data) return [];
  if (Array.isArray(data.bets)) return data.bets;
  return [];
}

function roundOf(data, fallback = 1) {
  const r = data?.round;
  if (typeof r === "number" && Number.isFinite(r)) return r;
  if (r && typeof r.round === "number" && Number.isFinite(r.round)) return r.round;
  return fallback;
}

function statusOf(data) {
  const r = data?.round;
  return (r && typeof r.status === "string" && r.status) || "open";
}

export default async function handler(req, res) {
  /*
   * Dispatch FIRST, before auth. /api/public/picks is deliberately public;
   * running this file's admin check ahead of the dispatch would 401 it.
   */
  const route = routeOf(req);
  if (route === "round") return roundHandler(req, res);
  if (route === "public") return publicPicksHandler(req, res);
  if (route === "events") return eventsHandler(req, res);

  if (handlePreflight(req, res, { methods: "GET, POST, PATCH, DELETE, OPTIONS", credentials: true })) return;
  applyCors(req, res, { methods: "GET, POST, PATCH, DELETE, OPTIONS", credentials: true });
  noStore(res);

  // Cron is excluded on purpose: nothing scheduled should be able to open a
  // position. Settlement closes them; it does not create them.
  const auth = authorise(req, { allow: ["session", "admin"] });
  if (!auth.ok) return fail(res, 401, "unauthorised", "Log in to the admin console first.");

  if (!isConfigured()) {
    return fail(
      res,
      503,
      "no-blob-store",
      "Create a Blob store in Vercel → Storage, then set BLOB_READ_WRITE_TOKEN.",
    );
  }

  /* ---------------- GET — current state for the form ---------------- */
  if (req.method === "GET") {
    try {
      const { data } = await readArenaJson();
      const bets = betsOf(data);
      const round = roundOf(data);
      const fighters = deriveFighters(bets, { round, timeZone: ARENA_TZ });

      return json(res, 200, {
        ok: true,
        round,
        status: statusOf(data),
        models: MODELS,
        dailyLimit: DAILY_LIMIT,
        startingBankroll: STARTING_BANKROLL,
        fighters,
        integrity: verifyChain(bets),
        /** How many picks will actually render a rationale drawer. */
        thesis: thesisCoverage(bets),
        // Newest first, and capped: the form only needs recent context, and a
        // full season would make this response large for no benefit.
        recent: [...bets].reverse().slice(0, 25),
        totalBets: bets.length,
      });
    } catch (err) {
      if (err?.code === "corrupt-state") return fail(res, 502, "corrupt-state", err.message);
      return fail(res, 502, "read-failed", String(err?.message ?? err));
    }
  }

  /* ---------------- POST — log a pick ---------------- */
  if (req.method === "POST") {
    if (await enforce(res, `picks:post:${auth.subject}:${clientIp(req)}`, { max: 60, windowSeconds: 60 })) {
      return;
    }

    const parsed = await readJson(req, { limitBytes: 32_768 });
    if (!parsed.ok) return fail(res, 400, parsed.reason);
    if (!parsed.value || typeof parsed.value !== "object") {
      return fail(res, 400, "bad-payload", "Expected a JSON object.");
    }

    let validation = null;

    try {
      const result = await mutate(
        (data) => {
          const bets = betsOf(data);
          const round = roundOf(data);

          /*
           * Only an OPEN round accepts picks.
           *
           * This used to compare against the single literal "settled", which
           * meant the live arena's actual status — "locked" — sailed straight
           * through. A round the operator believes is closed silently
           * accepting new picks is worse than either state on its own.
           */
          const status = statusOf(data);
          if (!acceptsPicks(status)) {
            const err = new Error(
              `Round ${round} is "${status}", not open. ` +
                `Open it or advance to the next round before logging new picks.`,
            );
            err.code = "round-locked";
            err.roundStatus = status;
            throw err;
          }

          /*
           * Validation runs HERE, inside the mutation, not before it. On a
           * retry it re-runs against the state that caused the retry — so a
           * duplicate or a budget breach introduced by a concurrent write is
           * still caught rather than being waved through by a check that
           * passed a moment earlier.
           */
          validation = validatePick(parsed.value, { bets, round, timeZone: ARENA_TZ });
          if (!validation.ok) {
            const err = new Error("Validation failed.");
            err.code = "invalid";
            err.errors = validation.errors;
            throw err;
          }

          const nextBets = appendPick(bets, validation.normalised);
          return buildArena(nextBets, {
            round,
            status: statusOf(data),
            timeZone: ARENA_TZ,
            // Carry the match board through, or this write wipes it.
            events: eventsOf(data),
          });
        },
        { backupPrefix: "backups" },
      );

      const bets = betsOf(result.data);
      const logged = bets[bets.length - 1];
      const fighter = result.data.fighters?.[logged.model] ?? null;

      return json(res, 201, {
        ok: true,
        bet: logged,
        /** The caller updates its own display from this — no refetch needed. */
        fighter,
        fighters: result.data.fighters,
        warnings: validation?.warnings ?? [],
        etag: result.etag,
        backup: result.backup,
        attempts: result.attempts,
      });
    } catch (err) {
      if (err?.code === "invalid") {
        return json(res, 422, { ok: false, reason: "invalid", errors: err.errors });
      }
      if (err?.code === "round-locked") {
        return json(res, 409, {
          ok: false,
          reason: "round-locked",
          roundStatus: err.roundStatus ?? null,
          errors: [err.message],
        });
      }
      if (err?.code === "conflict") {
        return json(res, 409, {
          ok: false,
          reason: "conflict",
          errors: ["The arena changed while saving. Nothing was written — try again."],
        });
      }
      if (err?.code === "corrupt-state") return fail(res, 502, "corrupt-state", err.message);
      return fail(res, 502, "write-failed", String(err?.message ?? err));
    }
  }

  /* ---------------- PATCH — settle a pick ---------------- */
  /*
   * The instant calculation engine.
   *
   *   win        payout = stake x odds       bankroll += stake x (odds - 1)
   *   loss       payout = 0                  bankroll -= stake
   *   void/push  payout = stake              bankroll unchanged (100% refund)
   *
   * Fighters are recomputed from the full bet list inside the same write, so
   * the response already carries the new bankroll, ROI and exposure — the
   * caller repaints from it rather than refetching and risking a stale read.
   *
   * Grading does NOT touch the hash chain. The preimage covers only what was
   * chosen before the event ran, so a result can be recorded — or corrected —
   * without invalidating the proof that the pick itself was never edited.
   */
  if (req.method === "PATCH") {
    if (await enforce(res, `picks:patch:${auth.subject}`, { max: 120, windowSeconds: 60 })) return;

    const parsed = await readJson(req, { limitBytes: 4096 });
    if (!parsed.ok) return fail(res, 400, parsed.reason);

    const id = Number(parsed.value?.id ?? req.query?.id);
    const result = parsed.value?.result;

    if (!Number.isInteger(id) || id < 1) {
      return fail(res, 400, "bad-id", "Pass a numeric pick id.");
    }
    if (!["win", "loss", "void", "push", "pending"].includes(result)) {
      return fail(res, 400, "bad-result", 'result must be win, loss, void, push or pending.');
    }

    try {
      let settled = null;
      let previous = null;
      let money = null;

      const out = await mutate(
        (data) => {
          const bets = betsOf(data);
          const round = roundOf(data);

          const applied = settleBet(bets, id, result);
          if (!applied.ok) {
            const err = new Error(
              applied.reason === "not-found"
                ? `No pick with id ${id}.`
                : applied.reason === "no-change"
                  ? `Pick ${id} is already "${result}".`
                  : `Cannot settle pick ${id}.`,
            );
            err.code = applied.reason;
            throw err;
          }

          settled = applied.bet;
          previous = applied.previousResult;
          money = applied.money;

          return buildArena(applied.bets, {
            round,
            status: statusOf(data),
            timeZone: ARENA_TZ,
            // Settling must not wipe the match board.
            events: eventsOf(data),
          });
        },
        { backupPrefix: "backups" },
      );

      const fighters = out.data.fighters ?? {};

      return json(res, 200, {
        ok: true,
        bet: settled,
        previousResult: previous,
        /** Exactly what this grading paid, so the UI can show the delta. */
        settlement: {
          result,
          stake: settled.stake,
          odds: settled.odds,
          payout: money.payout,
          profit: money.profit,
          stakeReturned: money.stakeReturned,
        },
        fighter: fighters[settled.model] ?? null,
        fighters,
        integrity: out.data.integrity,
        etag: out.etag,
      });
    } catch (err) {
      if (err?.code === "not-found") return fail(res, 404, "not-found", err.message);
      if (err?.code === "no-change") {
        return json(res, 409, { ok: false, reason: "no-change", errors: [err.message] });
      }
      if (err?.code === "conflict") {
        return json(res, 409, {
          ok: false,
          reason: "conflict",
          errors: ["The arena changed while saving. Nothing was written — try again."],
        });
      }
      return fail(res, 502, "write-failed", String(err?.message ?? err));
    }
  }

  /* ---------------- DELETE — remove a pick ---------------- */
  if (req.method === "DELETE") {
    if (await enforce(res, `picks:del:${auth.subject}`, { max: 30, windowSeconds: 60 })) return;

    const id = Number(req.query?.id);
    if (!Number.isInteger(id) || id < 1) {
      return fail(res, 400, "bad-id", "Pass ?id= the numeric id of the pick to remove.");
    }

    try {
      let removed = null;

      const result = await mutate(
        (data) => {
          const bets = betsOf(data);
          const round = roundOf(data);

          const target = bets.find((b) => Number(b.id) === id);
          if (!target) {
            const err = new Error(`No pick with id ${id}.`);
            err.code = "not-found";
            throw err;
          }
          /*
           * A settled bet has already moved the bankroll. Deleting it would
           * silently rewrite history and change every figure downstream, so
           * it is refused — void it through settlement instead, which leaves
           * a trace.
           */
          if (target.result !== "pending") {
            const err = new Error(
              `Pick ${id} is already settled (${target.result}). Void it through settlement instead of deleting it.`,
            );
            err.code = "already-settled";
            throw err;
          }

          const out = removePick(bets, id);
          if (!out.ok) {
            const err = new Error(`No pick with id ${id}.`);
            err.code = "not-found";
            throw err;
          }
          removed = out.removed;

          return buildArena(out.bets, {
            round,
            status: statusOf(data),
            timeZone: ARENA_TZ,
            // Removing a pick must not wipe the match board.
            events: eventsOf(data),
          });
        },
        { backupPrefix: "backups" },
      );

      return json(res, 200, {
        ok: true,
        removed,
        fighters: result.data.fighters,
        etag: result.etag,
        /** The chain is rebuilt after a delete; confirm it still verifies. */
        integrity: result.data.integrity,
      });
    } catch (err) {
      if (err?.code === "not-found") return fail(res, 404, "not-found", err.message);
      if (err?.code === "already-settled") return json(res, 409, { ok: false, reason: "already-settled", errors: [err.message] });
      if (err?.code === "conflict") {
        return json(res, 409, {
          ok: false,
          reason: "conflict",
          errors: ["The arena changed while saving. Nothing was written — try again."],
        });
      }
      return fail(res, 502, "write-failed", String(err?.message ?? err));
    }
  }

  return fail(res, 405, "method-not-allowed");
}

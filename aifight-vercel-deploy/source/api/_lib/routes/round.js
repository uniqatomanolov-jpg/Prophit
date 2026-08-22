/**
 * /api/round — open, lock, or advance the round.
 *
 * WHY THIS IS THE UNBLOCK
 * -----------------------
 * The live arena holds 25 bets, every one of them graded, and the round is
 * marked `"locked"`. The public board's active list is
 * `bets.filter(b => b.result === 'pending')`, so it is empty — correctly.
 * No amount of query flattening changes that; what changes it is a round with
 * live picks in it.
 *
 * Round state also had no owner. `localArena` writes it from the browser and
 * checks it in exactly one place — `if (status === 'settled') throw` — so the
 * `"locked"` currently stored is a value nothing in the codebase handles: it
 * does not block logging, and it does not read as closed either. This route
 * makes the states explicit and gives them one server-side owner.
 *
 *   GET                          current round and what it permits
 *   POST {"action":"open"}       reopen this round for logging
 *   POST {"action":"lock"}       stop new picks; existing ones stay live
 *   POST {"action":"advance"}    lock this round and open the next
 *   POST {"action":"set", "round":3, "status":"open"}
 *
 * ADVANCING DOES NOT TOUCH BETS
 * -----------------------------
 * It changes one number. Existing picks keep their own `round` field and stay
 * exactly as they are, settled or pending. That matters: `pick_id` embeds the
 * round, so advancing is also what frees a fixture to be bet again by the same
 * fighter without colliding with last round's entry.
 */

import { authorise } from "../auth.js";
import { applyCors, fail, handlePreflight, json, noStore, readJson } from "../http.js";
import { enforce } from "../ratelimit.js";
import { isConfigured, mutate, readArenaJson } from "../store.js";
import { TOTAL_ROUNDS, buildArena, deriveFighters, eventsOf } from "../ledger.js";

const ARENA_TZ = process.env.ARENA_TZ || "Europe/Sofia";

/**
 * The states a round can be in.
 *
 * `locked` is included because the live arena is already in it — refusing to
 * recognise a state the production data is sitting in would make this route
 * useless for the one case it was written for.
 */
const STATUSES = new Set(["open", "locked", "grading", "settled"]);

/** Only an open round accepts new picks. Everything else is closed. */
export function acceptsPicks(status) {
  return (status ?? "open") === "open";
}

function betsOf(data) {
  return Array.isArray(data?.bets) ? data.bets : [];
}

function roundOf(data) {
  const r = data?.round;
  if (typeof r === "number" && Number.isFinite(r)) return { round: r, status: "open" };
  if (r && typeof r === "object") {
    return {
      round: Number.isFinite(Number(r.round)) ? Number(r.round) : 1,
      status: typeof r.status === "string" && r.status ? r.status : "open",
    };
  }
  return { round: 1, status: "open" };
}

/** What the admin can do from here, given the current state. */
function permissions(round, bets) {
  const pending = bets.filter((b) => (b.result ?? "pending") === "pending").length;
  const inRound = bets.filter((b) => Number(b.round) === round.round).length;

  return {
    canLogPicks: acceptsPicks(round.status),
    pendingPicks: pending,
    picksThisRound: inRound,
    /*
     * Advancing with picks still pending is allowed but flagged. There are
     * legitimate reasons — a fixture postponed past the round boundary — and
     * blocking it would strand the arena. Warning is the right strength.
     */
    advanceWarning:
      pending > 0
        ? `${pending} pick${pending === 1 ? "" : "s"} still pending. They stay live and settle normally, but they belong to round ${round.round}.`
        : null,
    atFinalRound: round.round >= TOTAL_ROUNDS,
  };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res, { methods: "GET, POST, OPTIONS", credentials: true })) return;
  applyCors(req, res, { methods: "GET, POST, OPTIONS", credentials: true });
  noStore(res);

  const auth = authorise(req, { allow: ["session", "admin"] });
  if (!auth.ok) return fail(res, 401, "unauthorised");

  if (!isConfigured()) {
    return fail(res, 503, "no-blob-store", "Set BLOB_READ_WRITE_TOKEN to manage rounds.");
  }

  /* ---------------- GET ---------------- */
  if (req.method === "GET") {
    try {
      const { data } = await readArenaJson();
      const bets = betsOf(data);
      const round = roundOf(data);
      return json(res, 200, {
        ok: true,
        round: round.round,
        status: round.status,
        totalRounds: TOTAL_ROUNDS,
        ...permissions(round, bets),
        /** Named so the console can explain a closed round rather than just disabling. */
        statusMeaning: describe(round.status),
      });
    } catch (err) {
      return fail(res, 502, "read-failed", String(err?.message ?? err));
    }
  }

  if (req.method !== "POST") return fail(res, 405, "method-not-allowed");
  if (await enforce(res, `round:${auth.subject}`, { max: 20, windowSeconds: 60 })) return;

  const parsed = await readJson(req, { limitBytes: 2048 });
  if (!parsed.ok) return fail(res, 400, parsed.reason);

  const action = parsed.value?.action;
  if (!["open", "lock", "advance", "set"].includes(action)) {
    return fail(res, 400, "bad-action", 'action must be "open", "lock", "advance" or "set".');
  }

  try {
    let before = null;
    let after = null;

    const result = await mutate(
      (data) => {
        const bets = betsOf(data);
        const current = roundOf(data);
        before = { ...current };

        let next;
        if (action === "open") {
          next = { round: current.round, status: "open" };
        } else if (action === "lock") {
          next = { round: current.round, status: "locked" };
        } else if (action === "advance") {
          if (current.round >= TOTAL_ROUNDS) {
            const err = new Error(
              `Round ${current.round} is the final round of ${TOTAL_ROUNDS}. Use "set" to go further.`,
            );
            err.code = "final-round";
            throw err;
          }
          next = { round: current.round + 1, status: "open" };
        } else {
          const roundNo = Number(parsed.value?.round);
          const status = parsed.value?.status ?? "open";
          if (!Number.isInteger(roundNo) || roundNo < 1 || roundNo > 999) {
            const err = new Error("round must be a whole number between 1 and 999.");
            err.code = "invalid";
            throw err;
          }
          if (!STATUSES.has(status)) {
            const err = new Error(`status must be one of: ${[...STATUSES].join(", ")}.`);
            err.code = "invalid";
            throw err;
          }
          next = { round: roundNo, status };
        }

        after = next;

        // Bets are carried through untouched — this changes round state only.
        return buildArena(bets, {
          round: next.round,
          status: next.status,
          timeZone: ARENA_TZ,
          // Round changes must not disturb the match board.
          events: eventsOf(data),
        });
      },
      { backupPrefix: "backups" },
    );

    const bets = betsOf(result.data);

    return json(res, 200, {
      ok: true,
      before,
      round: after.round,
      status: after.status,
      statusMeaning: describe(after.status),
      ...permissions(after, bets),
      fighters: deriveFighters(bets, { round: after.round, timeZone: ARENA_TZ }),
      etag: result.etag,
    });
  } catch (err) {
    if (err?.code === "invalid" || err?.code === "final-round") {
      return json(res, 422, { ok: false, reason: err.code, errors: [err.message] });
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

function describe(status) {
  switch (status) {
    case "open":
      return "Accepting new picks.";
    case "locked":
      return "Closed to new picks. Existing picks stay live and settle normally.";
    case "grading":
      return "Results coming in. No new picks.";
    case "settled":
      return "Finished and graded. Advance to start the next round.";
    default:
      return `Unrecognised status "${status}" — treated as closed.`;
  }
}

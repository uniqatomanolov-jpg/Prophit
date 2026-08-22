/**
 * /api/events — the Match Board.
 *
 * WHAT AN EVENT IS HERE
 * ---------------------
 * A fixture plus its priced markets, stored as ONE self-contained object:
 *
 *   { id, sport, name, home, away, competition, starts_at, status,
 *     markets: [ { key, label, line, outcomes: [ { label, odds } ] } ] }
 *
 * No `events` / `markets` / `outcomes` tables, no joins, no foreign keys. The
 * whole board is one array in the same blob the picks live in, so reading it
 * is one fetch and rendering it is a `.map()`.
 *
 * That is deliberate. A relational split buys referential integrity that this
 * arena does not need — an event is created once, priced once, and read many
 * times — and costs a join on every read plus a class of "pick exists but its
 * market row is missing" failures that are painful to diagnose.
 *
 * WHY PICKS DO NOT FOREIGN-KEY TO IT
 * ----------------------------------
 * A pick stores `event`, `market` and `pick` as plain strings, and carries an
 * `event_id` only as a convenience. If the board is wiped, every pick still
 * renders — it is self-describing. The board is scaffolding for the admin, not
 * a dependency of the ledger.
 *
 *   GET    /api/events                  the board + the sport registry
 *   POST   /api/events                  create one
 *   DELETE /api/events?id=...           remove one (refused if picks exist)
 */

import { authorise } from "../auth.js";
import { applyCors, fail, handlePreflight, json, noStore, readJson } from "../http.js";
import { enforce } from "../ratelimit.js";
import { isConfigured, mutate, readArenaJson } from "../store.js";
import { buildArena, eventIdFor, eventsOf } from "../ledger.js";
import {
  composeEventName,
  eventShape,
  isSport,
  marketFor,
  outcomesFor,
  registry,
} from "../sports.js";

const ARENA_TZ = process.env.ARENA_TZ || "Europe/Sofia";
const MAX_EVENTS = 200;

/**
 * Validate a proposed event and normalise it.
 *
 * Collects every problem rather than the first — an admin pricing a six-market
 * football fixture should not discover the mistakes one submit at a time.
 */
export function validateEvent(input, { events = [] } = {}) {
  const errors = [];
  const warnings = [];

  const sport = typeof input?.sport === "string" ? input.sport.trim() : "";
  if (!isSport(sport)) {
    return { ok: false, errors: [`Sport must be one of: soccer, nba, nfl, f1.`], warnings };
  }

  const shape = eventShape(sport);
  const fields = {};

  for (const field of shape.fields) {
    const raw = input?.[field.key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (field.required && !value) errors.push(`${field.label} is required.`);
    if (value.length > 120) errors.push(`${field.label} is too long (max 120 characters).`);
    fields[field.key] = value || null;
  }

  const name = composeEventName(sport, fields);
  if (!name || name.length < 3) errors.push("Could not build an event name from those fields.");

  let startsAt = null;
  if (input?.starts_at) {
    const d = new Date(input.starts_at);
    if (Number.isNaN(d.getTime())) errors.push("Kick-off time is not a valid date.");
    else startsAt = d.toISOString();
  }

  /* ---- markets ---- */
  const rawMarkets = Array.isArray(input?.markets) ? input.markets : [];
  if (rawMarkets.length === 0) errors.push("Price at least one market.");
  if (rawMarkets.length > 12) errors.push("Too many markets on one event (max 12).");

  const markets = [];
  const seenMarkets = new Set();

  rawMarkets.forEach((raw, i) => {
    const key = typeof raw?.key === "string" ? raw.key.trim() : "";
    const definition = marketFor(sport, key);
    if (!definition) {
      errors.push(`markets[${i}]: "${key}" is not a market for ${sport}.`);
      return;
    }
    if (seenMarkets.has(key)) {
      errors.push(`markets[${i}]: ${definition.label} is listed twice.`);
      return;
    }
    seenMarkets.add(key);

    let line = null;
    if (definition.shape === "line") {
      const n = Number(raw?.line ?? definition.defaultLine);
      if (!Number.isFinite(n)) {
        errors.push(`${definition.label}: the line must be a number.`);
        return;
      }
      line = n;
      /*
       * A whole-number line can push — the total lands exactly on it — and
       * that settles as VOID, not a loss. Flagged rather than blocked because
       * whole lines are legitimate; the admin should just know what they mean.
       */
      if (Number.isInteger(n)) {
        warnings.push(`${definition.label}: a whole line (${n}) can push — settle those as VOID.`);
      }
    }

    const labels = outcomesFor(sport, key, {
      home: fields.home,
      away: fields.away,
      line,
      entrants: Array.isArray(raw?.outcomes) ? raw.outcomes : [],
    });

    if (labels.length === 0) {
      errors.push(`${definition.label}: no outcomes. Add at least one entrant.`);
      return;
    }
    if (definition.maxEntrants && labels.length > definition.maxEntrants) {
      errors.push(`${definition.label}: at most ${definition.maxEntrants} entrants.`);
      return;
    }

    const supplied = Array.isArray(raw?.outcomes) ? raw.outcomes : [];
    const outcomes = labels.map((label, idx) => {
      // For fixed/line markets the odds arrive positionally; for a roster they
      // arrive alongside the entrant name.
      const from = supplied[idx];
      const oddsRaw = typeof from === "object" && from !== null ? from.odds : from;
      const odds = Number(oddsRaw);

      if (!Number.isFinite(odds) || odds <= 1) {
        errors.push(`${definition.label} — ${label}: odds must be a number greater than 1.00.`);
        return null;
      }
      if (odds > 1000) {
        errors.push(`${definition.label} — ${label}: odds above 1000 are not accepted.`);
        return null;
      }
      return { label, odds: Math.round(odds * 1000) / 1000 };
    });

    if (outcomes.some((o) => o === null)) return;

    /*
     * The overround, reported not enforced.
     *
     * Inverse probabilities summing to well under 1 means a priced-wrong
     * market that hands every model free money; way over 1 means nobody can
     * find value in it. Both are almost always a typo, and both are invisible
     * without this line.
     */
    if (definition.shape !== "roster" || key === "h2h") {
      const overround = outcomes.reduce((sum, o) => sum + 1 / o.odds, 0);
      if (overround < 0.95) {
        warnings.push(
          `${definition.label}: prices sum to ${(overround * 100).toFixed(1)}% — under 100% is an arbitrage. Check for a typo.`,
        );
      } else if (overround > 1.25) {
        warnings.push(
          `${definition.label}: prices sum to ${(overround * 100).toFixed(1)}% — a ${((overround - 1) * 100).toFixed(1)}% margin is very heavy.`,
        );
      }
    }

    markets.push({
      key,
      label: definition.label,
      shape: definition.shape,
      line,
      outcomes,
    });
  });

  if (errors.length) return { ok: false, errors, warnings, normalised: null };

  const id = eventIdFor(sport, name, startsAt);
  if (events.some((e) => e.id === id)) {
    errors.push(
      `That event already exists on the board (${name}${startsAt ? ` on ${startsAt.slice(0, 10)}` : ""}). ` +
        `Delete it first if you meant to re-price it.`,
    );
    return { ok: false, errors, warnings, normalised: null };
  }

  return {
    ok: true,
    errors: [],
    warnings,
    normalised: {
      id,
      sport,
      name,
      home: fields.home ?? null,
      away: fields.away ?? null,
      session: fields.session ?? null,
      competition: fields.competition ?? null,
      starts_at: startsAt,
      status: "open",
      markets,
      created_at: new Date().toISOString(),
    },
  };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res, { methods: "GET, POST, DELETE, OPTIONS", credentials: true })) return;
  applyCors(req, res, { methods: "GET, POST, DELETE, OPTIONS", credentials: true });
  noStore(res);

  const auth = authorise(req, { allow: ["session", "admin"] });
  if (!auth.ok) return fail(res, 401, "unauthorised");

  if (!isConfigured()) {
    return fail(res, 503, "no-blob-store", "Set BLOB_READ_WRITE_TOKEN to use the match board.");
  }

  /* ---------------- GET ---------------- */
  if (req.method === "GET") {
    try {
      const { data } = await readArenaJson();
      const events = eventsOf(data);
      const bets = Array.isArray(data?.bets) ? data.bets : [];

      return json(res, 200, {
        ok: true,
        /*
         * The registry travels with the board so the admin matrix renders from
         * the same definitions the server validates against. A hard-coded
         * client dropdown can offer a market the server will reject; this
         * cannot.
         */
        sports: registry(),
        events: events.map((e) => ({
          ...e,
          // How many picks reference this event, so the UI can warn before a
          // delete and show activity at a glance.
          pickCount: bets.filter((b) => b.event === e.name).length,
        })),
        count: events.length,
      });
    } catch (err) {
      return fail(res, 502, "read-failed", String(err?.message ?? err));
    }
  }

  /* ---------------- POST ---------------- */
  if (req.method === "POST") {
    if (await enforce(res, `events:post:${auth.subject}`, { max: 40, windowSeconds: 60 })) return;

    const parsed = await readJson(req, { limitBytes: 65_536 });
    if (!parsed.ok) return fail(res, 400, parsed.reason);

    let validation = null;
    try {
      const result = await mutate(
        (data) => {
          const events = eventsOf(data);
          if (events.length >= MAX_EVENTS) {
            const err = new Error(`The board is full (${MAX_EVENTS} events). Remove some first.`);
            err.code = "invalid";
            err.errors = [err.message];
            throw err;
          }

          // Validated INSIDE the mutation so the duplicate check runs against
          // the state actually being written to, not a stale read.
          validation = validateEvent(parsed.value, { events });
          if (!validation.ok) {
            const err = new Error("Validation failed.");
            err.code = "invalid";
            err.errors = validation.errors;
            throw err;
          }

          const bets = Array.isArray(data?.bets) ? data.bets : [];
          const round = data?.round ?? { round: 1, status: "open" };
          const next = buildArena(bets, {
            round: round.round ?? 1,
            status: round.status ?? "open",
            timeZone: ARENA_TZ,
          });
          next.events = [...events, validation.normalised];
          return next;
        },
        { backupPrefix: "backups" },
      );

      return json(res, 201, {
        ok: true,
        event: validation.normalised,
        warnings: validation.warnings,
        count: eventsOf(result.data).length,
        etag: result.etag,
      });
    } catch (err) {
      if (err?.code === "invalid") {
        return json(res, 422, { ok: false, reason: "invalid", errors: err.errors });
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

  /* ---------------- DELETE ---------------- */
  if (req.method === "DELETE") {
    if (await enforce(res, `events:del:${auth.subject}`, { max: 40, windowSeconds: 60 })) return;

    const id = typeof req.query?.id === "string" ? req.query.id : null;
    if (!id) return fail(res, 400, "bad-id", "Pass ?id= the event id.");

    try {
      let removed = null;
      const result = await mutate(
        (data) => {
          const events = eventsOf(data);
          const target = events.find((e) => e.id === id);
          if (!target) {
            const err = new Error(`No event with id ${id}.`);
            err.code = "not-found";
            throw err;
          }

          /*
           * Refused while picks reference it — not because the ledger would
           * break (picks are self-describing and would still render), but
           * because a board that silently loses the fixture its open positions
           * point at is how an admin ends up unable to settle them.
           */
          const bets = Array.isArray(data?.bets) ? data.bets : [];
          const referencing = bets.filter((b) => b.event === target.name);
          const open = referencing.filter((b) => (b.result ?? "pending") === "pending");
          if (open.length > 0) {
            const err = new Error(
              `${open.length} pick${open.length === 1 ? "" : "s"} on "${target.name}" ${open.length === 1 ? "is" : "are"} still pending. ` +
                `Settle or remove them before deleting the event.`,
            );
            err.code = "in-use";
            throw err;
          }

          removed = target;
          const round = data?.round ?? { round: 1, status: "open" };
          const next = buildArena(bets, {
            round: round.round ?? 1,
            status: round.status ?? "open",
            timeZone: ARENA_TZ,
          });
          next.events = events.filter((e) => e.id !== id);
          return next;
        },
        { backupPrefix: "backups" },
      );

      return json(res, 200, { ok: true, removed, count: eventsOf(result.data).length, etag: result.etag });
    } catch (err) {
      if (err?.code === "not-found") return fail(res, 404, "not-found", err.message);
      if (err?.code === "in-use") {
        return json(res, 409, { ok: false, reason: "in-use", errors: [err.message] });
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

  return fail(res, 405, "method-not-allowed");
}

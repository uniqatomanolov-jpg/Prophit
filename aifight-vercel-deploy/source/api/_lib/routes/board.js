/**
 * GET /api/board — today's board, with a reference number on every outcome.
 *
 * WHY THE NUMBERING LIVES HERE
 * ----------------------------
 * The prompt sent to the models numbers every selectable outcome, and the
 * model answers with that number. The manual logging form has to offer the
 * SAME numbers, or "ref 7" means one thing in the prompt and another in the
 * admin panel — which is a silent mis-log, the worst kind.
 *
 * So the numbering is computed once, server-side, by the same traversal order
 * `buildPromptBoard()` uses: matches in board order, then markets in a fixed
 * order, then outcomes as the feed returns them. Both consumers read this
 * route, so they cannot disagree.
 *
 *   ?date=YYYY-MM-DD   another arena day
 *   ?window=next24     roll forward instead of stopping at midnight
 *   ?fresh=1           bypass the cache
 *
 * DEGRADES INSTEAD OF FAILING
 * ---------------------------
 * With no ODDS_API_KEY, or when the feed is down, this returns
 * `{ ok: true, entries: [], reason: "..." }` rather than an error. The form
 * treats an empty board as "type the fixture manually", so logging still
 * works when the odds feed does not. A hard failure here would take manual
 * logging down with the odds API, which is exactly backwards — manual entry
 * is the fallback path.
 */

import { authorise } from "../auth.js";
import { applyCors, fail, handlePreflight, json, noStore } from "../http.js";
import { breaker } from "../ratelimit.js";
import {
  DEFAULT_TZ,
  LEAGUES,
  bestOdds,
  classifyKickoff,
  dayWindow,
  devig,
  discoverActiveLeagues,
  fetchOdds,
  friendlyLeague,
  isBettable,
  localTime,
} from "../oddsApi.js";

/** Market order is fixed so ref numbers are stable across calls. */
const MARKET_ORDER = [
  { key: "h2h", label: "Match Result", storeAs: "1X2" },
  { key: "totals", label: "Total Goals", storeAs: "goals_ou" },
  { key: "btts", label: "Both Teams To Score", storeAs: "btts" },
];

const CACHE_TTL_MS = 60_000;
const cache = new Map();

/**
 * Turn the fetched fixtures into a flat, numbered index.
 *
 * Every entry carries everything the logging form needs to write a complete
 * bet without a second lookup: the fixture string, the market key the ledger
 * stores, the outcome label, the price, and the de-vigged market probability.
 */
function buildIndex(matches, tz) {
  const entries = [];
  let ref = 0;

  for (const match of matches) {
    for (const market of MARKET_ORDER) {
      const outcomes = match.markets?.[market.key] ?? [];
      if (!outcomes.length) continue;

      // De-vig only makes sense on a complete, mutually exclusive market.
      const priced = market.key === "h2h" ? devig(outcomes) : outcomes;

      for (const outcome of priced) {
        if (!Number.isFinite(outcome?.price) || outcome.price <= 1) continue;
        ref += 1;

        const label =
          market.key === "totals" && outcome.point != null
            ? `${outcome.name} ${outcome.point}`
            : outcome.name;

        entries.push({
          ref,
          event: match.fixture,
          eventId: match.id,
          league: match.league,
          kickoff: match.kickoff,
          kickoffLocal: match.kickoffLocal,
          status: match.status,
          bettable: match.bettable,
          market: market.storeAs,
          marketLabel: market.label,
          pick: label,
          odds: Number(outcome.price.toFixed(3)),
          /** De-vigged market probability, when the market supports it. */
          marketProb: outcome.fair != null ? Number(outcome.fair.toFixed(4)) : null,
        });
      }
    }
  }

  return entries;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res, { methods: "GET, OPTIONS", credentials: true })) return;
  applyCors(req, res, { methods: "GET, OPTIONS", credentials: true });
  noStore(res);

  if (req.method !== "GET") return fail(res, 405, "method-not-allowed");

  const auth = authorise(req, { allow: ["session", "admin"] });
  if (!auth.ok) return fail(res, 401, "unauthorised");

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return json(res, 200, {
      ok: true,
      entries: [],
      count: 0,
      reason: "no-key",
      message: "ODDS_API_KEY is not set — enter the fixture manually.",
    });
  }

  const q = req.query ?? {};
  const tz = typeof q.tz === "string" && q.tz.includes("/") ? q.tz : DEFAULT_TZ;
  const rolling = q.window === "next24";
  const fresh = q.fresh === "1" || q.fresh === "true";
  const requestedDate = typeof q.date === "string" ? q.date : undefined;

  const now = new Date();
  const { start, end, date } = dayWindow(tz, requestedDate);
  const from = rolling ? now : start;
  const to = rolling ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : end;

  const cacheKey = `${date}|${tz}|${rolling ? "next24" : "day"}`;
  if (!fresh) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return json(res, 200, { ...hit.body, cached: true });
    }
  }

  try {
    const result = await breaker(
      "odds-board",
      async () => {
        // /events is free, so discovery costs nothing and usually cuts the
        // /odds bill from nine leagues to the two or three actually playing.
        const discovery = await discoverActiveLeagues({ apiKey, leagues: LEAGUES, from, to });
        if (discovery.fatal) {
          const err = new Error(discovery.fatal.code ?? "upstream-rejected");
          err.code = discovery.fatal.code;
          throw err;
        }
        const leagues = discovery.usable && discovery.active.length ? discovery.active : LEAGUES;
        if (discovery.usable && discovery.active.length === 0) {
          return { events: [], failures: [], quota: {}, fatal: null, empty: true };
        }
        return fetchOdds({ apiKey, leagues, from, to });
      },
      { threshold: 4, cooldownMs: 30_000 },
    );

    if (result.fatal) {
      return json(res, 200, {
        ok: true,
        entries: [],
        count: 0,
        reason: result.fatal.code === "quota-exceeded" ? "quota-exceeded" : "bad-api-key",
        message:
          result.fatal.code === "quota-exceeded"
            ? "The Odds API quota is spent — enter the fixture manually."
            : "The Odds API rejected the key — enter the fixture manually.",
      });
    }

    // Deduplicate across leagues, then order the way the prompt does:
    // bettable first, then live, then finished; kick-off time within each.
    const seen = new Set();
    const matches = [];
    for (const ev of result.events ?? []) {
      if (!ev?.id || seen.has(ev.id) || !ev.commence_time) continue;
      seen.add(ev.id);

      const status = classifyKickoff(ev.commence_time, now);
      matches.push({
        id: ev.id,
        fixture: `${ev.home_team} v ${ev.away_team}`,
        league: friendlyLeague(ev.sport_key),
        leaguePriority: ev._leaguePriority ?? 99,
        kickoff: ev.commence_time,
        kickoffLocal: localTime(ev.commence_time, tz),
        status,
        bettable: isBettable(status),
        markets: {
          h2h: bestOdds(ev.bookmakers ?? [], "h2h"),
          totals: bestOdds(ev.bookmakers ?? [], "totals"),
          btts: bestOdds(ev.bookmakers ?? [], "btts"),
        },
      });
    }

    const RANK = { scheduled: 0, in_play: 1, finished: 2 };
    matches.sort((a, b) => {
      if (RANK[a.status] !== RANK[b.status]) return RANK[a.status] - RANK[b.status];
      if (a.leaguePriority !== b.leaguePriority) return a.leaguePriority - b.leaguePriority;
      return new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime();
    });

    const entries = buildIndex(matches.slice(0, 30), tz);

    const body = {
      ok: true,
      date,
      tz,
      generatedAt: now.toISOString(),
      count: entries.length,
      entries,
      /** Only these are safe to stake on; the form disables the rest. */
      bettableCount: entries.filter((e) => e.bettable).length,
      partial: (result.failures ?? []).length > 0,
      reason: entries.length === 0 ? "no-fixtures" : null,
    };

    cache.set(cacheKey, { at: Date.now(), body });
    if (cache.size > 12) cache.delete(cache.keys().next().value);

    return json(res, 200, body);
  } catch (err) {
    /*
     * Never fail the form. Manual entry is the fallback for a broken odds
     * feed, so a 500 here would remove the workaround along with the feature.
     */
    return json(res, 200, {
      ok: true,
      entries: [],
      count: 0,
      reason: err?.code === "circuit-open" ? "feed-unavailable" : "fetch-failed",
      message: "Could not load the board — enter the fixture manually.",
    });
  }
}

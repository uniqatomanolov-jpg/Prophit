/**
 * /api/matches
 *
 * Today's prioritised football fixtures with real odds, shaped for the admin
 * "Find Today's Matches" panel and the public Market Monitor.
 *
 * What changed and why
 * --------------------
 * 1. The day window is computed in the arena's timezone, not the server's.
 *    Vercel runs in UTC, so setHours(0,0,0,0) started "today" up to three
 *    hours late and silently dropped the late kick-offs that matter most.
 *
 * 2. Fixtures whose kick-off has passed are classified, not discarded. Every
 *    match now carries status = scheduled | in_play | finished and a
 *    `bettable` flag. The fetcher no longer produces a slate that invites a
 *    model to bet on a match already at half time.
 *
 * 3. Upstream failures surface. The old code buried every rejection inside
 *    Promise.allSettled, so a rejected API key returned "0 matches" and the
 *    bad-api-key branch below could never run.
 *
 * 4. Hard timeouts, a short response cache and quota reporting. Nine leagues
 *    is nine upstream calls per click against a 500/month free tier; without
 *    a cache an impatient admin can burn the month in an afternoon.
 *
 * Query params:
 *   ?date=YYYY-MM-DD   another arena day (defaults to today)
 *   ?tz=Europe/Sofia   override the arena timezone
 *   ?window=day|next24 'next24' rolls forward instead of stopping at midnight
 *   ?include=all       keep in-play/finished fixtures in the list (default)
 *   ?include=bettable  only fixtures that have not kicked off
 *   ?fresh=1           bypass the cache
 *
 * Env:
 *   ODDS_API_KEY  required — the-odds-api.com
 *   ADMIN_TOKEN   optional — when set, callers must send X-Admin-Token
 *   ARENA_TZ      optional — defaults to Europe/Sofia
 */

import {
  DEFAULT_TZ,
  LEAGUES,
  STATUS_LABEL,
  bestOdds,
  classifyKickoff,
  dayWindow,
  devig,
  discoverActiveLeagues,
  fetchOdds,
  friendlyLeague,
  isBettable,
  localTime,
} from "./_lib/oddsApi.js";
import { authorise } from "./_lib/auth.js";
import { applyCors } from "./_lib/http.js";
import boardHandler from "./_lib/routes/board.js";

/** Direct-hit fallbacks, for a request that arrives without the rewrite. */
const PATH_ROUTES = { "/api/board": "board" };

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



/**
 * Warm-instance cache. Serverless containers are reused between requests, so
 * a 60s TTL collapses a burst of clicks into one upstream fetch. It is a
 * best-effort optimisation, never a correctness dependency.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function noStore(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  // Origin allowlist instead of "*" — see api/_lib/http.js.
  applyCors(req, res, { methods: "GET, OPTIONS", credentials: true });
}

export default async function handler(req, res) {
  if (routeOf(req) === "board") return boardHandler(req, res);

  noStore(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, reason: "method-not-allowed" });
  }

  // Timing-safe, and accepts the admin's session cookie. Kept optional so an
  // unconfigured deployment still serves the public Market Monitor.
  if (process.env.ADMIN_TOKEN && !authorise(req, { allow: ["session", "admin"] }).ok) {
    return res.status(401).json({ ok: false, reason: "unauthorised" });
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      reason: "no-key",
      message: "Set ODDS_API_KEY in your Vercel environment (free key from the-odds-api.com).",
      matches: [],
      count: 0,
    });
  }

  const q = req.query ?? {};
  const tz = typeof q.tz === "string" && q.tz.includes("/") ? q.tz : DEFAULT_TZ;
  const requestedDate = typeof q.date === "string" ? q.date : undefined;
  const rolling = q.window === "next24";
  const onlyBettable = q.include === "bettable";
  const fresh = q.fresh === "1" || q.fresh === "true";

  const now = new Date();
  const { start, end, date } = dayWindow(tz, requestedDate);

  /*
   * The fetch window deliberately begins at the start of the arena day, not
   * at "now". Matches that kicked off earlier today are still wanted — they
   * are what the settlement queue and the In Play badge are built from.
   */
  const from = rolling ? now : start;
  const to = rolling ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : end;

  const cacheKey = `${date}|${tz}|${rolling ? "next24" : "day"}`;
  if (!fresh) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.status(200).json({ ...hit.body, cached: true, cachedAgeMs: Date.now() - hit.at });
    }
  }

  let result;
  let leaguesQueried = LEAGUES;
  let discovery = null;

  try {
    /*
     * Find out who is actually playing before paying to ask.
     *
     * An /odds call costs (markets x regions) credits — 3 here — so querying
     * all nine leagues costs 27 credits even on a Tuesday when six of them are
     * idle. The /events endpoint is FREE, so this discovery pass costs nothing
     * and usually cuts the bill to 6-9 credits.
     *
     * If discovery itself fails we fall back to querying everything, which is
     * only the previous behaviour.
     */
    discovery = await discoverActiveLeagues({ apiKey, leagues: LEAGUES, from, to });
    if (discovery.fatal) {
      const code = discovery.fatal.code === "quota-exceeded" ? "quota-exceeded" : "bad-api-key";
      return res.status(discovery.fatal.status ?? 401).json({
        ok: false,
        reason: code,
        message:
          code === "quota-exceeded"
            ? "The Odds API monthly quota is spent. It resets on your plan's renewal date."
            : "The Odds API rejected your key. Check ODDS_API_KEY in the Vercel env vars.",
        matches: [],
        count: 0,
      });
    }
    if (discovery.usable) {
      if (discovery.active.length === 0) {
        // Nothing is on. Answering now costs zero credits.
        const empty = {
          ok: true,
          date,
          tz,
          window: {
            from: from.toISOString(),
            to: to.toISOString(),
            mode: rolling ? "next24" : "day",
          },
          generatedAt: now.toISOString(),
          count: 0,
          counts: { scheduled: 0, in_play: 0, finished: 0 },
          bettableCount: 0,
          matches: [],
          partial: false,
          failures: [],
          quota: null,
          creditsSpent: 0,
          leaguesQueried: [],
          emptyReason: "no-fixtures",
        };
        cache.set(cacheKey, { at: Date.now(), body: empty });
        return res.status(200).json(empty);
      }
      leaguesQueried = discovery.active;
    }

    result = await fetchOdds({ apiKey, leagues: leaguesQueried, from, to });
  } catch (err) {
    // fetchOdds itself does not throw for upstream trouble; this is a bug guard.
    return res.status(500).json({
      ok: false,
      reason: "fetch-failed",
      message: String(err?.message ?? err),
      matches: [],
      count: 0,
    });
  }

  const { events, failures, quota, fatal } = result;

  // A rejected key or a spent quota is global. Say so instead of "0 matches".
  if (fatal) {
    const code = fatal.code === "quota-exceeded" ? "quota-exceeded" : "bad-api-key";
    return res.status(fatal.status ?? 401).json({
      ok: false,
      reason: code,
      message:
        code === "quota-exceeded"
          ? "The Odds API monthly quota is spent. It resets on your plan's renewal date."
          : "The Odds API rejected your key. Check ODDS_API_KEY in the Vercel env vars.",
      matches: [],
      count: 0,
    });
  }

  /* Deduplicate across leagues, then sort. */
  const seen = new Set();
  const unique = [];
  for (const ev of events) {
    if (!ev?.id || seen.has(ev.id)) continue;
    seen.add(ev.id);
    unique.push(ev);
  }

  const shaped = unique
    .map((ev) => shapeMatch(ev, now, tz))
    .filter((m) => m !== null)
    .filter((m) => (onlyBettable ? m.bettable : true));

  /*
   * Ordering the admin actually wants: things you can still bet on first,
   * then live matches, then finished ones. Within each group, league
   * importance, then kick-off time.
   */
  const STATUS_RANK = { scheduled: 0, in_play: 1, finished: 2 };
  shaped.sort((a, b) => {
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
      return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    }
    if (a.leaguePriority !== b.leaguePriority) return a.leaguePriority - b.leaguePriority;
    return new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime();
  });

  const matches = shaped.slice(0, 30);
  const counts = matches.reduce((acc, m) => ((acc[m.status] = (acc[m.status] ?? 0) + 1), acc), {
    scheduled: 0,
    in_play: 0,
    finished: 0,
  });

  const body = {
    ok: true,
    date,
    tz,
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      mode: rolling ? "next24" : "day",
    },
    generatedAt: now.toISOString(),
    count: matches.length,
    counts,
    /** Only these are safe to build a prompt packet from. */
    bettableCount: counts.scheduled,
    matches,
    /** Non-fatal: leagues that failed while others succeeded. */
    partial: failures.length > 0,
    failures,
    quota: Number.isFinite(quota.remaining)
      ? { remaining: quota.remaining, used: quota.used }
      : null,
    /** Credits this call cost: 3 markets x 1 region per league queried. */
    creditsSpent: leaguesQueried.length * 3,
    leaguesQueried,
    /** Leagues skipped for free because /events showed no fixtures. */
    leaguesSkipped: discovery?.usable ? LEAGUES.length - leaguesQueried.length : 0,
    /** Set when the day genuinely had nothing, so the UI can say why. */
    emptyReason:
      matches.length === 0
        ? failures.length === LEAGUES.length
          ? "all-leagues-failed"
          : "no-fixtures"
        : null,
  };

  cache.set(cacheKey, { at: Date.now(), body });
  // Bound the map so a long-lived instance cannot grow without limit.
  if (cache.size > 24) cache.delete(cache.keys().next().value);

  return res.status(200).json(body);
}

/* ------------------------------------------------------------------ */

function shapeMatch(ev, now, tz) {
  if (!ev.commence_time || !ev.home_team || !ev.away_team) return null;

  const books = ev.bookmakers ?? [];
  const h2h = bestOdds(books, "h2h");
  const totals = bestOdds(books, "totals");
  const btts = bestOdds(books, "btts");

  const status = classifyKickoff(ev.commence_time, now);
  const bettable = isBettable(status);
  const kickoffMs = new Date(ev.commence_time).getTime();
  const minutesToKickoff = Math.round((kickoffMs - now.getTime()) / 60000);

  return {
    id: ev.id,
    fixture: `${ev.home_team} v ${ev.away_team}`,
    home: ev.home_team,
    away: ev.away_team,
    sport: ev.sport_key,
    league: friendlyLeague(ev.sport_key),
    leaguePriority: ev._leaguePriority ?? 99,

    kickoff: ev.commence_time,
    kickoffLocal: localTime(ev.commence_time, tz),
    minutesToKickoff,

    /** scheduled | in_play | finished */
    status,
    statusLabel: STATUS_LABEL[status],
    /** False once the whistle has gone — the prompt generator must respect this. */
    bettable,

    markets: { h2h, totals, btts },
    /** Margin-free probabilities, so the models can be scored on real edge. */
    fair: { h2h: devig(h2h) },

    promptBlock: formatForPrompt(ev, h2h, totals, btts, status, localTime(ev.commence_time, tz)),
  };
}

/**
 * One match as a paste-ready block for the AI prompt.
 *
 * The models quote these prices back verbatim, so the format has to be
 * unambiguous — and a non-bettable fixture has to say so loudly, or a model
 * will happily stake on a game that is already over.
 */
function formatForPrompt(ev, h2h, totals, btts, status, kickoffLocal) {
  const lines = [`${ev.home_team} v ${ev.away_team}  (${kickoffLocal})`];

  if (status !== "scheduled") {
    lines.push(`  ⚠ ${STATUS_LABEL[status].toUpperCase()} — NOT AVAILABLE FOR BETTING`);
  }

  if (h2h.length) {
    const priced = devig(h2h);
    lines.push(
      "  1X2: " +
        priced
          .map((o) => {
            const label =
              o.name === ev.home_team ? "Home" : o.name === ev.away_team ? "Away" : "Draw";
            const fair = o.fair != null ? ` (fair ${(o.fair * 100).toFixed(1)}%)` : "";
            return `${label} ${o.price.toFixed(2)}${fair}`;
          })
          .join(" | "),
    );
  }

  if (totals.length) {
    const over = totals.find((o) => o.name === "Over");
    const under = totals.find((o) => o.name === "Under");
    if (over && under) {
      lines.push(
        `  Totals ${over.point ?? 2.5}: Over ${over.price.toFixed(2)} | Under ${under.price.toFixed(2)}`,
      );
    }
  }

  if (btts.length) {
    const yes = btts.find((o) => o.name === "Yes");
    const no = btts.find((o) => o.name === "No");
    if (yes && no) {
      lines.push(`  BTTS: Yes ${yes.price.toFixed(2)} | No ${no.price.toFixed(2)}`);
    }
  }

  return lines.join("\n");
}

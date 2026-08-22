/**
 * Shared client for The Odds API.
 *
 * Used by /api/matches (fixture discovery) and /api/settle (result grading),
 * so the league list, timezone handling and quota accounting exist once
 * rather than drifting apart in two copies.
 *
 * Nothing in here throws for an ordinary upstream failure. Callers get a
 * structured result with a `failures` array, because one dead league must
 * not take down a fetch that succeeded for the other eight.
 */

export const LEAGUES = [
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_germany_bundesliga",
  "soccer_italy_serie_a",
  "soccer_france_ligue_one",
  "soccer_portugal_primeira_liga",
  "soccer_bulgaria_profesionalna_liga",
];

const LEAGUE_NAMES = {
  soccer_uefa_champs_league: "Champions League",
  soccer_uefa_europa_league: "Europa League",
  soccer_epl: "Premier League",
  soccer_spain_la_liga: "La Liga",
  soccer_germany_bundesliga: "Bundesliga",
  soccer_italy_serie_a: "Serie A",
  soccer_france_ligue_one: "Ligue 1",
  soccer_portugal_primeira_liga: "Primeira Liga",
  soccer_bulgaria_profesionalna_liga: "Bulgarian A PFG",
};

export const friendlyLeague = (key) => LEAGUE_NAMES[key] ?? key;

/** The arena's home timezone. Overridable per-deployment. */
export const DEFAULT_TZ = process.env.ARENA_TZ || "Europe/Sofia";

/**
 * Wall-clock minutes from kick-off until a football match is certainly done.
 * 90 + half time + stoppage + a safety margin. Used only to *propose* that a
 * fixture has finished; the scores endpoint is what confirms it.
 */
export const FULL_TIME_MINUTES = 130;

/* ------------------------------------------------------------------ *
 * Timezone-aware day boundaries
 *
 * The old code called setHours(0,0,0,0), which uses the *server's* clock.
 * On Vercel that is UTC, so "today" started up to three hours late and the
 * evening kick-offs an admin actually cares about fell outside the window.
 * ------------------------------------------------------------------ */

/** Offset, in ms, of `tz` from UTC at the given instant (DST-aware). */
function tzOffsetMs(instant, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(instant)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});

  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - instant.getTime();
}

/** Calendar date in `tz` as { y, m, d }. */
function civilDate(instant, tz) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(instant)
    .reduce((acc, x) => ((acc[x.type] = x.value), acc), {});
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

/** Midnight at the start of the given civil date in `tz`, as a Date. */
function midnightInTz({ y, m, d }, tz) {
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  // Two passes so a DST transition on the boundary still lands correctly.
  let ts = naive - tzOffsetMs(new Date(naive), tz);
  ts = naive - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

/**
 * The [start, end) window for one arena day.
 *
 * @param {string} tz      IANA zone.
 * @param {string} [isoDate] YYYY-MM-DD. Defaults to today in `tz`.
 */
export function dayWindow(tz = DEFAULT_TZ, isoDate) {
  const now = new Date();
  let civil;

  if (isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    const [y, m, d] = isoDate.split("-").map(Number);
    civil = { y, m, d };
  } else {
    civil = civilDate(now, tz);
  }

  const start = midnightInTz(civil, tz);
  const end = new Date(midnightInTz(civil, tz).getTime() + 24 * 60 * 60 * 1000);
  // Recompute the end from the next civil date so a 23h or 25h DST day is exact.
  const nextCivil = civilDate(new Date(start.getTime() + 36 * 60 * 60 * 1000), tz);
  const exactEnd = midnightInTz(nextCivil, tz);

  const date = `${String(civil.y).padStart(4, "0")}-${String(civil.m).padStart(2, "0")}-${String(civil.d).padStart(2, "0")}`;

  return { start, end: exactEnd.getTime() > start.getTime() ? exactEnd : end, date, tz };
}

/** Formats an instant as HH:mm in the arena's timezone. */
export function localTime(iso, tz = DEFAULT_TZ) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/* ------------------------------------------------------------------ *
 * Fixture status
 * ------------------------------------------------------------------ */

/**
 * Where a fixture sits in its lifecycle.
 *
 * The daily fetcher used to treat every returned event as an upcoming
 * fixture. Anything already kicked off then showed a kick-off time in the
 * past, and the prompt packet invited the models to bet on a match that was
 * halfway through. Classifying instead of discarding keeps those fixtures
 * visible and clearly labelled.
 *
 * @returns {"scheduled"|"in_play"|"finished"}
 */
export function classifyKickoff(commenceTime, now = new Date(), confirmedComplete = false) {
  if (confirmedComplete) return "finished";

  const kickoff = new Date(commenceTime).getTime();
  if (!Number.isFinite(kickoff)) return "scheduled";

  const elapsedMin = (now.getTime() - kickoff) / 60000;
  if (elapsedMin < 0) return "scheduled";
  if (elapsedMin < FULL_TIME_MINUTES) return "in_play";
  return "finished";
}

export const STATUS_LABEL = {
  scheduled: "Scheduled",
  in_play: "In Play",
  finished: "Finished",
};

/** A fixture is only bettable while it has not kicked off. */
export const isBettable = (status) => status === "scheduled";

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

export class OddsApiError extends Error {
  constructor(code, message, status) {
    super(message ?? code);
    this.code = code;
    this.status = status ?? 502;
  }
}

/**
 * One upstream call, with a hard timeout.
 *
 * Without this a hung connection holds the serverless function open until
 * the platform kills it, and the admin sees a generic gateway error instead
 * of a useful one.
 */
async function getJson(url, timeoutMs = 8000) {
  let res;
  try {
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new OddsApiError(
      timedOut ? "timeout" : "network",
      timedOut ? `Upstream did not respond within ${timeoutMs}ms` : String(err?.message ?? err),
      504,
    );
  }

  const quota = {
    remaining: Number(res.headers.get("x-requests-remaining") ?? NaN),
    used: Number(res.headers.get("x-requests-used") ?? NaN),
  };

  if (res.status === 401)
    throw new OddsApiError("bad-api-key", "The Odds API rejected the key.", 401);
  if (res.status === 429)
    throw new OddsApiError("quota-exceeded", "The Odds API monthly quota is spent.", 429);
  // 422 = this sport has no data right now. Normal, not an error.
  if (res.status === 422) return { data: [], quota };
  if (!res.ok) throw new OddsApiError(`http-${res.status}`, `Upstream returned ${res.status}`, 502);

  const data = await res.json().catch(() => null);
  return { data: data ?? [], quota };
}

/**
 * Which of these leagues actually have fixtures in the window.
 *
 * THIS ENDPOINT IS FREE — /events does not count against the usage quota.
 * That matters enormously here. An /odds request costs
 * (markets x regions) credits, so asking nine leagues for three markets
 * costs 27 credits whether or not those leagues are playing today. On a
 * Tuesday most of them are not.
 *
 * Spending zero credits to find out who is playing, then paying only for
 * those, typically cuts a fixture fetch from 27 credits to 6-9.
 *
 * Degrades safely: if discovery fails the caller falls back to querying
 * everything, which is merely the old behaviour.
 */
export async function discoverActiveLeagues({
  apiKey,
  leagues = LEAGUES,
  from,
  to,
  timeoutMs = 8000,
}) {
  const settled = await Promise.allSettled(
    leagues.map(async (sport) => {
      const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/events`);
      url.searchParams.set("apiKey", apiKey);
      if (from) url.searchParams.set("commenceTimeFrom", isoSeconds(from));
      if (to) url.searchParams.set("commenceTimeTo", isoSeconds(to));
      const { data } = await getJson(url.toString(), timeoutMs);
      return { sport, count: Array.isArray(data) ? data.length : 0 };
    }),
  );

  const active = [];
  let fatal = null;
  let usable = false;

  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      usable = true;
      if (r.value.count > 0) active.push(leagues[i]);
      return;
    }
    const code = r.reason instanceof OddsApiError ? r.reason.code : "unknown";
    if ((code === "bad-api-key" || code === "quota-exceeded") && !fatal) fatal = r.reason;
  });

  // If every probe failed we learned nothing — say so rather than claiming
  // there are no fixtures today.
  return { active, fatal, usable };
}

/**
 * Odds for every requested league, in parallel.
 *
 * Partial failure is expected and reported rather than hidden. The previous
 * version wrapped these in Promise.allSettled and dropped every rejection on
 * the floor, so an invalid API key produced a cheerful "0 matches found"
 * and the dedicated bad-api-key branch was unreachable.
 */
export async function fetchOdds({
  apiKey,
  leagues = LEAGUES,
  from,
  to,
  regions = "eu",
  markets = "h2h,totals,btts",
  bookmakers = "bet365,unibet,pinnacle,betfair_ex_eu",
  timeoutMs = 8000,
}) {
  const settled = await Promise.allSettled(
    leagues.map(async (sport) => {
      const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
      url.searchParams.set("apiKey", apiKey);
      url.searchParams.set("regions", regions);
      url.searchParams.set("markets", markets);
      url.searchParams.set("bookmakers", bookmakers);
      url.searchParams.set("oddsFormat", "decimal");
      if (from) url.searchParams.set("commenceTimeFrom", isoSeconds(from));
      if (to) url.searchParams.set("commenceTimeTo", isoSeconds(to));

      const { data, quota } = await getJson(url.toString(), timeoutMs);
      return { sport, events: Array.isArray(data) ? data : [], quota };
    }),
  );

  const events = [];
  const failures = [];
  let quota = { remaining: NaN, used: NaN };
  let fatal = null;

  settled.forEach((r, i) => {
    const sport = leagues[i];
    if (r.status === "fulfilled") {
      // Rank against the canonical league order, not this call's slice.
      // Callers may pass a filtered subset (see discoverActiveLeagues) and
      // still expect the Champions League to sort above the Bulgarian one.
      const priority = LEAGUES.indexOf(sport);
      for (const ev of r.value.events) {
        events.push({
          ...ev,
          _leaguePriority: priority === -1 ? i : priority,
          sport_key: ev.sport_key ?? sport,
        });
      }
      if (Number.isFinite(r.value.quota.remaining)) quota = r.value.quota;
      return;
    }
    const err = r.reason;
    const code = err instanceof OddsApiError ? err.code : "unknown";
    failures.push({
      sport,
      league: friendlyLeague(sport),
      code,
      message: String(err?.message ?? err),
    });
    // A bad key or spent quota is global, not per-league — surface it.
    if ((code === "bad-api-key" || code === "quota-exceeded") && !fatal) fatal = err;
  });

  return { events, failures, quota, fatal };
}

/**
 * Final scores for recently completed fixtures.
 *
 * This is the input to automated settlement: `completed: true` plus a score
 * pair is everything the grader needs.
 *
 * Costs 2 credits per league when daysFrom is set. See fetchScoresFor() for
 * the cheaper path settlement actually uses.
 */
export async function fetchScores({ apiKey, leagues = LEAGUES, daysFrom = 1, timeoutMs = 8000 }) {
  const settled = await Promise.allSettled(
    leagues.map(async (sport) => {
      const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/scores/`);
      url.searchParams.set("apiKey", apiKey);
      url.searchParams.set("daysFrom", String(Math.min(Math.max(daysFrom, 1), 3)));
      const { data, quota } = await getJson(url.toString(), timeoutMs);
      return { sport, games: Array.isArray(data) ? data : [], quota };
    }),
  );

  const games = [];
  const failures = [];
  let fatal = null;

  settled.forEach((r, i) => {
    const sport = leagues[i];
    if (r.status === "fulfilled") {
      for (const g of r.value.games) games.push({ ...g, sport_key: g.sport_key ?? sport });
      return;
    }
    const code = r.reason instanceof OddsApiError ? r.reason.code : "unknown";
    failures.push({ sport, code, message: String(r.reason?.message ?? r.reason) });
    if ((code === "bad-api-key" || code === "quota-exceeded") && !fatal) fatal = r.reason;
  });

  return { games, failures, fatal };
}

/**
 * Scores, one league at a time, stopping as soon as every fixture is found.
 *
 * The scores endpoint costs 2 credits per league per call. Settlement runs on
 * a schedule, so querying all nine leagues every time costs 18 credits a run —
 * 540 a month against a 500-credit free tier, before a single fixture fetch.
 *
 * In practice a day's bets sit in one or two leagues. Walking leagues in
 * priority order and stopping once `isSatisfied` reports everything matched
 * turns the usual run into 2-4 credits, while the worst case is still just the
 * old behaviour.
 *
 * @param {(games: object[]) => boolean} isSatisfied
 *        Called after each league with everything gathered so far.
 */
export async function fetchScoresFor({
  apiKey,
  leagues = LEAGUES,
  daysFrom = 1,
  timeoutMs = 8000,
  isSatisfied = () => false,
}) {
  const games = [];
  const failures = [];
  const queried = [];
  let fatal = null;

  for (const sport of leagues) {
    try {
      const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/scores/`);
      url.searchParams.set("apiKey", apiKey);
      url.searchParams.set("daysFrom", String(Math.min(Math.max(daysFrom, 1), 3)));

      const { data } = await getJson(url.toString(), timeoutMs);
      queried.push(sport);
      for (const g of Array.isArray(data) ? data : []) {
        games.push({ ...g, sport_key: g.sport_key ?? sport });
      }
    } catch (err) {
      const code = err instanceof OddsApiError ? err.code : "unknown";
      failures.push({ sport, code, message: String(err?.message ?? err) });
      // A bad key or spent quota applies to every league — stop paying to
      // rediscover the same failure eight more times.
      if (code === "bad-api-key" || code === "quota-exceeded") {
        fatal = err;
        break;
      }
      continue;
    }

    if (isSatisfied(games)) break;
  }

  return { games, failures, fatal, queried, creditsSpent: queried.length * 2 };
}

/** Reads home/away goals out of a scores-endpoint payload. */
export function readScore(game) {
  const scores = game?.scores;
  if (!Array.isArray(scores) || scores.length < 2) return null;

  const find = (team) => {
    const hit = scores.find((s) => s?.name === team);
    const n = Number(hit?.score);
    return Number.isFinite(n) ? n : null;
  };

  const home = find(game.home_team);
  const away = find(game.away_team);
  if (home === null || away === null) return null;
  return { home, away };
}

/** The Odds API wants whole-second ISO timestamps; milliseconds are rejected. */
export function isoSeconds(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Best (highest) price per outcome across all bookmakers for one market. */
export function bestOdds(bookmakers, market) {
  const map = new Map();
  for (const bk of bookmakers ?? []) {
    const m = bk.markets?.find((x) => x.key === market);
    if (!m) continue;
    for (const o of m.outcomes ?? []) {
      const existing = map.get(o.name);
      const price = Number(o.price);
      if (!Number.isFinite(price)) continue;
      if (!existing || price > existing.price) {
        map.set(o.name, { name: o.name, price, point: o.point ?? null, book: bk.title ?? bk.key });
      }
    }
  }
  return [...map.values()];
}

/** Removes the bookmaker's margin to get a fair implied probability per outcome. */
export function devig(outcomes) {
  const inv = outcomes.map((o) => (o.price > 1 ? 1 / o.price : 0));
  const overround = inv.reduce((a, b) => a + b, 0);
  if (overround <= 0) return outcomes.map((o) => ({ ...o, implied: null, fair: null }));
  return outcomes.map((o, i) => ({
    ...o,
    implied: inv[i],
    fair: inv[i] / overround,
  }));
}

/**
 * GET /api/health — system health and platform telemetry.
 *
 * Two audiences, one endpoint, two levels of detail:
 *
 *   unauthenticated   a bare `{ ok, status }`. Enough for an uptime probe,
 *                     and nothing an attacker can use to map the system.
 *   admin session     the full picture: dependency checks, circuit breaker
 *                     state, settlement backlog, quota, configuration gaps.
 *
 * WHY THE SPLIT MATTERS
 * ---------------------
 * A public health endpoint that lists which env vars are missing, which
 * dependency is down and how far behind settlement is, is a reconnaissance
 * gift. "storage-unavailable" plus "ADMIN_SESSION_SECRET missing" tells an
 * attacker exactly when to try. The detail is behind the session cookie.
 *
 * WHAT "DEGRADED" MEANS
 * ---------------------
 * Not every dependency is load-bearing. The odds API being down stops new
 * boards being built but does not affect a single visitor reading yesterday's
 * results. Supabase being down takes the site out. The status below reflects
 * that: `critical` only when something user-facing is broken.
 */

import { authConfigured, authorise } from "./_lib/auth.js";
import { fail, fetchWithTimeout, handlePreflight, json, noStore } from "./_lib/http.js";
import { breakerSnapshot } from "./_lib/ratelimit.js";
import diagnoseHandler from "./_lib/routes/diagnose.js";

/** Direct-hit fallbacks, for a request that arrives without the rewrite. */
const PATH_ROUTES = { "/api/diagnose": "diagnose" };

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
 * Probe one dependency.
 *
 * Always resolves — a health check that throws is a health check that reports
 * nothing. Latency is recorded even on failure, because a timeout at 8000ms
 * and a refused connection at 12ms are different problems.
 */
async function probe(name, critical, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, critical, ok: true, ms: Date.now() - started, ...detail };
  } catch (err) {
    return {
      name,
      critical,
      ok: false,
      ms: Date.now() - started,
      error: String(err?.message ?? err).slice(0, 200),
    };
  }
}

async function checkSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { skipped: true, reason: "not-configured" };

  // A HEAD against the REST root with a zero-row range: proves the database
  // answers without transferring a result set.
  const res = await fetchWithTimeout(`${url}/rest/v1/bets?select=id&limit=1`, {
    timeoutMs: 4000,
    headers: { apikey: key, Authorization: `Bearer ${key}`, Range: "0-0" },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  return { status: res.status };
}

async function checkBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { skipped: true, reason: "not-configured" };
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: "arena.json", limit: 1 });
  const arena = blobs.find((b) => b.pathname === "arena.json");
  return {
    present: Boolean(arena),
    updatedAt: arena?.uploadedAt ?? null,
    bytes: arena?.size ?? null,
  };
}

async function checkOddsApi() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { skipped: true, reason: "not-configured" };

  // /sports is free — it costs no quota to confirm the key is live.
  const res = await fetchWithTimeout(
    `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(key)}`,
    { timeoutMs: 5000 },
  );
  if (res.status === 401) throw new Error("key rejected");
  if (!res.ok) throw new Error(`odds api ${res.status}`);

  const remaining = Number(res.headers.get("x-requests-remaining"));
  const used = Number(res.headers.get("x-requests-used"));
  return {
    quotaRemaining: Number.isFinite(remaining) ? remaining : null,
    quotaUsed: Number.isFinite(used) ? used : null,
    // Surfaced so the admin sees it coming rather than discovering it when a
    // board comes back empty on a Saturday morning.
    quotaLow: Number.isFinite(remaining) && remaining < 50,
  };
}

export default async function handler(req, res) {
  if (routeOf(req) === "diagnose") return diagnoseHandler(req, res);

  if (handlePreflight(req, res, { methods: "GET, OPTIONS", credentials: true })) return;
  noStore(res);
  if (req.method !== "GET") return fail(res, 405, "method-not-allowed");

  const auth = authorise(req, { allow: ["session", "admin"] });

  /* ---- Public: liveness only ---- */
  if (!auth.ok) {
    return json(res, 200, { ok: true, status: "up" });
  }

  /* ---- Admin: the full picture ---- */
  const checks = await Promise.all([
    probe("supabase", true, checkSupabase),
    probe("blob", true, checkBlob),
    probe("odds-api", false, checkOddsApi),
  ]);

  const configured = authConfigured();
  const missing = [
    !configured.hash && "ADMIN_PASSWORD_HASH",
    !configured.secret && "ADMIN_SESSION_SECRET",
    !process.env.SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
    !process.env.BLOB_READ_WRITE_TOKEN && "BLOB_READ_WRITE_TOKEN",
    !process.env.ODDS_API_KEY && "ODDS_API_KEY",
    !process.env.CRON_SECRET && "CRON_SECRET",
  ].filter(Boolean);

  const failedCritical = checks.filter((c) => c.critical && !c.ok && !c.skipped);
  const failedOptional = checks.filter((c) => !c.critical && !c.ok && !c.skipped);

  const status =
    failedCritical.length > 0
      ? "critical"
      : failedOptional.length > 0 || missing.length > 0
        ? "degraded"
        : "healthy";

  return json(res, 200, {
    ok: status !== "critical",
    status,
    checkedAt: new Date().toISOString(),
    checks,
    /** Open breakers are the fastest read on "what is failing right now". */
    breakers: breakerSnapshot(),
    config: { missing, ready: configured.ready },
    deployment: {
      env: process.env.VERCEL_ENV ?? "development",
      region: process.env.VERCEL_REGION ?? null,
      // The commit this instance is running, so a "did my fix deploy?"
      // question is answered by a URL rather than by guesswork.
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
}

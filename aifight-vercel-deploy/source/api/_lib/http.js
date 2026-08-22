/**
 * Shared HTTP plumbing for every serverless function.
 *
 * WHAT THIS REPLACES
 * ------------------
 * Every handler in the shipped build opened with its own copy of:
 *
 *   res.setHeader("Access-Control-Allow-Origin", "*");
 *   res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
 *
 * A wildcard origin on a route that accepts a credential header is an open
 * door: it invites any page on the internet to script requests against this
 * API using a token it has phished or found. Now that the admin session is a
 * cookie, wildcard CORS is also simply illegal — browsers refuse to send
 * credentials to `*`, and the correct answer is an allowlist that echoes back
 * one specific origin.
 *
 * The four copies also drifted. `arena.js` allowed POST, `matches.js` did
 * not, `settle.js` allowed an Authorization header the other two dropped.
 * One implementation, used everywhere, cannot drift.
 */

/**
 * Origins allowed to call this API from a browser.
 *
 * Production and preview deployments are matched by pattern because Vercel
 * mints a new hostname per deploy. localhost is allowed only outside
 * production, so a developer's machine can never be an approved origin for
 * the live site.
 */
function allowedOrigin(origin) {
  if (!origin) return null;

  let host;
  let protocol;
  try {
    const url = new URL(origin);
    host = url.host;
    protocol = url.protocol;
  } catch {
    return null;
  }

  const extra = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return origin;

  const isProd = process.env.VERCEL_ENV === "production";

  if (!isProd && protocol === "http:" && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    return origin;
  }
  if (protocol !== "https:") return null;

  // The canonical production host.
  if (host === (process.env.PUBLIC_HOST ?? "aifight.vercel.app")) return origin;

  // Preview deployments: <project>-<hash>-<scope>.vercel.app
  if (!isProd && /^[a-z0-9-]+\.vercel\.app$/.test(host)) return origin;

  return null;
}

/**
 * Apply CORS and the baseline security headers.
 *
 * `Vary: Origin` is not optional here. Without it a CDN can cache the
 * response it built for one approved origin and serve those headers to
 * another — turning an allowlist back into a wildcard.
 */
export function applyCors(req, res, { methods = "GET, OPTIONS", credentials = false } = {}) {
  const origin = allowedOrigin(req.headers?.origin);

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    if (credentials) res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token, If-Match");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export function noStore(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
}

/**
 * Handle a preflight and report whether the request is finished.
 *
 * A preflight from a disallowed origin still gets 204 — refusing it here
 * would only tell a prober which origins are on the list. The browser
 * enforces the block because the Allow-Origin header is absent.
 */
export function handlePreflight(req, res, options) {
  applyCors(req, res, options);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

export function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(body));
}

export function fail(res, status, reason, message) {
  json(res, status, { ok: false, reason, ...(message ? { message } : {}) });
}

/**
 * Read and parse a JSON body with a hard size ceiling.
 *
 * Vercel usually pre-parses `req.body`, but not always — a wrong or missing
 * Content-Type leaves a raw stream, and the shipped `arena.js` handled that
 * with `typeof req.body === "string" ? JSON.parse(req.body) : req.body`,
 * which throws an unhandled SyntaxError on any malformed payload and returns
 * an opaque 500. This reads the stream itself, refuses anything oversized
 * before buffering it, and returns a typed failure instead of throwing.
 */
export async function readJson(req, { limitBytes = 1_000_000 } = {}) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== "string") {
    return { ok: true, value: req.body };
  }

  if (typeof req.body === "string") {
    if (Buffer.byteLength(req.body) > limitBytes) return { ok: false, reason: "payload-too-large" };
    try {
      return { ok: true, value: JSON.parse(req.body) };
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
  }

  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > limitBytes) {
    return { ok: false, reason: "payload-too-large" };
  }

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      // Check before pushing, so an oversized body is never fully buffered.
      if (total > limitBytes) return { ok: false, reason: "payload-too-large" };
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, reason: "read-failed" };
  }

  if (total === 0) return { ok: true, value: null };

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
}

/**
 * `fetch` with a real deadline.
 *
 * Node's fetch has no default timeout. A hung upstream — an LLM endpoint, the
 * odds API, a blob read — therefore hangs the whole function until Vercel
 * kills it at the platform limit and the caller gets a bare 504 with no
 * diagnosis. An AbortController gives us a timeout we chose, an error we can
 * name, and a fallback path we control.
 */
export async function fetchWithTimeout(url, { timeoutMs = 8000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retry an idempotent operation with exponential backoff and full jitter.
 *
 * Jitter is the point. Five leagues retrying on a synchronised schedule
 * reproduce the burst that caused the failure; randomising the delay spreads
 * them out. Only retries what is worth retrying — a 401 will still be a 401
 * in 400ms, and burning quota to confirm that helps nobody.
 */
export async function withRetry(fn, { attempts = 3, baseMs = 250, retryable } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const canRetry = retryable ? retryable(err) : err?.name !== "AbortError";
      if (!canRetry || attempt === attempts - 1) break;
      const backoff = baseMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * backoff));
    }
  }
  throw lastError;
}

/**
 * The caller's IP, for rate limiting.
 *
 * Only the FIRST entry of x-forwarded-for is trusted, and only because Vercel
 * rewrites that header at the edge. Reading the last entry, or trusting this
 * header behind a proxy that does not normalise it, lets a caller forge a new
 * identity per request and walk straight through the limiter.
 */
export function clientIp(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  const real = req.headers?.["x-real-ip"];
  if (typeof real === "string" && real.length) return real.trim();
  return req.socket?.remoteAddress ?? "unknown";
}

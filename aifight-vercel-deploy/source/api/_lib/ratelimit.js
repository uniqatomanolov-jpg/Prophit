/**
 * Rate limiting and circuit breaking.
 *
 * TWO PROBLEMS, TWO MECHANISMS
 * ----------------------------
 * `limit()` stops a caller hammering us. The login route is the one that
 * matters: without it, `/api/admin/login` is an unmetered password oracle and
 * a five-character password falls in minutes. Login is limited by IP *and* by
 * account, because an attacker with a botnet defeats an IP-only limiter.
 *
 * `breaker()` stops us hammering somebody else. When an upstream LLM endpoint
 * or the odds API starts failing, continuing to call it converts one broken
 * dependency into a slow, expensive, still-broken page. After a threshold of
 * failures the breaker opens and calls fail instantly with a named reason,
 * which is what lets the UI render a real fallback instead of a spinner.
 *
 * HONEST LIMITATION
 * -----------------
 * State lives in the warm serverless instance. Vercel reuses containers, so
 * this catches the overwhelming majority of real abuse, but an attacker who
 * can force cold starts gets a fresh bucket each time. For a paper-trading
 * arena that is a sound trade. If this ever guards real money, set
 * UPSTASH_REDIS_REST_URL / _TOKEN and `limit()` becomes globally durable —
 * the code path is below and needs no other change.
 */

import { fetchWithTimeout } from "./http.js";

const buckets = new Map();
const breakers = new Map();

/** Bound the map so a long-lived instance cannot grow without limit. */
const MAX_BUCKETS = 5000;

function prune(now) {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
    if (buckets.size <= MAX_BUCKETS / 2) break;
  }
}

/* ------------------------------------------------------------------ */
/* Durable limiter (optional)                                          */
/* ------------------------------------------------------------------ */

function redisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * INCR + EXPIRE against Upstash's REST API.
 *
 * A network failure here must not lock the site out of its own admin panel,
 * so this returns null on any error and the caller falls back to the
 * in-memory bucket. Failing open on the *durable* layer while the in-memory
 * layer still applies is the right trade: availability is preserved and abuse
 * is still bounded per instance.
 */
async function redisIncr(key, windowSeconds) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    const res = await fetchWithTimeout(`${base}/pipeline`, {
      method: "POST",
      timeoutMs: 1500,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(windowSeconds), "NX"],
      ]),
    });
    if (!res.ok) return null;
    const out = await res.json();
    const count = Number(out?.[0]?.result);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Fixed-window limiter                                                */
/* ------------------------------------------------------------------ */

/**
 * Consume one unit against `key`.
 *
 * Returns `{ ok, remaining, retryAfter }`. `retryAfter` is in seconds and is
 * meant for the `Retry-After` header — a well-behaved client backs off
 * correctly instead of guessing, and a badly-behaved one is no worse off.
 */
export async function limit(key, { max = 10, windowSeconds = 60 } = {}) {
  const now = Date.now();

  if (redisConfigured()) {
    const window = Math.floor(now / (windowSeconds * 1000));
    const count = await redisIncr(`rl:${key}:${window}`, windowSeconds);
    if (count !== null) {
      const resetAt = (window + 1) * windowSeconds * 1000;
      return {
        ok: count <= max,
        remaining: Math.max(0, max - count),
        retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
        durable: true,
      };
    }
  }

  prune(now);
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowSeconds * 1000 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  return {
    ok: bucket.count <= max,
    remaining: Math.max(0, max - bucket.count),
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    durable: false,
  };
}

/**
 * Apply a limit and write the standard headers.
 *
 * Returns true when the request should be rejected, so a handler reads:
 *
 *   if (await enforce(req, res, { key, max: 5 })) return;
 */
export async function enforce(res, key, options) {
  const result = await limit(key, options);
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
  if (!result.ok) {
    res.setHeader("Retry-After", String(result.retryAfter));
    res.status(429).json({
      ok: false,
      reason: "rate-limited",
      message: `Too many requests. Try again in ${result.retryAfter}s.`,
      retryAfter: result.retryAfter,
    });
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Circuit breaker                                                     */
/* ------------------------------------------------------------------ */

/**
 * Wrap a call to an unreliable dependency.
 *
 * States: closed (normal) → open (failing fast) → half-open (one probe).
 * The half-open probe is what makes this self-healing: exactly one request is
 * allowed through after the cooldown, and it either closes the breaker or
 * reopens it. Without it the breaker would need an external reset.
 *
 * The thrown error carries `code: "circuit-open"` so callers can distinguish
 * "the dependency is down" from "the dependency said no", and render the
 * right fallback for each.
 */
export async function breaker(name, fn, { threshold = 4, cooldownMs = 30_000 } = {}) {
  const now = Date.now();
  let state = breakers.get(name);
  if (!state) {
    state = { failures: 0, openedAt: 0, probing: false };
    breakers.set(name, state);
  }

  const isOpen = state.openedAt > 0 && now - state.openedAt < cooldownMs;
  if (isOpen && !state.probing) {
    const err = new Error(`Circuit open for ${name}`);
    err.code = "circuit-open";
    err.retryAfterMs = cooldownMs - (now - state.openedAt);
    throw err;
  }

  // Cooldown elapsed: let exactly one caller probe.
  if (state.openedAt > 0 && !isOpen) state.probing = true;

  try {
    const result = await fn();
    state.failures = 0;
    state.openedAt = 0;
    state.probing = false;
    return result;
  } catch (err) {
    state.failures += 1;
    state.probing = false;
    if (state.failures >= threshold) state.openedAt = Date.now();
    throw err;
  }
}

/** Breaker state, for `/api/health`. */
export function breakerSnapshot() {
  const now = Date.now();
  const out = {};
  for (const [name, state] of breakers) {
    out[name] = {
      failures: state.failures,
      open: state.openedAt > 0 && now - state.openedAt < 30_000,
      openedAt: state.openedAt ? new Date(state.openedAt).toISOString() : null,
    };
  }
  return out;
}

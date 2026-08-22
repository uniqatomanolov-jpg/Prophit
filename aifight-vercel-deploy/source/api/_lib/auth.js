/**
 * Server-side admin authentication.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The shipped build authenticated the admin like this:
 *
 *   function configuredPassword() { return window.__AIFIGHT_CONFIG__?.adminPassword }
 *   function isLocalUnlocked()    { return sessionStorage.getItem('aifight_local_pass_ok') === '1' }
 *
 * Both halves are broken, independently:
 *
 *   1. `config.js` is a public static asset. `curl https://<site>/config.js`
 *      returned the admin password in cleartext to anybody who asked.
 *   2. Even without the password, the gate was a client-side boolean. Typing
 *      `sessionStorage.setItem('aifight_local_pass_ok','1')` into devtools
 *      opened the admin console. There was no server involved at all.
 *
 * A third hole sat behind them: the real `ADMIN_TOKEN` — the secret that
 * authorises `POST /api/arena` and can rewrite every bankroll on the site —
 * was typed into the browser and persisted in `localStorage`, where any
 * injected script on the origin could read it.
 *
 * THE REPLACEMENT
 * ---------------
 * The password never leaves the server. The client posts it to
 * `/api/admin/login`, which compares it against a scrypt hash held in an
 * environment variable and, on success, sets an HMAC-signed session cookie.
 * Every privileged endpoint verifies that signature server-side. The browser
 * holds an opaque, expiring, HttpOnly credential and nothing else — no
 * password, no ADMIN_TOKEN, nothing an XSS payload can exfiltrate and replay
 * from another machine.
 *
 * Design notes that matter:
 *
 *   scrypt, not SHA-256   A password hash must be slow. scrypt is in Node's
 *                         standard library, so this adds no dependency.
 *   Timing-safe compare   Both the hash check and the signature check use
 *                         `timingSafeEqual`. A byte-by-byte `===` on a secret
 *                         leaks its prefix to a patient attacker.
 *   __Host- prefix        Browsers refuse a `__Host-` cookie that is not
 *                         Secure, Path=/ and host-locked. It is a free
 *                         guarantee that no subdomain can plant a session.
 *   Absolute expiry       The signature covers the expiry, so a stolen cookie
 *                         dies on schedule and cannot be extended client-side.
 *   Key-versioned         The payload carries the secret's version, so
 *                         rotating ADMIN_SESSION_SECRET invalidates every
 *                         outstanding session by construction.
 *
 * REQUIRED ENVIRONMENT (Vercel → Settings → Environment Variables)
 * ---------------------------------------------------------------
 *   ADMIN_PASSWORD_HASH    scrypt hash of the admin password.
 *                          Generate: `node scripts/hash-password.mjs`
 *   ADMIN_SESSION_SECRET   >= 32 random bytes. `openssl rand -hex 32`
 *   ADMIN_TOKEN            machine-to-machine secret for cron/CLI only.
 *                          Never sent to a browser.
 *   CRON_SECRET            what Vercel Cron sends. Optional.
 *
 * None of these are prefixed `VITE_`, so Vite cannot inline them into the
 * bundle even by accident. That is deliberate — see scripts/check-secrets.mjs,
 * which fails the build if a secret ever reaches the client output.
 */

import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

/** Cookie name. The `__Host-` prefix is enforced by the browser, not by us. */
export const SESSION_COOKIE = "__Host-aifight_admin";

/** Sessions last one working day, then the admin logs in again. */
const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** scrypt cost. 2^15 keeps a single verification near ~100ms on Vercel. */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Hash a password into the storable string `scrypt$N$r$p$salt$hash`.
 *
 * Parameters travel with the hash so raising the cost later does not
 * invalidate hashes generated today.
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const derived = await scrypt(password.normalize("NFKC"), salt, keylen, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return [
    "scrypt",
    N,
    r,
    p,
    salt.toString("base64url"),
    Buffer.from(derived).toString("base64url"),
  ].join("$");
}

/**
 * Verify a candidate password against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored hash: a
 * misconfigured env var must fail closed (nobody gets in), never open.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived;
  try {
    derived = Buffer.from(
      await scrypt(password.normalize("NFKC"), salt, expected.length, {
        N,
        r,
        p,
        maxmem: 128 * N * r * 2,
      }),
    );
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ------------------------------------------------------------------ */
/* Session tokens                                                      */
/* ------------------------------------------------------------------ */

function sessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return secret;
}

/**
 * A short, stable fingerprint of the signing secret.
 *
 * Embedded in every token. Rotate ADMIN_SESSION_SECRET and the version stops
 * matching, so every session issued under the old key is rejected on its next
 * request — logout-everywhere without a session store to purge.
 */
function keyVersion(secret) {
  return createHmac("sha256", secret).update("aifight/kv").digest("base64url").slice(0, 8);
}

function sign(secret, data) {
  return createHmac("sha256", secret).update(data).digest();
}

/**
 * Mint a signed session token: `v1.<payload>.<signature>`.
 *
 * The payload is readable — it is not a secret, it is a claim. Its integrity
 * is what matters, and that is what the HMAC provides. `jti` gives each
 * session a distinct identity for the audit log.
 */
export function issueSession({ subject = "admin", ttlSeconds = SESSION_TTL_SECONDS } = {}) {
  const secret = sessionSecret();
  if (!secret) return null;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sub: subject,
    kv: keyVersion(secret),
    iat: now,
    exp: now + ttlSeconds,
    jti: randomBytes(9).toString("base64url"),
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(secret, encoded).toString("base64url");
  return { token: `v1.${encoded}.${signature}`, payload, ttlSeconds };
}

/**
 * Verify a session token.
 *
 * Returns `{ ok: true, payload }` or `{ ok: false, reason }`. The reason is
 * for the server log, never for the response body — telling a caller whether
 * a token expired or was forged is free reconnaissance.
 */
export function verifySession(token) {
  const secret = sessionSecret();
  if (!secret) return { ok: false, reason: "no-session-secret" };
  if (typeof token !== "string") return { ok: false, reason: "missing" };

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };

  const [, encoded, signature] = parts;

  let supplied;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const expected = sign(secret, encoded);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload?.v !== 1) return { ok: false, reason: "bad-version" };
  if (payload.kv !== keyVersion(secret)) return { ok: false, reason: "key-rotated" };

  const now = Math.floor(Date.now() / 1000);
  // 30s of leeway absorbs clock skew between Vercel regions.
  if (typeof payload.exp !== "number" || payload.exp + 30 < now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.iat !== "number" || payload.iat - 30 > now) {
    return { ok: false, reason: "not-yet-valid" };
  }

  return { ok: true, payload };
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse a Cookie header without a dependency.
 *
 * Deliberately tolerant of the malformed pairs real browsers and extensions
 * emit: a junk cookie elsewhere in the jar must not lose us the session one.
 */
export function parseCookies(header) {
  const jar = Object.create(null);
  if (typeof header !== "string" || header.length === 0) return jar;

  for (const segment of header.split(";")) {
    const eq = segment.indexOf("=");
    if (eq < 1) continue;
    const name = segment.slice(0, eq).trim();
    if (!name) continue;
    const value = segment.slice(eq + 1).trim();
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      jar[name] = value;
    }
  }
  return jar;
}

export function sessionCookie(token, maxAgeSeconds) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    // Strict, not Lax: no cross-site navigation should ever carry an admin
    // session. The admin always arrives by typing the URL or from same-origin.
    "SameSite=Strict",
  ].join("; ");
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/* ------------------------------------------------------------------ */
/* Request authorisation                                               */
/* ------------------------------------------------------------------ */

/**
 * Constant-time string compare for machine tokens.
 *
 * Length is compared first and leaks — an attacker learning the token's
 * length gains nothing. Content is compared in constant time, which is the
 * part that matters.
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * The single authorisation entry point for every privileged route.
 *
 * Three accepted identities, in order of preference:
 *
 *   session   an admin in a browser, holding the signed cookie
 *   admin     a human on the CLI, sending X-Admin-Token / Bearer ADMIN_TOKEN
 *   cron      Vercel Cron, sending Bearer CRON_SECRET
 *
 * `allow` narrows that per route: settlement accepts cron, the arena write
 * does not, and nothing accepts an unauthenticated caller.
 *
 * Fails closed. If no credential is configured at all, this returns false —
 * an unconfigured deployment is locked, not open.
 */
export function authorise(req, { allow = ["session", "admin", "cron"] } = {}) {
  const allowed = new Set(allow);

  if (allowed.has("session")) {
    const jar = parseCookies(req.headers?.cookie);
    const result = verifySession(jar[SESSION_COOKIE]);
    if (result.ok) {
      return { ok: true, actor: "session", subject: result.payload.sub, jti: result.payload.jti };
    }
  }

  const header = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const headerToken = req.headers?.["x-admin-token"];
  const supplied = bearer || (typeof headerToken === "string" ? headerToken : null);

  if (supplied) {
    if (allowed.has("admin") && process.env.ADMIN_TOKEN && safeEqual(supplied, process.env.ADMIN_TOKEN)) {
      return { ok: true, actor: "admin", subject: "cli" };
    }
    if (allowed.has("cron") && process.env.CRON_SECRET && safeEqual(supplied, process.env.CRON_SECRET)) {
      return { ok: true, actor: "cron", subject: "vercel-cron" };
    }
  }

  return { ok: false, actor: null };
}

/**
 * Whether the deployment is configured well enough to log anyone in.
 *
 * `/api/admin/session` reports this so the login screen can say "the server
 * is missing ADMIN_SESSION_SECRET" instead of silently rejecting a correct
 * password forever.
 */
export function authConfigured() {
  return {
    hash: Boolean(process.env.ADMIN_PASSWORD_HASH),
    secret: Boolean(sessionSecret()),
    ready: Boolean(process.env.ADMIN_PASSWORD_HASH) && Boolean(sessionSecret()),
  };
}

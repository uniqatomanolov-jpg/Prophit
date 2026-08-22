/**
 * POST /api/admin/login
 *
 * The only place an admin password is ever checked, and the only place a
 * session is ever minted.
 *
 * Replaces `unlockLocal(password)` from `localArena.ts`, which compared the
 * typed password against `window.__AIFIGHT_CONFIG__.adminPassword` — a value
 * served publicly at `/config.js` — and then set a sessionStorage flag that
 * any visitor could set themselves.
 *
 * Request:   { "password": "..." }
 * Response:  204 with a Set-Cookie, or a 4xx with a deliberately vague reason.
 *
 * The response body never distinguishes "no such password configured" from
 * "wrong password". Both are `bad-credentials`. The one exception is
 * `not-configured`, returned only when the deployment has no
 * ADMIN_PASSWORD_HASH or ADMIN_SESSION_SECRET at all — the operator needs to
 * know that, and an attacker learns nothing from it because there is no
 * password to guess yet.
 */

import { authConfigured, issueSession, sessionCookie } from "../_lib/auth.js";
import { verifyPassword } from "../_lib/auth.js";
import { clientIp, fail, handlePreflight, json, noStore, readJson } from "../_lib/http.js";
import { enforce } from "../_lib/ratelimit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res, { methods: "POST, OPTIONS", credentials: true })) return;
  noStore(res);

  if (req.method !== "POST") return fail(res, 405, "method-not-allowed");

  const configured = authConfigured();
  if (!configured.ready) {
    return fail(
      res,
      503,
      "not-configured",
      [
        !configured.hash && "ADMIN_PASSWORD_HASH is not set",
        !configured.secret && "ADMIN_SESSION_SECRET is missing or shorter than 32 characters",
      ]
        .filter(Boolean)
        .join("; ") + ". Run `node scripts/hash-password.mjs` and set both in Vercel.",
    );
  }

  /*
   * Two limiters, deliberately.
   *
   * Per-IP stops one machine brute-forcing. The global limiter stops a
   * distributed attempt, where every request arrives from a different address
   * and the per-IP bucket never fills. The global ceiling is generous enough
   * that one honest admin fumbling their password is never caught by it, and
   * tight enough that a credential-stuffing run is throttled to uselessness.
   */
  const ip = clientIp(req);
  if (await enforce(res, `login:ip:${ip}`, { max: 5, windowSeconds: 300 })) return;
  if (await enforce(res, "login:global", { max: 40, windowSeconds: 300 })) return;

  const body = await readJson(req, { limitBytes: 4096 });
  if (!body.ok) return fail(res, 400, body.reason);

  const password = body.value?.password;
  if (typeof password !== "string" || password.length === 0 || password.length > 512) {
    return fail(res, 400, "bad-credentials");
  }

  const valid = await verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
  if (!valid) {
    /*
     * A uniform delay on failure. scrypt already dominates the timing, but a
     * fast reject on a malformed hash would still be distinguishable from a
     * slow reject on a wrong password. Padding removes the signal.
     */
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 120));
    return fail(res, 401, "bad-credentials", "Incorrect password.");
  }

  const session = issueSession({ subject: "admin" });
  if (!session) return fail(res, 503, "not-configured", "Session secret unavailable.");

  res.setHeader("Set-Cookie", sessionCookie(session.token, session.ttlSeconds));

  // The expiry is returned so the console can warn before it lapses mid-edit.
  // The token itself is never in the body — it lives only in the HttpOnly
  // cookie, where page JavaScript cannot read it.
  return json(res, 200, {
    ok: true,
    expiresAt: new Date(session.payload.exp * 1000).toISOString(),
  });
}

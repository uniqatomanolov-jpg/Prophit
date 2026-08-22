/**
 * GET  /api/admin/session — is the caller an admin?
 * POST /api/admin/session — log out (clears the cookie).
 *
 * The client cannot answer the first question itself. The session cookie is
 * HttpOnly by design, so `document.cookie` cannot see it and there is nothing
 * in the page for a script to inspect. That is the point: the answer comes
 * from the server, on every mount, or it is not an answer.
 *
 * This is what `AdminShell` calls in place of `isLocalUnlocked()`.
 */

import { authConfigured, authorise, clearedCookie } from "../_lib/auth.js";
import { fail, handlePreflight, json, noStore } from "../_lib/http.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res, { methods: "GET, POST, OPTIONS", credentials: true })) return;
  noStore(res);

  if (req.method === "POST") {
    // Logout is unconditional: clearing a cookie that is already invalid is
    // harmless, and requiring a valid session to log out would strand anyone
    // holding a corrupted one.
    res.setHeader("Set-Cookie", clearedCookie());
    return json(res, 200, { ok: true, authenticated: false });
  }

  if (req.method !== "GET") return fail(res, 405, "method-not-allowed");

  // Session cookies only. A CLI token is a machine credential and must not
  // light up a browser console as though a human had logged in.
  const auth = authorise(req, { allow: ["session"] });
  const configured = authConfigured();

  return json(res, 200, {
    ok: true,
    authenticated: auth.ok,
    subject: auth.ok ? auth.subject : null,
    /** Lets the login screen explain a misconfigured deployment. */
    configured: configured.ready,
    missing: configured.ready
      ? []
      : [
          !configured.hash && "ADMIN_PASSWORD_HASH",
          !configured.secret && "ADMIN_SESSION_SECRET",
        ].filter(Boolean),
  });
}

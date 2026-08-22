/*
 * AiFight — public runtime configuration.
 *
 * ⚠ THIS FILE IS PUBLIC. It is served as a static asset at /config.js and
 *   anyone can read it with a single curl.
 *
 *   NEVER put a password or a server secret in this file.
 *
 * The previous version contained a live admin password (`adminPassword:
 * "beroe"`). Anyone who opened https://aifight.vercel.app/config.js could read
 * it and log into /admin. It has been removed — but rotate that password if
 * you have reused it anywhere, because removing it here does not un-publish
 * what was already served.
 *
 * ── ADMIN AUTH NOW ────────────────────────────────────────────────────
 *
 * The password is verified server-side against a scrypt hash in a Vercel
 * environment variable, and a signed HttpOnly cookie carries the session:
 *
 *   ADMIN_PASSWORD_HASH    node scripts/hash-password.mjs
 *   ADMIN_SESSION_SECRET   openssl rand -hex 32
 *
 * Set both in Vercel → Settings → Environment Variables before deploying,
 * or /admin will show "server not configured" and nobody can log in.
 */
window.__AIFIGHT_CONFIG__ = {
  /*
   * Supabase project URL and ANON key.
   *
   * These two ARE meant to be public — that is what the anon key is for. It
   * identifies the project and authorises nothing on its own.
   *
   * ⚠ They are safe ONLY IF Row Level Security is enabled on every table.
   *   Without RLS, this key is a full read-write database connection for
   *   anyone with devtools open:
   *
   *     const s = createClient(URL, ANON_KEY)
   *     await s.from('bets').update({ result: 'win' })   // rewrites everything
   *
   *   Run supabase/migrations/002_rls.sql (in the upgrade bundle), then the
   *   verification query at the foot of that file. Every table must report
   *   rls_enabled = true.
   *
   * The SERVICE ROLE key is a different thing entirely and must NEVER appear
   * here. It lives only in SUPABASE_SERVICE_ROLE_KEY, server-side.
   */
  supabaseUrl: "https://wwdekopvslvrmeupnsyx.supabase.co",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3ZGVrb3B2c2x2cm1ldXBuc3l4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNjgzODgsImV4cCI6MjEwMTg0NDM4OH0.YZIhv-NXP2N15lT8pONeY2UdXFfZvZfKNbEbYE4fJqc",
};

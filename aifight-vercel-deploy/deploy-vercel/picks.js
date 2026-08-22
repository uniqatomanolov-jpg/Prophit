/*
 * AiFight — published picks snapshot.
 *
 * THIS FILE MUST ALWAYS EXIST IN THE DEPLOYED OUTPUT.
 *
 * Every page loads it with <script src="/picks.js">. If it is missing, the
 * host answers with an HTML 404 page, and because the site sends
 * X-Content-Type-Options: nosniff the browser refuses to execute it:
 *
 *   Refused to execute script from '.../picks.js' because its MIME type
 *   ('text/html') is not executable, and strict MIME type checking is enabled.
 *
 * An empty snapshot (below) is the correct content for a fresh site, or for
 * any site running in Supabase / shared-store mode. Never delete the file to
 * "clear" it — blank it out instead, exactly as it ships here.
 *
 * To update: /admin → 📡 Publish → Download picks.js → replace this file.
 * `npm run build` copies public/ into the deploy output and then verifies
 * this file survived (see scripts/verify-build.mjs).
 */
window.__AIFIGHT_PICKS__ = {
  bets: [],
  fighters: {},
  round: { round: 1, status: "open" },
  publishedAt: null,
};

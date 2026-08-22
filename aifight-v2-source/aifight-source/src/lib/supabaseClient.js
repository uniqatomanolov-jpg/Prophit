import { createClient } from "@supabase/supabase-js";

/**
 * The single Supabase client for the whole app.
 *
 * ON THESE TWO ENVIRONMENT VARIABLES
 * ----------------------------------
 * Both are `VITE_`-prefixed, which means Vite inlines them into the public
 * JavaScript bundle at build time. For these two that is correct and
 * intended: the project URL is not a secret, and the `anon` key is designed
 * to be published -- it is an identity ("an anonymous visitor"), not a
 * permission. What that identity may actually do is decided entirely by the
 * Row Level Security policies in supabase/schema.sql.
 *
 * The corollary is absolute: NEVER give a `VITE_` name to anything that is
 * genuinely secret. In particular the `service_role` key bypasses every RLS
 * policy, so putting it here would publish full read/write access to your
 * database inside a file anyone can open in DevTools.
 */

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Whether the app was built with credentials at all.
 *
 * Vercel builds do not fail on a missing environment variable -- they build
 * fine and the site then throws on first render, which reads as "the deploy
 * is broken" rather than "the variable is missing". Exporting this lets the
 * UI say the true thing instead.
 */
export const isSupabaseConfigured = Boolean(url && anonKey);

if (!isSupabaseConfigured && import.meta.env.DEV) {
  console.warn(
    "[aifight] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. " +
      "Copy .env.example to .env.local and fill them in."
  );
}

export const supabase = createClient(
  url ?? "https://placeholder.supabase.co",
  anonKey ?? "public-anon-key-placeholder",
  {
    auth: {
      // The operator stays signed in across reloads, and the token refreshes
      // itself. Supabase stores it in localStorage -- that is a session
      // token scoped by RLS, not a credential, and it expires.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    realtime: {
      // Ten messages a second is plenty for a betting board and keeps a
      // pathological update storm from locking the tab.
      params: { eventsPerSecond: 10 },
    },
  }
);

/** Human-readable text for a PostgREST error, including the useful hints. */
export function describeError(error) {
  if (!error) return "";
  const code = error.code ?? "";

  // The two failures that actually happen in this app, named properly.
  if (code === "23505") return "That exact bet is already logged for this fighter.";
  if (code === "23514") return "The database rejected those numbers as inconsistent.";
  if (code === "42501" || error.message?.includes("row-level security")) {
    return "Not signed in, or this account has no write permission.";
  }
  if (code === "PGRST301" || error.message?.includes("JWT")) {
    return "Your session expired. Sign in again.";
  }
  if (error.message?.includes("Failed to fetch")) {
    return "Could not reach Supabase. Check your connection and the project URL.";
  }
  return error.message || "Something went wrong.";
}

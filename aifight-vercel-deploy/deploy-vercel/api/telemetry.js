/**
 * POST /api/telemetry — client error sink.
 *
 * Receives what the React error boundaries catch. Without this, a render
 * crash that only happens on one browser is invisible: the visitor sees a
 * dead panel, shrugs, and leaves, and nothing anywhere records that it
 * happened.
 *
 * THE DESIGN CONSTRAINT
 * ---------------------
 * This endpoint is unauthenticated by necessity — the errors worth catching
 * happen to anonymous visitors. That makes it the softest target on the API,
 * so it is built to be worthless to abuse:
 *
 *   - Rate limited per IP, tightly.
 *   - Every field is length-capped before storage. A 4KB body cannot become a
 *     4MB row.
 *   - Only a fixed set of `kind` values is accepted, so it cannot be used as
 *     free storage.
 *   - Nothing submitted is ever echoed back to any client, so it cannot
 *     become a stored-XSS vector against the admin console.
 *   - Always answers 204, even when it discards the payload. An error
 *     reporter that returns errors produces error loops.
 *
 * WHAT IT DELIBERATELY DOES NOT COLLECT
 * -------------------------------------
 * No cookies, no user agent string, no IP in the stored row, no referrer.
 * A crash report needs the stack and the route; everything else is a privacy
 * liability with no diagnostic value.
 */

import { createClient } from "@supabase/supabase-js";
import { clientIp, fail, handlePreflight, json, noStore, readJson } from "./_lib/http.js";
import { limit } from "./_lib/ratelimit.js";

const KINDS = new Set(["render-error", "fetch-error", "parse-error", "unhandled-rejection"]);

/** Truncate and coerce. Never trust a length from a client. */
function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * Strip anything that looks like a credential out of a stack trace.
 *
 * Stacks include URLs, and URLs collect query strings. A model reply or an
 * admin action can put a token into a stack frame, and a log that quietly
 * accumulates secrets is a breach waiting to be discovered. Redacting on the
 * way in means the store never holds one.
 */
function scrub(text) {
  if (!text) return null;
  return text
    .replace(/([?&](?:token|key|secret|password|apiKey)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "[jwt-redacted]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9]{20,}\b/g, "[key-redacted]");
}

export default async function handler(req, res) {
  if (handlePreflight(req, res, { methods: "POST, OPTIONS" })) return;
  noStore(res);
  if (req.method !== "POST") return fail(res, 405, "method-not-allowed");

  /*
   * A crashing page can fire repeatedly — a render loop produces one report
   * per frame. The limiter is what stops one broken browser generating tens
   * of thousands of rows. Over the limit is silently accepted and dropped:
   * a 429 here would just be logged as another error by the client.
   */
  const quota = await limit(`telemetry:${clientIp(req)}`, { max: 20, windowSeconds: 300 });
  if (!quota.ok) return res.status(204).end();

  const parsed = await readJson(req, { limitBytes: 16_384 });
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return res.status(204).end();
  }

  const body = parsed.value;
  const kind = typeof body.kind === "string" && KINDS.has(body.kind) ? body.kind : null;
  if (!kind) return res.status(204).end();

  const row = {
    kind,
    boundary: clip(body.boundary, 80),
    message: scrub(clip(body.message, 500)),
    stack: scrub(clip(body.stack, 4000)),
    component_stack: scrub(clip(body.componentStack, 4000)),
    // Path only — never the full URL, which can carry a query string.
    route: clip(body.url, 200)?.split("?")[0] ?? null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    reported_at: new Date().toISOString(),
  };

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    // No store configured: log and move on. Vercel's function logs are a
    // perfectly good sink for a low-traffic site, and failing here would
    // make an unconfigured deployment noisier than a broken one.
    console.error("[telemetry]", JSON.stringify(row));
    return res.status(204).end();
  }

  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await supabase.from("client_errors").insert(row);
  } catch (err) {
    console.error("[telemetry] insert failed", String(err?.message ?? err));
  }

  return res.status(204).end();
}

/*
 * Table for this endpoint. Add to supabase/migrations/.
 *
 *   CREATE TABLE IF NOT EXISTS public.client_errors (
 *     id              bigserial PRIMARY KEY,
 *     kind            text NOT NULL,
 *     boundary        text,
 *     message         text,
 *     stack           text,
 *     component_stack text,
 *     route           text,
 *     commit          text,
 *     reported_at     timestamptz NOT NULL DEFAULT now()
 *   );
 *
 *   CREATE INDEX IF NOT EXISTS client_errors_at_idx
 *     ON public.client_errors (reported_at DESC);
 *
 *   -- Group by message to find the one bug behind fifty reports.
 *   CREATE INDEX IF NOT EXISTS client_errors_message_idx
 *     ON public.client_errors (message, reported_at DESC);
 *
 *   ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE public.client_errors FORCE ROW LEVEL SECURITY;
 *
 *   -- Admins read. Nobody inserts through the anon key: writes arrive only
 *   -- from this function, using the service role.
 *   CREATE POLICY "admins read client errors"
 *     ON public.client_errors FOR SELECT TO authenticated
 *     USING (public.is_admin());
 *
 * Prune on a schedule; a crash from four months ago is not a bug report:
 *
 *   DELETE FROM public.client_errors WHERE reported_at < now() - interval '30 days';
 */

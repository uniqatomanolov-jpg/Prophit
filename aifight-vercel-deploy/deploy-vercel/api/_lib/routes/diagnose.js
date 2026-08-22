/**
 * GET /api/diagnose — why is the Arena board empty?
 *
 * WHY THIS ROUTE EXISTS
 * ---------------------
 * "The picks aren't showing" has been diagnosed three different ways on this
 * project — strict joins, nested market objects, status filters — and none of
 * them was the cause. That is not a failure of anyone's reasoning; it is a
 * failure of the system to be observable. Four data sources feed this site
 * and nothing anywhere says which one the board is actually reading.
 *
 * This route answers that question with measurements instead of theories.
 *
 * THE TWO REAL CAUSES, BOTH FOUND BY READING THE SHIPPED BUNDLE
 * -------------------------------------------------------------
 * 1. SOURCE PRECEDENCE. `useArena`'s query function is:
 *
 *      if (getSupabaseClient()) {
 *        const r = await fetchSupabase();
 *        return { arena: r?.leaderboard.length ? r : EMPTY, source: 'supabase' };
 *      }
 *      const r = await fetchBlob();          // <-- unreachable when configured
 *      ...
 *
 *    That is an EARLY RETURN, not a fallback. The moment `config.js` carries
 *    a real `supabaseUrl` and `supabaseAnonKey`, `/api/arena` is never called
 *    by the public board — no matter how many picks the blob holds. If the
 *    Supabase tables are empty or RLS-blocked, the board shows EMPTY while
 *    the blob sits there full.
 *
 * 2. NO PENDING PICKS. The active board is `bets.filter(b => b.result ===
 *    'pending')`. A blob whose every bet is settled produces an empty active
 *    board, correctly. That is not a bug and no amount of query flattening
 *    will change it — the fix is to open a round and log picks into it.
 *
 * This endpoint reports both, plus which one is currently biting.
 */

import { createClient } from "@supabase/supabase-js";
import { authorise } from "../auth.js";
import { applyCors, fail, fetchWithTimeout, handlePreflight, json, noStore } from "../http.js";
import { isConfigured, readArenaJson } from "../store.js";
import { MODELS, thesisCoverage, verifyChain } from "../ledger.js";

/** Placeholders the bundle treats as "not configured". Must match exactly. */
const PLACEHOLDERS = ["YOUR-PROJECT", "YOUR-ANON-KEY", "REPLACE_WITH_YOUR_ANON_KEY"];

/**
 * Reproduce the bundle's decision, exactly.
 *
 * Deliberately duplicated rather than approximated: the whole point is to
 * report what the FRONTEND will do, so this has to be the frontend's rule,
 * including the placeholder substrings it checks for.
 */
function frontendSource(url, key) {
  const u = (url ?? "").trim();
  const k = (key ?? "").trim();
  const configured =
    Boolean(u) &&
    Boolean(k) &&
    !PLACEHOLDERS.some((p) => u.includes(p)) &&
    !PLACEHOLDERS.some((p) => k.includes(p));
  return configured ? "supabase" : "blob";
}

/** Read the deployed config.js the same way a browser would. */
async function readPublicConfig(req) {
  const host = req.headers?.["x-forwarded-host"] ?? req.headers?.host;
  const proto = req.headers?.["x-forwarded-proto"] ?? "https";
  if (!host) return { ok: false, reason: "no-host" };

  try {
    const res = await fetchWithTimeout(`${proto}://${host}/config.js`, {
      timeoutMs: 5000,
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, reason: `config.js ${res.status}` };
    const text = await res.text();

    const url = text.match(/supabaseUrl\s*:\s*["'`]([^"'`]*)["'`]/)?.[1] ?? "";
    const key = text.match(/supabaseAnonKey\s*:\s*\n?\s*["'`]([^"'`]*)["'`]/)?.[1] ?? "";
    // Reported so a reappearing password is caught here too, not just at build.
    const hasPassword = /adminPassword\s*:\s*["'`][^"'`]+["'`]/.test(text);

    return {
      ok: true,
      supabaseUrl: url,
      // Never echo the key itself, even though it is public by design —
      // an endpoint that prints credentials trains people to paste output.
      supabaseAnonKeyPresent: Boolean(key),
      adminPasswordPresent: hasPassword,
      source: frontendSource(url, key),
    };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/**
 * Count rows the anon key can actually see.
 *
 * Uses the ANON key, not the service role, because the question is what the
 * BROWSER sees. A service-role count would be reassuring and wrong: RLS could
 * be blocking every public read and the count would still come back full.
 */
async function probeSupabase(url, anonKey) {
  if (!url || !anonKey) return { checked: false, reason: "not-configured" };

  const tables = ["bets", "fighters", "season"];
  const out = {};

  for (const table of tables) {
    try {
      const client = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { count, error } = await client
        .from(table)
        .select("*", { count: "exact", head: true });

      if (error) {
        out[table] = { rows: null, error: error.message, code: error.code ?? null };
      } else {
        out[table] = { rows: count ?? 0, error: null };
      }
    } catch (err) {
      out[table] = { rows: null, error: String(err?.message ?? err) };
    }
  }

  return { checked: true, tables: out };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res, { methods: "GET, OPTIONS", credentials: true })) return;
  applyCors(req, res, { methods: "GET, OPTIONS", credentials: true });
  noStore(res);
  if (req.method !== "GET") return fail(res, 405, "method-not-allowed");

  const auth = authorise(req, { allow: ["session", "admin"] });
  if (!auth.ok) return fail(res, 401, "unauthorised");

  const findings = [];
  const config = await readPublicConfig(req);

  /* ---- the blob ---- */
  let blob = { configured: isConfigured(), reachable: false };
  if (blob.configured) {
    try {
      const { data } = await readArenaJson();
      const bets = Array.isArray(data?.bets) ? data.bets : [];
      const byResult = bets.reduce((acc, b) => {
        const r = b.result ?? "pending";
        acc[r] = (acc[r] ?? 0) + 1;
        return acc;
      }, {});
      blob = {
        configured: true,
        reachable: true,
        totalBets: bets.length,
        byResult,
        pending: byResult.pending ?? 0,
        round: data?.round ?? null,
        integrity: verifyChain(bets),
        thesis: thesisCoverage(bets),
        models: [...new Set(bets.map((b) => b.model))],
      };
    } catch (err) {
      blob = { configured: true, reachable: false, error: String(err?.message ?? err) };
    }
  }

  /* ---- supabase, as the browser sees it ---- */
  const supabase = config.ok
    ? await probeSupabase(config.supabaseUrl, await anonKeyFrom(req))
    : { checked: false, reason: "config unreadable" };

  /* ---- the verdict ---- */
  const source = config.ok ? config.source : "unknown";

  if (source === "supabase") {
    const betRows = supabase?.tables?.bets?.rows;
    const betError = supabase?.tables?.bets?.error;

    findings.push({
      severity: "critical",
      code: "source-precedence",
      title: "The public board reads Supabase, not the blob.",
      detail:
        "config.js carries a real supabaseUrl and supabaseAnonKey, so useArena takes the " +
        "Supabase branch and returns early. /api/arena is never called by the public board. " +
        `Picks logged through /api/picks go to the blob (${blob.totalBets ?? 0} bets there) and ` +
        "will not appear until either Supabase holds them or config.js stops declaring Supabase.",
      fix:
        "Pick ONE source. To use the blob (what /api/picks writes to): remove supabaseUrl and " +
        "supabaseAnonKey from public/config.js and redeploy. To use Supabase: keep them and " +
        "write picks into the bets table instead.",
    });

    if (betError) {
      findings.push({
        severity: "critical",
        code: "supabase-blocked",
        title: "The anon key cannot read the bets table.",
        detail: `Supabase returned: ${betError}. useArena throws on this, so the board renders empty.`,
        fix: "Apply supabase/migrations/002_rls.sql and confirm a public SELECT policy exists on bets.",
      });
    } else if (betRows === 0) {
      findings.push({
        severity: "critical",
        code: "supabase-empty",
        title: "Supabase is the active source and its bets table is empty.",
        detail:
          `The blob holds ${blob.totalBets ?? 0} bets, but the board is not reading the blob. ` +
          "This is why the Arena shows nothing.",
        fix: "Either point the site at the blob (see above) or import the blob's bets into Supabase.",
      });
    }
  }

  if (blob.reachable && blob.pending === 0 && blob.totalBets > 0) {
    findings.push({
      severity: "high",
      code: "no-pending-picks",
      title: `All ${blob.totalBets} picks are settled — there are no active picks to show.`,
      detail:
        "The active board is bets.filter(b => b.result === 'pending'). With every bet graded, " +
        "an empty active board is CORRECT, not a rendering fault. " +
        `Current spread: ${JSON.stringify(blob.byResult)}.`,
      fix: "Open a new round (POST /api/round {\"action\":\"advance\"}) and log picks into it.",
    });
  }

  const roundStatus = blob?.round?.status ?? null;
  if (roundStatus && roundStatus !== "open") {
    findings.push({
      severity: "high",
      code: "round-not-open",
      title: `Round ${blob?.round?.round ?? "?"} has status "${roundStatus}".`,
      detail:
        roundStatus === "locked"
          ? "\"locked\" is not a status the shipped client handles — it only ever checks for " +
            "\"settled\". Nothing blocks logging, but nothing treats the round as closed either."
          : "New picks cannot be logged into a closed round.",
      fix: 'POST /api/round {"action":"advance"} to start the next round, or {"action":"open"} to reopen this one.',
    });
  }

  if (config.ok && config.adminPasswordPresent) {
    findings.push({
      severity: "critical",
      code: "password-in-config",
      title: "config.js still contains an admin password.",
      detail: "That file is public. Anyone can read it.",
      fix: "Remove adminPassword from public/config.js and rotate it.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "ok",
      code: "healthy",
      title: "No blocking problem found.",
      detail:
        `Source: ${source}. ` +
        (blob.reachable ? `Blob has ${blob.pending} pending of ${blob.totalBets} bets.` : ""),
      fix: null,
    });
  }

  return json(res, 200, {
    ok: true,
    checkedAt: new Date().toISOString(),
    /** What the PUBLIC BOARD will actually read. The whole question. */
    activeSource: source,
    config: config.ok
      ? {
          supabaseDeclared: Boolean(config.supabaseUrl),
          supabaseAnonKeyPresent: config.supabaseAnonKeyPresent,
          adminPasswordPresent: config.adminPasswordPresent,
        }
      : { error: config.reason },
    blob,
    supabase,
    findings: findings.sort(
      (a, b) =>
        ({ critical: 0, high: 1, medium: 2, ok: 3 })[a.severity] -
        ({ critical: 0, high: 1, medium: 2, ok: 3 })[b.severity],
    ),
    models: MODELS,
  });
}

/**
 * The anon key, read from the deployed config.js.
 *
 * Read at request time rather than held in an env var because the question is
 * what the SHIPPED file says — an env var could easily disagree with what the
 * browser actually downloads, which is the exact class of drift this endpoint
 * exists to catch.
 */
async function anonKeyFrom(req) {
  const host = req.headers?.["x-forwarded-host"] ?? req.headers?.host;
  const proto = req.headers?.["x-forwarded-proto"] ?? "https";
  if (!host) return null;
  try {
    const res = await fetchWithTimeout(`${proto}://${host}/config.js`, {
      timeoutMs: 5000,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.match(/supabaseAnonKey\s*:\s*\n?\s*["'`]([^"'`]*)["'`]/)?.[1] ?? null;
  } catch {
    return null;
  }
}

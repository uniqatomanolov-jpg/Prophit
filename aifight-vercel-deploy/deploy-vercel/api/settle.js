/**
 * /api/settle — automated match settlement.
 *
 * Pulls pending bets whose kick-off is comfortably past, fetches final scores,
 * grades what it can read with confidence, and applies the whole batch in one
 * database transaction. Anything ambiguous is left pending and reported, so a
 * human grades it in the admin queue instead of a parser guessing.
 *
 * Three properties make this safe to run unattended:
 *
 *   Idempotent   bulk_settle() skips any bet that is no longer pending, so a
 *                retry, a double-fire or an overlapping cron is a no-op.
 *   Atomic       one RPC per batch. A dropped connection cannot leave half a
 *                fixture graded and the bankrolls half moved.
 *   Conservative certain === false is never applied. A wrong grade moves real
 *                money and silently corrupts every figure downstream.
 *
 * Calling it
 * ----------
 *   GET  /api/settle?dry=1     preview: grades nothing, shows what it would do
 *   POST /api/settle           apply
 *   POST /api/settle?mode=challenge   the $1M Challenge instead of the season
 *
 * Auth (any one):
 *   Authorization: Bearer <ADMIN_TOKEN>
 *   X-Admin-Token: <ADMIN_TOKEN>
 *   Authorization: Bearer <CRON_SECRET>   — what Vercel Cron sends
 *
 * Env:
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY   required
 *   ODDS_API_KEY                               required
 *   ADMIN_TOKEN / CRON_SECRET                  required (at least one)
 *
 * Vercel Cron: see the "crons" block in vercel.json — it runs this every
 * three hours. Vercel sends CRON_SECRET as a bearer token.
 */

import { createClient } from "@supabase/supabase-js";
import { authorise } from "./_lib/auth.js";
import { applyCors } from "./_lib/http.js";
import { FULL_TIME_MINUTES, LEAGUES, fetchScoresFor, readScore } from "./_lib/oddsApi.js";
import { matchFixture, proposeOutcome } from "./_lib/grader.js";

const TABLES = {
  season: "bets",
  challenge: "challenge_bets",
};

function cors(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  // Origin allowlist instead of "*": this route accepts credentials, and a
  // wildcard invites any page on the internet to script it with a stolen token.
  applyCors(req, res, { methods: "GET, POST, OPTIONS", credentials: true });
}

/**
 * Service-role client. Settlement calls SECURITY DEFINER functions that check
 * is_admin(), so it must act as a real admin rather than the anon key.
 */
function serviceClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function authorised(req) {
  /*
   * Delegates to the shared authoriser (api/_lib/auth.js).
   *
   * The previous local copy compared secrets with `===`, which leaks a
   * token's prefix through timing, and knew nothing about the signed session
   * cookie — so an admin logged into the console still had to paste a raw
   * ADMIN_TOKEN to settle anything.
   *
   * `cron` stays in the allow list: this is the one route Vercel Cron calls.
   */
  return authorise(req, { allow: ["session", "admin", "cron"] }).ok;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "method-not-allowed" });
  }

  if (!authorised(req)) {
    return res.status(401).json({ ok: false, reason: "bad-token" });
  }

  const q = req.query ?? {};
  const mode = q.mode === "challenge" ? "challenge" : "season";
  // GET is always a preview. Applying on a GET would make settlement one
  // stray link-preview crawler away from moving money.
  const dryRun = req.method === "GET" || q.dry === "1" || q.dry === "true";
  const graceMinutes = clampInt(q.grace, FULL_TIME_MINUTES, 60, 24 * 60);
  const daysFrom = clampInt(q.days, 1, 1, 3);

  const sb = serviceClient();
  if (!sb) {
    return res.status(503).json({
      ok: false,
      reason: "no-supabase",
      message: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable automated settlement.",
    });
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return res
      .status(503)
      .json({ ok: false, reason: "no-key", message: "ODDS_API_KEY is not set." });
  }

  const table = TABLES[mode];
  const startedAt = new Date();

  try {
    /* ---- 1. What is waiting to be graded ---- */
    const cutoff = new Date(startedAt.getTime() - graceMinutes * 60_000).toISOString();

    const { data: pendingRows, error: pendingError } = await sb
      .from(table)
      .select("id, model, event, market, pick, odds, stake, kickoff_at")
      .eq("result", "pending")
      .not("kickoff_at", "is", null)
      .lt("kickoff_at", cutoff)
      .order("kickoff_at", { ascending: true })
      .limit(200);

    if (pendingError) {
      const missing = pendingError.code === "42P01";
      return res.status(missing ? 503 : 500).json({
        ok: false,
        reason: missing ? "table-missing" : "read-failed",
        message: missing
          ? `Table "${table}" does not exist. Run supabase/002_challenge_and_settlement.sql.`
          : pendingError.message,
      });
    }

    const pending = pendingRows ?? [];
    if (pending.length === 0) {
      return res.status(200).json({
        ok: true,
        mode,
        dryRun,
        pending: 0,
        settled: 0,
        skipped: 0,
        review: [],
        message: `Nothing past kick-off + ${graceMinutes} minutes is awaiting a result.`,
      });
    }

    /* ---- 2. Scores. Cache first, feed only for what's missing. ---- */
    const events = [...new Set(pending.map((b) => b.event))];

    const { data: cachedRows } = await sb
      .from("match_results")
      .select("event, home_team, away_team, home_score, away_score, completed")
      .in("event", events);

    const cached = new Map();
    for (const r of cachedRows ?? []) {
      if (r.completed)
        cached.set(r.event, { home: r.home_score, away: r.away_score, source: "cache" });
    }

    let games = [];
    let feedFailures = [];
    let creditsSpent = 0;
    let leaguesQueried = [];

    const uncached = events.filter((e) => !cached.has(e));

    if (uncached.length) {
      /*
       * Stop paying as soon as every fixture is accounted for.
       *
       * The scores endpoint costs 2 credits per league. Querying all nine on
       * every scheduled run is 18 credits a go — 540 a month against a
       * 500-credit free tier, before a single fixture fetch. A day's bets
       * almost always sit in one or two leagues, so walking them in priority
       * order and stopping early usually costs 2-4 instead.
       */
      const scores = await fetchScoresFor({
        apiKey,
        leagues: LEAGUES,
        daysFrom,
        isSatisfied: (found) => {
          const completed = found.filter((g) => g.completed);
          if (!completed.length) return false;
          return uncached.every((event) => matchFixture(event, completed) !== null);
        },
      });

      feedFailures = scores.failures;
      creditsSpent = scores.creditsSpent;
      leaguesQueried = scores.queried;

      if (scores.fatal) {
        return res.status(scores.fatal.status ?? 502).json({
          ok: false,
          reason: scores.fatal.code,
          message: scores.fatal.message,
        });
      }
      games = scores.games.filter((g) => g.completed);
    }

    /* ---- 3. Grade ---- */
    const toApply = [];
    const review = [];
    const noResult = [];
    const freshResults = new Map();

    for (const bet of pending) {
      let score = cached.get(bet.event) ?? null;

      if (!score && games.length) {
        const hit = matchFixture(bet.event, games);
        if (hit) {
          const parsed = readScore(hit.game);
          if (parsed) {
            // A reversed listing means the parsed home/away are swapped
            // relative to how the bet was written. Put them back.
            score = hit.flipped
              ? { home: parsed.away, away: parsed.home, source: "feed" }
              : { ...parsed, source: "feed" };
            freshResults.set(bet.event, { game: hit.game, parsed, flipped: hit.flipped, score });
          }
        }
      }

      if (!score) {
        noResult.push({
          id: bet.id,
          event: bet.event,
          model: bet.model,
          kickoff_at: bet.kickoff_at,
        });
        continue;
      }

      const verdict = proposeOutcome(bet, score.home, score.away);
      const entry = {
        bet_id: bet.id,
        model: bet.model,
        event: bet.event,
        market: bet.market,
        pick: bet.pick,
        outcome: verdict.outcome,
        reason: verdict.why,
        score: `${score.home}-${score.away}`,
      };

      if (verdict.certain && verdict.outcome) toApply.push(entry);
      else review.push(entry);
    }

    /* ---- 4. Cache the scores we just paid for ---- */
    if (!dryRun && freshResults.size) {
      const rows = [...freshResults.entries()].map(([event, r]) => ({
        event,
        sport_key: r.game.sport_key ?? null,
        home_team: r.flipped ? r.game.away_team : r.game.home_team,
        away_team: r.flipped ? r.game.home_team : r.game.away_team,
        home_score: r.score.home,
        away_score: r.score.away,
        kickoff_at: r.game.commence_time ?? null,
        completed: true,
        source: "odds-api",
      }));
      // Non-fatal: a failed cache write costs an API call next time, nothing more.
      const { error } = await sb
        .from("match_results")
        .upsert(rows, { onConflict: "event,kickoff_at", ignoreDuplicates: false });
      if (error) console.warn("match_results cache write failed:", error.message);
    }

    /* ---- 5. Apply ---- */
    let applied = { settled: 0, skipped: 0, failed: [] };

    if (!dryRun && toApply.length) {
      const { data, error } = await sb.rpc("bulk_settle", {
        p_items: toApply.map((t) => ({
          bet_id: t.bet_id,
          outcome: t.outcome,
          reason: t.reason,
          score: t.score,
        })),
        p_mode: mode,
      });

      if (error) {
        return res.status(500).json({
          ok: false,
          reason: "settle-failed",
          message: error.message,
          // The caller still learns what would have been applied.
          wouldSettle: toApply,
        });
      }
      applied = {
        settled: data?.settled ?? 0,
        skipped: data?.skipped ?? 0,
        failed: data?.failed ?? [],
      };
    }

    return res.status(200).json({
      ok: true,
      mode,
      dryRun,
      graceMinutes,
      pending: pending.length,
      graded: toApply.length,
      settled: dryRun ? 0 : applied.settled,
      skipped: applied.skipped,
      failed: applied.failed,
      /** Read but not confident — grade these by hand in /admin. */
      review,
      /** No final score available yet; will be retried on the next run. */
      awaitingResult: noResult,
      scoresFromCache: cached.size,
      scoresFromFeed: freshResults.size,
      feedFailures,
      /** Odds API credits this run cost: 2 per league actually queried. */
      creditsSpent,
      leaguesQueried,
      durationMs: Date.now() - startedAt.getTime(),
      applied: dryRun ? [] : toApply,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      reason: "unexpected",
      message: String(err?.message ?? err),
    });
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

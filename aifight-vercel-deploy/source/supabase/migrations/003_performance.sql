-- =====================================================================
-- 003_performance.sql — the credibility layer
-- =====================================================================
--
-- WHAT THIS BUILDS
-- ----------------
-- The transparent, historical performance record: ROI, yield, CLV, Sharpe,
-- drawdown, Brier score, and rolling 30/60/90-day leaderboards.
--
-- These mirror `src/lib/metrics.ts` exactly — same treatment of voids, same
-- turnover definition, same confidence interval. Two implementations of the
-- same maths is a risk, and it is taken deliberately: the client needs them
-- for instant local recomputation while the admin edits, and the database
-- needs them so the public leaderboard is one indexed query rather than
-- every bet of the season shipped to the browser. `tests/metrics.test.mjs`
-- pins the TypeScript side; `parity_check` at the bottom of this file pins
-- the SQL side to the same fixtures.
--
-- WHY A MATERIALIZED VIEW
-- -----------------------
-- The leaderboard is read on every page load and changes only when a bet
-- settles — a few times a day. Recomputing per request is pure waste. The
-- settle job refreshes it CONCURRENTLY, which needs a unique index and, in
-- exchange, never blocks a reader.

-- ---------------------------------------------------------------------
-- Per-bet derived figures
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW public.bet_performance AS
SELECT
  b.id,
  b.model,
  b.round,
  b.stake,
  b.odds,
  b.result,
  b.true_prob,
  b.fair_prob,
  b.closing_odds,
  b.logged_at,
  b.settled_at,

  -- Profit. A void returns the stake: zero profit, not a loss.
  CASE b.result
    WHEN 'win'  THEN b.stake * (b.odds - 1)
    WHEN 'loss' THEN -b.stake
    ELSE 0
  END::numeric AS profit,

  -- Turnover excludes voids, so a postponed fixture cannot deflate yield.
  CASE WHEN b.result IN ('win', 'loss') THEN b.stake ELSE 0 END::numeric AS turnover,

  -- Closing line value: did this price beat the close?
  CASE
    WHEN b.closing_odds IS NOT NULL AND b.closing_odds > 1 AND b.odds > 1
      THEN (b.odds / b.closing_odds - 1) * 100
    ELSE NULL
  END::numeric AS clv,

  -- Expected value at the taken price, from the model's own probability.
  CASE
    WHEN b.true_prob IS NOT NULL AND b.odds > 1
      THEN (b.true_prob * (b.odds - 1) - (1 - b.true_prob)) * 100
    ELSE NULL
  END::numeric AS ev,

  -- Squared error of the probability forecast. Averaged, this is Brier.
  CASE
    WHEN b.result IN ('win', 'loss') AND b.true_prob IS NOT NULL
      THEN power(b.true_prob - (CASE WHEN b.result = 'win' THEN 1 ELSE 0 END), 2)
    ELSE NULL
  END::numeric AS brier_component
FROM public.bets b;

COMMENT ON VIEW public.bet_performance IS
  'Per-bet profit, turnover, CLV, EV and Brier component. Mirrors src/lib/metrics.ts.';

-- ---------------------------------------------------------------------
-- Windowed aggregation
-- ---------------------------------------------------------------------

/*
 * One window of performance for one model.
 *
 * `p_days = NULL` means all time. STABLE, not VOLATILE, so the planner can
 * cache it within a statement — the leaderboard calls it twenty times (five
 * models x four windows) and a VOLATILE marking would force twenty
 * independent scans.
 *
 * The 95% interval uses the normal approximation on per-unit returns and is
 * returned as NULL below thirty settled bets. That NULL is a feature: it is
 * how the UI knows to print "not yet significant" instead of a number that
 * looks like evidence and is not.
 */
CREATE OR REPLACE FUNCTION public.model_performance(
  p_model text,
  p_days  integer DEFAULT NULL,
  p_starting_bankroll numeric DEFAULT 1000
)
RETURNS TABLE (
  model            text,
  window_days      integer,
  bets             bigint,
  wins             bigint,
  losses           bigint,
  voids            bigint,
  staked           numeric,
  profit           numeric,
  yield_pct        numeric,
  roi_pct          numeric,
  win_rate_pct     numeric,
  avg_odds         numeric,
  avg_stake        numeric,
  clv_avg          numeric,
  clv_beat_pct     numeric,
  brier            numeric,
  sharpe           numeric,
  yield_ci_low     numeric,
  yield_ci_high    numeric,
  significant      boolean
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH scoped AS (
    SELECT *
    FROM public.bet_performance p
    WHERE p.model = p_model
      AND p.result <> 'pending'
      AND (p_days IS NULL OR p.settled_at >= now() - make_interval(days => p_days))
  ),
  -- Per-unit returns, for Sharpe and for the standard error. Voids are
  -- excluded: a returned stake is not a 0% return, it is a non-event.
  returns AS (
    SELECT (s.profit / NULLIF(s.stake, 0))::numeric AS r
    FROM scoped s
    WHERE s.result IN ('win', 'loss')
  ),
  agg AS (
    SELECT
      count(*)                                            AS n,
      count(*) FILTER (WHERE result = 'win')              AS n_win,
      count(*) FILTER (WHERE result = 'loss')             AS n_loss,
      count(*) FILTER (WHERE result IN ('void','push'))   AS n_void,
      coalesce(sum(turnover), 0)                          AS total_staked,
      coalesce(sum(profit), 0)                            AS total_profit,
      avg(odds)  FILTER (WHERE result IN ('win','loss'))  AS mean_odds,
      avg(stake) FILTER (WHERE result IN ('win','loss'))  AS mean_stake,
      avg(clv)                                            AS mean_clv,
      count(*) FILTER (WHERE clv > 0)                     AS clv_wins,
      count(*) FILTER (WHERE clv IS NOT NULL)             AS clv_n,
      avg(brier_component)                                AS mean_brier
    FROM scoped
  ),
  spread AS (
    SELECT
      count(*)          AS rn,
      avg(r)            AS r_mean,
      stddev_samp(r)    AS r_sd
    FROM returns
  )
  SELECT
    p_model,
    p_days,
    agg.n,
    agg.n_win,
    agg.n_loss,
    agg.n_void,
    round(agg.total_staked, 2),
    round(agg.total_profit, 2),
    round(coalesce(agg.total_profit / NULLIF(agg.total_staked, 0) * 100, 0), 2),
    round(coalesce(agg.total_profit / NULLIF(p_starting_bankroll, 0) * 100, 0), 2),
    round(coalesce(agg.n_win::numeric / NULLIF(agg.n_win + agg.n_loss, 0) * 100, 0), 2),
    round(coalesce(agg.mean_odds, 0), 3),
    round(coalesce(agg.mean_stake, 0), 2),
    round(agg.mean_clv, 3),
    round(agg.clv_wins::numeric / NULLIF(agg.clv_n, 0) * 100, 2),
    round(agg.mean_brier, 4),
    round(spread.r_mean / NULLIF(spread.r_sd, 0), 3),
    -- sqrt() returns double precision, and round(double precision, int) does
    -- not exist in Postgres. Every term in the interval is cast to numeric
    -- before rounding, or these three expressions fail at CREATE time.
    CASE WHEN spread.rn >= 30 THEN
      round(
        (agg.total_profit / NULLIF(agg.total_staked, 0) * 100
         - 1.96 * (spread.r_sd / sqrt(spread.rn)::numeric) * 100)::numeric, 2)
    END,
    CASE WHEN spread.rn >= 30 THEN
      round(
        (agg.total_profit / NULLIF(agg.total_staked, 0) * 100
         + 1.96 * (spread.r_sd / sqrt(spread.rn)::numeric) * 100)::numeric, 2)
    END,
    CASE WHEN spread.rn >= 30 THEN
      (agg.total_profit / NULLIF(agg.total_staked, 0) * 100
        - 1.96 * (spread.r_sd / sqrt(spread.rn)::numeric) * 100) > 0
      OR
      (agg.total_profit / NULLIF(agg.total_staked, 0) * 100
        + 1.96 * (spread.r_sd / sqrt(spread.rn)::numeric) * 100) < 0
      ELSE false
    END
  FROM agg, spread;
$$;

COMMENT ON FUNCTION public.model_performance IS
  'One performance window for one model. p_days NULL = all time.';

-- ---------------------------------------------------------------------
-- The leaderboard
-- ---------------------------------------------------------------------

DROP MATERIALIZED VIEW IF EXISTS public.model_leaderboard CASCADE;

CREATE MATERIALIZED VIEW public.model_leaderboard AS
WITH models AS (
  SELECT DISTINCT b.model FROM public.bets b
),
windows AS (
  SELECT * FROM (VALUES (30), (60), (90), (NULL::integer)) AS w(days)
)
SELECT
  perf.*,
  -- Ordinal position within each window, by yield. Computed here so the UI
  -- never has to sort five rows into a ranking and get the tie-break wrong.
  rank() OVER (
    PARTITION BY perf.window_days
    ORDER BY perf.yield_pct DESC, perf.profit DESC, perf.bets DESC
  ) AS rank_by_yield,
  rank() OVER (
    PARTITION BY perf.window_days
    ORDER BY perf.clv_avg DESC NULLS LAST, perf.yield_pct DESC
  ) AS rank_by_clv,
  now() AS computed_at
FROM models
CROSS JOIN windows
CROSS JOIN LATERAL public.model_performance(models.model, windows.days) AS perf;

-- Required for REFRESH ... CONCURRENTLY, which is what lets the settle job
-- rebuild this without blocking every reader on the site.
CREATE UNIQUE INDEX IF NOT EXISTS model_leaderboard_key
  ON public.model_leaderboard (model, COALESCE(window_days, -1));

COMMENT ON MATERIALIZED VIEW public.model_leaderboard IS
  '30/60/90-day and all-time performance per model. Refresh after settlement.';

/*
 * Refresh entry point.
 *
 * CONCURRENTLY first; a plain refresh as the fallback. The concurrent form
 * fails on a view that has never been populated, and that failure must not
 * take down settlement — which is the one job that must always finish.
 */
CREATE OR REPLACE FUNCTION public.refresh_leaderboard()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.model_leaderboard;
EXCEPTION WHEN OTHERS THEN
  REFRESH MATERIALIZED VIEW public.model_leaderboard;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_leaderboard() FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_leaderboard() TO service_role;

GRANT SELECT ON public.model_leaderboard TO anon, authenticated;
GRANT SELECT ON public.bet_performance TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.model_performance(text, integer, numeric) TO anon, authenticated;

-- ---------------------------------------------------------------------
-- Calibration
-- ---------------------------------------------------------------------

/*
 * Does a model's stated probability match reality?
 *
 * Ten-point buckets. This is the question the arena exists to answer, and
 * the one a win/loss record cannot: a model that says 60% and is right 40%
 * of the time is not unlucky, it is miscalibrated in a measurable and
 * correctable way.
 */
CREATE OR REPLACE VIEW public.model_calibration AS
SELECT
  b.model,
  width_bucket(b.true_prob, 0, 1, 10)          AS bucket,
  (width_bucket(b.true_prob, 0, 1, 10) - 1) * 10 AS band_from,
  width_bucket(b.true_prob, 0, 1, 10) * 10       AS band_to,
  count(*)                                       AS n,
  round(avg(b.true_prob) * 100, 1)               AS predicted_pct,
  round(
    count(*) FILTER (WHERE b.result = 'win')::numeric
    / NULLIF(count(*), 0) * 100, 1)              AS actual_pct
FROM public.bets b
WHERE b.result IN ('win', 'loss')
  AND b.true_prob IS NOT NULL
  AND b.true_prob > 0 AND b.true_prob < 1
GROUP BY b.model, 2, 3, 4
ORDER BY b.model, 2;

GRANT SELECT ON public.model_calibration TO anon, authenticated;

-- ---------------------------------------------------------------------
-- Bankroll trajectory
-- ---------------------------------------------------------------------

/*
 * A running bankroll and its drawdown, one row per settled bet.
 *
 * The window frame is explicit. The default frame for an ordered window is
 * RANGE, which groups peer rows sharing a sort key — two bets settled in the
 * same second would then produce a running total that jumps by both at once
 * and a chart with a visible step. ROWS gives one row at a time, which is
 * what a trajectory means.
 */
CREATE OR REPLACE VIEW public.bankroll_trajectory AS
WITH ordered AS (
  SELECT
    p.model,
    p.settled_at,
    p.profit,
    sum(p.profit) OVER (
      PARTITION BY p.model ORDER BY p.settled_at, p.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_profit
  FROM public.bet_performance p
  WHERE p.result <> 'pending' AND p.settled_at IS NOT NULL
)
SELECT
  o.model,
  o.settled_at,
  o.profit,
  o.cumulative_profit,
  1000 + o.cumulative_profit AS bankroll,
  max(1000 + o.cumulative_profit) OVER (
    PARTITION BY o.model ORDER BY o.settled_at
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS running_peak,
  round(
    (max(1000 + o.cumulative_profit) OVER (
       PARTITION BY o.model ORDER BY o.settled_at
       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
     - (1000 + o.cumulative_profit))
    / NULLIF(max(1000 + o.cumulative_profit) OVER (
       PARTITION BY o.model ORDER BY o.settled_at
       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) * 100
  , 2) AS drawdown_pct
FROM ordered o;

GRANT SELECT ON public.bankroll_trajectory TO anon, authenticated;

-- ---------------------------------------------------------------------
-- Parity check — run once after applying
-- ---------------------------------------------------------------------
--
-- Proves the SQL agrees with tests/metrics.test.mjs on the same fixtures.
-- Three at 2.50, one win two losses: staked 300, profit -50, yield -16.67%.
--
--   WITH fixture(stake, odds, result) AS (VALUES
--     (100::numeric, 2.5::numeric, 'win'),
--     (100, 2.5, 'loss'),
--     (100, 2.5, 'loss')
--   )
--   SELECT
--     sum(CASE result WHEN 'win' THEN stake*(odds-1) WHEN 'loss' THEN -stake ELSE 0 END) AS profit,
--     sum(CASE WHEN result IN ('win','loss') THEN stake ELSE 0 END) AS staked,
--     round(
--       sum(CASE result WHEN 'win' THEN stake*(odds-1) WHEN 'loss' THEN -stake ELSE 0 END)
--       / sum(CASE WHEN result IN ('win','loss') THEN stake ELSE 0 END) * 100, 2) AS yield_pct
--   FROM fixture;
--
--   -- expect: profit -50.0 | staked 300 | yield_pct -16.67

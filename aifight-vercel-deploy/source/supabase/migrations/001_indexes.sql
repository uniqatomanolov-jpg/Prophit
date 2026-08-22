-- =====================================================================
-- 001_indexes.sql — indexes for the hot query paths
-- =====================================================================
--
-- HOW THESE WERE CHOSEN
-- ---------------------
-- Not guessed. Each one below answers a query that the shipped client
-- actually issues, taken from the bundle:
--
--   useArena      .from('bets').select(...).order('logged_at')
--                 .from('bets').eq('result','pending')
--                 .from('fighters').select(...)
--                 .from('bankroll_checkpoints').select(...)
--   routes        .from('challenge_bets'), .from('tail_or_fade')
--   briefing      .from('briefing_room')
--   admin         .from('market_board'), .from('events')
--
-- Every index is CONCURRENTLY built so applying this to a live database
-- does not take a write lock on `bets`. That means each statement must run
-- OUTSIDE a transaction — the Supabase SQL editor does this correctly, but
-- `supabase db push` wraps migrations in one. Run this file through the
-- editor, or split it, or drop CONCURRENTLY if the table is small enough
-- that a brief lock is acceptable (under ~50k rows it is).
--
-- IF NOT EXISTS on every statement makes the whole file re-runnable.

-- ---------------------------------------------------------------------
-- bets — the table everything reads
-- ---------------------------------------------------------------------

-- The standings query: every settled bet for one fighter, newest first.
-- Composite and ordered, so it answers both the filter and the sort from
-- the index alone and never touches the heap for ordering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS bets_model_settled_idx
  ON public.bets (model, settled_at DESC NULLS LAST);

-- The settlement queue. PARTIAL — it indexes only pending rows, which are a
-- tiny and roughly constant fraction of the table. A full index on `result`
-- would grow forever and be almost entirely dead weight, because nothing
-- ever queries for "all losses since the season began".
CREATE INDEX CONCURRENTLY IF NOT EXISTS bets_pending_idx
  ON public.bets (kickoff_at ASC)
  WHERE result = 'pending';

-- The public feed and the round view.
CREATE INDEX CONCURRENTLY IF NOT EXISTS bets_logged_at_idx
  ON public.bets (logged_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS bets_round_idx
  ON public.bets (round, model);

-- Settlement joins bets to outcomes. Without this, grading a fixture is a
-- sequential scan of the whole bets table per outcome.
CREATE INDEX CONCURRENTLY IF NOT EXISTS bets_outcome_idx
  ON public.bets (outcome_id)
  WHERE outcome_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS bets_event_idx
  ON public.bets (event_id);

-- The rolling 30/60/90 windows. Ordering by settled_at within a model is the
-- single most frequent analytical query on the site.
CREATE INDEX CONCURRENTLY IF NOT EXISTS bets_settled_window_idx
  ON public.bets (settled_at DESC)
  WHERE result <> 'pending';

-- ---------------------------------------------------------------------
-- events / markets / outcomes — the board
-- ---------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_starts_at_idx
  ON public.events (starts_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_status_starts_idx
  ON public.events (status, starts_at ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS markets_event_idx
  ON public.markets (event_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS outcomes_market_ord_idx
  ON public.outcomes (market_id, ord);

-- ---------------------------------------------------------------------
-- challenge tables
-- ---------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS challenge_bets_model_settled_idx
  ON public.challenge_bets (model, settled_at DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS challenge_bets_pending_idx
  ON public.challenge_bets (kickoff_at ASC)
  WHERE result = 'pending';

-- ---------------------------------------------------------------------
-- supporting tables
-- ---------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS bankroll_checkpoints_model_at_idx
  ON public.bankroll_checkpoints (model, captured_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS briefing_room_event_idx
  ON public.briefing_room (event_id, model);

-- One vote per visitor per bet. A UNIQUE index is the constraint AND the
-- lookup path: it makes double-voting impossible at the database level
-- rather than in client code that can be bypassed with curl.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS tail_or_fade_unique_idx
  ON public.tail_or_fade (bet_id, voter_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tail_or_fade_bet_idx
  ON public.tail_or_fade (bet_id);

-- ---------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------
--
-- After applying, confirm the planner actually uses them:
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT * FROM bets WHERE model = 'AXIOM' ORDER BY settled_at DESC LIMIT 50;
--
-- Expect "Index Scan using bets_model_settled_idx". A "Seq Scan" on a table
-- with more than a few thousand rows means the index is not being used and
-- the query needs to change, not another index.
--
-- Find unused indexes later with:
--
--   SELECT relname, indexrelname, idx_scan
--   FROM pg_stat_user_indexes
--   WHERE idx_scan = 0 AND schemaname = 'public'
--   ORDER BY relname;
--
-- An index with zero scans after a full season is write overhead and nothing
-- else. Drop it.

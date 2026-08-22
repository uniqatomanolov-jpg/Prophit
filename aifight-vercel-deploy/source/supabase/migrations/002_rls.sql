-- =====================================================================
-- 002_rls.sql — Row Level Security
-- =====================================================================
--
-- WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE REPO
-- ---------------------------------------------------
-- The Supabase anon key is published in `/config.js`. That is correct and
-- normal — it is designed to be public, it identifies the project rather
-- than authorising anything, and it cannot be hidden in a static site.
--
-- But it is only safe if RLS is on and the policies are right. With RLS
-- disabled, or with a permissive `USING (true)` write policy, that public
-- key is a full read-write connection to the database, and anyone who
-- opens devtools has it:
--
--   const s = createClient(URL, ANON_KEY)
--   await s.from('bets').update({ result: 'win' }).eq('model', 'AXIOM')
--
-- Every bankroll on the site, rewritten from a browser console, with no
-- password and no trace. Verify this file has been applied before doing
-- anything else on this list.
--
-- THE MODEL
-- ---------
--   anon           reads the public arena. Writes nothing, ever.
--   authenticated  same as anon unless it is also an admin.
--   admin          identified by is_admin(); writes through RPCs only.
--   service_role   bypasses RLS entirely. Server-side only. Never shipped.
--
-- Writes go through SECURITY DEFINER functions rather than table policies.
-- A policy can say "an admin may update a bet"; only a function can say
-- "settling a bet must also move the bankroll, in the same transaction,
-- exactly once". Business rules that span rows belong in functions.

-- ---------------------------------------------------------------------
-- Admin identity
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id    uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email      text,
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   uuid REFERENCES auth.users (id)
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users FORCE ROW LEVEL SECURITY;

-- Deliberately no SELECT policy for anon or authenticated. The list of
-- admins is not public information, and a non-admin has no reason to read
-- it. Only service_role and the SECURITY DEFINER function below can see it.

/*
 * is_admin() — the single source of authorisation truth.
 *
 * SECURITY DEFINER so it can read admin_users despite that table being
 * closed. `search_path` is pinned to empty and every reference is fully
 * qualified: without that, a caller who can create objects could plant a
 * malicious `admin_users` earlier in their search_path and this function
 * would happily consult it. That is the classic SECURITY DEFINER
 * privilege-escalation and it is defeated entirely by this one line.
 *
 * STABLE lets the planner call it once per statement rather than per row.
 */
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users a WHERE a.user_id = (SELECT auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, anon;

-- ---------------------------------------------------------------------
-- bets
-- ---------------------------------------------------------------------

ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;
-- FORCE applies RLS to the table owner too. Without it, a policy bug plus a
-- query running as owner silently bypasses everything below.
ALTER TABLE public.bets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bets are public" ON public.bets;
DROP POLICY IF EXISTS "anon can read bets" ON public.bets;
DROP POLICY IF EXISTS "public read bets" ON public.bets;

-- The whole point of the site: every pick is public, wins and losses alike.
CREATE POLICY "public read bets"
  ON public.bets FOR SELECT
  TO anon, authenticated
  USING (true);

-- No INSERT, UPDATE or DELETE policy exists for anon or authenticated.
-- In Postgres RLS, absence of a policy is a denial. Writes reach this table
-- only through the SECURITY DEFINER RPCs (`log_pick`, `bulk_settle`,
-- `settle_market`), which check is_admin() themselves.

-- ---------------------------------------------------------------------
-- fighters, season, checkpoints — public read, no client write
-- ---------------------------------------------------------------------

ALTER TABLE public.fighters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fighters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read fighters" ON public.fighters;
CREATE POLICY "public read fighters"
  ON public.fighters FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE public.season ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read season" ON public.season;
CREATE POLICY "public read season"
  ON public.season FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE public.bankroll_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bankroll_checkpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read checkpoints" ON public.bankroll_checkpoints;
CREATE POLICY "public read checkpoints"
  ON public.bankroll_checkpoints FOR SELECT TO anon, authenticated USING (true);

-- ---------------------------------------------------------------------
-- events / markets / outcomes
-- ---------------------------------------------------------------------

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read events" ON public.events;
CREATE POLICY "public read events"
  ON public.events FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE public.markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.markets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read markets" ON public.markets;
CREATE POLICY "public read markets"
  ON public.markets FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE public.outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcomes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read outcomes" ON public.outcomes;
CREATE POLICY "public read outcomes"
  ON public.outcomes FOR SELECT TO anon, authenticated USING (true);

-- ---------------------------------------------------------------------
-- briefing_room
-- ---------------------------------------------------------------------

ALTER TABLE public.briefing_room ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.briefing_room FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read briefing" ON public.briefing_room;
CREATE POLICY "public read briefing"
  ON public.briefing_room FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "admins write briefing" ON public.briefing_room;
CREATE POLICY "admins write briefing"
  ON public.briefing_room FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ---------------------------------------------------------------------
-- tail_or_fade — the one table the public may write to
-- ---------------------------------------------------------------------
--
-- This needs real care. It is anonymous, unauthenticated, public write
-- access, which is exactly the shape of an abuse vector. Three constraints
-- contain it:
--
--   the UNIQUE index from 001    one vote per voter_key per bet
--   the WITH CHECK below         only 'tail' or 'fade', never arbitrary data
--   no UPDATE and no DELETE      a vote is final; nobody can rewrite the poll
--
-- voter_key is a client-generated identifier, so it is trivially forgeable.
-- That is accepted: this is an entertainment poll, not a ballot. What must
-- not be possible is writing junk into the table or altering existing rows,
-- and neither is.

ALTER TABLE public.tail_or_fade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tail_or_fade FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read votes" ON public.tail_or_fade;
CREATE POLICY "public read votes"
  ON public.tail_or_fade FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public insert votes" ON public.tail_or_fade;
CREATE POLICY "public insert votes"
  ON public.tail_or_fade FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    vote IN ('tail', 'fade')
    AND voter_key IS NOT NULL
    AND length(voter_key) BETWEEN 8 AND 64
    -- Only open bets can be voted on. Without this, the poll on a settled
    -- bet stays open forever and can be stuffed after the result is known.
    AND EXISTS (
      SELECT 1 FROM public.bets b
      WHERE b.id = bet_id AND b.result = 'pending'
    )
  );

-- ---------------------------------------------------------------------
-- challenge tables
-- ---------------------------------------------------------------------

ALTER TABLE public.challenge_bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_bets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read challenge bets" ON public.challenge_bets;
CREATE POLICY "public read challenge bets"
  ON public.challenge_bets FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE public.challenge_fighters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_fighters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read challenge fighters" ON public.challenge_fighters;
CREATE POLICY "public read challenge fighters"
  ON public.challenge_fighters FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE public.challenge_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read challenge config" ON public.challenge_config;
CREATE POLICY "public read challenge config"
  ON public.challenge_config FOR SELECT TO anon, authenticated USING (true);

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------
--
-- Every privileged mutation writes a row here. This is what makes an
-- override defensible: when a pick is manually graded or a model weight is
-- changed, there is a permanent record of who did it and what the value was
-- before. A site whose whole claim is "settled honestly" needs to be able
-- to prove it.

CREATE TABLE IF NOT EXISTS public.admin_audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL,
  target      text,
  before      jsonb,
  after       jsonb,
  note        text
);

CREATE INDEX IF NOT EXISTS admin_audit_at_idx ON public.admin_audit (at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_action_idx ON public.admin_audit (action, at DESC);

ALTER TABLE public.admin_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins read audit" ON public.admin_audit;
CREATE POLICY "admins read audit"
  ON public.admin_audit FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- No INSERT policy at all, for anyone. Rows are written only by the
-- SECURITY DEFINER function below, so an audit entry cannot be forged and,
-- more importantly, cannot be omitted by a caller who would rather not
-- leave a trace.

CREATE OR REPLACE FUNCTION public.write_audit(
  p_actor  text,
  p_action text,
  p_target text DEFAULT NULL,
  p_before jsonb DEFAULT NULL,
  p_after  jsonb DEFAULT NULL,
  p_note   text  DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_id bigint;
BEGIN
  INSERT INTO public.admin_audit (actor, action, target, before, after, note)
  VALUES (p_actor, p_action, p_target, p_before, p_after, p_note)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.write_audit(text, text, text, jsonb, jsonb, text) FROM public;
-- service_role only: audit entries come from the server, never a browser.
GRANT EXECUTE ON FUNCTION public.write_audit(text, text, text, jsonb, jsonb, text) TO service_role;

-- ---------------------------------------------------------------------
-- A note on sequence grants
-- ---------------------------------------------------------------------
--
-- Supabase grants `USAGE, SELECT ON ALL SEQUENCES` to anon and authenticated
-- by default. This file relies on that: `tail_or_fade` uses a bigserial id,
-- so a public vote needs sequence usage as well as the INSERT policy above.
--
-- Do not "harden" by revoking sequence access. It would break voting while
-- providing no security — every write path here is already governed by an
-- RLS policy, which is the layer that decides what may be written. This was
-- verified against a live Postgres 16: with sequence grants in place, every
-- forged INSERT is refused with "new row violates row-level security
-- policy", and only the legitimate vote succeeds.

-- ---------------------------------------------------------------------
-- Verify — run this and read every row
-- ---------------------------------------------------------------------
--
--   SELECT c.relname,
--          c.relrowsecurity  AS rls_enabled,
--          c.relforcerowsecurity AS rls_forced,
--          count(p.polname)  AS policies
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   LEFT JOIN pg_policy p ON p.polrelid = c.oid
--   WHERE n.nspname = 'public' AND c.relkind = 'r'
--   GROUP BY 1,2,3
--   ORDER BY 2, 1;
--
-- Any table with rls_enabled = false is publicly writable with the anon key.
-- There must be none.
--
-- Then confirm from the client side, which is the test that actually counts:
--
--   const s = createClient(URL, ANON_KEY)
--   const { error } = await s.from('bets').update({ result: 'win' }).eq('id', 1)
--   // error must be non-null. If it is null, STOP and fix this file.

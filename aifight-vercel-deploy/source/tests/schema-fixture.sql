-- Minimal stand-in for the live AiFight schema, reconstructed from the
-- columns the shipped bundle reads. Used only to prove the migrations in
-- supabase/migrations/ parse, apply and produce correct numbers.
--
-- Also stubs the two Supabase-provided objects the migrations depend on:
-- the `auth` schema and `auth.uid()`.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.events (
  id          bigserial PRIMARY KEY,
  sport       text NOT NULL DEFAULT 'football',
  competition text,
  name        text NOT NULL,
  home        text,
  away        text,
  starts_at   timestamptz,
  status      text NOT NULL DEFAULT 'scheduled'
);

CREATE TABLE IF NOT EXISTS public.markets (
  id       bigserial PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
  key      text NOT NULL,
  label    text NOT NULL,
  kind     text NOT NULL DEFAULT 'single',
  status   text NOT NULL DEFAULT 'open',
  winners_expected int,
  settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.outcomes (
  id        bigserial PRIMARY KEY,
  market_id bigint NOT NULL REFERENCES public.markets (id) ON DELETE CASCADE,
  ord       int NOT NULL,
  label     text NOT NULL,
  odds      numeric,
  won       boolean
);

CREATE TABLE IF NOT EXISTS public.bets (
  id           bigserial PRIMARY KEY,
  model        text NOT NULL,
  round        int  NOT NULL DEFAULT 1,
  event_id     bigint REFERENCES public.events (id) ON DELETE SET NULL,
  outcome_id   bigint REFERENCES public.outcomes (id) ON DELETE SET NULL,
  event        text,
  market       text,
  pick         text,
  odds         numeric NOT NULL,
  stake        numeric NOT NULL,
  true_prob    numeric,
  fair_prob    numeric,
  closing_odds numeric,
  result       text NOT NULL DEFAULT 'pending',
  reasoning    text,
  logged_at    timestamptz NOT NULL DEFAULT now(),
  kickoff_at   timestamptz,
  settled_at   timestamptz
);

CREATE TABLE IF NOT EXISTS public.fighters (
  model             text PRIMARY KEY,
  bankroll          numeric NOT NULL DEFAULT 1000,
  starting_bankroll numeric NOT NULL DEFAULT 1000,
  wins int NOT NULL DEFAULT 0,
  losses int NOT NULL DEFAULT 0,
  voids int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.season (
  id     int PRIMARY KEY DEFAULT 1,
  round  int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS public.bankroll_checkpoints (
  id          bigserial PRIMARY KEY,
  model       text NOT NULL,
  bankroll    numeric NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.briefing_room (
  id        bigserial PRIMARY KEY,
  event_id  bigint REFERENCES public.events (id) ON DELETE CASCADE,
  model     text NOT NULL,
  headline  text, form text, team_news text, tactical text,
  trend text, x_factor text, risk text,
  confidence int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tail_or_fade (
  id         bigserial PRIMARY KEY,
  bet_id     bigint NOT NULL REFERENCES public.bets (id) ON DELETE CASCADE,
  voter_key  text NOT NULL,
  vote       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.challenge_bets (
  id         bigserial PRIMARY KEY,
  model      text NOT NULL,
  odds       numeric NOT NULL,
  stake      numeric NOT NULL,
  result     text NOT NULL DEFAULT 'pending',
  kickoff_at timestamptz,
  settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.challenge_fighters (
  model    text PRIMARY KEY,
  bankroll numeric NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS public.challenge_config (
  id  int PRIMARY KEY DEFAULT 1,
  rules jsonb
);

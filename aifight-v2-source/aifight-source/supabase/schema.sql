-- ============================================================================
-- AIFIGHT - COMPLETE SUPABASE SCHEMA
-- ============================================================================
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New
-- query -> paste -> Run). It is idempotent: running it twice is harmless.
--
-- THE SECURITY MODEL, STATED PLAINLY
-- ----------------------------------
-- With no serverless functions, the browser talks to Postgres directly using
-- the anon key. That key IS PUBLIC -- it ships inside your JavaScript bundle
-- and anyone can read it. That is by design and it is fine, but ONLY because
-- Row Level Security is what actually enforces permissions:
--
--     anyone (anon)        -> may SELECT events and bets. Nothing else.
--     signed-in (authenticated) -> may INSERT / UPDATE / DELETE.
--
-- So the admin panel is protected by Supabase Auth, not by a password in the
-- frontend code. A password compared in JavaScript protects nothing: the
-- attacker skips your React component and calls the REST endpoint directly.
-- Only RLS sits between an anonymous caller and your data.
--
-- NEVER put the service_role key in this app. Anything prefixed VITE_ is
-- compiled into the public bundle, and service_role bypasses every policy
-- below.
-- ============================================================================

-- Needed for gen_random_uuid(). Present by default on Supabase; harmless here.
create extension if not exists "pgcrypto";

-- ============================================================================
-- EVENTS - the match board
-- ============================================================================
create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),

  sport         text        not null,
  -- Fixture fields. `away` and `session` are nullable because a Grand Prix
  -- has one name and no opponent -- the schema should not force F1 to
  -- invent an away side.
  home          text        not null,
  away          text,
  session       text,
  competition   text,

  -- The composed display name, written by composeEventName() so the string
  -- the operator saw is the string that is stored.
  event_name    text        not null,

  starts_at     timestamptz,
  round         integer     not null default 1,

  -- Operator-supplied outcome list for roster markets (F1 drivers, correct
  -- scores). jsonb array of strings.
  entrants      jsonb       not null default '[]'::jsonb,

  -- The priced odds matrix, keyed by market:
  --   { "1X2":      { "line": null, "prices": { "Arsenal": 2.10, "Draw": 3.40, "Chelsea": 3.60 } },
  --     "goals_ou": { "line": 2.5,  "prices": { "Over 2.5 Goals": 1.90, "Under 2.5 Goals": 1.95 } } }
  -- jsonb rather than a prices table because odds are read as a whole matrix
  -- and never queried across events. A join here would buy nothing.
  odds          jsonb       not null default '{}'::jsonb,

  status        text        not null default 'open',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint events_status_check check (status in ('open', 'closed', 'settled')),
  constraint events_sport_check  check (
    sport in ('soccer','nba','nfl','nhl','darts','snooker','f1')
  )
);

comment on table public.events is
  'One row per fixture or race. `odds` holds the whole priced matrix as jsonb.';

-- The board is read newest-first, filtered by status, on every page load.
create index if not exists events_status_starts_idx
  on public.events (status, starts_at desc nulls last);
create index if not exists events_sport_idx on public.events (sport);
create index if not exists events_round_idx on public.events (round);

-- ============================================================================
-- BETS - the ledger. Every number on the site is derived from this table.
-- ============================================================================
create table if not exists public.bets (
  id            uuid primary key default gen_random_uuid(),

  -- ON DELETE CASCADE: deleting a fixture must not leave orphaned bets that
  -- still count toward a bankroll while being invisible in the UI.
  event_id      uuid        not null references public.events(id) on delete cascade,

  model         text        not null,
  market        text        not null,
  pick          text        not null,

  odds          numeric(10,3) not null,
  stake         numeric(10,2) not null,

  -- The fighter's own probability, 0-1. Nullable: a pick without a stated
  -- probability is still a pick.
  fair_prob     numeric(6,5),
  confidence    integer,

  -- The thesis. This is exactly what the public rationale drawer renders,
  -- which is why it is NOT NULL -- an empty drawer was the original bug.
  reasoning     text        not null,
  risk_factors  text,

  -- Grading. NULL means pending, and it is always reversible.
  result        text,
  payout        numeric(12,2),
  profit        numeric(12,2),

  round         integer     not null default 1,
  logged_at     timestamptz not null default now(),
  settled_at    timestamptz,

  constraint bets_model_check  check (model in ('Claude','Grok','ChatGPT','Gemini','Kimi')),
  constraint bets_result_check check (result is null or result in ('win','loss','void')),
  constraint bets_odds_check   check (odds > 1),
  constraint bets_stake_check  check (stake > 0),
  constraint bets_prob_check   check (fair_prob is null or (fair_prob > 0 and fair_prob < 1)),

  -- The database's own guarantee that the money is right, independent of
  -- whatever the client believed. If a client ever writes a WIN whose payout
  -- is not stake x odds, the INSERT fails loudly instead of corrupting a
  -- bankroll quietly.
  --
  -- The one-cent tolerance is deliberate, not sloppiness. Postgres `numeric`
  -- is exact decimal; JavaScript `number` is binary floating point. For a
  -- product landing exactly on a half-cent -- stake 1.00 at odds 1.005 --
  -- Postgres rounds 1.005 up to 1.01 while JavaScript holds 1.00499999...
  -- and rounds down to 1.00. An equality check would reject that perfectly
  -- valid bet. A cent of slack absorbs the representation gap while still
  -- catching every error that actually matters: a zero payout on a win, a
  -- transposed stake and odds, a profit that includes the returned stake.
  constraint bets_payout_check check (
    result is null
    or (result = 'win'
        and abs(payout - stake * odds) <= 0.01
        and abs(profit - (stake * odds - stake)) <= 0.01)
    or (result = 'loss' and payout = 0     and profit = -stake)
    or (result = 'void' and payout = stake and profit = 0)
  ),

  -- One fighter cannot hold the same selection twice on the same market.
  constraint bets_no_duplicate unique (event_id, model, market, pick)
);

comment on table public.bets is
  'The append-mostly ledger. Bankrolls are DERIVED from this, never stored.';
comment on column public.bets.result is
  'NULL = pending. Grading is freely correctable in both directions.';

create index if not exists bets_event_idx  on public.bets (event_id);
create index if not exists bets_model_idx  on public.bets (model);
create index if not exists bets_logged_idx on public.bets (logged_at desc);
-- Partial index: "what still needs grading" is the admin's hottest query.
create index if not exists bets_pending_idx on public.bets (logged_at desc) where result is null;

-- ============================================================================
-- updated_at
-- ============================================================================
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before update on public.events
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- FIGHTER_STANDINGS - the same maths as src/lib/engine.js, in SQL
-- ============================================================================
-- A VIEW rather than a table, so it cannot drift from the bets it summarises.
-- There is no sync job to fail, no row to be left stale by a re-grade, and no
-- possibility of the API and the UI disagreeing about a bankroll.
-- ============================================================================
create or replace view public.fighter_standings as
with fighters as (
  select unnest(array['Claude','Grok','ChatGPT','Gemini','Kimi']) as model
),
settled as (
  select
    model,
    count(*)                                       as settled_count,
    count(*) filter (where result = 'win')         as wins,
    count(*) filter (where result = 'loss')        as losses,
    count(*) filter (where result = 'void')        as voids,
    coalesce(sum(stake), 0)                        as turnover,
    coalesce(sum(profit), 0)                       as profit,
    -- Sharpe over per-bet returns (profit / stake). NULL below 5 samples --
    -- a Sharpe over three bets is not a measurement. `::numeric` casts are
    -- required: stddev_samp() returns double precision, and round(double,
    -- integer) does not exist in Postgres.
    case
      when count(*) >= 5 and stddev_samp(profit / stake) > 0
      then round((avg(profit / stake) / stddev_samp(profit / stake))::numeric, 4)
    end                                            as sharpe
  from public.bets
  where result is not null
  group by model
),
pending as (
  select model,
         count(*)                as pending_count,
         coalesce(sum(stake), 0) as pending_stake
  from public.bets
  where result is null
  group by model
),
today as (
  select model, coalesce(sum(stake), 0) as staked_today
  from public.bets
  -- The arena's day boundary, not UTC's.
  where (logged_at at time zone 'Europe/Sofia')::date
      = (now()      at time zone 'Europe/Sofia')::date
  group by model
)
select
  f.model,
  1000::numeric                                            as starting_bankroll,
  round(1000 + coalesce(s.profit, 0), 2)                   as bankroll,
  round(coalesce(s.profit, 0), 2)                          as profit,
  round(coalesce(s.turnover, 0), 2)                        as turnover,
  case when coalesce(s.turnover, 0) > 0
       then round(s.profit / s.turnover, 4) end            as roi,
  case when coalesce(s.wins, 0) + coalesce(s.losses, 0) > 0
       then round(s.wins::numeric / (s.wins + s.losses), 4) end as win_rate,
  s.sharpe,
  coalesce(s.wins, 0)                                      as wins,
  coalesce(s.losses, 0)                                    as losses,
  coalesce(s.voids, 0)                                     as voids,
  coalesce(s.settled_count, 0)                             as settled_count,
  coalesce(p.pending_count, 0)                             as pending_count,
  round(coalesce(p.pending_stake, 0), 2)                   as pending_stake,
  round(coalesce(t.staked_today, 0), 2)                    as staked_today,
  greatest(0, round(100 - coalesce(t.staked_today, 0), 2)) as daily_remaining,
  (1000 + coalesce(s.profit, 0)) <= 0                      as liquidated
from fighters f
left join settled s on s.model = f.model
left join pending p on p.model = f.model
left join today   t on t.model = f.model
order by liquidated asc, bankroll desc;

comment on view public.fighter_standings is
  'Derived standings. Mirrors src/lib/engine.js so server and client agree.';

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- Without these the anon key is a full read/write credential published in
-- your JavaScript bundle. This section is the actual security of the app.
-- ============================================================================
alter table public.events enable row level security;
alter table public.bets   enable row level security;

-- Read: open to the world. The arena is a public scoreboard.
drop policy if exists "events are publicly readable" on public.events;
create policy "events are publicly readable"
  on public.events for select
  to anon, authenticated
  using (true);

drop policy if exists "bets are publicly readable" on public.bets;
create policy "bets are publicly readable"
  on public.bets for select
  to anon, authenticated
  using (true);

-- Write: signed-in operators only. Separate policies per verb rather than
-- FOR ALL, so tightening one later (say, forbidding DELETE) does not require
-- unpicking a single permissive rule.
drop policy if exists "operators insert events" on public.events;
create policy "operators insert events"
  on public.events for insert to authenticated with check (true);

drop policy if exists "operators update events" on public.events;
create policy "operators update events"
  on public.events for update to authenticated using (true) with check (true);

drop policy if exists "operators delete events" on public.events;
create policy "operators delete events"
  on public.events for delete to authenticated using (true);

drop policy if exists "operators insert bets" on public.bets;
create policy "operators insert bets"
  on public.bets for insert to authenticated with check (true);

drop policy if exists "operators update bets" on public.bets;
create policy "operators update bets"
  on public.bets for update to authenticated using (true) with check (true);

drop policy if exists "operators delete bets" on public.bets;
create policy "operators delete bets"
  on public.bets for delete to authenticated using (true);

-- The view runs with the caller's own permissions, so the SELECT policies
-- above still apply through it. `security_invoker` needs Postgres 15+; on an
-- older project the view simply runs as its owner, which reads the same two
-- publicly-readable tables, so the guard is safe rather than a silent hole.
do $$
begin
  execute 'alter view public.fighter_standings set (security_invoker = on)';
exception when others then
  raise notice 'security_invoker unavailable on this Postgres version - skipped';
end
$$;

grant select on public.fighter_standings to anon, authenticated;

-- ============================================================================
-- REALTIME
-- ============================================================================
-- Publishing both tables is what makes the admin panel and the public arena
-- update live without polling. Wrapped because adding a table twice errors.
-- ============================================================================
do $$
begin
  begin
    alter publication supabase_realtime add table public.events;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.bets;
  exception when duplicate_object then null;
  end;
end
$$;

-- Realtime sends the previous row on UPDATE/DELETE only with a replica
-- identity. Without this the client cannot tell which bet was re-graded.
alter table public.events replica identity full;
alter table public.bets   replica identity full;

-- ============================================================================
-- AFTER RUNNING THIS
-- ============================================================================
-- 1. Dashboard -> Authentication -> Users -> "Add user" -> create your admin
--    account with a real password. That account is now the only way to write.
-- 2. Dashboard -> Authentication -> Providers -> Email: turn OFF
--    "Enable sign ups". Otherwise anyone can register themselves an operator
--    account and the RLS write policies above will happily let them in.
-- 3. Dashboard -> Settings -> API: copy the Project URL and the `anon`
--    public key into Vercel as VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
--    Do not copy service_role. Ever.
-- ============================================================================

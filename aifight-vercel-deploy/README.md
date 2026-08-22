# Deploying this folder to Vercel

This is a complete, drag-and-drop-ready deployment of AiFight with the
security fixes applied. It is your existing build with the API layer replaced
and the admin console moved behind a real server-side login.

---

## ⚠ Do this first, before you deploy

**Rotate the admin password.** The old one (`beroe`) was served publicly at
`https://aifight.vercel.app/config.js` — anyone could read it and log into
`/admin`. Deleting it from the file does not un-publish what has already been
served. If you have reused that password anywhere else, change it there too.

**Rotate `ADMIN_TOKEN`** if it was ever typed into a browser. It was persisted
in `localStorage`, where any script on the page could read it.

---

## 1. Set the environment variables

You need **two new ones** or nobody can log in. Generate them:

```sh
node hash-password.mjs
```

(That script is in the zip, one level up from this folder. It never writes the
password anywhere — it prints only the hash and a fresh signing secret.)

Then in **Vercel → Settings → Environment Variables**, add both to
**Production _and_ Preview**:

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_PASSWORD_HASH` | **yes** | scrypt hash of your new password |
| `ADMIN_SESSION_SECRET` | **yes** | signs session cookies (≥32 chars) |
| `BLOB_READ_WRITE_TOKEN` | for sync | arena storage. Vercel sets this when you create a Blob store |
| `ODDS_API_KEY` | for odds | from the-odds-api.com |
| `SUPABASE_URL` | for settle | your project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | for settle | **server only.** Never in `config.js` |
| `ADMIN_TOKEN` | optional | CLI/machine access only. Not needed in a browser any more |
| `CRON_SECRET` | optional | what Vercel Cron sends to `/api/settle` |
| `ALLOWED_ORIGINS` | optional | extra CORS origins, comma-separated |
| `PUBLIC_HOST` | optional | defaults to `aifight.vercel.app`. **Set this if your domain differs** |

**Never prefix any of these with `VITE_`.** That prefix inlines a value into
the JavaScript everyone downloads — it is how the previous password became
public.

## 2. Deploy

> **If a previous deploy failed ~10s in with no code error:** that was the
> Vercel Hobby limit of **12 Serverless Functions per deployment**. Every `.js`
> under `api/` becomes one; the build fails during function enumeration, so
> nothing in the log points at a file. This folder ships **9 functions** —
> four handlers live in `api/_lib/routes/` (underscore paths are bundled as
> plain modules, not functions) and are dispatched from `api/picks.js`,
> `api/health.js` and `api/matches.js`, with `vercel.json` rewrites keeping
> every public URL identical. `scripts/check-secrets.mjs` now fails the build
> before Vercel does if the count ever goes over.


**Drag and drop:** zip *this folder's contents* (not the folder itself) and
drop it on the Vercel dashboard, or drag the folder into the deployment area.
Vercel reads `vercel.json`, installs the two dependencies in `package.json`,
and turns everything in `api/` into serverless functions. There is no build
step — the site is already compiled.

**Or with the CLI**, from inside this folder:

```sh
npx vercel --prod
```

## 3. Verify it worked

```sh
# 1. The password must be GONE from the public config.
curl -s https://YOUR-SITE.vercel.app/config.js | grep -i adminPassword
#    → no output. If it prints anything, the old file is still deployed.

# 2. Auth must be configured.
curl -s https://YOUR-SITE.vercel.app/api/admin/session
#    → {"ok":true,"authenticated":false,"configured":true,...}
#    If "configured":false, the env vars are missing — check step 1.

# 3. The arena must reject an unauthenticated write.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{"bets":[]}' \
  https://YOUR-SITE.vercel.app/api/arena
#    → 401
```

Then open `/admin`. You should get a login screen, not the console.

## 4. Check Supabase RLS — do not skip this

Your Supabase **anon key** is in `config.js`. That is correct and unavoidable
for a static site; the key is designed to be public. But it is only safe if
Row Level Security is on. Without it, that key is a full read-write database
connection for anyone with devtools open.

In the Supabase SQL editor:

```sql
SELECT c.relname, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY 2, 1;
```

**Every row must show `rls_enabled = true`.** If any is false, apply
`supabase/migrations/002_rls.sql` from the upgrade bundle before doing
anything else.

---

## ⚠ Why the Arena board shows no picks — measured, not guessed

Two independent causes, both confirmed by reading your live `/api/arena` and
the shipped bundle. Neither is a join, a nested market object, or a kickoff
filter — the stored records are already flat and the board's only filter is
`result === 'pending'`.

### Cause 1 — the board reads Supabase, not the blob

`useArena`'s query function, deminified from `assets/useArena-*.js`:

```js
if (getSupabaseClient()) {                     // configured?
  const r = await fetchSupabase();
  return { arena: r?.leaderboard.length ? r : EMPTY, source: 'supabase' };
}
const r = await fetchBlob();                   // <-- never reached
```

That is an **early return, not a fallback**. `config.js` carries a real
`supabaseUrl` and `supabaseAnonKey`, so the Supabase branch always wins and
`/api/arena` is never called by the public board. If those tables are empty or
RLS-blocked, the board renders empty while the blob sits there full.

**Picks logged through `/api/picks` go to the blob.** They will not appear
until you pick one source.

**To use the blob** (simplest, and what the new admin console writes to):
remove `supabaseUrl` and `supabaseAnonKey` from `public/config.js`, redeploy.
**To use Supabase**: keep them, and write picks into the `bets` table instead.

### Cause 2 — every pick is already settled

Your live arena at the time of writing: **25 bets, 0 pending** (15 win, 6 loss,
4 void), round 1 status `"locked"`. The active board is
`bets.filter(b => b.result === 'pending')`, so it is empty — correctly.

`"locked"` is also a status nothing in the shipped client handles; it only ever
checks for `"settled"`. So the round neither blocked logging nor read as
closed. `/api/round` now owns round state and `/api/picks` accepts picks only
when the round is `open`.

**Open `/admin/log` and click "Advance round"**, then log picks. They appear on
`/api/public/picks` immediately.

### `/api/diagnose` — never guess again

Admin-only. Reports which source the frontend will actually read, blob counts
by status, what the anon key can see in Supabase, round state, and a ranked
list of findings with the fix for each. The logging console shows it at the top
of the page.

## The flat public feed — `/api/public/picks`

Public, no auth, one flat array, no joins.

```
GET /api/public/picks                 active (pending) picks — default
GET /api/public/picks?status=all      everything
GET /api/public/picks?status=settled  graded only
    &model=Claude  &round=3  &limit=200
```

Every row carries **both** vocabularies, so a new consumer gets clean names and
the existing bundle keeps working:

| Flat schema | Bundle's existing name |
|---|---|
| `fighter_model` | `model` |
| `event_name` | `event` |
| `selection_name` | `pick` |
| `selection_ref` | `ref` |
| `market_key` | `market` |
| `probability` | `fair_prob` |
| `status` | `result` |

Plus precomputed `is_active`, `is_settled`, `profit`, `ev`, `has_thesis`, and
`reasoning` / `core_thesis` for the drawer.

The response also carries `totals` for the whole arena before filtering — so a
consumer can say *"no active picks — 25 settled"* instead of a bare "no picks",
which is the difference between an explanation and a dead end.

## `/admin/console` — Command

The two-column admin. No wizards, no popovers: everything that decides a write
is on screen at the moment of writing.

### Left — The Match Board

Sport tabs for **Football, NBA, NFL and Formula 1**. The fields and the odds
matrix both render from the server's own market registry, so the form can never
offer a market the server would reject.

| Sport | Markets |
|---|---|
| Football | Match Result (1X2 with draw), Double Chance, BTTS, Total Goals, Total Corners, Total Cards |
| NBA | Moneyline (2-way), Spread, Total Points |
| NFL | Moneyline (2-way), Spread, Total Points |
| Formula 1 | Race Winner, Podium (Top 3), Driver Head-to-Head |

Three matrix shapes: **fixed** (one odds box per outcome), **line** (a line
input plus two boxes — the away side of a spread mirrors automatically), and
**roster** (name + odds per driver, for F1).

Outcome labels repaint as you type. Enter "Boston Celtics" and a `-6.5` line
and the matrix immediately reads `Boston Celtics -6.5` / `Miami Heat +6.5` —
what you see beside each box is exactly the string that gets stored.

F1 has no away side, so the form asks for a Grand Prix and a session instead.

### Right — AI Dispatcher & Settler

Choose a fixture and all five fighters appear as rows: market, selection,
stake, probability, thesis. **The price comes from the board, never retyped** —
selecting an outcome carries its odds, so a transcription slip cannot move a
bankroll. Live EV per fighter as you type the probability.

Below that, every open position with three inline buttons that **preview what
they will pay before you press them**:

| Button | Payout | Bankroll |
|---|---|---|
| `WIN` | stake × odds | `+ stake × (odds − 1)` |
| `LOSS` | 0 | `− stake` |
| `VOID` | stake | unchanged — 100% refund |

Clicking one settles server-side and returns the recomputed fighter, so the
bankroll, ROI and daily meter repaint from the write itself rather than a
refetch. A result can be corrected — grading is not one-way — and doing so
moves the bankroll back. A collapsible audit log tracks the session.

A fighter whose bankroll reaches zero gets the graveyard treatment: the card
desaturates and takes a `LIQUIDATED R{n}` stamp.

## Validation and safety, enforced server-side

- Decimal odds must be **> 1.00** (and ≤ 1000).
- Duplicate fixtures on the board are refused; duplicate picks (same fighter,
  fixture, market, round) are refused by `pick_id`.
- A stake cannot exceed the fighter's **remaining daily budget** or its
  **bankroll**.
- The book's overround is reported: under 100% is flagged as an arbitrage
  (almost always a typo), over 125% as a very heavy margin.
- A whole-number line warns that it can push — settle those as VOID.
- An event with **pending** picks cannot be deleted from the board.

**An F1 bug fixed on the way:** the old event-code derivation took the first
two words, so "Monaco Grand Prix" and "Monza Grand Prix" both became `MONvsGRA`
— the second race would have been rejected as a duplicate of the first and
could never be logged. Single-name events now get a collision-proof code.
Two-sided fixtures (`A v B`, `A - B`) are byte-identical to before, so no
existing football `pick_id` changed.

## The two new admin pages

Both are behind the same server-side login as `/admin`, and both are linked
from a small strip in the bottom-left corner of the main console.

### `/admin/log` — manual pick logging

Replaces pasting text into the parser when you already know what you want to
log. A fighter dropdown, a board-reference selector, odds / stake /
probability, and a thesis box. Clicking **Log Pick** writes through
`/api/picks`, which validates server-side and returns the updated fighter, so
the budget bars move in the same response — no refetch, no stale number.

What the server enforces, in this order:

| Rule | Behaviour |
|---|---|
| Unknown fighter | rejected |
| Duplicate (same fighter + fixture + market + round) | rejected, names the `pick_id` |
| Stake over the remaining daily budget | rejected, names the remainder |
| Stake over the fighter's bankroll | rejected |
| Stake over 10% of bankroll | allowed, warned |
| Missing or trivial thesis | rejected — see below |
| Probability given as `55` instead of `0.55` | coerced, warned |
| Negative EV at the stated probability | allowed, warned |
| Round already settled | rejected, form disables itself |

The **Board reference** dropdown is populated from `/api/board`, which numbers
every outcome using the same traversal order the model prompt uses — so "ref
7" means the same thing in both places. Selecting one fills the fixture,
market, selection and odds. With no `ODDS_API_KEY`, the dropdown says so and
you type the fixture manually; logging still works.

Every pick extends the same **SHA-256 hash chain** the site already uses, with
a preimage byte-identical to the browser's implementation (verified against
the shipped bundle). Deleting a pending pick rebuilds the chain from that
point so it still verifies, and restores the budget.

### `/admin/prompts` — the five persona prompts

AXIOM (quant), LEDGER (sharp), FULCRUM (tactician), MERIDIAN (situational),
HERETIC (contrarian) — each leading with a different class of evidence and
forbidden from leading with another's. Copy button per persona, plus the
schema contract on its own.

The page is generated from `src/lib/personas.ts` at build time, so the prompts
here and the prompts in the repo cannot drift.

## Why the rationale drawer was empty

**Your site already has a rationale drawer.** The compiled bundle contains a
`role="dialog"` slide-in panel that typewriter-reveals the pick's rationale,
with focus management and ESC-to-close, plus an inline "📊 Quant breakdown"
expander on each bet card.

Both are gated on `bet.reasoning &&`. A pick logged without a thesis renders
as a card with no explanation and **no way to open one** — which reads as a
broken feature rather than a missing field.

So the fix is data, not UI:

- The logging form requires a thesis (minimum 20 characters) and the server
  refuses one without it.
- The thesis is written to **both** `reasoning` (what the bundle reads) and
  `core_thesis` (what the schema parser reads), so either path populates the
  drawer.
- `GET /api/picks` reports thesis coverage, and the console warns you on load
  if any existing picks have none — those are the cards showing no drawer on
  the live site right now.

## What changed in this folder

| Path | Change |
|---|---|
| `config.js` | **admin password removed.** Supabase anon key kept (public by design) |
| `admin/index.html`<br>`admin-terminal/index.html` | App script held back until the server confirms a session |
| `admin-gate.js` / `admin-gate.css` | The login screen. New |
| `api/_lib/auth.js` | scrypt hashing, HMAC sessions, one shared authoriser. New |
| `api/_lib/http.js` | CORS allowlist, bounded JSON parsing, fetch timeouts. New |
| `api/_lib/ratelimit.js` | Rate limiting + circuit breaker. New |
| `api/admin/login.js`<br>`api/admin/session.js` | Login, session check, logout. New |
| `api/arena.js` | **Replaced.** Cookie auth, ETag concurrency, real validation, backups |
| `api/settle.js`<br>`api/ingest.js`<br>`api/matches.js` | Timing-safe auth, accepts session cookie, CORS allowlist |
| `api/picks.js` | Manual logging: validate, append, recompute. New |
| `api/_lib/ledger.js` | Hash chain, budgets, fighter derivation. New |
| `api/_lib/store.js` | Concurrency-safe arena read/modify/write. New |
| `admin/log/`, `admin-log.js/.css` | The logging console. New |
| `admin/prompts/`, `admin-prompts.js`, `admin-personas.js` | Persona prompts. New |
| `api/_lib/routes/publicPicks.js` | Flat public pick feed, no auth. Served at `/api/public/picks` |
| `api/_lib/routes/diagnose.js` | Why the board is empty. Served at `/api/diagnose` |
| `api/_lib/routes/round.js` | Open / lock / advance the round. Served at `/api/round` |
| `api/_lib/routes/board.js` | Numbered board. Served at `/api/board` |
| `api/_lib/routes/events.js` | The match board CRUD. Served at `/api/events` |
| `api/_lib/sports.js` | Sport + market registry for all four sports |
| `admin/console/`, `admin-command.js/.css` | The two-column admin. New |
| `api/health.js` | Dependency probes, quota, breaker state. New |
| `api/telemetry.js` | Client error sink. New (needs a `client_errors` table — see the file) |
| `vercel.json` | HSTS, Permissions-Policy, no-store on `/admin`, CSP in **Report-Only** |

### About the Content-Security-Policy

It ships as `Content-Security-Policy-Report-Only`, so it **reports** violations
without blocking anything. That is deliberate — a strict CSP against a bundle
I could not fully exercise risks a white screen on your live site.

Watch the browser console for a week. When it is quiet, rename the header to
`Content-Security-Policy` in `vercel.json` to start enforcing. If you use a
custom domain, update the `connect-src` Supabase URL first.

---

## Known limitations — read these

**The admin gate is defence in depth, not the security boundary.** The real
boundary is the API: every privileged route verifies the signed cookie
server-side, and Supabase writes are governed by RLS. This gate stops the
console *rendering* for someone who has no business seeing it.

It does not make the admin UI unreachable — a determined visitor can still get
the SPA router to render `/admin` client-side from the home page. When they do,
every write they attempt fails at the server. The clean fix is to replace the
bundle's `isLocalUnlocked()` with the `useAdminSession` hook in the upgrade
bundle, which needs the React source.

**Pre-existing bug, not introduced here:** the home page throws React error
#418 (a hydration text mismatch) on load. Verified identical in your current
live bundle before any changes. It is almost certainly a time-dependent value
— a countdown or timestamp — rendered during SSR and again on the client.
Fixing it needs the source.

**Concurrency is guarded, not eliminated.** Vercel Blob has no
compare-and-swap, so `api/_lib/store.js` uses three mechanisms: an in-process
queue (removes interleaving on one instance), a pre-write ETag check (stops us
overwriting another instance), and a post-write read-back (detects another
instance overwriting us). Measured: 25 concurrent logs, 25 stored, no loss;
and a simulated cross-instance clobber is detected and retried. A tiny window
remains between the pre-write check and the put. For a paper-trading arena
that is a sound trade; a store with real CAS (Supabase row, Redis) is the
upgrade path if this ever guards real money.

**`/api/telemetry` needs a table.** Until you create `client_errors` (schema is
in the comment at the foot of `api/telemetry.js`), client errors are written to
the Vercel function log instead. Nothing breaks either way.

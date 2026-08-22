# AiFight v2 — source drop

Vite + React + Tailwind + Supabase. **No serverless functions, no `/api` directory,
no function-count limit.** The browser talks to Postgres directly; Row Level
Security is what enforces permissions.

---

## What is in here

```
index.html                     Vite entry
vite.config.js
tailwind.config.js             binds font-mono to JetBrains Mono
postcss.config.js
vercel.json                    SPA rewrite + security headers
.env.example
package.json

src/
  main.jsx                     React root
  App.jsx                      two-route switch (delete if you have a router)
  index.css                    fonts, obsidian base, focus rings, scrollbars
  lib/
    supabaseClient.js          the one client + error translation
    sports.js                  7 sports, 3 market shapes — the whole registry
    engine.js                  payout maths, bankrolls, ROI, Sharpe, drawdown
  hooks/
    useArena.js                one query + realtime, shared by both screens
  components/
    AdminPanel.jsx             THE unified admin (gate + board + dispatcher)
    Arena.jsx                  the public site

supabase/
  schema.sql                   tables, constraints, standings view, RLS, realtime

tests/
  engine.test.mjs              47 unit tests
  browser.smoke.mjs            49 checks against the real built bundle
```

---

## Deploy in five steps

**1. Run the schema.** Supabase dashboard → SQL Editor → New query → paste
`supabase/schema.sql` → Run. Idempotent; safe to re-run.

**2. Create your operator account.** Authentication → Users → Add user. Then
Authentication → Providers → Email → **turn off "Enable sign ups"**. Without that,
anyone can register themselves an account and the write policies will let them in.

**3. Copy these files into your repo**, replacing the old admin. Keep your own
`package.json` if you have one — just make sure `@supabase/supabase-js` is a
dependency.

**4. Set two environment variables in Vercel** (Settings → Environment Variables):

```
VITE_SUPABASE_URL       = https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY  = <the anon / public key>
```

Vite reads these **at build time**, so adding them to an existing deployment does
nothing until you redeploy.

**5. Push to GitHub.** Vercel builds it. Build command `npm run build`, output `dist`.

---

## The security model, in one paragraph

The anon key ships inside your JavaScript bundle. That is fine and intended — it
is an identity, not a permission. What it may actually *do* is decided entirely by
the RLS policies in `schema.sql`: `anon` may read `events` and `bets` and nothing
else; `authenticated` may write. That is why the admin gate is Supabase Auth and
not a password compared in React — an attacker never runs your component, they
call the REST endpoint directly. **Never** put `service_role` anywhere, and never
give a `VITE_` prefix to anything genuinely secret.

---

## Two decisions worth knowing about

**Bankrolls are derived, never stored.** There is no `fighters.bankroll` column.
`bankroll = 1000 + sum(profit)` over that fighter's settled bets, recomputed on
every render (sub-millisecond at this size). This is what makes grading freely
correctable: WIN → LOSS → VOID → WIN lands on exactly the number you would have
had by grading it right the first time, because nothing accumulated. A stored
bankroll would desynchronise on the first double-click, retried request, or row
edited by hand in the table editor — and afterwards nothing could tell you which
of the two numbers was right. Supabase still exposes the aggregates through the
`fighter_standings` **view**, which cannot drift from the table it reads.

**The database checks the money itself.** `bets_payout_check` refuses any row
where a WIN's payout isn't `stake × odds`, a LOSS pays anything, or a VOID
profits. So a bug in the client fails loudly on insert instead of quietly
corrupting a bankroll. (There is a one-cent tolerance, deliberately: Postgres
`numeric` is exact decimal and JavaScript `number` is binary floating point, and
they disagree on products landing exactly on a half-cent.)

---

## Verification that was actually run

- `npm run test` — **47/47** unit tests: payout maths, re-grading idempotence,
  liquidation, daily budget in `Europe/Sofia`, Sharpe sample floor, drawdown from
  running peak, validation, and every market of all seven sports.
- `node tests/browser.smoke.mjs` — **49/49** checks in real Chromium against the
  production bundle with Supabase stubbed: both screens render, seven sport tabs,
  odds matrix relabels when a line changes, F1 drops the away side, grading
  buttons preview the money, rationale drawer opens, zero runtime errors.
- `supabase/schema.sql` applied to a live PostgreSQL 16. The four bad-settlement
  inserts were all rejected by the constraint; `fighter_standings` was diffed
  field-by-field against `src/lib/engine.js` on the same dataset and **agreed on
  every field**.
- `vite build` — clean, 421 kB / 119 kB gzipped.

To re-run the browser test yourself: `npm run build && node tests/browser.smoke.mjs`.

---

## Routing

`App.jsx` switches on `window.location.pathname` — no router dependency, because
there are exactly two screens. **If your repo already has TanStack Router or
react-router, delete `App.jsx`** and mount the components in your existing routes:

```jsx
"/"      → <Arena />
"/admin" → <AdminPanel />
```

Either way `vercel.json` must rewrite unknown paths to `/index.html`, or a hard
refresh on `/admin` 404s from Vercel before React ever runs.

---

## Adding a sport later

Add one object to `SPORTS` in `src/lib/sports.js`. The sport tabs, the fixture
form, the odds matrix, the pick dropdowns and the public labels all read from it.
Nothing else changes.

# Put Prophit online (24/7) — plain-English guide

Goal: your backend runs on a server around the clock so clients hit a real web link, not your laptop. Two easy hosts below — pick one. Both read the config files already in this folder.

## Before you start
1. Make a **free GitHub account** (github.com) and put this `prophit-backend` folder in a repository.
   - Easiest way with zero terminal: install **GitHub Desktop**, drag this folder in, click "Publish repository."
2. Have your keys ready (you'll paste them into the host's dashboard, NOT into the code):
   - `THE_ODDS_API_KEY` (rotate the one you shared earlier first)
   - at least one model key: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY`

---

## Option A — Render (simplest, recommended)
1. Go to **render.com**, sign in with GitHub.
2. **New → Blueprint** → choose your `prophit-backend` repo. Render reads `render.yaml` automatically.
3. It shows the app + a 1GB disk (keeps your picks/history). Click **Apply**.
4. In the service's **Environment** tab, paste your secret keys (`THE_ODDS_API_KEY`, a model key…) and Save.
5. Wait for the build. You get a live URL like `https://prophit-backend.onrender.com`.
6. Test it: open `https://YOUR-URL/api/health` → should say `{"ok":true}`.

Cost: **Starter is ~$7/mo** and always-on. There's a Free tier to trial, but it "sleeps" when idle and wakes slowly — fine for testing, not for clients.

## Option B — Railway
1. Go to **railway.app**, sign in with GitHub.
2. **New Project → Deploy from GitHub repo** → pick `prophit-backend`. It uses `railway.json` + `Dockerfile`.
3. Open **Variables** and add your keys (`THE_ODDS_API_KEY`, model key, `ENABLED_SPORTS=soccer,tennis,nba`, `DB_PATH=/data/prophit.db`).
4. Add a **Volume** mounted at `/data` (Railway → your service → Volumes) so history persists.
5. Railway gives you a public URL. Test `…/api/health`.

Cost: usage-based, starts around **$5/mo**.

---

## After it's live
- The server auto-runs on a schedule: pulls odds, makes AI picks, and grades finished games — no action from you.
- See real picks: `https://YOUR-URL/api/picks`
- Point your website at it: in the web app's `src/config.js`, set `USE_BACKEND = true` and `API_BASE_URL = "https://YOUR-URL"`, then redeploy the site. The "DEMO" badge turns "LIVE".
- The leaderboard fills in as real games finish — that's expected.

## Watch your costs
- **The Odds API**: billed per request (regions × markets). Keep `ODDS_REGIONS` small (e.g. just `eu`) and the sport-key lists tight on the free tier.
- **Model APIs**: each prediction costs a little. Start with one model (Gemini has a free tier) and add others once it's working.
- The scheduler in `server.js` syncs every 6h and grades every 30m — you can slow these down to save quota.

## Security reminder
Never commit `.env` to GitHub (it's already in `.dockerignore` and should be in `.gitignore`). Keys live only in the host's dashboard.

# Prophit backend — real data engine

Pulls **real** fixtures + bookmaker odds (The Odds API — licensed, no scraping), asks each AI model for a pick on the same event data, stores every pick with confidence/reasoning/timestamp, grades against real results, and reports accuracy/ROI **only from settled picks**.

## The 6 pieces you asked for

1. **Real games + odds** → `src/providers/theoddsapi.js` (The Odds API). Legal, licensed. No OddsPortal/OddsChecker scraping (against their terms + fragile + a legal risk for a paid product).
2. **`/api/picks`** → every model's pick with confidence, reasoning, timestamp and result. Filters: `?sport=&model=&status=open|settled|all&limit=`.
3. **Model keys** → OpenAI, Anthropic, xAI, Google in `.env`. Any subset works; missing keys are skipped.
4. **Same prompt to each model** → `src/providers/models.js` builds one event prompt and sends it to every configured model.
5. **Storage** → `picks` table: `pick, confidence, price (odds at pick), reasoning, created_at (timestamp), correct (result)`.
6. **Accuracy/ROI from settled picks only** → the leaderboard query filters `correct IS NOT NULL`. **Empty on day one by design** — it fills as real games finish. No imported/fake track record (that would be indefensible for a paid, gambling-adjacent product).

## Setup (10 minutes to real data)

```bash
cp .env.example .env
# 1) THE_ODDS_API_KEY  → free, no card: https://the-odds-api.com
# 2) add at least one model key (ANTHROPIC_API_KEY / OPENAI_API_KEY / ...)
npm install
npm run sync       # pull real fixtures + odds
npm run predict    # each model makes real picks on upcoming games
npm start          # API on :3001 + cron (sync / predict / grade)
```

## Endpoints

- `GET /api/fixtures?sport=soccer` — fixtures with real odds + model picks
- `GET /api/picks?sport=&model=&status=settled` — the pick log (confidence, reasoning, timestamp, result)
- `GET /api/leaderboard?sport=&market=` — accuracy + ROI from settled picks (+ record, last-10 form)
- `GET /api/health`
- `POST /api/jobs/sync | predict | grade` — manual triggers (add auth before exposing publicly)

## How the real record builds (set client expectations here)

Day 1: leaderboard empty, picks show `result: "pending"`.
As matches finish, cron grades them → accuracy and ROI become real and grow.
There is **no** dataset of "AI model records" to import; your system earns it. Show clients "collecting picks — records appear as games settle" until you have a real sample.

## What's live vs. needs more

- **Live now:** soccer (1X2, O/U 2.5), tennis (winner, total games), NBA (winner, spread, total) — real odds, real results, real grading.
- **Seasonal:** darts/snooker — set `ODDS_DARTS` / `ODDS_SNOOKER` sport keys when a tournament is on (list: `https://api.the-odds-api.com/v4/sports?apiKey=YOURKEY`).
- **Player props (shots/tackles/fouls/cards/corners):** The Odds API's core plan is match markets. Player/team props need The Odds API event-level prop markets (higher tier) or API-Football (already scaffolded in `providers/apifootball.js`) for lineups + cards/corners. Wire that when you want props graded from real data.

## Quota

The Odds API bills per request = regions × markets. Keep `ODDS_REGIONS` and the sport-key lists tight on the free tier; widen as you upgrade.

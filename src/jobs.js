const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import "dotenv/config";
import { db, upsertFixture, upsertOdd, insertPick, setOutcome, gradePick, q } from "./db.js";
import { SPORTS, isRace } from "./sports.js";
import { adapterFor } from "./providers/index.js";
import { buildPrompt } from "./providers/models.js";
import { activeProviders } from "./providers/models.js";
import { settleH2H, settleRace, isPickCorrect } from "./settle.js";

// Per-sport feed config from env. Extend as you wire real feeds.
// Soccer uses API-Football leagues; other sports pass through whatever their adapter needs.
const SPORT_CFG = {
  soccer: { leagueId: (process.env.LEAGUE_IDS || "1").split(",")[0], season: process.env.SEASON || "2026" },
};
const ENABLED = (process.env.ENABLED_SPORTS || "soccer").split(",").map((s) => s.trim());

const norm = (f, sport) => ({
  id: String(f.id).startsWith(sport) ? String(f.id) : `${sport}:${f.id}`,
  sport,
  comp: f.comp ?? null,
  home: f.home ?? null,
  away: f.away ?? null,
  entrants: f.entrants ? JSON.stringify(f.entrants) : null,
  kickoff: f.kickoff ?? null,
  status: f.status ?? "upcoming",
  score: f.score ?? null,
  raw: f.raw ?? JSON.stringify(f),
});

// —— 1. Sync fixtures + odds across all enabled sports ——
export async function syncFixtures() {
  for (const sport of ENABLED) {
    const adapter = adapterFor(SPORTS[sport].provider);
    let fixtures = [];
    try { fixtures = await adapter.fetchFixtures({ sport, ...(SPORT_CFG[sport] || {}) }); }
    catch (e) { console.warn(`[sync:${sport}] fixtures failed: ${e.message}`); continue; }

    const normed = fixtures.map((f) => norm(f, sport));
    db.transaction(() => normed.forEach((f) => upsertFixture.run(f)))();
    console.log(`[sync:${sport}] ${normed.length} fixtures`);

    const soon = normed.filter((f) => f.status === "upcoming" && f.kickoff && new Date(f.kickoff) - Date.now() < 48 * 3600e3);
    for (const f of soon) {
      try {
        const odds = await adapter.fetchOdds({ id: f.id.split(":").slice(1).join(":") || f.id, raw: f.raw, sport });
        odds.forEach((o) => upsertOdd.run({ fixture_id: f.id, market: o.market, option: o.option, price: o.price }));
      } catch (e) { console.warn(`[sync:${sport}] odds failed ${f.id}: ${e.message}`); }
    }
  }
}

// —— 2. Generate AI picks ——
export async function generatePicks() {
  const providers = activeProviders();
  if (!providers.length) { console.warn("[predict] no AI provider keys set"); return; }
  const deadModels = new Set();   // models with no quota this run → skip after first failure

  for (const f of q.upcoming.all()) {
    const dt = f.kickoff ? new Date(f.kickoff) - Date.now() : 0;
    // Predict games within PREDICT_WINDOW_HOURS of kickoff (default 72h).
    // Manual uploads (id starts "manual:") are always eligible.
    const windowMs = (Number(process.env.PREDICT_WINDOW_HOURS) || 72) * 3600e3;
    const isManual = String(f.id).startsWith("manual:");
    if (!isManual && (!f.kickoff || dt <= 0 || dt > windowMs)) continue;

    const odds = q.oddsFor.all(f.id);
    const priceOf = (market, pick) =>
      odds.find((o) => o.market === market && o.option.toLowerCase().includes(String(pick).toLowerCase()))?.price ?? null;
    // markets to predict = sport defaults ∪ any markets present in this fixture's odds (uploaded)
    const sportMarkets = SPORTS[f.sport]?.markets || [];
    const oddsMarkets = [...new Set(odds.map((o) => o.market))];
    const markets = [...new Set([...sportMarkets, ...oddsMarkets])];
    const prompt = buildPrompt(f, odds, markets);

    for (const provider of providers) {
      if (deadModels.has(provider.id)) continue;   // quota:0 → skip entirely
      if (q.hasPicks.get(f.id, provider.id).n > 0) continue;
      const gap = Number(process.env.PREDICT_GAP_MS) || 2500;
      let attempt = 0, done = false;
      while (attempt < 4 && !done) {
        try {
          const picks = await provider.call(prompt);
          for (const [market, p] of Object.entries(picks)) {
            if (!p?.pick) continue;
            const price = priceOf(market, p.pick);
            const implied = price ? 100 / price : null;                 // bookmaker's implied %
            const probability = p.probability ?? null;                   // Claude's true %
            const edge = (probability != null && implied != null) ? +(probability - implied).toFixed(1) : null;
            insertPick.run({
              fixture_id: f.id, model: provider.id, market,
              pick: String(p.pick), confidence: p.confidence ?? probability ?? null,
              price, reasoning: p.why ?? null, probability, edge,
            });
          }
          const values = Object.values(picks).filter((p) => p && p.probability != null).length;
          console.log(`[predict:${f.sport}] ${provider.id} → ${f.comp}`);
          done = true;
        } catch (e) {
          // Dead free tier (limit: 0 / quota exceeded with 0 allowance) → drop for whole run.
          if (/limit:\s*0|quota.*exceeded/i.test(e.message) && attempt === 0) {
            console.warn(`[predict] ${provider.id} has no quota — skipping it for this run.`);
            deadModels.add(provider.id);
            done = true;
          } else if (/429|rate limit/i.test(e.message) && attempt < 3) {
            const wait = 8000 * (attempt + 1);
            console.warn(`[predict] ${provider.id} rate-limited, waiting ${wait / 1000}s…`);
            await sleep(wait);
            attempt++;
          } else {
            console.warn(`[predict] ${provider.id} failed ${f.id}: ${e.message}`);
            done = true;
          }
        }
      }
      if (!deadModels.has(provider.id)) await sleep(gap);
    }
  }
}

// —— 3. Grade finished events ——
export async function gradeFinished() {
  await syncFixtures(); // refresh statuses
  for (const f of q.finishedUngraded.all()) {
    const adapter = adapterFor(SPORTS[f.sport].provider);
    let result;
    try { result = await adapter.fetchResult({ id: f.id.split(":").slice(1).join(":") || f.id, raw: f.raw, home: f.home, away: f.away, sport: f.sport }); }
    catch (e) { console.warn(`[grade] result failed ${f.id}: ${e.message}`); continue; }
    if (!result) continue;

    const outcomes = isRace(f.sport)
      ? settleRace(result.order)
      : settleH2H(f.sport, { ...result, home: f.home, away: f.away });

    Object.entries(outcomes).forEach(([market, outcome]) =>
      setOutcome.run({ fixture_id: f.id, market, outcome: JSON.stringify(outcome) }));

    for (const p of q.picksFor.all(f.id)) {
      const correct = isPickCorrect(p.market, p.pick, outcomes[p.market]);
      if (correct != null) gradePick.run({ correct, fixture_id: f.id, model: p.model, market: p.market });
    }
    console.log(`[grade:${f.sport}] settled ${f.comp}`);
  }
}

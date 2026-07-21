const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import "dotenv/config";
import { db, upsertFixture, upsertOdd, insertPick, setOutcome, gradePick, markFinal, q } from "./db.js";
import { SPORTS, isRace } from "./sports.js";
import { adapterFor } from "./providers/index.js";
import { buildPrompt } from "./providers/models.js";
import { activeProviders } from "./providers/models.js";
import { settleH2H, settleRace, isPickCorrect } from "./settle.js";
import { isBadName } from "./uploads.js";

// Per-sport feed config from env. Extend as you wire real feeds.
// Soccer uses API-Football leagues; other sports pass through whatever their adapter needs.
const SPORT_CFG = {
  soccer: { leagueId: (process.env.LEAGUE_IDS || "1").split(",")[0], season: process.env.SEASON || "2026" },
};
const ENABLED = (process.env.ENABLED_SPORTS || "soccer")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
{
  const unknown = ENABLED.filter((k) => !SPORTS[k]);
  if (unknown.length) console.warn(`[config] ENABLED_SPORTS lists unknown sport(s): ${unknown.join(", ")} — known keys: ${Object.keys(SPORTS).join(", ")}`);
}

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
  // Odds API removed — ORAKL is upload-driven. This is a no-op kept for compatibility.
  return { synced: 0, source: "manual-upload" };
}

// —— 2. Generate AI picks ——
export function backfillEdges() {
  const rows = db.prepare(`SELECT p.rowid rid, p.fixture_id, p.market, p.pick, p.probability
    FROM picks p WHERE p.edge IS NULL AND p.probability IS NOT NULL`).all();
  let fixed = 0;
  for (const r of rows) {
    const odds = q.oddsFor.all(r.fixture_id);
    const b = String(r.pick).toLowerCase().trim();
    const hit = odds.find((o) => o.market === r.market &&
      (o.option.toLowerCase().trim().includes(b) || b.includes(o.option.toLowerCase().trim())));
    if (!hit) continue;
    const edge = +(r.probability - 100 / hit.price).toFixed(1);
    db.prepare(`UPDATE picks SET price=?, edge=? WHERE rowid=?`).run(hit.price, edge, r.rid);
    fixed++;
  }
  if (fixed) console.log(`[edges] backfilled ${fixed} picks`);
}

export async function generatePicks() {
  backfillEdges();
  const providers = activeProviders();
  if (!providers.length) { console.warn("[predict] no AI provider keys set"); return; }
  const deadModels = new Set();   // models with no quota this run → skip after first failure

  for (const f of q.upcoming.all()) {
    const dt = f.kickoff ? new Date(f.kickoff) - Date.now() : 0;
    // Predict games within PREDICT_WINDOW_HOURS of kickoff (default 72h).
    // Manual uploads (id starts "manual:") are always eligible.
    const windowMs = (Number(process.env.PREDICT_WINDOW_HOURS) || 168) * 3600e3;
    const isManual = String(f.id).startsWith("manual:");
    if (!isManual && (!f.kickoff || dt <= 0 || dt > windowMs)) continue;
    // Never spend a model call on garbage or on a game that has already been played.
    // (Manual uploads used to be exempt from the time check — that is how finished
    //  games kept getting re-priced and kept showing on the feed.)
    if (isBadName(f.home) || (f.away && isBadName(f.away))) continue;
    if (!f.kickoff || dt < -(Number(process.env.PREDICT_GRACE_HOURS) || 2) * 3600e3) continue;

    const odds = q.oddsFor.all(f.id);
    // Resolve a model pick to a stored price. Handles the label drift between
    // sources and the model: "away" ↔ the away team's name ↔ "2", "Under" ↔ "under 2.5".
    const aliases = (pick) => {
      const b = String(pick).toLowerCase().trim();
      const h = String(f.home || "").toLowerCase().trim(), a = String(f.away || "").toLowerCase().trim();
      const out = new Set([b]);
      if (b === "home" || (h && b === h)) { out.add("home"); out.add("1"); if (h) out.add(h); }
      if (b === "away" || (a && b === a)) { out.add("away"); out.add("2"); if (a) out.add(a); }
      if (b === "draw" || b === "x" || b === "tie") { out.add("draw"); out.add("x"); out.add("tie"); }
      return [...out];
    };
    const priceOf = (market, pick) => {
      const cands = aliases(pick);
      const pool = odds.filter((o) => o.market === market);
      for (const c of cands) {                          // exact label first
        const hit = pool.find((o) => o.option.toLowerCase().trim() === c);
        if (hit) return hit.price;
      }
      const b = String(pick).toLowerCase().trim();
      const loose = pool.find((o) => {                  // then substring ("Under" ↔ "under 2.5")
        const a = o.option.toLowerCase().trim();
        return a.includes(b) || b.includes(a);
      });
      return loose ? loose.price : null;
    };
    // markets to predict = sport defaults ∪ any markets present in this fixture's odds (uploaded)
    const sportMarkets = SPORTS[f.sport]?.markets || [];
    const oddsMarkets = [...new Set(odds.map((o) => o.market))];
    // manual uploads: only predict markets that have real uploaded odds (a pick with no
    // price has no edge — pointless for value hunting). API fixtures keep sport defaults.
    const markets = isManual && oddsMarkets.length ? oddsMarkets : [...new Set([...sportMarkets, ...oddsMarkets])];
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

// —— 3b. Auto-settle MANUAL games by matching team names to the scores feed ——
const nrm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, "");
// grade a pick from the final score (score-derivable markets only)
export function correctFromScore(market, pick, hs, as, home, away) {
  const p = String(pick).toLowerCase().trim();
  const total = hs + as;
  const num = (p.match(/-?\d+(\.\d+)?/) || [])[0];
  if (market === "x12" || market === "htr" && false) {
    const w = hs > as ? "home" : hs < as ? "away" : "draw";
    if (["home", "draw", "away"].includes(p)) return p === w ? 1 : 0;
    return nrm(p) === nrm(hs > as ? home : hs < as ? away : "draw") ? 1 : 0;
  }
  if (market === "ml") {
    if (hs === as) return null;
    const winner = hs > as ? home : away;
    return (nrm(p) === nrm(winner) || p === (hs > as ? "home" : "away")) ? 1 : 0;
  }
  if (market === "btts") return (p.startsWith("y") ? (hs > 0 && as > 0) : !(hs > 0 && as > 0)) ? 1 : 0;
  if (market === "cs") return p.replace(/\s/g, "") === `${hs}-${as}` ? 1 : 0;
  if (/corner|card|shot|foul|tackle|180|checkout|ace|frame|break/.test(market)) return null; // needs its own stat
  // HANDICAP / SPREAD — derivable from the scoreline once the line is applied.
  // "home -1.5" / "Lakers +6.5" / "away -2": the pick names a side and a margin.
  if (/spread|hcp|handicap|^ah$|line/.test(market) && num != null) {
    const line = parseFloat(num);
    const backedHome = p.startsWith("home") || nrm(p).startsWith(nrm(home));
    const backedAway = p.startsWith("away") || nrm(p).startsWith(nrm(away));
    if (!backedHome && !backedAway) return null;
    const margin = backedHome ? (hs - as) : (as - hs);
    const adj = margin + line;                       // line is signed in the pick text
    if (adj === 0) return null;                      // exact push — void, not a loss
    return adj > 0 ? 1 : 0;
  }
  if (/ou|total|goals|points/.test(market) && num != null && /over|under/.test(p)) {
    const line = parseFloat(num);
    if (total === line) return null;                       // push
    return (p.includes("over") ? total > line : total < line) ? 1 : 0;
  }
  return null;                                              // exotic markets need a results upload
}

export async function settleManualFromScores() {
  const pending = q.manualPending.all().filter((f) => {
    const t = new Date(String(f.kickoff).replace(" ", "T")).getTime();
    return !Number.isNaN(t) && t < Date.now() - 2.5 * 3600e3;   // safely finished
  });
  if (!pending.length) return;
  const bySport = {};
  pending.forEach((f) => (bySport[f.sport] = bySport[f.sport] || []).push(f));
  for (const sport of Object.keys(bySport)) {
    let list = [];
    continue; // API removed — settle via type-the-score panel / results CSV
    if (!list.length) continue;
    const map = {};
    list.forEach((m) => { map[nrm(m.home) + "|" + nrm(m.away)] = m; map[nrm(m.away) + "|" + nrm(m.home)] = { ...m, flip: true }; });
    for (const f of bySport[sport]) {
      const hit = map[nrm(f.home) + "|" + nrm(f.away)];
      if (!hit) continue;
      const hs = hit.flip ? hit.as : hit.hs, as = hit.flip ? hit.hs : hit.as;
      if (hs == null || as == null) continue;
      markFinal.run({ id: f.id, score: `${hs}-${as}` });
      let graded = 0;
      for (const pk of q.picksFor.all(f.id)) {
        const c = correctFromScore(pk.market, pk.pick, hs, as, f.home, f.away);
        if (c != null) { gradePick.run({ correct: c, fixture_id: f.id, model: pk.model, market: pk.market }); graded++;
          // compounding: settle any pending mission bet on this exact market/pick
          const run = q.cmpActiveRun.get();
          if (run) for (const cb of q.cmpPendingForFixture.all({ fid: f.id })) {
            if (cb.market === pk.market) { const { settleCompoundingBet } = await import("./compounding.js"); settleCompoundingBet(cb.id, c ? "win" : "loss", run); }
          }
        }
      }
      console.log(`[settle] ${f.home} ${hs}-${as} ${f.away} → graded ${graded} picks`);
    }
  }
}

// —— 3. Grade finished events ——
// —— CLV capture ————————————————————————————————————————
// At kick-off the last price we hold IS the closing line. Snapshot it once per
// pick so accuracy can be measured against the market, not just against results.
export function snapshotClosingLines() {
  const pending = q.picksNeedingClose.all();
  let n = 0;
  for (const p of pending) {
    const odds = q.oddsFor.all(p.fixture_id).filter((o) => o.market === p.market);
    if (!odds.length) continue;
    const b = String(p.pick).toLowerCase().trim();
    const h = String(p.home || "").toLowerCase().trim(), a = String(p.away || "").toLowerCase().trim();
    const want = new Set([b]);
    if (b === "home" || (h && b === h)) { want.add("home"); want.add("1"); if (h) want.add(h); }
    if (b === "away" || (a && b === a)) { want.add("away"); want.add("2"); if (a) want.add(a); }
    if (b === "draw" || b === "x") { want.add("draw"); want.add("x"); }
    let hit = odds.find((o) => want.has(o.option.toLowerCase().trim()));
    if (!hit) hit = odds.find((o) => { const x = o.option.toLowerCase().trim(); return x.includes(b) || b.includes(x); });
    if (!hit || !(hit.price > 1)) continue;
    q.setClosing.run({ closing: hit.price, fixture_id: p.fixture_id, model: p.model, market: p.market });
    n++;
  }
  if (n) console.log(`[clv] captured ${n} closing lines`);
  return n;
}

export async function gradeFinished() {
  snapshotClosingLines();                  // must happen before results overwrite anything
  // 1) results feed (if a key is configured) settles finished games by name match
  try {
    const { autoSettle, resultsFeedStatus } = await import("./results.js");
    if (resultsFeedStatus().enabled) {
      const r = await autoSettle({});
      console.log(`[grade] auto-settle: ${r.settled} games, ${r.graded} picks graded` + (r.unmatchedCount ? `, ${r.unmatchedCount} unmatched` : ""));
    }
  } catch (e) { console.warn("[grade] auto-settle failed:", e.message); }
  await settleManualFromScores();          // manual games settle themselves by score
  await syncFixtures(); // refresh statuses
  for (const f of q.finishedUngraded.all()) {
    const cfg = SPORTS[f.sport];
    if (!cfg) { continue; }                 // uploaded sport with no config → settled by score/admin, not a feed
    const adapter = adapterFor(cfg.provider);
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

// —— STAT-BASED SETTLEMENT ————————————————————————————————
// Markets that the scoreline can never decide: corners, cards, shots, darts 180s,
// snooker frames, tennis aces. Each needs its own final number, typed at settle time.
// STAT_FOR maps a market id to the stat key the admin panel asks for.
export const STAT_FOR = (market) => {
  const m = String(market || "").toLowerCase();
  if (/corner/.test(m)) return "corners";
  if (/card|booking/.test(m)) return "cards";
  if (/180/.test(m)) return "s180s";
  if (/checkout/.test(m)) return "checkout";
  if (/ace/.test(m)) return "aces";
  if (/frame/.test(m)) return "frames";
  if (/shot/.test(m)) return "shots";
  if (/foul/.test(m)) return "fouls";
  if (/tackle/.test(m)) return "tackles";
  if (/break/.test(m)) return "breaks";
  return null;
};
export const STAT_LABEL = {
  corners: "total corners", cards: "total cards", s180s: "total 180s",
  checkout: "highest checkout", aces: "total aces", frames: "total frames",
  shots: "total shots", fouls: "total fouls", tackles: "total tackles", breaks: "total breaks",
};

export function correctFromStat(market, pick, value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const v = Number(value);
  const p = String(pick).toLowerCase().trim();
  const num = (p.match(/-?\d+(\.\d+)?/) || [])[0];
  if (num == null || !/over|under/.test(p)) return null;
  const line = parseFloat(num);
  if (v === line) return null;                       // push
  return (p.includes("over") ? v > line : v < line) ? 1 : 0;
}

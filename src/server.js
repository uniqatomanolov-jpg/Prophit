import 'dotenv/config';
import express from "express";
import cron from "node-cron";
import { q, db, markFinal, GradePick } from "./db.js";
import { syncFixtures, generatePicks, gradeFinished, correctFromScore } from "./jobs.js";
import { parseScreenshot } from "./vision.js";
import { settleCompoundingBet } from "./compounding.js";
import { createCheckout, handleWebhook, billingEnabled, isPro } from "./billing.js";
import { ingestEvents, ingestResults } from "./uploads.js";

let predictBusy = false;
function predictSoon() {
   
  if (predictBusy) return;
  predictBusy = true;
  generatePicks().catch((e) => console.error("[auto-predict]", e.message)).finally(() => { predictBusy = false; });
}


const app = express();
// Stripe webhook needs the raw body for signature verification — mount BEFORE json parser.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try { const r = await handleWebhook(req.body, req.get("stripe-signature")); res.json(r); }
  catch (e) { console.error("[stripe webhook]", e.message); res.status(400).json({ error: e.message }); }
});
app.use(express.json({ limit: "12mb" }));
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// —— API for the React frontend ——————————————————
app.get("/api/fixtures", (req, res) => {
  const base = req.query.sport ? q.fixturesBySport.all({ sport: req.query.sport }) : q.fixturesAll.all();
  const fixtures = base.map((f) => ({
    ...f,
    entrants: f.entrants ? JSON.parse(f.entrants) : null,
    odds: q.oddsFor.all(f.id),
    picks: q.picksFor.all(f.id),
  }));
  res.json(fixtures);
});

app.get("/api/leaderboard", (req, res) => {
  const sport = req.query.sport || "all";
  const rows = q.leaderboard.all({ sport, market: req.query.market || "all" });
  // build last-10 form per model (market-agnostic, most recent first)
  const form = {};
  for (const r of q.recentResults.all({ sport })) {
    (form[r.model] ||= []);
    if (form[r.model].length < 10) form[r.model].push(r.correct ? "W" : "L");
  }
  res.json(rows.map((r) => ({
    ...r,
    record: `${r.wins}\u2013${r.total - r.wins}`,
    form: form[r.model] || [],
  })));
});

// —— /api/picks — each model's pick, confidence, reasoning, timestamp, and result ——
// query params: sport, model, status (all|open|settled), limit
app.get("/api/picks", (req, res) => {
  const rows = q.picksList.all({
    sport: req.query.sport || "all",
    model: req.query.model || "all",
    status: req.query.status || "all",
    limit: Math.min(Number(req.query.limit) || 200, 1000),
  });
  res.json(rows.map((r) => ({
    fixtureId: r.fixture_id,
    sport: r.sport,
    event: `${r.home} vs ${r.away}`,
    competition: r.comp,
    kickoff: r.kickoff,
    fixtureStatus: r.status,
    score: r.score,
    model: r.model,
    market: r.market,
    pick: r.pick,
    confidence: r.confidence,
    oddsAtPick: r.price,
    reasoning: r.reasoning,
    predictedAt: r.created_at,
    outcome: r.outcome,                                   // null until settled
    result: r.correct == null ? "pending" : r.correct ? "win" : "loss",
  })));
});

app.get("/api/billing/status", (_, res) => res.json({ enabled: billingEnabled() }));

app.post("/api/stripe/create-checkout-session", async (req, res) => {
  try {
    if (!billingEnabled()) return res.status(503).json({ error: "billing not configured yet" });
    const url = await createCheckout({ plan: req.body?.plan || "monthly", email: req.body?.email });
    res.json({ url });
  } catch (e) { console.error("[checkout]", e.message); res.status(400).json({ error: e.message }); }
});

app.get("/api/health", (_, res) => res.json({ ok: true }));

// External-cron endpoint: wakes the server and runs the full cycle.
// Point a free pinger (e.g. cron-job.org) at GET /api/cron every few hours.
let cronBusy = false;
app.get("/api/cron", async (_, res) => {
  if (cronBusy) return res.json({ ok: true, running: true });
  cronBusy = true;
  res.json({ ok: true, started: true });   // reply immediately; work continues
  try {
    await syncFixtures();
    await generatePicks();
    await gradeFinished();
    console.log("[cron] cycle complete");
  } catch (e) { console.error("[cron]", e.message); }
  finally { cronBusy = false; }
});

// Claude's real track record vs the bookies: headline stats, P&L curve, receipts.
app.get("/api/track", (req, res) => {
  const sport = req.query.sport || "all";
  const s = q.claudeStats.get({ sport }) || {};
  const history = q.claudeHistory.all({ sport });      // newest first
  // build a running profit curve in chronological order
  const chrono = history.slice().reverse();
  let run = 0;
  const curve = chrono.map((h) => {
    run += h.correct ? (Number(h.price || 1.9) - 1) : -1;
    return Math.round(run * 100) / 100;
  });
  res.json({
    settled: s.total || 0,
    wins: s.wins || 0,
    losses: (s.total || 0) - (s.wins || 0),
    accuracy: s.accuracy ?? null,
    roi: s.roi ?? null,
    profitUnits: s.profit ?? 0,          // profit in flat 1-unit stakes
    avgEdge: s.avg_edge ?? null,
    curve,                                // running units over time
    receipts: history.map((h) => ({
      sport: h.sport, event: `${h.home} v ${h.away}`, competition: h.comp,
      kickoff: h.kickoff, score: h.score, market: h.market, pick: h.pick,
      odds: h.price, edge: h.edge, result: h.correct ? "win" : "loss",
    })),
  });
});

// distinct markets present (for the per-market leaderboard selector)
app.get("/api/sports", (_, res) => {
  res.json(q.distinctSports.all().map((r) => r.sport));
});

app.get("/api/markets", (req, res) => {
  res.json(q.distinctMarkets.all({ sport: req.query.sport || "all" }).map((r) => r.market));
});

// per-market leaderboard breakdown in one call: { market: rows[] }
app.get("/api/leaderboard/breakdown", (req, res) => {
  const sport = req.query.sport || "all";
  const markets = ["all", ...q.distinctMarkets.all({ sport }).map((r) => r.market)];
  const out = {};
  for (const m of markets) out[m] = q.leaderboard.all({ sport, market: m });
  res.json(out);
});

// —— CSV upload (admin-only when ADMIN_KEY is set in the environment) ——
const requireAdmin = (req, res, next) => {
  const key = process.env.ADMIN_KEY;
  if (key && req.get("x-admin-key") !== key) return res.status(401).json({ error: "invalid admin key" });
  next();
};

// ===== MISSION: €100 → €1,000,000 compounding challenge =====
const KELLY_MULT = Number(process.env.KELLY_MULT) || 0.25;   // quarter-Kelly
function kellyStake(bankroll, odds, fairOdds) {
  const b = odds - 1;
  const p = fairOdds > 0 ? 1 / fairOdds : 0;
  if (b <= 0 || p <= 0) return 0;
  let f = KELLY_MULT * (p - (1 - p) / b);
  f = Math.max(0, Math.min(0.25, f));                        // never risk >25% on one bet
  return Math.round(bankroll * f * 100) / 100;
}
const MILESTONES = [100, 1000, 10000, 100000, 1000000];
function runView(run) {
  if (!run) return null;
  const bets = q.cmpBets.all({ run: run.id });
  let lvl = 0;
  for (let i = 0; i < MILESTONES.length - 1; i++) if (run.current_bankroll >= MILESTONES[i]) lvl = i;
  return { ...run, level: lvl + 1, nextTarget: MILESTONES[Math.min(lvl + 1, MILESTONES.length - 1)],
    levelFloor: MILESTONES[lvl], bets };
}

app.get("/api/compounding/run/active", (_, res) => res.json(runView(q.cmpActiveRun.get()) || { none: true }));

app.post("/api/compounding/run", requireAdmin, (req, res) => {
  q.cmpArchiveAll.run();
  const bank = Number(req.body?.starting_bankroll) || 100;
  const name = req.body?.name || "Run to a Million";
  q.cmpNewRun.run({ name, bank });
  res.json(runView(q.cmpActiveRun.get()));
});

app.post("/api/compounding/bet", requireAdmin, (req, res) => {
  const run = q.cmpActiveRun.get();
  if (!run) return res.status(400).json({ error: "no active run — start one first" });
  const { fixture_id, market, option, odds, fairOdds } = req.body || {};
  if (!fixture_id || !market || !option || !odds) return res.status(400).json({ error: "need fixture_id, market, option, odds" });
  let stake = Number(req.body?.stake);
  if (!stake || stake <= 0) stake = kellyStake(run.current_bankroll, Number(odds), Number(fairOdds) || Number(odds));
  stake = Math.min(stake, run.current_bankroll);
  q.cmpAddBet.run({ run: run.id, fid: fixture_id, market, option, odds: Number(odds), stake });
  res.json(runView(q.cmpActiveRun.get()));
});

app.post("/api/compounding/settle", requireAdmin, (req, res) => {
  const { id, result } = req.body || {};   // result: 'win' | 'loss'
  const run = q.cmpActiveRun.get();
  if (!run || !id) return res.status(400).json({ error: "no run / id" });
  settleCompoundingBet(Number(id), result, run);
  res.json(runView(q.cmpActiveRun.get()));
});


// POST the CSV text with Content-Type: text/csv
// finished-but-unsettled games (for the manual settle panel)
app.get("/api/unsettled", requireAdmin, (_, res) => res.json(q.unsettledPast.all()));

// Admin: delete one fixture (and its picks/odds) — for junk rows or long-finished games
app.post("/api/fixture/delete", requireAdmin, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "need id" });
  db.prepare("DELETE FROM picks WHERE fixture_id=?").run(id);
  db.prepare("DELETE FROM odds WHERE fixture_id=?").run(id);
  const r = db.prepare("DELETE FROM fixtures WHERE id=?").run(id);
  res.json({ ok: true, deleted: r.changes });
});

// Admin: clear ALL past-dated unsettled manual games (junk/finished leftovers). Deletes their picks.
app.post("/api/clear-finished", requireAdmin, (_, res) => {
  const rows = q.unsettledPast.all();
  let n = 0;
  for (const f of rows) {
    db.prepare("DELETE FROM picks WHERE fixture_id=?").run(f.id);
    db.prepare("DELETE FROM odds WHERE fixture_id=?").run(f.id);
    n += db.prepare("DELETE FROM fixtures WHERE id=?").run(f.id).changes;
  }
  console.log(`[clear-finished] deleted ${n} games`);
  res.json({ ok: true, deleted: n });
});

// One-click rescue: any manual game whose (guessed) kickoff slipped into the past but was never
// settled gets bumped to the next evening slot → back on the Live Feed, out of the settle queue.
app.post("/api/fix-dates", requireAdmin, (_, res) => {
  const now = new Date();
  let slot = new Date(now.toISOString().slice(0, 10) + "T20:00:00");
  if (slot.getTime() < now.getTime() + 30 * 60e3) slot = new Date(slot.getTime() + 24 * 3600e3);
  const k = slot.toISOString().slice(0, 10) + " 20:00";
  const r = db.prepare(`
    UPDATE fixtures SET kickoff=@k, status='upcoming'
    WHERE id LIKE 'manual:%' AND status='upcoming' AND kickoff IS NOT NULL
      AND datetime(replace(kickoff,' ','T')) < datetime('now')
  `).run({ k });
  console.log(`[fix-dates] moved ${r.changes} games to ${k}`);
  res.json({ ok: true, moved: r.changes, kickoff: k });
});

// settle one game by typing the final score — grades every score-derivable pick
app.post("/api/settle", requireAdmin, (req, res) => {
  try {
    const { id, hs, as } = req.body || {};
    const H = Number(hs), A = Number(as);
    if (!id || Number.isNaN(H) || Number.isNaN(A)) return res.status(400).json({ error: "need id, hs, as" });
    const f = q.fixtureById ? q.fixtureById.get(id) : db.prepare("SELECT * FROM fixtures WHERE id=?").get(id);
    if (!f) return res.status(404).json({ error: "fixture not found" });
    markFinal.run({ id, score: `${H}-${A}` });
    let graded = 0, skipped = 0;
    for (const pk of q.picksFor.all(id)) {
      const c = correctFromScore(pk.market, pk.pick, H, A, f.home, f.away);
      if (c != null) { gradePick.run({ correct: c, fixture_id: id, model: pk.model, market: pk.market }); graded++; }
      else skipped++;
    }
    res.json({ ok: true, score: `${H}-${A}`, graded, skipped });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/upload-screenshot", requireAdmin, async (req, res) => {
  try {
    let { image, mediaType } = req.body || {};
    if (!image) return res.status(400).json({ error: "no image" });
    const m = String(image).match(/^data:(image\/\w+);base64,(.*)$/);
    if (m) { mediaType = m[1]; image = m[2]; }
    const out = await parseScreenshot(image, mediaType || "image/png");
    res.json(out);
    if (out.fixtures > 0) { console.log("[screenshot] auto-predicting…"); predictSoon(); }
  } catch (e) { console.error("[screenshot]", e.message); res.status(400).json({ error: e.message }); }
});

app.post("/api/upload/events", requireAdmin, (req, res) => {
  try {
    const result = ingestEvents(req.body || "");
    res.json(result);
    if (result.fixtures > 0) { console.log("[upload] auto-predicting new events…"); predictSoon(); }
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/upload/results", requireAdmin, (req, res) => {
  try { res.json(ingestResults(req.body || "")); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// manual job triggers (protect these behind auth before going public)
app.post("/api/jobs/sync", async (_, res) => { await syncFixtures(); res.json({ ok: true }); });
app.post("/api/jobs/predict", async (_, res) => { await generatePicks(); res.json({ ok: true }); });
app.post("/api/jobs/grade", async (_, res) => { await gradeFinished(); res.json({ ok: true }); });

// —— schedule ————————————————————————————————————
cron.schedule("0 */6 * * *", () => syncFixtures().catch(console.error));   // fixtures+odds 4×/day
cron.schedule("30 */6 * * *", () => generatePicks().catch(console.error)); // picks after each sync
cron.schedule("*/30 * * * *", () => gradeFinished().catch(console.error)); // grade every 30 min

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Prophit backend on :${port}`));

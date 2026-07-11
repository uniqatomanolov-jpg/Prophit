import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { q } from "./db.js";
import { syncFixtures, generatePicks, gradeFinished } from "./jobs.js";
import { ingestEvents, ingestResults } from "./uploads.js";

const app = express();
app.use(express.json());
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
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

app.get("/api/health", (_, res) => res.json({ ok: true }));

// distinct markets present (for the per-market leaderboard selector)
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

// —— CSV upload: add your own events/odds/markets from a daily spreadsheet ——
// POST the CSV text with Content-Type: text/csv
app.post("/api/upload/events", (req, res) => {
  try { res.json(ingestEvents(req.body || "")); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/upload/results", (req, res) => {
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

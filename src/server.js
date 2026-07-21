import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { q, db, markFinal, gradePick } from "./db.js";
import { syncFixtures, generatePicks, gradeFinished, correctFromScore, correctFromStat, STAT_FOR, STAT_LABEL } from "./jobs.js";
import { parseScreenshot } from "./vision.js";
import { settleCompoundingBet } from "./compounding.js";
import { createCheckout, handleWebhook, billingEnabled, isPro, emailForSession } from "./billing.js";
let predictBusy = false;
function predictSoon() {
  if (predictBusy) return;
  predictBusy = true;
  generatePicks().catch((e) => console.error("[auto-predict]", e.message)).finally(() => { predictBusy = false; });
}
import { ingestEvents, ingestResults, isBadName, parseCSV, mergeDuplicateFixtures, canonSport } from "./uploads.js";

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

// Admin gate — defined HIGH so every route below can use it (do not move down).
const requireAdmin = (req, res, next) => {
  const key = process.env.ADMIN_KEY;
  if (key && req.get("x-admin-key") !== key) return res.status(401).json({ error: "invalid admin key" });
  next();
};

// —— REAL access control for locked/Pro content ——————————————————
// Previously, "locked" picks were only hidden by the frontend's own render
// logic while the API sent full pick data (option + reasoning) to every
// caller regardless of subscription — trivially bypassable via devtools or
// by calling /api/fixtures directly. This resolves the caller's real tier
// server-side so locked data never leaves the server in the first place.
function callerAccess(req) {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.get("x-admin-key") === adminKey) return { admin: true, pro: true };
  const email = req.get("x-user-email");
  if (email && isPro(email)) return { admin: false, pro: true };
  return { admin: false, pro: false };
}
// Mirrors the frontend's own thresholds (FREE picks/sport + 4-star "max-bet"
// lock) so free users see exactly the same teaser, but the underlying
// option/reasoning never reaches an unauthenticated client.
const FREE_PER_SPORT = 2;
function unitsForEdge(edge) {
  if (edge == null || edge <= 0) return 0;
  if (edge >= 40) return 10; if (edge >= 25) return 9; if (edge >= 15) return 8;
  if (edge >= 10) return 6; if (edge >= 5) return 4; if (edge >= 2) return 2;
  return 1;
}
const starsForEdge = (edge) => Math.min(5, Math.ceil(unitsForEdge(edge) / 2));
// Redact a single pick row down to what a locked/free viewer is allowed to see.
function redactPick(p, unlocked) {
  if (unlocked) return p;
  const claude = p.model === "claude";
  const maxBet = claude && starsForEdge(p.edge) >= 4;
  if (!maxBet) return p; // below max-bet threshold: shown even to free/locked viewers
  const { pick, reasoning, ...rest } = p;
  return { ...rest, locked: true };
}
// Apply free-quota + redaction across a sport's fixture list, same order the
// frontend renders in (status!=="final" fixtures count toward the FREE quota).
function applyAccessGate(fixtures, access) {
  if (access.pro || access.admin) return fixtures;
  const bySport = {};
  for (const f of fixtures) (bySport[f.sport] ||= []).push(f);
  const out = [];
  for (const sport of Object.keys(bySport)) {
    let freeLeft = FREE_PER_SPORT;
    for (const f of bySport[sport]) {
      const countsTowardFree = f.status !== "final";
      const unlockedFixture = !countsTowardFree || freeLeft > 0;
      if (countsTowardFree && unlockedFixture) freeLeft--;
      out.push({ ...f, picks: (f.picks || []).map((p) => redactPick(p, unlockedFixture)) });
    }
  }
  return out;
}

// —— API for the React frontend ——————————————————
// —— FEED HYGIENE ————————————————————————————————————
// Two rules the public feed must never break:
//   1. no fixture without real competitor names (parse junk)
//   2. no fixture whose kickoff is long past (finished games must not linger)
// Stale games stay in the DB and in /api/unsettled so admin can still settle them.
const STALE_HOURS = Number(process.env.FEED_STALE_HOURS) || 8;
const koMs = (k) => { if (!k) return null; const t = Date.parse(String(k).replace(" ", "T")); return Number.isNaN(t) ? null : t; };
function feedReject(f) {
  if (isBadName(f.home)) return "no-name";
  if (f.away && isBadName(f.away)) return "no-name";
  const ko = koMs(f.kickoff);
  if (ko == null) return "no-date";                                  // unschedulable → never show
  if (f.status !== "final" && ko < Date.now() - STALE_HOURS * 3600e3) return "stale";
  return null;
}

// Value Board feed — biggest edges across EVERY sport, not just whatever
// happened to fit in the fixture list. Junk rows are filtered the same way.
app.get("/api/value", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const rows = q.valuePicks.all({ limit: limit * 3 }).filter((r) => !feedReject({ ...r, status: "upcoming" }));
  const access = callerAccess(req);
  const seen = new Set(), out = [];
  for (const r of rows) {                        // one entry per fixture — its best market
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const row = { id: r.id, sport: r.sport, comp: r.comp, home: r.home, away: r.away, kickoff: r.kickoff,
               market: r.market, pick: r.pick, edge: r.edge, probability: r.probability, price: r.price,
               closing: r.closing_price ?? null,
               clv: (r.price > 1 && r.closing_price > 1) ? Math.round((r.price / r.closing_price - 1) * 1000) / 10 : null,
               reasoning: r.reasoning || null };
    out.push(redactPick({ ...row, model: "claude" }, access.pro || access.admin));
    if (out.length >= limit) break;
  }
  res.json(out);
});

app.get("/api/fixtures", (req, res) => {
  const base = req.query.sport ? q.fixturesBySport.all({ sport: req.query.sport }) : q.fixturesAll.all();
  const clean = base.filter((f) => !feedReject(f));
  const fixtures = clean.map((f) => ({
    ...f,
    entrants: f.entrants ? JSON.parse(f.entrants) : null,
    odds: q.oddsFor.all(f.id),
    picks: q.picksFor.all(f.id),
  }));
  res.json(applyAccessGate(fixtures, callerAccess(req)));
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

// Called by the frontend right after Stripe redirects back with ?session_id=...
// Confirms payment actually completed and returns the paying email so the
// client can persist it (and send it as x-user-email on future requests).
// This is what makes Pro survive a page refresh instead of resetting.
app.get("/api/stripe/session", async (req, res) => {
  try {
    const email = await emailForSession(req.query.session_id);
    if (!email) return res.status(400).json({ error: "session not found or not paid" });
    res.json({ email, pro: isPro(email) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// High-selectivity auto-pick: scan every priced game, take the single best QUALIFYING edge.
// Sits out entirely when nothing clears the bar — no forced daily bet.
const MISSION_MIN_EDGE = Number(process.env.MISSION_MIN_EDGE) || 4;    // %
const MISSION_MAX_ODDS = Number(process.env.MISSION_MAX_ODDS) || 3.5;  // survival: no longshots
app.post("/api/compounding/auto", requireAdmin, (req, res) => {
  const run = q.cmpActiveRun.get();
  if (!run) return res.status(400).json({ error: "no active run" });
  const already = q.cmpBets.all({ run: run.id }).some((b) => b.status === "pending");
  if (already) return res.json({ ...runView(run), note: "a mission bet is already live" });

  const now = Date.now();
  let best = null;
  for (const f of q.fixturesAll.all()) {
    if (f.status === "final") continue;
    const ko = f.kickoff ? Date.parse(String(f.kickoff).replace(" ", "T")) : null;
    if (ko != null && ko < now) continue;                       // future games only
    const odds = q.oddsFor.all(f.id);
    for (const p of q.picksFor.all(f.id)) {
      if (p.model !== "claude" || !p.pick || p.edge == null) continue;
      if (p.edge < MISSION_MIN_EDGE) continue;
      const o = odds.find((x) => x.market === p.market &&
        String(x.option).toLowerCase() === String(p.pick).toLowerCase());
      const price = o ? o.price : p.price;
      if (!price || price > MISSION_MAX_ODDS) continue;          // no longshots
      // rank: highest edge, tie-break on shorter (safer) price
      if (!best || p.edge > best.edge || (p.edge === best.edge && price < best.price))
        best = { fixture_id: f.id, market: p.market, option: p.pick, odds: price,
                 edge: p.edge, prob: p.probability, event: `${f.home} v ${f.away}` };
    }
  }
  if (!best) return res.json({ ...runView(run), none: true,
    reason: `no edge \u2265 ${MISSION_MIN_EDGE}% at odds \u2264 ${MISSION_MAX_ODDS} today \u2014 sitting out` });

  const fair = best.prob > 0 ? 100 / best.prob : best.odds;
  let stake = kellyStake(run.current_bankroll, best.odds, fair);
  if (stake <= 0) stake = Math.round(run.current_bankroll * 0.02 * 100) / 100;
  stake = Math.min(stake, run.current_bankroll);
  q.cmpAddBet.run({ run: run.id, fid: best.fixture_id, market: best.market,
    option: best.option, odds: best.odds, stake });
  console.log(`[mission] auto-picked ${best.event} ${best.option} @${best.odds} (edge ${best.edge}%) stake \u20ac${stake}`);
  res.json({ ...runView(q.cmpActiveRun.get()), picked: { ...best, stake } });
});

app.get("/api/health", (_, res) => res.json({ ok: true }));

// —— BUILD IDENTITY ————————————————————————————————————
// The page checks this on load. If the deployed backend is older than the page,
// features that call routes it doesn't have would 404 with no explanation —
// instead the UI reads these flags and says exactly what's missing.
const BUILD = "2026-07-19b";   // bump on every deploy so /api/version proves which code is live
const CAPABILITIES = ["mission-auto", "auto-settle", "purge-junk", "reset", "showdown-bulk", "feed-hygiene", "value-board", "undated-uploads", "schema-migrations", "dedupe", "reclassify", "settle-stats"];
app.get("/api/version", (_, res) => res.json({ build: BUILD, capabilities: CAPABILITIES, resetOnBoot: process.env.RESET_ON_BOOT || null }));

// External-cron endpoint: wakes the server and runs the full cycle.
// Point a free pinger (e.g. cron-job.org) at GET /api/cron every few hours.
let cronBusy = false;
app.get("/api/cron", async (_, res) => {
  if (cronBusy) return res.json({ ok: true, running: true });
  cronBusy = true;
  res.json({ ok: true, started: true });   // reply immediately; work continues
  try {
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
      closing: h.closing_price ?? null,
      // CLV: how much better than the closing line the pick was taken at
      clv: (h.price > 1 && h.closing_price > 1) ? Math.round((h.price / h.closing_price - 1) * 1000) / 10 : null,
      why: h.reasoning || null,
    })),
    bySport: (sport === "all") ? q.bySport.all() : [],
    clv: (() => { const c = q.clvStats.get({ sport }) || {};
      return { n: c.n || 0, avg: c.n ? Math.round(c.avg_clv * 10) / 10 : null,
               beatRate: c.n ? Math.round((c.beat / c.n) * 1000) / 10 : null }; })(),
    updatedAt: new Date().toISOString(),
  });
});

// distinct markets present (for the per-market leaderboard selector)
// Global headline stats for the hero row — deliberately NOT scoped to any
// single sport, so it doesn't read "0 games priced" just because whichever
// sport tab happens to be selected/default has no fixtures yet.
app.get("/api/stats/hero", (_, res) => {
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT f.id) AS games_priced,
      SUM(CASE WHEN p.model='claude' AND p.edge IS NOT NULL AND p.edge > 0 THEN 1 ELSE 0 END) AS value_edges,
      MAX(CASE WHEN p.model='claude' THEN p.edge END) AS best_edge
    FROM fixtures f
    JOIN picks p ON p.fixture_id = f.id
    WHERE f.status != 'final' AND p.model='claude' AND p.pick IS NOT NULL
  `).get();
  res.json({
    gamesPriced: row.games_priced || 0,
    valueEdges: row.value_edges || 0,
    bestEdge: row.best_edge ?? null,
  });
});

app.get("/api/sports", (_, res) => {
  const seen = new Set();
  for (const r of q.distinctSports.all()) seen.add(canonSport(r.sport));
  res.json([...seen]);
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


// ===== AI SHOWDOWN: 4 models, €100 each, manage their own bankroll =====
function showdownView() {
  const models = q.sdModels.all();
  const bets = q.sdBets.all();
  const byModel = {};
  for (const m of models) byModel[m.id] = { ...m, profit: Math.round((m.current_bankroll - m.starting_bankroll) * 100) / 100,
    wins: 0, losses: 0, pending: 0, bets: [] };
  for (const b of bets) { const mv = byModel[b.model_id]; if (!mv) continue; mv.bets.push(b);
    if (b.result === "win") mv.wins++; else if (b.result === "loss") mv.losses++; else mv.pending++; }
  const leaderboard = Object.values(byModel).sort((a, b) => b.current_bankroll - a.current_bankroll);
  return { leaderboard, rounds: q.sdRounds.all(), bets };
}

app.get("/api/showdown", (_, res) => res.json(showdownView()));

app.post("/api/showdown/round", requireAdmin, (req, res) => {
  q.sdNewRound.run({ label: req.body?.label || ("Round " + new Date().toISOString().slice(0, 10)) });
  res.json(showdownView());
});

// A model's live exposure: everything already staked on pending bets. Without this
// four €100 bets could all be logged against one €100 bankroll.
function exposureOf(modelId) {
  return q.sdBets.all().filter((b) => b.model_id === modelId && b.result === "pending")
    .reduce((a, b) => a + Number(b.stake || 0), 0);
}
function freeBankroll(m) { return Math.round((m.current_bankroll - exposureOf(m.id)) * 100) / 100; }

app.post("/api/showdown/bet", requireAdmin, (req, res) => {
  const { model, event, market, pick, odds, stake, reasoning, round_id } = req.body || {};
  const m = q.sdModelByName.get({ name: model });
  if (!m) return res.status(400).json({ error: "unknown model: " + model });
  if (!event || !market || !pick || !odds || !stake) return res.status(400).json({ error: "need event, market, pick, odds, stake" });
  const free = freeBankroll(m);
  if (Number(stake) > free) return res.status(400).json({ error: `${model} has €${free} unstaked (bankroll €${m.current_bankroll}, €${exposureOf(m.id)} already live)` });
  let round = round_id;
  if (!round) { const rs = q.sdRounds.all(); round = rs.length ? rs[0].id : (q.sdNewRound.run({ label: "Round 1" }), q.sdRounds.all()[0].id); }
  q.sdAddBet.run({ model_id: m.id, round_id: round, event, market, pick, odds: Number(odds), stake: Number(stake), reasoning: reasoning || null });
  res.json(showdownView());
});

// Bulk-log a whole round in one paste. Accepts either
//   { bets: [ {model,event,market,pick,odds,stake,reasoning}, ... ] }
//   { text: "Claude | Spain v Argentina | x12 | draw | 3.40 | 20 | reasoning…" }   (one per line)
//   { text: "model,event,market,pick,odds,stake,reasoning\n..." }                   (CSV with header)
// Every row is validated independently: good rows are logged, bad rows come back
// with the reason, so one typo never silently drops a model's whole round.
function parseBulkBets(body) {
  if (Array.isArray(body?.bets)) return body.bets.map((b, i) => ({ ...b, _line: i + 1 }));
  const text = String(body?.text || "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const first = lines[0].toLowerCase();
  if (/\bmodel\b/.test(first) && /\bpick\b/.test(first)) {
    const rows = parseCSV(text);
    return rows.map((r, i) => ({ model: r.model, event: r.event, market: r.market, pick: r.pick,
      odds: r.odds, stake: r.stake, reasoning: r.reasoning || r.why || "", _line: i + 2 }));
  }
  return lines.map((l, i) => {
    const parts = l.includes("|") ? l.split("|") : l.split(/\t/);
    const [model, event, market, pick, odds, stake, ...rest] = parts.map((x) => String(x).trim());
    return { model, event, market, pick, odds, stake, reasoning: rest.join(" | ").trim(), _line: i + 1 };
  });
}

app.post("/api/showdown/bulk", requireAdmin, (req, res) => {
  let rows;
  try { rows = parseBulkBets(req.body || {}); }
  catch (e) { return res.status(400).json({ error: "could not parse: " + e.message }); }
  if (!rows.length) return res.status(400).json({ error: "nothing to log" });

  let round = req.body?.round_id;
  if (!round) { const rs = q.sdRounds.all(); round = rs.length ? rs[0].id : (q.sdNewRound.run({ label: "Round " + new Date().toISOString().slice(0, 10) }), q.sdRounds.all()[0].id); }

  const added = [], rejected = [];
  const spent = {};                                   // running exposure inside this paste
  for (const r of rows) {
    const name = String(r.model || "").trim();
    const m = q.sdModelByName.get({ name }) ||
              q.sdModels.all().find((x) => x.name.toLowerCase() === name.toLowerCase());
    const fail = (why) => rejected.push({ line: r._line, row: `${r.model} · ${r.event} · ${r.pick}`, reason: why });
    if (!m) { fail(`unknown model "${r.model}" (use Grok / ChatGPT / Gemini / Claude)`); continue; }
    if (!r.event || !r.market || !r.pick) { fail("need event, market and pick"); continue; }
    const odds = Number(String(r.odds).replace(",", "."));
    const stake = Number(String(r.stake).replace(",", "."));
    if (!(odds >= 1.01)) { fail(`odds "${r.odds}" invalid`); continue; }
    if (!(stake > 0)) { fail(`stake "${r.stake}" invalid`); continue; }
    const used = spent[m.id] || 0;
    const free = Math.round((freeBankroll(m) - used) * 100) / 100;
    if (stake > free) { fail(`${m.name} only has €${free} unstaked left`); continue; }
    q.sdAddBet.run({ model_id: m.id, round_id: round, event: String(r.event).trim(), market: String(r.market).trim(),
      pick: String(r.pick).trim(), odds, stake, reasoning: r.reasoning || null });
    spent[m.id] = used + stake;
    added.push({ model: m.name, event: r.event, market: r.market, pick: r.pick, odds, stake });
  }
  console.log(`[showdown bulk] added ${added.length}, rejected ${rejected.length}`);
  res.json({ ...showdownView(), added: added.length, addedRows: added, rejected });
});

app.post("/api/showdown/settle", requireAdmin, (req, res) => {
  const { id, result } = req.body || {};   // settle ONE bet: win | loss | void
  const b = q.sdBetById.get({ id: Number(id) });
  if (!b || b.result !== "pending") return res.status(400).json({ error: "bet not pending" });
  const m = q.sdModels.all().find((x) => x.id === b.model_id);
  let bank = m.current_bankroll;
  if (result === "win") bank += b.stake * (b.odds - 1);
  else if (result === "loss") bank -= b.stake;
  // void = stake returned, no change
  q.sdSetBank.run({ id: m.id, bank: Math.round(bank * 100) / 100 });
  q.sdSetBet.run({ id: b.id, result });
  res.json(showdownView());
});

app.post("/api/showdown/reset", requireAdmin, (_, res) => {
  db.prepare("DELETE FROM showdown_bets").run();
  db.prepare("DELETE FROM showdown_rounds").run();
  q.sdResetAll.run();
  res.json(showdownView());
});



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
app.get("/api/unsettled", requireAdmin, async (_, res) => {
  const { STAT_FOR, STAT_LABEL } = await import("./jobs.js");
  const rows = q.unsettledPast.all().map((f) => {
    // every ungraded pick on this fixture, with the market/line so the admin can
    // see what is actually being settled — and which need a number of their own.
    const picks = q.picksFor.all(f.id)
      .filter((p) => p.correct == null)
      .map((p) => {
        const stat = STAT_FOR(p.market);
        return { market: p.market, pick: p.pick, price: p.price, edge: p.edge,
                 stat, statLabel: stat ? STAT_LABEL[stat] : null };
      });
    const needs = [...new Set(picks.map((p) => p.stat).filter(Boolean))]
      .map((k) => ({ key: k, label: STAT_LABEL[k] }));
    return { ...f, picks, needs };
  });
  res.json(rows);
});

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

// Admin: fold duplicate fixtures (same teams, same day, different spelling) into one.
// Admin: clean up legacy rows — misfiled outrights and duplicate sport keys.
app.post("/api/reclassify", requireAdmin, (_, res) => {
  try { res.json({ ok: true, ...reclassifyFixtures() }); }
  catch (e) { console.error("[reclassify]", e.message); res.status(400).json({ error: e.message }); }
});

app.post("/api/dedupe", requireAdmin, (_, res) => {
  try { res.json({ ok: true, ...mergeDuplicateFixtures() }); }
  catch (e) { console.error("[dedupe]", e.message); res.status(400).json({ error: e.message }); }
});

// Admin: purge parse-junk already in the DB — fixtures whose "names" are prices,
// market labels or league headers, plus anything with an unusable kickoff.
app.post("/api/purge-junk", requireAdmin, (_, res) => {
  const all = db.prepare("SELECT id, home, away, kickoff, status FROM fixtures").all();
  const junk = all.filter((f) => {
    if (isBadName(f.home)) return true;
    if (f.away && isBadName(f.away)) return true;
    return koMs(f.kickoff) == null;                 // "Invalid Date" rows
  });
  let n = 0;
  for (const f of junk) {
    db.prepare("DELETE FROM picks WHERE fixture_id=?").run(f.id);
    db.prepare("DELETE FROM odds WHERE fixture_id=?").run(f.id);
    n += db.prepare("DELETE FROM fixtures WHERE id=?").run(f.id).changes;
  }
  console.log(`[purge-junk] deleted ${n} junk fixtures`);
  res.json({ ok: true, deleted: n, examples: junk.slice(0, 5).map((f) => `${f.home} v ${f.away} (${f.kickoff})`) });
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

// —— AUTO-SETTLE ————————————————————————————————————————
// Pulls final scores from the configured results feed and grades everything it
// can match. Safe to call repeatedly; already-final games are skipped.
app.get("/api/settle/status", async (_, res) => {
  const { resultsFeedStatus } = await import("./results.js");
  res.json(resultsFeedStatus());
});
app.post("/api/settle/auto", requireAdmin, async (req, res) => {
  try {
    const { autoSettle } = await import("./results.js");
    res.json(await autoSettle({ daysFrom: Math.min(3, Number(req.body?.daysFrom) || 3), dryRun: !!req.body?.dryRun }));
  } catch (e) { console.error("[auto-settle]", e.message); res.status(400).json({ error: e.message }); }
});

// —— DATA RESET ————————————————————————————————————————
// scope: "record"   → wipe picks + outcomes (track record starts clean, fixtures stay)
//        "fixtures" → wipe fixtures + odds + picks + outcomes (feed starts clean)
//        "all"      → everything above plus mission + showdown bets
export function wipeData(scope) {
  const wiped = {};
  const del = (sql, label) => { wiped[label] = db.prepare(sql).run().changes; };
  db.transaction(() => {
    del("DELETE FROM picks", "picks");
    del("DELETE FROM outcomes", "outcomes");
    if (scope === "fixtures" || scope === "all") {
      del("DELETE FROM odds", "odds");
      del("DELETE FROM fixtures", "fixtures");
    }
    if (scope === "all") {
      del("DELETE FROM compounding_bets", "missionBets");
      del("DELETE FROM showdown_bets", "showdownBets");
      db.prepare("UPDATE compounding_runs SET current_bankroll=starting_bankroll, peak_bankroll=starting_bankroll").run();
      q.sdResetAll.run();
    }
  })();
  console.log(`[reset] scope=${scope}`, wiped);
  return wiped;
}

app.post("/api/reset", requireAdmin, (req, res) => {
  const scope = String(req.body?.scope || "");
  if (!["record", "fixtures", "all"].includes(scope)) return res.status(400).json({ error: 'scope must be record | fixtures | all' });
  res.json({ ok: true, scope, wiped: wipeData(scope) });
});

// settle one game by typing the final score — grades every score-derivable pick
app.post("/api/settle", requireAdmin, (req, res) => {
  try {
    const { id, hs, as, stats } = req.body || {};
    const H = Number(hs), A = Number(as);
    if (!id || Number.isNaN(H) || Number.isNaN(A)) return res.status(400).json({ error: "need id, hs, as" });
    const f = q.fixtureById ? q.fixtureById.get(id) : db.prepare("SELECT * FROM fixtures WHERE id=?").get(id);
    if (!f) return res.status(404).json({ error: "fixture not found" });
    markFinal.run({ id, score: `${H}-${A}` });
    let graded = 0, pushed = 0;
    const pending = [];
    for (const pk of q.picksFor.all(id)) {
      let c = correctFromScore(pk.market, pk.pick, H, A, f.home, f.away);
      if (c == null) {
        // market the scoreline can't decide — use the number typed for it, if given
        const key = STAT_FOR(pk.market);
        if (key && stats && stats[key] != null && stats[key] !== "") c = correctFromStat(pk.market, pk.pick, stats[key]);
      }
      if (c != null) { gradePick.run({ correct: c, fixture_id: id, model: pk.model, market: pk.market }); graded++; }
      else if (STAT_FOR(pk.market)) pending.push(`${pk.market} (needs ${STAT_LABEL[STAT_FOR(pk.market)]})`);
      else pushed++;
    }
    res.json({ ok: true, score: `${H}-${A}`, graded, pushed, pending });
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
app.post("/api/jobs/sync", async (_, res) => { res.json({ ok: true, note: "upload-driven; no external sync" }); });
app.post("/api/jobs/predict", async (_, res) => { await generatePicks(); res.json({ ok: true }); });
app.post("/api/jobs/grade", async (_, res) => { await gradeFinished(); res.json({ ok: true }); });

// —— schedule ————————————————————————————————————
cron.schedule("30 */6 * * *", () => generatePicks().catch(console.error)); // picks after each sync
cron.schedule("*/30 * * * *", () => gradeFinished().catch(console.error)); // grade every 30 min

const port = process.env.PORT || 3001;
// FRESH START ON DEPLOY
// Set RESET_ON_BOOT=record|fixtures|all in the host env and redeploy: the wipe runs
// before the server accepts traffic. This is the way to clear data on a host whose
// deployed build is too old to expose /api/reset — the same deploy that ships the
// new code also clears the record.
// REMOVE THE VAR AFTERWARDS or every future deploy wipes again (the UI warns you).
const RESET_ON_BOOT = String(process.env.RESET_ON_BOOT || "").trim();
if (RESET_ON_BOOT) {
  if (["record", "fixtures", "all"].includes(RESET_ON_BOOT)) {
    console.log(`[boot] RESET_ON_BOOT=${RESET_ON_BOOT} — wiping before startup`);
    console.log("[boot] wiped:", wipeData(RESET_ON_BOOT));
    console.log("[boot] \u26a0 remove RESET_ON_BOOT from your env now, or the next deploy wipes again");
  } else {
    console.warn(`[boot] RESET_ON_BOOT="${RESET_ON_BOOT}" is not one of record|fixtures|all — ignoring`);
  }
}

app.listen(port, () => console.log(`Prophit backend on :${port}`));

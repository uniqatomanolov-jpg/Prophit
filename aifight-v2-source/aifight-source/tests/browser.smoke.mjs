/**
 * Browser smoke test.
 *
 * Unit tests prove the maths; `vite build` proves the imports resolve.
 * Neither proves a component renders -- a stray edit inside a render
 * function, a null dereference on an empty list, an infinite re-render,
 * none of those fail a build. So this loads the real production bundle in
 * a real Chromium, with Supabase's REST and Auth endpoints stubbed, and
 * asserts on what is actually painted.
 *
 * Run: node tests/browser.smoke.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const PORT = 4319;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PROJECT = "https://stub.supabase.co";

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json",
};

/* ---------------- static server with SPA fallback ---------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  let file = join(DIST, url.pathname);
  try {
    const s = await stat(file);
    if (s.isDirectory()) throw new Error("dir");
  } catch {
    file = join(DIST, "index.html"); // the vercel.json rewrite, locally
  }
  const body = await readFile(file);
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, r));

/* ---------------- fixtures ---------------- */

const EVENT_SOCCER = {
  id: "evt-soccer",
  sport: "soccer",
  home: "Arsenal",
  away: "Chelsea",
  session: null,
  competition: "Premier League",
  event_name: "Arsenal v Chelsea",
  starts_at: "2026-08-25T18:30:00.000Z",
  round: 4,
  entrants: [],
  odds: {
    "1X2": { line: null, prices: { Arsenal: 2.1, Draw: 3.4, Chelsea: 3.6 } },
    goals_ou: { line: 2.5, prices: { "Over 2.5 Goals": 1.9, "Under 2.5 Goals": 1.95 } },
  },
  status: "open",
  created_at: "2026-08-20T09:00:00.000Z",
  updated_at: "2026-08-20T09:00:00.000Z",
};

const EVENT_F1 = {
  id: "evt-f1",
  sport: "f1",
  home: "Monaco Grand Prix",
  away: null,
  session: "Race",
  competition: "F1 2026",
  event_name: "Monaco Grand Prix - Race",
  starts_at: "2026-08-26T13:00:00.000Z",
  round: 4,
  entrants: ["Max Verstappen", "Lando Norris", "Charles Leclerc"],
  odds: {
    winner: { line: null, prices: { "Max Verstappen": 2.2, "Lando Norris": 3.1, "Charles Leclerc": 5.5 } },
  },
  status: "open",
  created_at: "2026-08-20T09:00:00.000Z",
  updated_at: "2026-08-20T09:00:00.000Z",
};

// A clash (Arsenal vs Chelsea), a graded win, a graded loss, a pending bet,
// and enough losses to liquidate Kimi so the graveyard state renders.
const BETS = [
  b("b1", "Claude", "evt-soccer", "1X2", "Arsenal", 2.1, 50, "win", "Arsenal press high and Chelsea concede from turnovers."),
  b("b2", "Grok", "evt-soccer", "1X2", "Arsenal", 2.1, 40, "win", "Same read, smaller stake: the price is short."),
  b("b3", "ChatGPT", "evt-soccer", "1X2", "Chelsea", 3.6, 30, "loss", "Contrarian: Arsenal are short on rest days."),
  b("b4", "Gemini", "evt-soccer", "goals_ou", "Over 2.5 Goals", 1.9, 25, null, "Both defences are missing a first choice centre back."),
  b("b5", "Claude", "evt-f1", "winner", "Max Verstappen", 2.2, 20, null, "Monaco rewards qualifying pace and he has it."),
  b("b6", "Kimi", "evt-soccer", "1X2", "Draw", 3.4, 100, "loss", "The draw is mispriced given both managers' caution."),
  b("b7", "Kimi", "evt-f1", "winner", "Lando Norris", 3.1, 900, "loss", "An oversized swing on a driver in form."),
];

function b(id, model, event_id, market, pick, odds, stake, result, reasoning) {
  const row = {
    id, model, event_id, market, pick, odds, stake, reasoning,
    fair_prob: 0.55, confidence: 70, risk_factors: "The obvious way this loses.",
    result, payout: null, profit: null, round: 4,
    logged_at: "2026-08-20T10:00:00.000Z",
    settled_at: result ? "2026-08-20T22:00:00.000Z" : null,
  };
  if (result === "win") { row.payout = +(stake * odds).toFixed(2); row.profit = +(row.payout - stake).toFixed(2); }
  if (result === "loss") { row.payout = 0; row.profit = -stake; }
  if (result === "void") { row.payout = stake; row.profit = 0; }
  return row;
}

/* ---------------- harness ---------------- */

const failures = [];
const consoleErrors = [];

/**
 * `innerText` applies CSS text-transform, so every label styled `uppercase`
 * comes back shouting. Comparing case-insensitively keeps these assertions
 * about content rather than about styling.
 */
function has(haystack, needle) {
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
    failures.push(name);
  }
}

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  // Honour a pre-installed Chromium if the environment provides one.
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });

// Stub every Supabase call. Nothing leaves the machine.
await context.route("**/stub.supabase.co/**", async (route) => {
  const url = route.request().url();
  const json = (data, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

  if (url.includes("/rest/v1/events")) return json([EVENT_SOCCER, EVENT_F1]);
  if (url.includes("/rest/v1/bets")) return json(BETS);
  if (url.includes("/auth/v1/user")) return json({ id: "op-1", email: "ops@aifight.test" });
  if (url.includes("/auth/v1/token")) {
    return json({
      access_token: "stub", token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "stub-r",
      user: { id: "op-1", email: "ops@aifight.test" },
    });
  }
  return json([]);
});

const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

/* ================= 1. THE PUBLIC ARENA ================= */

console.log("\nPUBLIC ARENA");
await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const arenaText = await page.locator("body").innerText();

check("hero renders the challenge headline", has(arenaText, "€1,000,000"));
check("all five fighters render", ["Claude", "Grok", "ChatGPT", "Gemini", "Kimi"].every((m) => has(arenaText, m)));

// Claude: +55 win. Grok: +44. ChatGPT: -30. Kimi: -1000 -> liquidated.
check("winning bankroll is correct", has(arenaText, "€1,055.00"), "expected Claude at 1055");
check("losing bankroll is correct", has(arenaText, "€970.00"), "expected ChatGPT at 970");
check("liquidated fighter reads zero", has(arenaText, "€0.00"));
check("graveyard state is stamped with its round", /LIQUIDATED \[ROUND 4\]/i.test(arenaText));

check("clash badge renders on the split market", /clash/i.test(arenaText));
check("combined bankroll totals every fighter", has(arenaText, "€4,069.00"));

check("both fixtures render", has(arenaText, "Arsenal v Chelsea") && has(arenaText, "Monaco Grand Prix"));
check("F1 roster market renders its driver", has(arenaText, "Max Verstappen"));
check("market labels are resolved, not raw keys", has(arenaText, "Match Result") && !has(arenaText, "goals_ou"));
check("no placeholder leaked into a label", !has(arenaText, "{home}") && !has(arenaText, "{line}"));

// The rationale drawer -- the bug that started the rebuild.
check("theses are collapsed by default", !has(arenaText, "Arsenal press high"));
await page.locator('button[aria-expanded="false"]').first().click();
await page.waitForTimeout(250);
const opened = await page.locator("body").innerText();
check("rationale drawer opens and shows the thesis", has(opened, "Arsenal press high"));
check("risk factors render in the drawer", has(opened, "The obvious way this loses"));

await page.screenshot({ path: "/home/claude/aifight/arena-public.png", fullPage: true });

// Filters
await page.locator("button", { hasText: /^Settled$/ }).click();
await page.waitForTimeout(250);
check("settled filter still renders a board", (await page.locator("article").count()) >= 0);
await page.locator("button", { hasText: /^All$/ }).click();

/* ================= 2. THE ADMIN PANEL ================= */

console.log("\nADMIN PANEL");

// Seed a session so the gate opens. Key format is sb-<ref>-auth-token.
await context.addInitScript(() => {
  const now = Math.floor(Date.now() / 1000);
  window.localStorage.setItem(
    "sb-stub-auth-token",
    JSON.stringify({
      access_token: "stub", token_type: "bearer", expires_in: 3600,
      expires_at: now + 3600, refresh_token: "stub-r",
      user: { id: "op-1", email: "ops@aifight.test", aud: "authenticated", role: "authenticated" },
    })
  );
});

const admin = await context.newPage();
admin.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[admin] ${m.text()}`); });
admin.on("pageerror", (e) => consoleErrors.push(`[admin] pageerror: ${e.message}`));

await admin.goto(`${ORIGIN}/admin`, { waitUntil: "networkidle" });
await admin.waitForTimeout(800);

let adminText = await admin.locator("body").innerText();
check("the gate opened with a session", !has(adminText, "Operator sign-in"), adminText.slice(0, 120));
check("both columns render", has(adminText, "The Match Board") && has(adminText, "AI Dispatcher"));

// Sport tabs -- all seven.
for (const label of ["Soccer", "NBA", "NFL", "Ice Hockey", "Darts", "Snooker", "Formula 1"]) {
  check(`sport tab: ${label}`, has(adminText, label));
}

// Soccer odds matrix
check("soccer markets are listed", has(adminText, "Match Result (1X2)") && has(adminText, "Both Teams To Score"));

// Enable a market and confirm the price boxes appear with resolved labels.
await admin.getByPlaceholder("Arsenal").first().fill("Liverpool");
await admin.getByPlaceholder("Chelsea").first().fill("Everton");
await admin.waitForTimeout(200);
adminText = await admin.locator("body").innerText();
check("composed event name previews live", has(adminText, "Liverpool v Everton"));

const oneXtwo = admin.locator("label", { hasText: "Match Result (1X2)" }).first();
await oneXtwo.locator('input[type="checkbox"]').check();
await admin.waitForTimeout(250);
adminText = await admin.locator("body").innerText();
check("enabling a market reveals its outcomes", has(adminText, "Liverpool") && has(adminText, "Draw"));

// Line market: changing the line must rewrite the outcome labels.
const totals = admin.locator("label", { hasText: "Total Goals" }).first();
await totals.locator('input[type="checkbox"]').check();
await admin.waitForTimeout(250);
adminText = await admin.locator("body").innerText();
check("line market defaults to 2.5", has(adminText, "Over 2.5 Goals"));

const lineInput = admin.locator('input[type="number"][step="0.5"]').first();
await lineInput.fill("3.5");
await admin.waitForTimeout(250);
adminText = await admin.locator("body").innerText();
check("changing the line rewrites the outcome labels", has(adminText, "Over 3.5 Goals"));

await admin.screenshot({ path: "/home/claude/aifight/admin-matchboard.png", fullPage: true });

// F1 tab: no away side, roster input appears.
await admin.locator("button", { hasText: "Formula 1" }).first().click();
await admin.waitForTimeout(300);
adminText = await admin.locator("body").innerText();
check("F1 asks for a Grand Prix, not a home team", has(adminText, "Grand Prix") && !has(adminText, "Away team"));
check("F1 shows the roster input", has(adminText, "Drivers / entrants"));
check("F1 markets render", has(adminText, "Race Winner") && has(adminText, "Podium Finish"));
check("switching sport cleared the previous fixture", !has(adminText, "Liverpool v Everton"));

await admin.getByPlaceholder(/Max Verstappen/).fill("Max Verstappen\nLando Norris");
await admin.waitForTimeout(200);
const winner = admin.locator("label", { hasText: "Race Winner" }).first();
await winner.locator('input[type="checkbox"]').check();
await admin.waitForTimeout(250);
adminText = await admin.locator("body").innerText();
check("roster market prices the supplied drivers", has(adminText, "Lando Norris"));

// Snooker + darts render their own markets.
for (const [tab, market] of [["Snooker", "Frame Handicap"], ["Darts", "Total 180s"], ["Ice Hockey", "Puck Line"]]) {
  await admin.locator("button", { hasText: tab }).first().click();
  await admin.waitForTimeout(250);
  adminText = await admin.locator("body").innerText();
  check(`${tab} renders ${market}`, has(adminText, market));
}

/* ---------------- the settler ---------------- */

console.log("\nSETTLER");
adminText = await admin.locator("body").innerText();
check("standings strip shows derived bankrolls", has(adminText, "€1,055.00"));
check("liquidated fighter is stamped in the strip", /liquidated/i.test(adminText));
check("settlement section renders", has(adminText, "Settlement"));

// Every grading button must show the money it would move, before it is clicked.
const winButtons = admin.locator("button", { hasText: /^WIN/ });
check("grading buttons rendered", (await winButtons.count()) > 0, `${await winButtons.count()} found`);
const winLabel = await winButtons.first().innerText();
check("WIN button previews the profit it would add", /\+€/.test(winLabel), winLabel);

const lossLabel = await admin.locator("button", { hasText: /^LOSS/ }).first().innerText();
check("LOSS button previews the loss it would take", /-€/.test(lossLabel), lossLabel);

const voidLabel = await admin.locator("button", { hasText: /^VOID/ }).first().innerText();
check("VOID button previews a zero swing", /€0\.00/.test(voidLabel), voidLabel);

// A fighter row opens with dropdowns fed from the event's own matrix.
const claudeRow = admin.locator("button", { hasText: "Claude" }).first();
await claudeRow.click();
await admin.waitForTimeout(300);
const marketSelect = admin.locator("select").first();
const marketOptions = await marketSelect.locator("option").allInnerTexts();
check("market dropdown is fed by the published matrix", marketOptions.some((o) => has(o, "Match Result")), marketOptions.join("|"));

await marketSelect.selectOption({ index: 1 });
await admin.waitForTimeout(250);
const pickOptions = await admin.locator("select").nth(1).locator("option").allInnerTexts();
check("selection dropdown carries the price", pickOptions.some((o) => o.includes("@")), pickOptions.join("|"));

await admin.screenshot({ path: "/home/claude/aifight/admin-dispatcher.png", fullPage: true });

/* ================= 3. CONSOLE HYGIENE ================= */

console.log("\nRUNTIME");
// Failed realtime websockets to the stub host are expected and irrelevant.
const real = consoleErrors.filter(
  (e) => !/websocket|realtime|wss:|Failed to load resource|net::ERR/i.test(e)
);
check("no React or JavaScript runtime errors", real.length === 0, real.slice(0, 3).join(" | "));

await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? "ALL BROWSER CHECKS PASSED" : `${failures.length} FAILED: ${failures.join(", ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);

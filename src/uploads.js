// ————————————————————————————————————————————————————————
// Manual CSV upload — add ANY events, markets and odds the API doesn't cover
// (e.g. corners, cards, player props) by uploading a spreadsheet each day.
// Export your Excel sheet as CSV and POST it. No dependencies.
//
// EVENTS CSV columns (header row required):
//   sport,kickoff,competition,home,away,market,option,line,odds
//   - one row per option. Multiple rows (same sport+kickoff+home+away) = one event.
//   - `line` optional; if present it's appended to the option ("Over" + "9.5" → "Over 9.5").
//   - kickoff: ISO or "YYYY-MM-DD HH:MM".
//
// RESULTS CSV columns (to settle manual markets so they count toward accuracy/ROI):
//   sport,kickoff,home,away,market,outcome[,score]
// ————————————————————————————————————————————————————————
import { db, upsertFixture, upsertOdd, setOutcome, markFinal, gradePick, q } from "./db.js";
import { isPickCorrect } from "./settle.js";

// minimal, quote-aware CSV parser → array of row objects
export function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length);
  if (!lines.length) return rows;
  const splitLine = (line) => {
    const out = []; let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
      else if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const row = {};
    header.forEach((h, j) => (row[h] = cells[j] ?? ""));
    rows.push(row);
  }
  return rows;
}

const slug = (s) => String(s).trim().replace(/[^\w.-]+/g, "-");
export const manualId = (r) => `manual:${slug(r.sport)}:${slug(r.kickoff)}:${slug(r.home)}_v_${slug(r.away)}`;

// —— ingest events + odds ——
export function ingestEvents(csvText) {
  const rows = parseCSV(csvText);
  const seenFixture = new Set();
  let fixtures = 0, odds = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.sport || !r.home || !r.away || !r.market) continue;
      const id = manualId(r);
      if (!seenFixture.has(id)) {
        upsertFixture.run({
          id, sport: r.sport.toLowerCase(),
          comp: r.competition || "Manual",
          home: r.home, away: r.away, entrants: null,
          kickoff: r.kickoff || null, status: "upcoming", score: null,
          raw: JSON.stringify({ source: "manual" }),
        });
        seenFixture.add(id); fixtures++;
      }
      const option = r.line ? `${r.option} ${r.line}`.trim() : r.option;
      const price = parseFloat(r.odds);
      if (option && !Number.isNaN(price)) { upsertOdd.run({ fixture_id: id, market: r.market, option, price }); odds++; }
    }
  });
  tx();
  return { fixtures, odds, rows: rows.length };
}

// —— ingest results → settle manual markets ——
export function ingestResults(csvText) {
  const rows = parseCSV(csvText);
  let settled = 0, graded = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.sport || !r.home || !r.away || !r.market || r.outcome === "") continue;
      const id = manualId(r);
      setOutcome.run({ fixture_id: id, market: r.market, outcome: JSON.stringify(r.outcome) });
      if (r.score) markFinal.run({ id, score: r.score }); else markFinal.run({ id, score: null });
      settled++;
      for (const p of q.picksFor.all(id)) {
        if (p.market !== r.market) continue;
        const correct = isPickCorrect(p.market, p.pick, r.outcome);
        if (correct != null) { gradePick.run({ correct, fixture_id: id, model: p.model, market: p.market }); graded++; }
      }
    }
  });
  tx();
  return { settled, graded, rows: rows.length };
}

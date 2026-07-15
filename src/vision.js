
// src/vision.js — Screenshot → structured odds via Claude vision.
// Reuses your ANTHROPIC_API_KEY / ANTHROPIC_MODEL. No new keys needed.
import { ingestEvents } from "./uploads.js";

const VISION_MODEL = process.env.VISION_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You read betting-slip / bookmaker screenshots and output ONLY strict JSON — no prose, no markdown, no code fences.

Return a JSON ARRAY. Each element is one match you can clearly read:
{
  "sport": "soccer" | "basketball" | "tennis" | "darts" | "snooker",
  "competition": string,
  "home": string,
  "away": string,
  "kickoff": "YYYY-MM-DD HH:MM",
  "market": "x12" | "ml" | "goals_ou" | "total" | "spread",
  "odds": { "home": number, "draw"?: number, "away": number }
}

RULES:
- "x12" = 3-way football result (include "draw"). "ml" = 2-way winner (tennis/darts/snooker/basketball; NO draw).
- Decimal odds only (e.g. 1.85). If a price shows as American (+150/-200), convert to decimal.
- home = left/first team, away = right/second team. Map their odds to the SAME side. NEVER output identical odds for both sides unless the screenshot literally shows them equal.
- kickoff: if the image shows a date/time use it; if only a time, assume today; if nothing, use the string "UNKNOWN". Do not invent precise dates.
- Only include matches where you can read BOTH team names AND at least the two main prices. Skip anything ambiguous.
- Output [] if you cannot confidently read any match. Output ONLY the JSON array.`;

function stripToJSON(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

// Convert the vision JSON into the flat rows ingestEvents() already understands,
// then reuse the SAME pipeline (dedupe, futureSlot dating, auto-predict).
function toCsvRows(items) {
  const rows = [["sport", "kickoff", "competition", "home", "away", "market", "option", "line", "odds"]];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  for (const it of items || []) {
    if (!it || !it.home || !it.away || !it.odds) continue;
    const ko = it.kickoff && it.kickoff !== "UNKNOWN" ? it.kickoff : "";
    const mk = it.market || (it.odds.draw != null ? "x12" : "ml");
    const push = (option, odds) => {
      if (odds == null || isNaN(Number(odds))) return;
      rows.push([it.sport || "soccer", ko, it.competition || "Screenshot",
        it.home, it.away, mk, option, "", Number(odds)].map(esc).join(","));
    };
    if (mk === "x12") {
      push("home", it.odds.home); push("draw", it.odds.draw); push("away", it.odds.away);
    } else {
      push(it.home, it.odds.home); push(it.away, it.odds.away);
    }
  }
  return rows.join("\n");
}

export async function parseScreenshot(base64, mediaType) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType || "image/png", data: base64 } },
          { type: "text", text: "Extract every match and its odds as the strict JSON array." },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`vision API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

  let items;
  try { items = JSON.parse(stripToJSON(text)); }
  catch { throw new Error("vision model did not return valid JSON"); }
  if (!Array.isArray(items)) items = [items];

  const csv = toCsvRows(items);
  const result = ingestEvents(csv);           // ← straight into upsertFixture / upsertOdd
  return { parsed: items, ...result };
}

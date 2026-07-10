// Every AI provider gets the identical prompt and must return the identical JSON shape.
// Providers with no API key in .env are skipped automatically.

import { SPORTS, MARKET_DEFS, marketList, isRace } from "../sports.js";

// Build the required-JSON spec from a market list (sport defaults + any uploaded markets).
function marketsSpec(markets) {
  const lines = markets.map(
    (m) => `  "${m}": { "pick": "<${MARKET_DEFS[m] || m}>", "confidence": 0-100, "why": "one sentence" }`
  );
  return `Return ONLY a JSON object, no markdown, with exactly these keys (omit a key only if you truly cannot pick):\n{\n${lines.join(",\n")}\n}`;
}

export function buildPrompt(fixture, odds, markets) {
  const sportKey = fixture.sport;
  const oddsLines = odds.map((o) => `${o.market} | ${o.option} @ ${o.price}`).join("\n") || "(odds unavailable — use your judgment)";
  const label = SPORTS[sportKey]?.label || sportKey;
  // markets = caller-provided (sport defaults ∪ uploaded markets); fall back to sport list
  const mkts = markets && markets.length ? markets : (SPORTS[sportKey] ? marketList(sportKey) : []);

  const subject = isRace(sportKey)
    ? `EVENT: ${fixture.comp}\nENTRANTS: ${(JSON.parse(fixture.entrants || "[]")).join(", ")}`
    : `MATCH: ${fixture.home} vs ${fixture.away}\nCOMPETITION: ${fixture.comp}`;

  return `You are a professional ${label} analyst competing against other AI models on prediction accuracy and ROI.

${subject}
START (UTC): ${fixture.kickoff}

CURRENT BOOKMAKER ODDS:
${oddsLines}

Use everything you know about form, matchups, injuries, venue and conditions. Be decisive; calibrate confidence honestly (55 = slight lean, 80 = strong conviction). For any handicap/total market, state the exact line you are taking inside the pick string.
${marketsSpec(mkts)}`;
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  return JSON.parse(clean.slice(start, end + 1));
}

// —— provider callers ————————————————————————
async function callAnthropic(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Anthropic ${res.status}: ${data.error?.message || "request failed"}`);
  const text = (data.content || []).map((c) => c.text || "").join("");
  if (!text) throw new Error("Anthropic: empty response");
  return parseJson(text);
}

async function callOpenAICompatible(baseUrl, key, model, prompt) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`${baseUrl} ${res.status}: ${data.error?.message || "request failed"}`);
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  if (!msg || !msg.content) throw new Error(`${baseUrl}: no content returned`);
  return parseJson(msg.content);
}

async function callGemini(prompt) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Gemini ${res.status}: ${data.error?.message || "request failed"}`);
  const cand = data.candidates && data.candidates[0];
  if (!cand) throw new Error(`Gemini returned no answer${data.promptFeedback?.blockReason ? " (blocked: " + data.promptFeedback.blockReason + ")" : ""}`);
  const text = (cand.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error(`Gemini empty response (finishReason: ${cand.finishReason || "unknown"})`);
  return parseJson(text);
}

// ——— Model lineup ———
// Provider id = how the pick is labeled in the app (honest — the real model called).
//   claude  → Anthropic (paid; add a key when you have one)
//   gemini  → Google AI Studio (free tier)
//   llama   → Groq  (Llama 3.3 70B, free)
//   gptoss  → Cerebras (GPT-OSS 120B, free)
export const PROVIDERS = [
  { id: "claude", envKey: "ANTHROPIC_API_KEY", call: callAnthropic },
  { id: "gemini", envKey: "GEMINI_API_KEY", call: callGemini },
  { id: "llama", envKey: "GROQ_API_KEY",
    call: (p) => callOpenAICompatible("https://api.groq.com/openai/v1", process.env.GROQ_API_KEY, process.env.GROQ_MODEL || "llama-3.3-70b-versatile", p) },
  { id: "gptoss", envKey: "CEREBRAS_API_KEY",
    call: (p) => callOpenAICompatible("https://api.cerebras.ai/v1", process.env.CEREBRAS_API_KEY, process.env.CEREBRAS_MODEL || "gpt-oss-120b", p) },
];

export function activeProviders() {
  return PROVIDERS.filter((p) => process.env[p.envKey]);
}

// Every AI provider gets the identical prompt and must return the identical JSON shape.
// Providers with no API key in .env are skipped automatically.

import { SPORTS, MARKET_DEFS, marketList, isRace } from "../sports.js";

// Value-betting spec: Claude estimates the TRUE probability of each market's best pick.
// We compare that to the bookmaker's implied probability to compute the edge (value).
function marketsSpec(markets) {
  const lines = markets.map(
    (m) => `  "${m}": { "pick": "<${MARKET_DEFS[m] || m}>", "probability": 0-100, "confidence": 0-100, "why": "one sentence on why the bookmaker may be mispricing this" }`
  );
  return `Return ONLY a JSON object, no markdown, with exactly these keys (omit a key only if you have no read on it):\n{\n${lines.join(",\n")}\n}\n"probability" = your honest true chance (%) that the pick wins. Be calibrated — most edges are small.`;
}

export function buildPrompt(fixture, odds, markets) {
  const sportKey = fixture.sport;
  const oddsLines = odds.map((o) => `${o.market} | ${o.option} @ ${o.price}  (bookmaker implies ${(100 / o.price).toFixed(1)}%)`).join("\n") || "(odds unavailable)";
  const label = SPORTS[sportKey]?.label || sportKey;
  const mkts = markets && markets.length ? markets : (SPORTS[sportKey] ? marketList(sportKey) : []);

  const subject = isRace(sportKey)
    ? `EVENT: ${fixture.comp}\nENTRANTS: ${(JSON.parse(fixture.entrants || "[]")).join(", ")}`
    : `MATCH: ${fixture.home} vs ${fixture.away}\nCOMPETITION: ${fixture.comp}`;

  return `You are a sharp ${label} betting analyst. Your job is to beat the bookmakers by finding VALUE — outcomes where the true probability is higher than the bookmaker's odds imply.

${subject}
START (UTC): ${fixture.kickoff}

BOOKMAKER ODDS (with the probability each price implies):
${oddsLines}

For each market, pick the outcome you think offers the best value and estimate its TRUE probability of winning. If your true probability exceeds the bookmaker's implied probability, that's a value bet. Use everything you know about form, injuries, matchups, venue and conditions. Do not force a bet — only lean in where you genuinely disagree with the price. Keep your picks logically CONSISTENT with each other across markets of this same match (e.g. never pick a 90-minute draw in 1X2 and also a team to win in regular time).
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

// ——— Claude vs the Bookies — single sharp analyst ———
export const PROVIDERS = [
  { id: "claude", envKey: "ANTHROPIC_API_KEY", call: callAnthropic },
];

export function activeProviders() {
  return PROVIDERS.filter((p) => process.env[p.envKey]);
}

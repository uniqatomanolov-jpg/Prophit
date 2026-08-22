/**
 * /api/ingest
 *
 * Receives structured pick payloads from external scripts or cron jobs
 * and writes them to Supabase (picks table) and Vercel Blob (arena.json).
 *
 * This is the backend half of the automated pipeline. The companion
 * script (scripts/batch-runner.mjs) fetches fixtures, calls each AI
 * model API, parses the responses, and POSTs here.
 *
 * Auth: Bearer token in Authorization header (same ADMIN_TOKEN used by
 * /api/arena). A mismatch returns 401 immediately.
 *
 * Request body (array of picks):
 * [
 *   {
 *     "model": "Claude",
 *     "event": "Arsenal v Chelsea",
 *     "market": "x12",
 *     "pick": "Arsenal (Home)",
 *     "odds": 2.05,
 *     "stake": 45,
 *     "fair_prob": 0.58,
 *     "reasoning": "...",
 *     "confidence": 72,
 *     "is_chaos": false,
 *     "kickoff": "2026-08-20T19:45:00Z"  // optional
 *   },
 *   ...
 * ]
 *
 * Returns:
 * { ok: true, saved: N, skipped: N, ids: [...] }
 */

import { put, list } from "@vercel/blob";
import { createClient } from "@supabase/supabase-js";
import { authorise } from "./_lib/auth.js";
import { applyCors } from "./_lib/http.js";

const BLOB_PATH = "arena.json";
const ALLOWED_MODELS = ["Claude", "Grok", "ChatGPT", "Gemini", "Kimi"];
const ALLOWED_MARKETS = ["x12", "ml", "goals_ou", "btts", "spread", "double_chance"];

function cors(res) {
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, reason: "method-not-allowed" });

  // Auth. Timing-safe, and accepts the admin's signed session cookie so the
  // console no longer needs a raw ADMIN_TOKEN pasted into the browser.
  // Cron is excluded: nothing scheduled should be able to inject picks.
  if (!authorise(req, { allow: ["session", "admin"] }).ok) {
    return res.status(401).json({ ok: false, reason: "unauthorised" });
  }

  // Parse body
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const picks = Array.isArray(body) ? body : body?.picks;
  if (!Array.isArray(picks) || picks.length === 0) {
    return res
      .status(400)
      .json({ ok: false, reason: "bad-payload", message: "Expected an array of picks." });
  }

  // Validate each pick
  const valid = [];
  const errors = [];

  for (const pick of picks) {
    const issues = [];
    if (!ALLOWED_MODELS.includes(pick.model)) issues.push(`unknown model "${pick.model}"`);
    if (!pick.event?.trim()) issues.push("missing event");
    if (!ALLOWED_MARKETS.includes(pick.market)) issues.push(`unknown market "${pick.market}"`);
    if (!pick.pick?.trim()) issues.push("missing pick");
    if (!Number.isFinite(Number(pick.odds)) || Number(pick.odds) < 1.01) issues.push("bad odds");
    if (!Number.isFinite(Number(pick.stake)) || Number(pick.stake) < 1) issues.push("bad stake");

    if (issues.length) {
      errors.push({ input: pick, issues });
    } else {
      valid.push(pick);
    }
  }

  if (valid.length === 0) {
    return res.status(400).json({ ok: false, reason: "all-invalid", errors });
  }

  const now = new Date().toISOString();
  const saved = [];
  const skipped = [];

  // Write to Supabase if available
  const sb = getSupabase();
  if (sb) {
    for (const pick of valid) {
      // Build a deterministic pick_id to prevent duplicates.
      const pickId =
        `${pick.model.slice(0, 3).toUpperCase()}-${pick.event.replace(/\s/g, "").slice(0, 12)}-${pick.market}`.toUpperCase();

      /*
       * Writes to `bets`, the table schema.sql actually creates.
       *
       * This used to target a table called `picks` that no migration has ever
       * created, and to send `kickoff` and `logged_at` columns that do not
       * exist on it either. Every automated ingest therefore failed, was
       * caught below, and reported as a skip - so the endpoint answered 200
       * while saving nothing. Column names now match the schema, and
       * migration 002 adds pick_id / confidence / is_chaos / round.
       */
      const row = {
        pick_id: pickId,
        model: pick.model,
        event: pick.event.trim(),
        market: pick.market,
        pick: pick.pick.trim(),
        odds: Number(pick.odds),
        stake: Number(pick.stake),
        fair_prob: pick.fair_prob != null ? Number(pick.fair_prob) : null,
        reasoning: pick.reasoning ?? null,
        confidence: pick.confidence != null ? Number(pick.confidence) : null,
        is_chaos: pick.is_chaos ?? false,
        kickoff_at: pick.kickoff ?? null,
        round: pick.round != null ? Number(pick.round) : null,
        result: "pending",
        source: "ingest",
        created_at: now,
      };

      const { error } = await sb
        .from("bets")
        .upsert(row, { onConflict: "pick_id", ignoreDuplicates: true });

      if (error) {
        skipped.push({ pick_id: pickId, error: error.message });
      } else {
        saved.push(pickId);
      }
    }
  } else {
    // No Supabase — write to Blob only (picks.js path will be stale).
    for (const pick of valid) {
      const pickId =
        `${pick.model.slice(0, 3).toUpperCase()}-${pick.event.replace(/\s/g, "").slice(0, 12)}-${pick.market}`.toUpperCase();
      saved.push(pickId);
    }
  }

  // Update Blob store with the new arena snapshot so visitors see it.
  if (process.env.BLOB_READ_WRITE_TOKEN && saved.length > 0) {
    try {
      // Fetch current Blob state.
      const { blobs } = await list({ prefix: BLOB_PATH, limit: 1 });
      const existing = blobs[0];
      let current = { bets: [], fighters: {}, round: { round: 1 } };

      if (existing) {
        const r = await fetch(existing.url, { cache: "no-store" });
        if (r.ok) current = await r.json();
      }

      // Append new picks (deduplication by pick_id).
      const existingIds = new Set((current.bets ?? []).map((b) => b.pick_id));
      const newBets = valid
        .filter((p) => {
          const id =
            `${p.model.slice(0, 3).toUpperCase()}-${p.event.replace(/\s/g, "").slice(0, 12)}-${p.market}`.toUpperCase();
          return !existingIds.has(id);
        })
        .map((p, i) => ({
          id: Date.now() + i,
          pick_id:
            `${p.model.slice(0, 3).toUpperCase()}-${p.event.replace(/\s/g, "").slice(0, 12)}-${p.market}`.toUpperCase(),
          model: p.model,
          event: p.event.trim(),
          market: p.market,
          pick: p.pick.trim(),
          odds: Number(p.odds),
          stake: Number(p.stake),
          fair_prob: p.fair_prob ?? null,
          reasoning: p.reasoning ?? null,
          confidence: p.confidence ?? null,
          is_chaos: p.is_chaos ?? false,
          result: "pending",
          logged_at: now,
        }));

      const updated = { ...current, bets: [...(current.bets ?? []), ...newBets], savedAt: now };
      const payload = JSON.stringify(updated);

      try {
        await put(BLOB_PATH, payload, {
          access: "public",
          contentType: "application/json",
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: 0,
        });
      } catch (e) {
        if (/private access|public access/i.test(String(e?.message ?? ""))) {
          await put(BLOB_PATH, payload, {
            access: "private",
            contentType: "application/json",
            addRandomSuffix: false,
            allowOverwrite: true,
            cacheControlMaxAge: 0,
          });
        } else throw e;
      }
    } catch (blobErr) {
      // Blob failure is non-fatal — Supabase is the source of truth.
      console.error("Blob update failed:", blobErr);
    }
  }

  // Saving nothing because every row errored is not a success. Say so, or a
  // cron job reports green forever while the table stays empty.
  const allFailed = sb && saved.length === 0 && skipped.length > 0;

  res.status(allFailed ? 500 : 200).json({
    ok: !allFailed,
    saved: saved.length,
    skipped: skipped.length + errors.length,
    ids: saved,
    errors: [...errors, ...skipped],
    supabase: !!sb,
  });
}

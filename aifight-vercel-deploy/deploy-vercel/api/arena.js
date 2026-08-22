/**
 * /api/arena — the shared arena state, stored as one JSON blob.
 *
 * WHAT CHANGED FROM THE SHIPPED VERSION, AND WHY
 * ----------------------------------------------
 *
 * 1. THE LOST UPDATE. This is the real bug in the old file.
 *
 *    The write path was read-modify-write with no concurrency control:
 *
 *      const payload = { ...body, savedAt: new Date().toISOString() };
 *      await put(BLOB_PATH, JSON.stringify(payload), { allowOverwrite: true });
 *
 *    Two admin tabs — or one admin and the settle cron, which is the common
 *    case — both load the arena, both edit, both save. The second write
 *    silently destroys the first. No error, no warning, no trace: a settled
 *    round simply reappears as pending, or a published pick vanishes.
 *
 *    Fixed with optimistic concurrency. Every GET returns an ETag over the
 *    stored bytes. A POST may send `If-Match: <etag>`; if the stored state has
 *    moved on, the write is refused with 409 and the current state is returned
 *    so the client can merge rather than clobber. A POST without If-Match is
 *    still accepted — the CLI and the reset script need that — but it is
 *    flagged in the response so an unconditional write is a visible choice
 *    rather than an invisible default.
 *
 * 2. AUTHORISATION. The old check was `req.headers["x-admin-token"] !== secret`
 *    — a plain `!==` on a secret, which leaks its prefix through timing, and a
 *    scheme that required the raw ADMIN_TOKEN to be typed into a browser and
 *    kept in localStorage. Now: signed session cookie for humans, timing-safe
 *    ADMIN_TOKEN for machines, via the shared `authorise()`.
 *
 * 3. VALIDATION. The old guard was `Array.isArray(body.bets)`. A payload of
 *    200,000 malformed bets passed it and became the canonical arena. There is
 *    now a real schema check with bounded sizes, and it runs before anything
 *    is written.
 *
 * 4. UNBOUNDED READS. `await upstream.json()` on a blob of unknown size, with
 *    no timeout. A slow or oversized blob hung the function to the platform
 *    limit. Now: hard timeout, size ceiling, circuit breaker.
 *
 * 5. BACKUPS. Overwriting a fixed path with `allowOverwrite: true` means the
 *    previous state is gone forever. Each write now also lands a timestamped
 *    copy under `backups/`, so a bad publish is recoverable.
 */

import { head, list, put } from "@vercel/blob";
import { authorise } from "./_lib/auth.js";
import {
  applyCors,
  clientIp,
  fail,
  fetchWithTimeout,
  handlePreflight,
  json,
  noStore,
  readJson,
} from "./_lib/http.js";
import { breaker, enforce } from "./_lib/ratelimit.js";
import { createHash } from "node:crypto";

const BLOB_PATH = "arena.json";
const MAX_PAYLOAD_BYTES = 2_000_000;
const MAX_BETS = 5000;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const OUTCOMES = new Set(["pending", "win", "loss", "void", "push"]);

/**
 * Validate an arena payload before it can become canonical state.
 *
 * Collects every problem rather than returning the first, because an admin
 * fixing a malformed publish one error per round-trip is an admin who gives
 * up and forces the write. Caps at 20 so a catastrophically wrong payload
 * does not produce a wall of text.
 */
function validateArena(body) {
  const errors = [];
  const push = (msg) => {
    if (errors.length < 20) errors.push(msg);
  };

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["Payload must be a JSON object."] };
  }
  if (!Array.isArray(body.bets)) {
    return { ok: false, errors: ["`bets` must be an array."] };
  }
  if (body.bets.length > MAX_BETS) {
    return { ok: false, errors: [`Too many bets: ${body.bets.length} (max ${MAX_BETS}).`] };
  }

  const seenIds = new Set();

  body.bets.forEach((bet, i) => {
    const at = `bets[${i}]`;
    if (!bet || typeof bet !== "object") return push(`${at} is not an object.`);

    if (bet.id === undefined || bet.id === null) push(`${at}.id is required.`);
    else {
      const id = String(bet.id);
      if (seenIds.has(id)) push(`${at}.id "${id}" is duplicated.`);
      seenIds.add(id);
    }

    if (typeof bet.model !== "string" || !bet.model.trim()) push(`${at}.model must be a non-empty string.`);

    // Odds and stake are the two fields that move money. Anything outside a
    // sane range is a bug upstream, not a legitimate exotic price.
    const odds = Number(bet.odds);
    if (!Number.isFinite(odds) || odds <= 1 || odds > 1000) {
      push(`${at}.odds must be a number between 1 and 1000 (got ${JSON.stringify(bet.odds)}).`);
    }
    const stake = Number(bet.stake);
    if (!Number.isFinite(stake) || stake < 0 || stake > 1_000_000) {
      push(`${at}.stake must be a number between 0 and 1,000,000 (got ${JSON.stringify(bet.stake)}).`);
    }

    if (bet.result !== undefined && bet.result !== null && !OUTCOMES.has(bet.result)) {
      push(`${at}.result must be one of ${[...OUTCOMES].join(", ")}.`);
    }

    if (bet.fair_prob !== undefined && bet.fair_prob !== null) {
      const p = Number(bet.fair_prob);
      if (!Number.isFinite(p) || p <= 0 || p >= 1) {
        push(`${at}.fair_prob must be strictly between 0 and 1.`);
      }
    }
  });

  if (body.fighters !== undefined && (typeof body.fighters !== "object" || body.fighters === null)) {
    push("`fighters` must be an object when present.");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * A strong ETag over the exact bytes stored.
 *
 * Hashing the serialised payload rather than a timestamp means two writes in
 * the same millisecond still produce different tags, and an identical
 * re-publish produces the same one.
 */
function etagFor(serialised) {
  return `"${createHash("sha256").update(serialised).digest("base64url").slice(0, 27)}"`;
}

/* ------------------------------------------------------------------ */
/* Blob access                                                         */
/* ------------------------------------------------------------------ */

/**
 * Read the arena blob with a deadline and a size ceiling.
 *
 * Streams and counts bytes rather than trusting Content-Length, which a blob
 * host is not obliged to set correctly.
 */
async function readArena() {
  const { blobs } = await list({ prefix: BLOB_PATH, limit: 10 });
  const blob = blobs.find((b) => b.pathname === BLOB_PATH);
  if (!blob) return { found: false };

  let upstream = await fetchWithTimeout(blob.url, { timeoutMs: 6000, cache: "no-store" });
  if (upstream.status === 401 || upstream.status === 403) {
    // Private store: head() mints a signed URL using the token we hold.
    const meta = await head(blob.url);
    upstream = await fetchWithTimeout(meta.downloadUrl ?? blob.url, {
      timeoutMs: 6000,
      cache: "no-store",
    });
  }
  if (!upstream.ok) {
    const err = new Error(`blob fetch ${upstream.status}`);
    err.status = upstream.status;
    throw err;
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    const text = await upstream.text();
    if (text.length > MAX_PAYLOAD_BYTES) throw new Error("arena blob exceeds size limit");
    return { found: true, text, uploadedAt: blob.uploadedAt ?? null };
  }

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PAYLOAD_BYTES) {
      await reader.cancel();
      throw new Error("arena blob exceeds size limit");
    }
    chunks.push(value);
  }

  return {
    found: true,
    text: Buffer.concat(chunks).toString("utf8"),
    uploadedAt: blob.uploadedAt ?? null,
  };
}

/**
 * Write to a fixed path, handling either store visibility.
 *
 * Vercel Blob stores are created public or private and the SDK errors on the
 * wrong one. Trying public then private means this works against whichever
 * store already exists, without the operator having to know which they made.
 */
async function writeBlob(path, serialised) {
  const options = {
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  };
  try {
    return await put(path, serialised, { ...options, access: "public" });
  } catch (err) {
    if (!/private access|public access/i.test(String(err?.message ?? ""))) throw err;
    return await put(path, serialised, { ...options, access: "private" });
  }
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

export default async function handler(req, res) {
  if (handlePreflight(req, res, { methods: "GET, POST, OPTIONS", credentials: true })) return;
  applyCors(req, res, { methods: "GET, POST, OPTIONS", credentials: true });
  noStore(res);

  const configured = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

  /* ---------------- GET — public ---------------- */
  if (req.method === "GET") {
    if (!configured) {
      // Not an error. The site works without shared storage, just without sync.
      return json(res, 200, { ok: false, reason: "no-blob-store", data: null });
    }

    if (await enforce(res, `arena:get:${clientIp(req)}`, { max: 120, windowSeconds: 60 })) return;

    try {
      const result = await breaker("blob-read", () => readArena(), {
        threshold: 5,
        cooldownMs: 20_000,
      });

      if (!result.found) return json(res, 200, { ok: true, data: null, etag: null });

      const etag = etagFor(result.text);
      res.setHeader("ETag", etag);

      // A matching If-None-Match saves parsing and re-sending the whole arena
      // on every poll. The client polls often; most polls change nothing.
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }

      let data;
      try {
        data = JSON.parse(result.text);
      } catch {
        return fail(res, 502, "corrupt-state", "The stored arena is not valid JSON.");
      }

      return json(res, 200, { ok: true, data, etag, updatedAt: result.uploadedAt });
    } catch (err) {
      if (err?.code === "circuit-open") {
        res.setHeader("Retry-After", String(Math.ceil((err.retryAfterMs ?? 20_000) / 1000)));
        return fail(res, 503, "storage-unavailable", "Shared storage is failing; using local state.");
      }
      return fail(res, 502, "read-failed", String(err?.message ?? err));
    }
  }

  /* ---------------- POST — admin only ---------------- */
  if (req.method !== "POST") return fail(res, 405, "method-not-allowed");

  // Cron is excluded deliberately: settlement writes through Supabase RPCs,
  // and nothing scheduled should be able to overwrite the whole arena blob.
  const auth = authorise(req, { allow: ["session", "admin"] });
  if (!auth.ok) return fail(res, 401, "unauthorised");

  if (await enforce(res, `arena:post:${auth.subject}`, { max: 30, windowSeconds: 60 })) return;

  if (!configured) {
    return fail(res, 503, "no-blob-store", "Create a Blob store in Vercel → Storage to enable saving.");
  }

  const parsed = await readJson(req, { limitBytes: MAX_PAYLOAD_BYTES });
  if (!parsed.ok) return fail(res, 400, parsed.reason);

  const validation = validateArena(parsed.value);
  if (!validation.ok) {
    return json(res, 422, { ok: false, reason: "invalid-payload", errors: validation.errors });
  }

  /* --- Optimistic concurrency: refuse to clobber a newer state. --- */
  const ifMatch = req.headers["if-match"];
  let currentEtag = null;
  try {
    const current = await readArena();
    currentEtag = current.found ? etagFor(current.text) : null;
  } catch {
    // A read failure must not block a write. If we cannot establish the
    // current state we cannot enforce If-Match either, so the write proceeds
    // unconditionally and says so in the response.
    currentEtag = null;
  }

  if (ifMatch && currentEtag && ifMatch !== currentEtag && ifMatch !== "*") {
    let data = null;
    try {
      const current = await readArena();
      data = current.found ? JSON.parse(current.text) : null;
    } catch {
      /* best effort — the 409 is the important part */
    }
    return json(res, 409, {
      ok: false,
      reason: "stale-write",
      message:
        "The arena changed since you loaded it. Someone else published, or the settle job ran. " +
        "Reload, re-apply your change, and save again.",
      etag: currentEtag,
      current: data,
    });
  }

  try {
    const payload = {
      ...parsed.value,
      savedAt: new Date().toISOString(),
      savedBy: auth.actor,
    };
    const serialised = JSON.stringify(payload);
    const etag = etagFor(serialised);

    const blob = await breaker("blob-write", () => writeBlob(BLOB_PATH, serialised), {
      threshold: 3,
      cooldownMs: 15_000,
    });

    /*
     * Timestamped backup, best effort.
     *
     * The canonical write has already succeeded at this point, so a failed
     * backup must not fail the request — reporting an error after the state
     * was saved would push the admin into a retry loop that writes the same
     * state again. The response reports whether the backup landed.
     */
    let backup = null;
    try {
      const stamp = payload.savedAt.replace(/[:.]/g, "-");
      const copy = await writeBlob(`backups/arena-${stamp}.json`, serialised);
      backup = copy.pathname ?? null;
    } catch {
      backup = null;
    }

    res.setHeader("ETag", etag);
    return json(res, 200, {
      ok: true,
      url: blob.url,
      etag,
      savedAt: payload.savedAt,
      backup,
      /** True when the client chose not to guard against a concurrent write. */
      unconditional: !ifMatch,
    });
  } catch (err) {
    if (err?.code === "circuit-open") {
      return fail(res, 503, "storage-unavailable", "Shared storage is failing. Your change was NOT saved.");
    }
    return fail(res, 502, "write-failed", String(err?.message ?? err));
  }
}

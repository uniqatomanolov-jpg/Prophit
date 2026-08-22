/**
 * Arena persistence — the one place the blob is read and written.
 *
 * WHY IT IS SEPARATE FROM api/arena.js
 * ------------------------------------
 * Two routes now write the arena: `/api/arena` (publish the whole state) and
 * `/api/picks` (append one pick). If each carried its own copy of the
 * read-modify-write, they would drift — one would gain a size cap the other
 * lacked, one would handle the private-store fallback and the other would
 * not — and the failure would appear as data loss, not as a bug report.
 *
 * `mutate()` below is the important export. It wraps the whole
 * read → change → conditional-write cycle, including the retry, so no caller
 * has to remember the ordering. A caller that forgets the ETag is a caller
 * that silently destroys someone else's concurrent write.
 */

import { head, list, put } from "@vercel/blob";
import { createHash } from "node:crypto";
import { fetchWithTimeout } from "./http.js";

export const BLOB_PATH = "arena.json";
export const MAX_PAYLOAD_BYTES = 2_000_000;

/**
 * A strong ETag over the exact bytes stored.
 *
 * Hashing the serialised payload rather than a timestamp means two writes in
 * the same millisecond still differ, and an identical re-publish produces the
 * same tag — so a no-op save does not look like a conflict.
 */
export function etagFor(serialised) {
  return `"${createHash("sha256").update(serialised).digest("base64url").slice(0, 27)}"`;
}

export function isConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/**
 * Read the arena, with a deadline and a size ceiling.
 *
 * Bytes are counted as they stream rather than trusting Content-Length, which
 * a blob host is not obliged to set correctly. Without the ceiling, a corrupt
 * multi-gigabyte blob would hang the function until the platform killed it.
 */
export async function readArena() {
  const { blobs } = await list({ prefix: BLOB_PATH, limit: 10 });
  const blob = blobs.find((b) => b.pathname === BLOB_PATH);
  if (!blob) return { found: false, text: null, etag: null, uploadedAt: null };

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

  let text;
  const reader = upstream.body?.getReader?.();
  if (!reader) {
    text = await upstream.text();
    if (text.length > MAX_PAYLOAD_BYTES) throw new Error("arena blob exceeds size limit");
  } else {
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
    text = Buffer.concat(chunks).toString("utf8");
  }

  return { found: true, text, etag: etagFor(text), uploadedAt: blob.uploadedAt ?? null };
}

/** Read and parse. A corrupt blob throws with a named reason. */
export async function readArenaJson() {
  const result = await readArena();
  if (!result.found) return { found: false, data: null, etag: null };
  try {
    return { found: true, data: JSON.parse(result.text), etag: result.etag, uploadedAt: result.uploadedAt };
  } catch {
    const err = new Error("The stored arena is not valid JSON.");
    err.code = "corrupt-state";
    throw err;
  }
}

/**
 * Write to a fixed path, handling either store visibility.
 *
 * Vercel Blob stores are created public or private and the SDK errors on the
 * wrong one. Trying public then private means this works against whichever
 * store already exists, without the operator needing to know which they made.
 */
export async function writeBlob(path, serialised) {
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

/**
 * Serialises mutations inside this process.
 *
 * WHY: Vercel Blob has no compare-and-swap. A read-modify-write cycle
 * therefore has a genuine TOCTOU window, and an earlier version of this file
 * tried to close it by re-reading immediately before the put and comparing
 * ETags. That does not work, and the failure is total rather than marginal:
 * when N requests all read before any of them writes, every one sees an
 * unchanged ETag, every one proceeds, and the last write wins. Measured with
 * five concurrent logs, all five reported success and one was stored.
 *
 * A single serverless instance handles concurrent requests on one event loop,
 * so chaining every mutation onto one promise removes the interleaving
 * entirely for the overwhelmingly common case: one warm instance, one admin,
 * several rapid clicks.
 *
 * It does NOT help across instances. That case is caught by the pre- and
 * post-write checks in `mutate()` below, which are the layers that make a
 * lost update detectable rather than silent.
 */
let mutationQueue = Promise.resolve();

function serialise(task) {
  const run = mutationQueue.then(task, task);
  // Swallow rejection on the CHAIN only, so one failed mutation does not
  // poison every mutation queued behind it. The caller still sees `run`.
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Read → change → write, safe against concurrent writers.
 *
 * `change(data)` receives the current arena (null when none exists) and
 * returns the next one, or throws to abort. It MUST be a pure function of
 * what it is handed and must not close over a snapshot read earlier, because
 * it is re-invoked on every retry against freshly read state.
 *
 * Three mechanisms, because each catches a failure the others miss:
 *
 *   in-process queue     removes interleaving on a single instance entirely
 *   pre-write check      stops US overwriting another instance's write
 *   post-write verify    detects another instance overwriting US
 *
 * The two ETag checks guard opposite directions and both are required. An
 * earlier version had only the post-write check and silently destroyed a
 * concurrent writer's change; a version before that had only the pre-write
 * check and lost its own. Together they convert a lost update from silent
 * data loss into a retry, and the retry re-validates — so a duplicate or a
 * budget breach introduced by the concurrent write is caught rather than
 * waved through.
 *
 * Retrying rather than failing outright is deliberate: two admins logging two
 * DIFFERENT picks should both succeed, and rejecting the second for a
 * conflict it did not cause would be its own bug.
 */
export async function mutate(change, { attempts = 4, backupPrefix = null } = {}) {
  return serialise(async () => {
    let lastConflict = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await readArena();

      let data = null;
      if (current.found) {
        try {
          data = JSON.parse(current.text);
        } catch {
          const err = new Error("The stored arena is not valid JSON.");
          err.code = "corrupt-state";
          throw err;
        }
      }

      // Throws from `change` — validation failures, locked rounds — propagate
      // straight out. They are decisions, not conflicts, and retrying them
      // would just produce the same answer more slowly.
      const next = await change(data, { etag: current.etag, attempt });

      const serialised = JSON.stringify(next);
      if (serialised.length > MAX_PAYLOAD_BYTES) {
        const err = new Error("Arena payload exceeds the size limit.");
        err.code = "payload-too-large";
        throw err;
      }
      const expectedEtag = etagFor(serialised);

      /*
       * PRE-WRITE GUARD — do not clobber someone else.
       *
       * Re-read and confirm the stored state is still the one `change` was
       * given. If another writer landed in between, our `next` was computed
       * from stale input; writing it would destroy their change silently.
       * Retry instead, so `change` re-runs against what is actually there.
       *
       * This and the post-write check below are BOTH required and catch
       * opposite failures: this one stops us overwriting another writer, the
       * other detects another writer overwriting us. An earlier version had
       * only one at a time and lost data in whichever direction was unguarded.
       */
      const before = await readArena();
      if ((before.etag ?? null) !== (current.etag ?? null)) {
        lastConflict = { stage: "pre-write", expected: current.etag, found: before.etag, attempt };
        continue;
      }

      const blob = await writeBlob(BLOB_PATH, serialised);

      /*
       * Read back what actually landed.
       *
       * If it is not ours, another instance wrote between our read and our
       * put and our change is gone. Retry against whatever is there now —
       * `change` re-runs its own duplicate and budget checks, so the retry is
       * validated, not blindly re-applied.
       *
       * An identical re-publish by someone else produces the same ETag and is
       * correctly treated as success: the stored state is what we intended.
       */
      const confirmed = await readArena();
      if (confirmed.etag !== expectedEtag) {
        lastConflict = { stage: "post-write", expected: expectedEtag, found: confirmed.etag, attempt };
        continue;
      }

      // Timestamped backup, best effort and only after the canonical write is
      // confirmed. A failed backup must not fail the request, or the caller
      // retries and writes the same state again.
      let backup = null;
      if (backupPrefix) {
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const copy = await writeBlob(`${backupPrefix}/arena-${stamp}.json`, serialised);
          backup = copy.pathname ?? null;
        } catch {
          backup = null;
        }
      }

      return {
        ok: true,
        data: next,
        etag: expectedEtag,
        url: blob.url,
        backup,
        attempts: attempt + 1,
      };
    }

    const err = new Error(
      "Another writer kept changing the arena while saving. Nothing was written — reload and try again.",
    );
    err.code = "conflict";
    err.detail = lastConflict;
    throw err;
  });
}

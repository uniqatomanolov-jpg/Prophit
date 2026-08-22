#!/usr/bin/env node
/**
 * Build-time secret scanner. Fails the build if a credential reached the
 * client bundle.
 *
 * WHY THIS EXISTS
 * ---------------
 * The admin password leak was not caused by a bad decision. It was caused by
 * a config file that was convenient to edit and happened to be publicly
 * served. That will happen again — someone will add a key "just for testing",
 * or prefix an env var `VITE_` without noticing that `VITE_` means "inline
 * this into the JavaScript everyone downloads".
 *
 * A review catches that some of the time. A build that refuses to ship
 * catches it every time.
 *
 * Wire it in as:
 *
 *   "build": "vite build && node scripts/check-secrets.mjs"
 *
 * so `vercel build` runs it and a positive finding fails the deploy rather
 * than publishing it.
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG
 * ----------------------------------
 * The Supabase ANON key. That key is designed to be public — it identifies
 * the project and authorises nothing on its own. It is safe if and only if
 * RLS is enabled, which is what supabase/migrations/002_rls.sql enforces and
 * what the query at the bottom of that file verifies. Flagging it here would
 * train everyone to ignore this script's output, which is worse than not
 * having it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.argv[2] ?? "dist";

/**
 * Each rule is a real credential shape, not a keyword.
 *
 * Matching on the word "password" produces false positives on every login
 * form and gets the script disabled within a week. These match the structure
 * of the secret itself.
 */
const RULES = [
  {
    id: "supabase-service-role",
    severity: "critical",
    // A JWT whose payload declares the service_role. Full database access,
    // RLS bypassed. This must never be within a mile of a browser.
    test: (text) => {
      const jwts = text.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/g) ?? [];
      return jwts.filter((jwt) => {
        try {
          const payload = JSON.parse(
            Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"),
          );
          return payload.role === "service_role";
        } catch {
          return false;
        }
      });
    },
    message: "A Supabase SERVICE ROLE key is in the client bundle. Rotate it immediately.",
  },
  {
    id: "admin-password-literal",
    severity: "critical",
    /*
     * The exact shape of the shipped leak: an adminPassword with a value.
     *
     * Match first, filter second. An inline negative lookahead was tried and
     * silently disabled the whole rule — an empty alternative in the
     * alternation (`(?!A|B|)`) matches the empty string at every position, so
     * the lookahead always failed and the rule never fired. Placeholders are
     * excluded in code below, where the logic is visible and testable.
     */
    test: (text) => {
      const placeholders = new Set(["change-this", "changeme", "your-password-here", ""]);
      const matches = text.match(/adminPassword\s*[:=]\s*["'`]([^"'`]*)["'`]/g) ?? [];
      return matches.filter((m) => {
        const value = m.replace(/^.*?["'`]/, "").replace(/["'`]$/, "");
        return !placeholders.has(value.trim().toLowerCase());
      });
    },
    message:
      "An admin password literal is in the client bundle. Passwords are verified " +
      "server-side via ADMIN_PASSWORD_HASH — see api/_lib/auth.js.",
  },
  {
    id: "admin-token",
    severity: "critical",
    /*
     * Excludes template interpolations. `ADMIN_SESSION_SECRET="${secret}"` is
     * a script PRINTING an env var name, not a leaked value — flagging it
     * trains people to ignore this tool, which is worse than the false
     * negative it protects against.
     */
    test: (text) => {
      const matches =
        text.match(/(?:ADMIN_TOKEN|CRON_SECRET|ADMIN_SESSION_SECRET)\s*[:=]\s*["'`][^"'`]{8,}["'`]/g) ?? [];
      return matches.filter((m) => !/\$\{|\$\(|%[sd]\b/.test(m));
    },
    message: "A server-only token is in the client bundle.",
  },
  {
    id: "vercel-blob-token",
    severity: "critical",
    test: (text) => text.match(/vercel_blob_rw_[A-Za-z0-9_]{16,}/g) ?? [],
    message: "A Vercel Blob read-write token is in the client bundle.",
  },
  {
    id: "odds-api-key",
    severity: "high",
    test: (text) => text.match(/ODDS_API_KEY\s*[:=]\s*["'`][^"'`]{8,}["'`]/g) ?? [],
    message: "The Odds API key is in the client bundle. It is metered and will be drained.",
  },
  {
    id: "openai-style-key",
    severity: "critical",
    test: (text) => text.match(/\b(?:sk|rk)-[A-Za-z0-9]{20,}\b/g) ?? [],
    message: "An LLM provider API key is in the client bundle.",
  },
  {
    id: "generic-private-key",
    severity: "critical",
    test: (text) => text.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g) ?? [],
    message: "A private key is in the client bundle.",
  },
];

const SCANNABLE = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json", ".map", ".txt"]);

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, files);
    else if (SCANNABLE.has(extname(path))) files.push(path);
  }
  return files;
}

/** Never print a secret. Confirming its shape is enough to act on. */
function redact(value) {
  const text = String(value);
  if (text.length <= 12) return "*".repeat(text.length);
  return `${text.slice(0, 6)}…${text.slice(-4)} (${text.length} chars)`;
}

const files = walk(ROOT);

if (files.length === 0) {
  console.error(`✗ check-secrets: nothing to scan in "${ROOT}".`);
  console.error("  The build output is missing. Run the build first.");
  process.exit(1);
}

const findings = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const rule of RULES) {
    for (const match of rule.test(text)) {
      findings.push({ file, rule, match });
    }
  }
}

/* ---- Serverless function budget ---- */
/*
 * Vercel's Hobby plan allows 12 Serverless Functions per deployment. Every
 * `.js` under `api/` becomes one, EXCEPT paths containing an underscore-
 * prefixed segment (`api/_lib/...`), which are bundled as plain modules.
 *
 * Exceeding the limit fails the deploy about ten seconds in, during function
 * enumeration, with no code error to point at — which is exactly what makes
 * it expensive to diagnose. Counting here turns a mystified deploy failure
 * into a build error that names the offending files.
 */
const FUNCTION_LIMIT = Number(process.env.VERCEL_FUNCTION_LIMIT ?? 12);
const functions = files.filter(
  (f) =>
    /(^|[/\\])api[/\\]/.test(f) &&
    extname(f) === ".js" &&
    !f.split(/[/\\]/).some((seg) => seg.startsWith("_")),
);

if (functions.length > FUNCTION_LIMIT) {
  console.error("");
  console.error("═".repeat(70));
  console.error(`  BUILD BLOCKED — ${functions.length} Serverless Functions (limit ${FUNCTION_LIMIT})`);
  console.error("═".repeat(70));
  console.error("");
  for (const f of functions.sort()) console.error(`    ${f}`);
  console.error("");
  console.error("  Vercel fails the deploy during function enumeration, with no");
  console.error("  code error, so this is caught here instead.");
  console.error("");
  console.error("  Fix: move a handler into api/_lib/routes/ and dispatch to it");
  console.error("  from an existing function, with a vercel.json rewrite keeping");
  console.error("  the public URL. See api/picks.js for the pattern.");
  console.error("");
  process.exit(1);
}
console.log(`✓ check-secrets: ${functions.length} serverless functions (limit ${FUNCTION_LIMIT}).`);

/* ---- picks.js: the other half of the shipped guarantee ---- */
const hasPicks = files.some((f) => f.endsWith("picks.js"));
if (!hasPicks) {
  console.error("✗ check-secrets: picks.js is missing from the build output.");
  console.error("  Every page loads it, and nosniff makes the 404 HTML unexecutable.");
  console.error("  See the header comment in public/picks.js.");
  process.exit(1);
}

if (findings.length === 0) {
  console.log(`✓ check-secrets: ${files.length} files scanned, no credentials found.`);
  process.exit(0);
}

console.error("");
console.error("═".repeat(70));
console.error(`  BUILD BLOCKED — ${findings.length} credential(s) in the client bundle`);
console.error("═".repeat(70));

for (const { file, rule, match } of findings) {
  console.error("");
  console.error(`  [${rule.severity.toUpperCase()}] ${rule.id}`);
  console.error(`  file:  ${file}`);
  console.error(`  value: ${redact(match)}`);
  console.error(`  ${rule.message}`);
}

console.error("");
console.error("  Anything in this output is already public to anyone who");
console.error("  downloads the page. Rotate every credential listed above");
console.error("  before doing anything else — removing it from the build");
console.error("  does not un-publish what has already shipped.");
console.error("");

process.exit(1);

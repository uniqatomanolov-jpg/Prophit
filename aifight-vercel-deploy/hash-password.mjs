#!/usr/bin/env node
/**
 * Generate the admin credentials.
 *
 *   node scripts/hash-password.mjs
 *
 * Prints an ADMIN_PASSWORD_HASH and a fresh ADMIN_SESSION_SECRET to paste
 * into Vercel. The password itself is never written anywhere — not to a file,
 * not to shell history, not to this script's own output.
 *
 * Reads from the TTY with echo disabled, so the password does not appear on
 * screen or in a scrollback buffer. If stdin is piped it reads a line
 * normally, which makes the script usable in automation while keeping the
 * interactive path safe.
 */

import { createInterface } from "node:readline";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = PARAMS;
  const derived = await scrypt(password.normalize("NFKC"), salt, keylen, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return ["scrypt", N, r, p, salt.toString("base64url"), Buffer.from(derived).toString("base64url")].join("$");
}

/** Read a line without echoing it. */
function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    // Suppress echo by intercepting the output stream while the answer is typed.
    const interactive = Boolean(process.stdin.isTTY);
    if (interactive) {
      const write = rl._writeToOutput?.bind(rl);
      rl._writeToOutput = function (chunk) {
        if (chunk.includes(question)) write?.(chunk);
      };
    }

    rl.question(question, (answer) => {
      if (interactive) process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Reject passwords that will not survive contact with the internet.
 *
 * The login route is rate-limited, which buys a great deal — but a
 * five-character password is still guessable by someone patient, and this is
 * the one moment where refusing a weak choice costs nothing.
 */
function assess(password) {
  const problems = [];
  if (password.length < 12) problems.push("shorter than 12 characters");
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push("no mixed case");
  if (!/\d/.test(password) && !/[^A-Za-z0-9]/.test(password)) {
    problems.push("no digit or symbol");
  }
  const common = ["password", "admin", "letmein", "changeme", "beroe", "aifight", "123456"];
  if (common.some((word) => password.toLowerCase().includes(word))) {
    problems.push("contains a predictable word");
  }
  return problems;
}

const password = await prompt("New admin password (input hidden): ");

if (!password) {
  console.error("\nNo password entered. Nothing generated.");
  process.exit(1);
}

const problems = assess(password);
if (problems.length) {
  console.error("\n⚠  Weak password:");
  for (const problem of problems) console.error(`   - ${problem}`);
  console.error("\n   This guards an admin console that can rewrite every bankroll on");
  console.error("   the site. Use a generated passphrase from a password manager.");

  const proceed = await prompt("\nUse it anyway? (yes/no): ");
  if (proceed.trim().toLowerCase() !== "yes") {
    console.error("Aborted.");
    process.exit(1);
  }
}

const hash = await hashPassword(password);
const secret = randomBytes(32).toString("hex");

console.log(`
────────────────────────────────────────────────────────────────────
  Vercel → Settings → Environment Variables
  Add both, to Production AND Preview, then redeploy.
────────────────────────────────────────────────────────────────────

ADMIN_PASSWORD_HASH="${hash}"

ADMIN_SESSION_SECRET="${secret}"

────────────────────────────────────────────────────────────────────

  ADMIN_PASSWORD_HASH   scrypt, N=${PARAMS.N}. The password cannot be
                        recovered from it.
  ADMIN_SESSION_SECRET  signs session cookies. Changing it logs every
                        admin out immediately — that is your panic
                        button if you suspect a session was stolen.

  Do NOT prefix either with VITE_. That prefix inlines a value into the
  client bundle, which is how the previous password became public.

  Then remove adminPassword from public/config.js and redeploy. The
  build will refuse to ship while it is still there
  (scripts/check-secrets.mjs).
`);

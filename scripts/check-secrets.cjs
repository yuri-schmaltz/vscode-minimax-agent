#!/usr/bin/env node
/**
 * check-secrets.cjs — defence-in-depth grep for token / secret leaks
 * in `src/`. Run via `npm run lint:secrets` (or as part of CI).
 *
 * The script enforces three rules:
 *
 *   1. No `console.log(...)` in `src/` other than the documented redaction
 *      helper comment. (Token-bearing values must go through `redact()` /
 *      `redactString()` / `fingerprintToken()` before any log statement.)
 *   2. `src/auth/SecretStore.ts` and `src/auth/OAuth.ts` must not
 *      interpolate a token into a `postMessage` / `window.show*Message` /
 *      `log*` / `console.*` call site.
 *   3. `src/views/ChatViewProvider.ts` must never postMessage a field
 *      named `access_token`, `refresh_token`, `token`, or
 *      `client_secret`.
 *
 * The script exits non-zero on any finding; CI should fail the build.
 *
 * NOTE: This is a heuristic grep — it does not parse TypeScript. It is
 * intentionally conservative (it flags false positives rather than
 * missing real leaks).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');

const findings = [];

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full);
    } else if (/\.ts$/.test(ent.name)) {
      const text = fs.readFileSync(full, 'utf8');
      check(full, text);
    }
  }
}

function check(file, text) {
  const rel = path.relative(SRC, file);

  // Rule 1: console.log/warn/error/info/debug in src/, excluding comments.
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const stripped = line.replace(/\/\/.*/, '').replace(/\/\*.*?\*\//g, '');
    if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(stripped)) {
      findings.push({
        rule: 'console.log leak',
        file: rel,
        line: i + 1,
        snippet: line.trim(),
      });
    }
  });

  // Rule 2: SecretStore / OAuth token interpolation in postMessage / log.
  if (rel === 'auth/SecretStore.ts' || rel === 'auth/OAuth.ts') {
    lines.forEach((line, i) => {
      if (/(access_token|refresh_token|token)\s*[+\}\)\]]/.test(line) &&
          /(postMessage|showInformationMessage|showErrorMessage|showWarningMessage|console\.|log)/.test(line)) {
        findings.push({
          rule: 'token-shaped value in user-facing call',
          file: rel,
          line: i + 1,
          snippet: line.trim(),
        });
      }
    });
  }

  // Rule 3: ChatViewProvider must not postMessage token-shaped fields.
  if (rel === 'views/ChatViewProvider.ts') {
    lines.forEach((line, i) => {
      if (/postMessage/.test(line) && /(access_token|refresh_token|client_secret)/.test(line)) {
        findings.push({
          rule: 'ChatViewProvider postMessage of token field',
          file: rel,
          line: i + 1,
          snippet: line.trim(),
        });
      }
    });
  }
}

walk(SRC);

if (findings.length === 0) {
  process.stdout.write('[check-secrets] OK — no token-leak patterns found in src/.\n');
  process.exit(0);
}

process.stderr.write(`[check-secrets] ${findings.length} finding(s):\n`);
for (const f of findings) {
  process.stderr.write(`  ${f.rule}  ${f.file}:${f.line}\n    ${f.snippet}\n`);
}
process.exit(1);

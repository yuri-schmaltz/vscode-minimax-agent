// Unit tests for the archonUrl URL builder in resources/mavis-cli/mavis.cjs.
// The bug: the old `archonUrl(path)` skipped MAVIS_API_BASE when the path
// started with '/', so the shim was hitting https://api.minimax.io/chat/completions
// (404) instead of https://api.minimax.io/v1/chat/completions.
//
// We exercise the function by spawning the shim with a tiny Node harness
// that imports/evaluates mavis.cjs and exports archonUrl.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(REPO_ROOT, 'resources', 'mavis-cli', 'mavis.cjs');

// Run a tiny Node script that loads ONLY the archonUrl function from the
// shim. We avoid evaluating the whole file because the shim's main()
// prints "mavis 0.x" to stdout at load time, polluting our JSON.
function evalArchonUrl(env) {
  const script = `
    const fs = require('node:fs');
    const shim = fs.readFileSync(${JSON.stringify(SHIM)}, 'utf8');
    // Extract just the archonUrl function definition. It's a top-level
    // function declaration; regex match is fine because the function is
    // small and stable.
    const m = /function archonUrl\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}/.exec(shim);
    if (!m) { process.stderr.write('archonUrl not found\\n'); process.exit(2); }
    const body = m[1];
    const fn = new Function('process', 'return function archonUrl(path) {' + body + '};');
    const archonUrl = fn(process);
    process.stdout.write(JSON.stringify({
      chat: archonUrl('/chat/completions'),
      models: archonUrl('/models'),
      relative: archonUrl('models'),
    }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`shim eval failed: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

test('archonUrl: prepends /v1 by default when path is /chat/completions', () => {
  const out = evalArchonUrl({
    MAVIS_ARCHON_URL: 'https://api.minimax.io',
    MAVIS_API_KEY: 'sk-test',
    MAVIS_API_BASE: '/v1',
  });
  assert.equal(out.chat, 'https://api.minimax.io/v1/chat/completions');
  assert.equal(out.models, 'https://api.minimax.io/v1/models');
  assert.equal(out.relative, 'https://api.minimax.io/v1/models');
});

test('archonUrl: respects custom MAVIS_API_BASE', () => {
  const out = evalArchonUrl({
    MAVIS_ARCHON_URL: 'https://api.minimax.io',
    MAVIS_API_KEY: 'sk-test',
    MAVIS_API_BASE: '/api/v2',
  });
  assert.equal(out.chat, 'https://api.minimax.io/api/v2/chat/completions');
});

test('archonUrl: trims trailing slashes from base', () => {
  const out = evalArchonUrl({
    MAVIS_ARCHON_URL: 'https://api.minimax.io///',
    MAVIS_API_KEY: 'sk-test',
    MAVIS_API_BASE: '/v1',
  });
  assert.equal(out.chat, 'https://api.minimax.io/v1/chat/completions');
});

test('archonUrl: works when MAVIS_ARCHON_URL is unset (mock mode)', () => {
  const out = evalArchonUrl({
    MAVIS_API_KEY: 'sk-test',
    MAVIS_API_BASE: '/v1',
    // No MAVIS_ARCHON_URL → MOCK = true, but archonUrl still builds a URL.
  });
  // base = '' (empty string after replace), so the result is just the
  // apiBase-prefixed path. The shim won't actually call this in mock
  // mode (MOCK guards the call), but the function shouldn't crash.
  assert.equal(out.chat, '/v1/chat/completions');
});

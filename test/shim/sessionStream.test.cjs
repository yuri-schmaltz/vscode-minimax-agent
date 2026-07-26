// Smoke test for the cmdSessionStream stdin streaming. Spawns the
// shim with MAVIS_MOCK=1 so it returns canned responses, writes a
// prompt to stdin without closing it, and verifies the shim emits
// 'message' + 'done' for that prompt without hanging on stdin.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Writable } = require('node:stream');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(REPO_ROOT, 'resources', 'mavis-cli', 'mavis.cjs');

// Tiny NDJSON line parser (one JSON object per line).
class LineParser extends Writable {
  constructor() {
    super();
    this.events = [];
    this.buf = '';
  }
  _write(chunk, _enc, cb) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try { this.events.push(JSON.parse(line)); } catch { /* ignore */ }
    }
    cb();
  }
}

function spawnSessionStream(env) {
  const child = spawn(
    process.execPath,
    [SHIM, 'session', 'stream', '--session-id', 'sess_test_mock'],
    { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const parser = new LineParser();
  child.stdout.pipe(parser);
  return { child, events: parser.events };
}

test('session stream: processes a single prompt and emits done (no stdin close)', async () => {
  const { child, events } = spawnSessionStream({ MAVIS_MOCK: '1' });
  // Write one prompt WITHOUT closing stdin. The old readStdinLines
  // would hang here forever; the new generator should yield the line
  // and the shim should emit done for it.
  child.stdin.write(JSON.stringify({ type: 'prompt', text: 'hello' }) + '\n');
  // Give the shim a moment to process.
  await new Promise((r) => setTimeout(r, 400));
  // Tear down: close stdin so the generator's 'end' handler fires
  // (otherwise the process would stay alive on our event loop).
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 200));
  child.kill();

  const messages = events.filter((e) => e.type === 'message');
  const done = events.filter((e) => e.type === 'done');
  assert.ok(messages.length >= 1, `expected at least one message, got ${messages.length}: ${JSON.stringify(events)}`);
  assert.ok(done.length >= 1, `expected at least one done, got ${done.length}: ${JSON.stringify(events)}`);
  // Mock response includes the prompt text.
  const combined = messages.map((m) => m.content || '').join('');
  assert.ok(combined.includes('hello'), `expected mock response to include "hello", got "${combined}"`);
});

test('session stream: processes two consecutive prompts in order', async () => {
  const { child, events } = spawnSessionStream({ MAVIS_MOCK: '1' });
  child.stdin.write(JSON.stringify({ type: 'prompt', text: 'first' }) + '\n');
  // Give the first prompt time to complete.
  await new Promise((r) => setTimeout(r, 250));
  child.stdin.write(JSON.stringify({ type: 'prompt', text: 'second' }) + '\n');
  await new Promise((r) => setTimeout(r, 400));
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 200));
  child.kill();

  const done = events.filter((e) => e.type === 'done');
  const messages = events.filter((e) => e.type === 'message').map((m) => m.content || '');
  assert.ok(done.length >= 2, `expected at least 2 done events, got ${done.length}`);
  // The first mock response should mention 'first', the second 'second'.
  const first = messages.find((m) => m.includes('first'));
  const second = messages.find((m) => m.includes('second'));
  assert.ok(first, `expected a message containing 'first'`);
  assert.ok(second, `expected a message containing 'second'`);
});

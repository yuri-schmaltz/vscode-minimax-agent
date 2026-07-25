/**
 * End-to-end test that spawns the real bundled shim binary and validates
 * the NDJSON contract. This protects against the shim drifting away from
 * what the TS client expects.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const SHIM = resolve(__dirname, '../../resources/mavis-cli/mavis.cjs');

function run(args: string[], stdinLines: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<string[]> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [SHIM, ...args], {
      env: { ...process.env, MAVIS_MOCK: '1', ...env },
    });
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (l) => lines.push(l));
    child.stderr.on('data', () => {
      /* ignore in tests */
    });
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code !== 0 && code !== null && lines.length === 0) {
        rejectP(new Error(`mavis exited with code ${code}`));
        return;
      }
      resolveP(lines);
    });
    for (const line of stdinLines) {
      child.stdin.write(line + '\n');
    }
    child.stdin.end();
  });
}

test('shim: --version prints a version string', async () => {
  const { execSync } = await import('node:child_process');
  const out = execSync(`node ${SHIM} --version`).toString().trim();
  assert.match(out, /^\d+\.\d+\.\d+/);
});

test('shim: agent list emits at least one agent with default "mavis"', async () => {
  const lines = await run(['agent', 'list']);
  const agents = lines.map((l) => JSON.parse(l)).filter((x) => !x.type);
  assert.ok(agents.length >= 1, 'expected >=1 agent');
  const mavis = agents.find((a) => a.id === 'mavis');
  assert.ok(mavis, 'expected default agent "mavis"');
  assert.equal(mavis.isDefault, true);
});

test('shim: session list emits a "done" sentinel', async () => {
  const lines = await run(['session', 'list']);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.type, 'done');
});

test('shim: session stream echoes prompts as assistant messages', async () => {
  const lines = await run(['session', 'stream', '--session-id', 'sess_e2e'], [
    JSON.stringify({ type: 'prompt', text: 'ping' }),
  ]);
  // First line should be ready, last should be done, and at least one
  // message in between.
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].type, 'ready');
  const messages = parsed.filter((p) => p.type === 'message');
  assert.ok(messages.length >= 1, 'expected at least one message');
  assert.match(messages[0].content, /ping/);
  assert.equal(parsed[parsed.length - 1].type, 'done');
});

test('shim: oauth code returns a user_code and device_code', async () => {
  const lines = await run(['oauth', 'code']);
  const parsed = lines.map((l) => JSON.parse(l));
  const code = parsed.find((p) => p.type === 'oauth-code');
  assert.ok(code);
  assert.match(code.user_code, /^\d{3}-\d{4}$/);
  assert.ok(code.device_code.length > 0);
});

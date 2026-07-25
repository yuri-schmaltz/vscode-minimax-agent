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

// --------------------------------------------------------------- drive (Fase 4)

test('shim: drive list emits at least 5 items spread across categories', async () => {
  const lines = await run(['drive', 'list']);
  const items = lines.map((l) => JSON.parse(l)).filter((x) => !x.type);
  assert.ok(items.length >= 5, `expected >=5 drive items, got ${items.length}`);
  const cats = new Set(items.map((i) => i.category));
  assert.ok(cats.size >= 3, `expected items in at least 3 categories, got ${cats.size}`);
  // Each item has the canonical shape.
  for (const it of items) {
    assert.ok(typeof it.id === 'string' && it.id.length > 0);
    assert.ok(typeof it.name === 'string');
    assert.ok(['documents', 'excel', 'ppt', 'images', 'videos', 'audio', 'other'].includes(it.category));
    assert.ok(typeof it.sizeBytes === 'number');
    assert.ok(typeof it.mimeType === 'string');
    assert.ok(typeof it.createdAt === 'number');
    assert.ok(typeof it.updatedAt === 'number');
  }
});

test('shim: drive list --category filters to that category', async () => {
  const lines = await run(['drive', 'list', '--category', 'images']);
  const items = lines.map((l) => JSON.parse(l)).filter((x) => !x.type);
  for (const it of items) {
    assert.equal(it.category, 'images');
  }
});

test('shim: drive list --category audio returns only audio items', async () => {
  const lines = await run(['drive', 'list', '--category', 'audio']);
  const items = lines.map((l) => JSON.parse(l)).filter((x) => !x.type);
  for (const it of items) {
    assert.equal(it.category, 'audio');
  }
  assert.ok(items.length >= 1);
});

test('shim: drive get <id> emits a {type:"file"} row with content + done', async () => {
  const lines = await run(['drive', 'get', 'drv_doc_1']);
  const parsed = lines.map((l) => JSON.parse(l));
  const file = parsed.find((p) => p.type === 'file');
  assert.ok(file);
  assert.equal(file.id, 'drv_doc_1');
  assert.equal(file.category, 'documents');
  assert.ok(typeof file.content === 'string' && file.content.length > 0);
  assert.ok(file.contentIsBase64 === true);
  const last = parsed[parsed.length - 1];
  assert.equal(last.type, 'done');
});

test('shim: drive get with unknown id exits non-zero', async () => {
  // The shim's `run` helper rejects on non-zero exit, so we expect a
  // rejection here. The shim emits no file row when the id is unknown.
  await assert.rejects(() => run(['drive', 'get', 'nope_unknown']));
});

test('shim: drive delete <id> emits {type:"deleted"} + done', async () => {
  const lines = await run(['drive', 'delete', 'drv_img_1']);
  const parsed = lines.map((l) => JSON.parse(l));
  const deleted = parsed.find((p) => p.type === 'deleted');
  assert.ok(deleted);
  assert.equal(deleted.id, 'drv_img_1');
  const last = parsed[parsed.length - 1];
  assert.equal(last.type, 'done');
});

// --------------------------------------------------------------- cron (Fase 4)

test('shim: cron list emits 3 mock crons (enabled, enabled, disabled)', async () => {
  const lines = await run(['cron', 'list']);
  const items = lines.map((l) => JSON.parse(l)).filter((x) => !x.type);
  assert.equal(items.length, 3);
  // 2 enabled + 1 disabled
  const enabled = items.filter((i) => i.enabled === true).length;
  const disabled = items.filter((i) => i.enabled === false).length;
  assert.equal(enabled, 2);
  assert.equal(disabled, 1);
  // The funny name is present.
  assert.ok(items.find((i) => /Morning standup summary/i.test(i.name)));
});

test('shim: cron list each row has the canonical shape', async () => {
  const lines = await run(['cron', 'list']);
  const items = lines.map((l) => JSON.parse(l)).filter((x) => !x.type);
  for (const c of items) {
    assert.ok(typeof c.id === 'string');
    assert.ok(typeof c.name === 'string');
    assert.ok(typeof c.schedule === 'string');
    assert.ok(typeof c.prompt === 'string');
    assert.ok(typeof c.agent === 'string');
    assert.equal(typeof c.enabled, 'boolean');
  }
});

test('shim: cron create emits a {type:"cron"} row with id + done', async () => {
  const lines = await run([
    'cron', 'create',
    '--name', 'Test cron',
    '--schedule', '0 9 * * *',
    '--prompt', 'say hi',
    '--agent', 'mavis',
  ]);
  const parsed = lines.map((l) => JSON.parse(l));
  const created = parsed.find((p) => p.type === 'cron');
  assert.ok(created);
  assert.equal(created.name, 'Test cron');
  assert.equal(created.schedule, '0 9 * * *');
  assert.equal(created.prompt, 'say hi');
  assert.equal(created.agent, 'mavis');
  assert.equal(created.enabled, true);
  assert.match(created.id, /^cron_/);
  assert.ok(typeof created.nextRunAt === 'string' && created.nextRunAt.length > 0);
  const last = parsed[parsed.length - 1];
  assert.equal(last.type, 'done');
});

test('shim: cron create with --disabled emits enabled=false', async () => {
  const lines = await run([
    'cron', 'create',
    '--name', 'Off cron',
    '--schedule', '0 9 * * *',
    '--prompt', 'p',
    '--agent', 'mavis',
    '--disabled',
  ]);
  const parsed = lines.map((l) => JSON.parse(l));
  const created = parsed.find((p) => p.type === 'cron');
  assert.ok(created);
  assert.equal(created.enabled, false);
});

test('shim: cron create without required args exits with non-zero', async () => {
  // Shim rejects missing required args (exit code 2).
  await assert.rejects(() => run(['cron', 'create', '--name', 'x']));
});

test('shim: cron enable <id> emits {type:"cron"} with enabled=true', async () => {
  const lines = await run(['cron', 'enable', 'cron_disabled']);
  const parsed = lines.map((l) => JSON.parse(l));
  const updated = parsed.find((p) => p.type === 'cron');
  assert.ok(updated);
  assert.equal(updated.id, 'cron_disabled');
  assert.equal(updated.enabled, true);
});

test('shim: cron disable <id> emits {type:"cron"} with enabled=false', async () => {
  const lines = await run(['cron', 'disable', 'cron_morning']);
  const parsed = lines.map((l) => JSON.parse(l));
  const updated = parsed.find((p) => p.type === 'cron');
  assert.ok(updated);
  assert.equal(updated.id, 'cron_morning');
  assert.equal(updated.enabled, false);
});

test('shim: cron delete <id> emits {type:"deleted"} + done', async () => {
  const lines = await run(['cron', 'delete', 'cron_morning']);
  const parsed = lines.map((l) => JSON.parse(l));
  const deleted = parsed.find((p) => p.type === 'deleted');
  assert.ok(deleted);
  assert.equal(deleted.id, 'cron_morning');
  const last = parsed[parsed.length - 1];
  assert.equal(last.type, 'done');
});

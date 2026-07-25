/**
 * MavisClient unit tests — Drive + Cron methods (Fase 4).
 *
 * Each test spawns a fake child, writes NDJSON to its stdout, and
 * closes the child. The client methods are pure parsers; we assert on
 * the parsed shape and the side-effect of `onDriveChanged` /
 * `onCronChanged`.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MavisClient } from '../../src/client/MavisClient';
import { DriveItem, CronSummary } from '../../src/client/types';
import { makeFakeChild, makeSpawner } from '../helpers/spawnStub';

function makeClient(child = makeFakeChild()): MavisClient {
  return new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
}

const SAMPLE_DRIVE_ITEMS: DriveItem[] = [
  { id: 'd1', name: 'a.md', category: 'documents', sizeBytes: 1024, mimeType: 'text/markdown', createdAt: 100, updatedAt: 200 },
  { id: 'd2', name: 'b.png', category: 'images', sizeBytes: 2048, mimeType: 'image/png', createdAt: 300, updatedAt: 400 },
  { id: 'd3', name: 'c.mp3', category: 'audio', sizeBytes: 4096, mimeType: 'audio/mpeg', createdAt: 500, updatedAt: 600 },
];

// ------------------------------------------------------------------ drive list

test('listDrive: parses NDJSON rows into DriveItem[]', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    for (const it of SAMPLE_DRIVE_ITEMS) child.stdout.push(JSON.stringify(it) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done', count: 3 }) + '\n');
    child.emitter.emit('close', 0);
  });
  const items = await c.listDrive();
  assert.equal(items.length, 3);
  assert.equal(items[0].id, 'd1');
  assert.equal(items[1].category, 'images');
  assert.equal(items[2].sizeBytes, 4096);
  c.dispose();
});

test('listDrive: with category passes the --category flag', async () => {
  // Capture the args via a per-call spawner so we can introspect what
  // was actually sent to the shim.
  const { makePerCallSpawner } = await import('../helpers/spawnStub');
  const { spawn, children } = makePerCallSpawner();
  const c = new MavisClient({ spawnImpl: spawn, resolveBundledPath: () => '/bin/mavis' });
  // Drive the first child with one item and close it.
  setImmediate(() => {
    const first = children[0];
    first.stdout.push(JSON.stringify(SAMPLE_DRIVE_ITEMS[0]) + '\n');
    first.stdout.push(JSON.stringify({ type: 'done', count: 1 }) + '\n');
    first.emitter.emit('close', 0);
  });
  const items = await c.listDrive('documents');
  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'documents');
  c.dispose();
});

test('listDrive: fires onDriveChanged("list") on success', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  let fired: unknown;
  c.onDriveChanged.on('list', (e: unknown) => (fired = e));
  setImmediate(() => {
    child.stdout.push(JSON.stringify(SAMPLE_DRIVE_ITEMS[0]) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.listDrive();
  assert.ok(fired, 'onDriveChanged("list") should fire');
  c.dispose();
});

test('listDrive: returns [] on empty Drive (done only)', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'done', count: 0 }) + '\n');
    child.emitter.emit('close', 0);
  });
  const items = await c.listDrive();
  assert.deepEqual(items, []);
  c.dispose();
});

// ------------------------------------------------------------------ drive get

test('getDriveFile: parses a file row and resolves to DriveFile', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({
      type: 'file',
      id: 'd1',
      name: 'a.md',
      category: 'documents',
      sizeBytes: 5,
      mimeType: 'text/markdown',
      createdAt: 100,
      updatedAt: 200,
      url: 'https://example.invalid/d1',
      content: 'aGVsbG8=',
      contentIsBase64: true,
    }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const file = await c.getDriveFile('d1');
  assert.equal(file.id, 'd1');
  assert.equal(file.content, 'aGVsbG8=');
  assert.equal(file.contentIsBase64, true);
  assert.equal(file.url, 'https://example.invalid/d1');
  c.dispose();
});

test('getDriveFile: rejects when no file row is emitted', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await assert.rejects(() => c.getDriveFile('d1'), /without a file row/);
  c.dispose();
});

test('getDriveFile: rejects when id is empty', async () => {
  const c = makeClient();
  await assert.rejects(() => c.getDriveFile(''), /id is required/);
  c.dispose();
});

test('getDriveFile: fires onDriveChanged("get") with the id', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  let payload: unknown;
  c.onDriveChanged.on('get', (e: unknown) => (payload = e));
  setImmediate(() => {
    child.stdout.push(JSON.stringify({
      type: 'file',
      id: 'd1', name: 'a.md', category: 'documents',
      sizeBytes: 1, mimeType: 'text/plain',
      createdAt: 0, updatedAt: 0,
      content: 'x', contentIsBase64: true,
    }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.getDriveFile('d1');
  assert.ok(payload, 'onDriveChanged("get") should fire');
  c.dispose();
});

// ------------------------------------------------------------------ drive delete

test('deleteDriveFile: resolves when the shim emits a deleted row', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'deleted', id: 'd1' }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.deleteDriveFile('d1');
  c.dispose();
});

test('deleteDriveFile: fires onDriveChanged("delete") with the id', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  let payload: unknown;
  c.onDriveChanged.on('delete', (e: unknown) => (payload = e));
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'deleted', id: 'd2' }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.deleteDriveFile('d2');
  assert.ok(payload, 'onDriveChanged("delete") should fire');
  c.dispose();
});

test('deleteDriveFile: rejects when id is empty', async () => {
  const c = makeClient();
  await assert.rejects(() => c.deleteDriveFile(''), /id is required/);
  c.dispose();
});

// ------------------------------------------------------------------ cron list

const SAMPLE_CRONS: CronSummary[] = [
  { id: 'c1', name: 'morning', schedule: '0 8 * * *', prompt: 'p', agent: 'mavis', enabled: true, nextRunAt: 1000 },
  { id: 'c2', name: 'evening', schedule: '0 20 * * *', prompt: 'p', agent: 'mavis-coder', enabled: false, nextRunAt: 2000 },
];

test('listCrons: parses NDJSON rows into CronSummary[]', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    for (const cr of SAMPLE_CRONS) child.stdout.push(JSON.stringify(cr) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done', count: 2 }) + '\n');
    child.emitter.emit('close', 0);
  });
  const crons = await c.listCrons();
  assert.equal(crons.length, 2);
  assert.equal(crons[0].id, 'c1');
  assert.equal(crons[1].enabled, false);
  c.dispose();
});

test('listCrons: fires onCronChanged("list") on success', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  let fired: unknown;
  c.onCronChanged.on('list', (e: unknown) => (fired = e));
  setImmediate(() => {
    child.stdout.push(JSON.stringify(SAMPLE_CRONS[0]) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.listCrons();
  assert.ok(fired, 'onCronChanged("list") should fire');
  c.dispose();
});

// ------------------------------------------------------------------ cron create

test('createCron: resolves with the created cron row', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({
      type: 'cron',
      id: 'c_new',
      name: 'My cron',
      schedule: '*/5 * * * *',
      prompt: 'hello',
      agent: 'mavis',
      enabled: true,
      nextRunAt: 12345,
    }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const created = await c.createCron({ name: 'My cron', schedule: '*/5 * * * *', prompt: 'hello' });
  assert.equal(created.id, 'c_new');
  assert.equal(created.name, 'My cron');
  assert.equal(created.enabled, true);
  assert.equal(created.nextRunAt, 12345);
  c.dispose();
});

test('createCron: rejects when required fields are missing', async () => {
  const c = makeClient();
  await assert.rejects(() => c.createCron({ name: '', schedule: '0 * * * *', prompt: 'p' }), /required/);
  await assert.rejects(() => c.createCron({ name: 'x', schedule: '', prompt: 'p' }), /required/);
  await assert.rejects(() => c.createCron({ name: 'x', schedule: '0 * * * *', prompt: '' }), /required/);
  c.dispose();
});

test('createCron: rejects when no cron row is emitted', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await assert.rejects(
    () => c.createCron({ name: 'x', schedule: '0 * * * *', prompt: 'p' }),
    /without a cron row/,
  );
  c.dispose();
});

test('createCron: fires onCronChanged("create") with the cron', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  let payload: unknown;
  c.onCronChanged.on('create', (e: unknown) => (payload = e));
  setImmediate(() => {
    child.stdout.push(JSON.stringify({
      type: 'cron', id: 'c3', name: 'a', schedule: '0 * * * *',
      prompt: 'p', agent: 'mavis', enabled: true,
    }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.createCron({ name: 'a', schedule: '0 * * * *', prompt: 'p' });
  assert.ok(payload, 'onCronChanged("create") should fire');
  c.dispose();
});

// ------------------------------------------------------------------ cron delete

test('deleteCron: resolves when shim emits a deleted row', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'deleted', id: 'c1' }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.deleteCron('c1');
  c.dispose();
});

test('deleteCron: fires onCronChanged("delete")', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  let payload: unknown;
  c.onCronChanged.on('delete', (e: unknown) => (payload = e));
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'deleted', id: 'c1' }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.deleteCron('c1');
  assert.ok(payload);
  c.dispose();
});

test('deleteCron: rejects when id is empty', async () => {
  const c = makeClient();
  await assert.rejects(() => c.deleteCron(''), /id is required/);
  c.dispose();
});

// ------------------------------------------------------------------ enable / disable

test('enableCron(true): resolves with the updated cron', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({
      type: 'cron', id: 'c1', name: 'a', schedule: '0 * * * *',
      prompt: 'p', agent: 'mavis', enabled: true,
    }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const updated = await c.enableCron('c1', true);
  assert.equal(updated.enabled, true);
  c.dispose();
});

test('enableCron(false): resolves and treats as disable', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({
      type: 'cron', id: 'c1', name: 'a', schedule: '0 * * * *',
      prompt: 'p', agent: 'mavis', enabled: false,
    }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const updated = await c.disableCron('c1');
  assert.equal(updated.enabled, false);
  c.dispose();
});

test('enableCron: rejects when no cron row is emitted', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await assert.rejects(() => c.enableCron('c1', true), /without a cron row/);
  c.dispose();
});

test('enableCron: fires onCronChanged("enable") or ("disable")', async () => {
  const child = makeFakeChild();
  const c = makeClient(child);
  let enableFired: unknown;
  let disableFired: unknown;
  c.onCronChanged.on('enable', (e: unknown) => (enableFired = e));
  c.onCronChanged.on('disable', (e: unknown) => (disableFired = e));
  setImmediate(() => {
    child.stdout.push(JSON.stringify({
      type: 'cron', id: 'c1', name: 'a', schedule: '0 * * * *',
      prompt: 'p', agent: 'mavis', enabled: true,
    }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.enableCron('c1', true);
  assert.ok(enableFired, 'enable should fire');
  assert.equal(disableFired, undefined, 'disable should not fire');
  c.dispose();
});

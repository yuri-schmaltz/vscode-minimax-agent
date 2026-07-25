/**
 * MavisClient unit tests.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MavisClient } from '../../src/client/MavisClient';
import { AgentSummary, StreamEvent } from '../../src/client/types';
import { makeFakeChild, makeSpawner } from '../helpers/spawnStub';

test('resolveBinary returns settings override when provided', () => {
  const c = new MavisClient({ cliPath: '/opt/custom/mavis', spawnImpl: makeSpawner(makeFakeChild()) });
  assert.equal(c.resolveBinary(), '/opt/custom/mavis');
});

test('resolveBinary falls back to bundled path', () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/ext/resources/mavis-cli/mavis.cjs',
  });
  assert.equal(c.resolveBinary(), '/ext/resources/mavis-cli/mavis.cjs');
});

test('resolveBinary throws when nothing is configured', () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '',
  });
  assert.throws(() => c.resolveBinary(), /CLI not found/);
});

test('streamSession parses NDJSON and emits typed events', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  const received: StreamEvent[] = [];
  const handle = c.streamSession('sess_1', {
    message: (e) => received.push(e),
    done: (e) => received.push(e),
  });
  child.stdout.push(JSON.stringify({ type: 'ready', sessionId: 'sess_1' }) + '\n');
  child.stdout.push(JSON.stringify({ type: 'message', role: 'assistant', content: 'hello', sessionId: 'sess_1' }) + '\n');
  child.stdout.push(JSON.stringify({ type: 'message', role: 'assistant', content: ' world', sessionId: 'sess_1' }) + '\n');
  child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');

  // Wait for the event loop to flush.
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(received.length >= 3, `expected >=3 events, got ${received.length}`);
  const assistantMsgs = received.filter((e) => e.type === 'message') as Array<{ type: 'message'; content: string }>;
  assert.equal(assistantMsgs[0].content, 'hello');
  assert.equal(assistantMsgs[1].content, ' world');
  handle.close();
  c.dispose();
});

test('sendPrompt writes a JSON prompt line on stdin', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  const handle = c.streamSession('sess_2', {});
  handle.sendPrompt('hi there');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(handle, 'handle should exist');
  handle.close();
  c.dispose();
});

test('sendPrompt actually emits a JSON-line on a custom stdin', async () => {
  const { Writable } = await import('node:stream');
  const recorded: string[] = [];
  const recording = new Writable({
    write(chunk: Buffer, _enc, cb) {
      recorded.push(chunk.toString('utf8'));
      cb();
    },
  });
  const child = makeFakeChild();
  child.stdin = recording;
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  const handle = c.streamSession('sess_2b', {});
  handle.sendPrompt('hi there');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(recorded.length, 1);
  const parsed = JSON.parse(recorded[0].trim());
  assert.equal(parsed.type, 'prompt');
  assert.equal(parsed.text, 'hi there');
  handle.close();
  c.dispose();
});

test('child error emits an "error" event on the handle', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  let err: StreamEvent | undefined;
  const handle = c.streamSession('sess_3', { error: (e) => (err = e) });
  child.emitter.emit('error', new Error('spawn failed'));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(err, 'expected an error event');
  assert.equal(err!.type, 'error');
  handle.close();
  c.dispose();
});

test('dispose kills all running streams', () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  c.streamSession('sess_4', {});
  c.streamSession('sess_5', {});
  c.dispose();
  assert.equal(child.killed, true);
});

test('listAgents parses NDJSON into AgentSummary[]', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ id: 'a', name: 'A', description: '', model: 'm', isDefault: true } satisfies AgentSummary) + '\n');
    child.stdout.push(JSON.stringify({ id: 'b', name: 'B', description: '', model: 'm', isDefault: false } satisfies AgentSummary) + '\n');
    child.emitter.emit('close', 0);
  });
  const agents = await c.listAgents();
  assert.equal(agents.length, 2);
  assert.equal(agents[0].id, 'a');
  assert.equal(agents[1].id, 'b');
  c.dispose();
});

test('listSessions returns empty array when CLI emits only "done"', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'done', count: 0 }) + '\n');
    child.emitter.emit('close', 0);
  });
  const sessions = await c.listSessions();
  assert.deepEqual(sessions, []);
  c.dispose();
});

test('setActiveAgent fires contextChanged', () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/bin/mavis',
  });
  let agent: string | undefined;
  c.onContextChanged.on('agent', (a: string) => (agent = a));
  c.setActiveAgent('mavis-coder');
  assert.equal(agent, 'mavis-coder');
  assert.equal(c.getActiveAgent(), 'mavis-coder');
  c.dispose();
});

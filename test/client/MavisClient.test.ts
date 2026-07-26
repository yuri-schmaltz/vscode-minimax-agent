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

test('setActiveSession fires contextChanged and onSessionSwitched', () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/bin/mavis',
  });
  let ctxSession: string | undefined;
  let switched: string | undefined;
  c.onContextChanged.on('session', (s: string | undefined) => (ctxSession = s));
  c.onSessionSwitched.on('session', ((id: string) => (switched = id)) as unknown as (...args: unknown[]) => void);
  c.setActiveSession('sess_xyz');
  assert.equal(ctxSession, 'sess_xyz');
  assert.equal(switched, 'sess_xyz');
  assert.equal(c.getActiveSession(), 'sess_xyz');
  c.dispose();
});

test('setActiveSession is a no-op when id is unchanged', () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/bin/mavis',
  });
  c.setActiveSession('sess_abc');
  let count = 0;
  c.onContextChanged.on('session', () => count++);
  c.setActiveSession('sess_abc');
  assert.equal(count, 0);
  c.dispose();
});

test('createSession parses the {type:"session"} event and resolves', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'session', id: 'sess_new', agent: 'mavis', title: 'hi', createdAt: 1234 }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done', count: 1 }) + '\n');
    child.emitter.emit('close', 0);
  });
  const created = await c.createSession('mavis');
  assert.equal(created.id, 'sess_new');
  assert.equal(created.agent, 'mavis');
  assert.equal(created.title, 'hi');
  assert.equal(created.createdAt, 1234);
  c.dispose();
});

test('createSession fires onSessionCreated', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  let received: { id: string; agent: string } | undefined;
  c.onSessionCreated.on('session', ((e: unknown) => {
    const r = e as { id: string; agent: string };
    received = { id: r.id, agent: r.agent };
  }) as unknown as (...args: unknown[]) => void);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'session', id: 'sess_event', agent: 'mavis', title: '', createdAt: 0 }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await c.createSession();
  assert.ok(received, 'expected onSessionCreated to fire');
  assert.equal(received!.id, 'sess_event');
  assert.equal(received!.agent, 'mavis');
  c.dispose();
});

test('createSession defaults the agent to the active agent when none provided', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
    defaultAgent: 'mavis-coder',
  });
  let receivedAgent: string | undefined;
  c.onSessionCreated.on('session', ((e: unknown) => {
    receivedAgent = (e as { agent: string }).agent;
  }) as unknown as (...args: unknown[]) => void);
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'session', id: 'sess_x', agent: 'mavis-coder', title: '', createdAt: 0 }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const created = await c.createSession();
  assert.equal(created.agent, 'mavis-coder');
  assert.equal(receivedAgent, 'mavis-coder');
  c.dispose();
});

test('createSession rejects when the shim exits without a session row', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  await assert.rejects(() => c.createSession(), /without a session row/);
  c.dispose();
});

test('switchSession emits contextChanged and resolves with the new id', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  let agent: string | undefined;
  let session: string | undefined;
  c.onContextChanged.on('agent', (a: string) => (agent = a));
  c.onContextChanged.on('session', (s: string | undefined) => (session = s));
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'contextChanged', sessionId: 'sess_sw', agent: 'mavis-coder' }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const id = await c.switchSession('sess_sw');
  assert.equal(id, 'sess_sw');
  assert.equal(agent, 'mavis-coder');
  assert.equal(session, 'sess_sw');
  c.dispose();
});

test('switchSession is a no-op when id is unchanged', async () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/bin/mavis',
  });
  c.setActiveSession('sess_same');
  // Second call must not spawn anything (no events to assert on here,
  // but the no-op path returns the id without a child process).
  const id = await c.switchSession('sess_same');
  assert.equal(id, 'sess_same');
  c.dispose();
});

test('switchAgent sets the active agent and creates a new session', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
    defaultAgent: 'mavis',
  });
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'session', id: 'sess_newagent', agent: 'mavis-coder', title: '', createdAt: 0 }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const session = await c.switchAgent('mavis-coder');
  assert.equal(session.id, 'sess_newagent');
  assert.equal(session.agent, 'mavis-coder');
  assert.equal(c.getActiveAgent(), 'mavis-coder');
  c.dispose();
});

test('createCodeActionTask resolves with a patch for "refactor"', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'patch', file: 'foo.ts', diff: '--- a\n+++ b\n@@\n+// ok\n' }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const task = c.createCodeActionTask('refactor', 'fix it', 'foo.ts');
  const result = await task.result;
  assert.equal(result.kind, 'patch');
  if (result.kind === 'patch') {
    assert.equal(result.file, 'foo.ts');
    assert.match(result.diff, /\/\/ ok/);
  }
  c.dispose();
});

test('createCodeActionTask resolves with a text result for "explain"', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'text', text: 'this does X' }) + '\n');
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const task = c.createCodeActionTask('explain', 'why', 'bar.ts');
  const result = await task.result;
  assert.equal(result.kind, 'text');
  if (result.kind === 'text') {
    assert.match(result.text, /this does X/);
  }
  c.dispose();
});

test('createCodeActionTask rejects when no result row is emitted', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  setImmediate(() => {
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n');
    child.emitter.emit('close', 0);
  });
  const task = c.createCodeActionTask('refactor', 'x', 'foo.ts');
  await assert.rejects(() => task.result, /without a result row/);
  c.dispose();
});

test('createCodeActionTask.cancel() is idempotent', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  const task = c.createCodeActionTask('refactor', 'x', 'foo.ts');
  assert.doesNotThrow(() => {
    task.cancel();
    task.cancel();
    task.cancel();
  });
  c.dispose();
});

test('setApiKey + getApiKey round-trip', () => {
  const c = new MavisClient({ spawnImpl: makeSpawner(makeFakeChild()), resolveBundledPath: () => '/bin/mavis' });
  assert.equal(c.getApiKey(), undefined);
  c.setApiKey('sk-cp-test');
  assert.equal(c.getApiKey(), 'sk-cp-test');
  c.setApiKey('');
  assert.equal(c.getApiKey(), undefined);
  c.dispose();
});

test('spawnEnv passes MAVIS_API_KEY + MAVIS_MODEL + MAVIS_API_BASE to the child', () => {
  let captured: NodeJS.ProcessEnv | undefined;
  const c = new MavisClient({
    spawnImpl: ((_bin: string, _args: string[], opts: unknown) => {
      captured = (opts as { env: NodeJS.ProcessEnv }).env;
      return makeFakeChild();
    }) as never,
    archonUrl: 'https://api.minimax.io',
    apiBase: '/v1',
    model: 'MiniMax-M3',
    apiKey: 'sk-cp-test',
    resolveBundledPath: () => '/bin/mavis',
  });
  c.listSessions().catch(() => undefined);
  assert.equal(captured?.MAVIS_API_KEY, 'sk-cp-test');
  assert.equal(captured?.MAVIS_MODEL, 'MiniMax-M3');
  assert.equal(captured?.MAVIS_API_BASE, '/v1');
  assert.equal(captured?.MAVIS_ARCHON_URL, 'https://api.minimax.io');
  c.dispose();
});

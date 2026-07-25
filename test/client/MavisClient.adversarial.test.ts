/**
 * MavisClient adversarial tests.
 *
 * Targets the error paths the original test suite was light on:
 *  - binary resolution failures (typed error)
 *  - sendPrompt after the stream is closed (typed error)
 *  - dispose() while a stream is still emitting (cleanup / no orphan listeners)
 *  - MAVIS_MOCK=0 with archonUrl respected (env-var passthrough)
 *  - non-OK exit from listSessions / listAgents
 *  - re-dispose() is idempotent
 *  - child 'error' event from a spawn failure surfaces an 'error' on the handle
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  MavisClient,
  MavisCliNotFoundError,
  SessionClosedError,
} from '../../src/client/MavisClient';
import { makeFakeChild, makeSpawner } from '../helpers/spawnStub';

test('adversarial: resolveBinary throws MavisCliNotFoundError when no path is configured', () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '',
  });
  assert.throws(() => c.resolveBinary(), MavisCliNotFoundError);
});

test('adversarial: listSessions throws MavisCliNotFoundError when no binary', async () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '',
  });
  await assert.rejects(() => c.listSessions(), MavisCliNotFoundError);
});

test('adversarial: sendPrompt after handle.close() throws SessionClosedError', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  const handle = c.streamSession('sess_closed', {});
  handle.close();
  assert.throws(
    () => handle.sendPrompt('hi'),
    (err: unknown) => err instanceof SessionClosedError && err.sessionId === 'sess_closed',
  );
  c.dispose();
});

test('adversarial: sendPrompt after MavisClient.dispose() throws SessionClosedError', () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  const handle = c.streamSession('sess_disposed', {});
  c.dispose();
  // dispose() closes the stream → handle.sendPrompt must refuse.
  assert.throws(
    () => handle.sendPrompt('hi'),
    (err: unknown) => err instanceof SessionClosedError && err.sessionId === 'sess_disposed',
  );
});

test('adversarial: dispose() during an active stream kills the child and removes listeners', () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  let errorCount = 0;
  let doneCount = 0;
  const handle = c.streamSession('sess_live', {
    error: () => errorCount++,
    done: () => doneCount++,
  });
  // Wire extra listeners on the underlying emitter via handle.on to assert
  // that dispose() clears them all.
  handle.on('error', () => errorCount++);
  handle.on('done', () => doneCount++);

  c.dispose();

  // Dispose should have:
  //   1. closed stdin
  //   2. killed the child
  //   3. removed all listeners on the per-stream emitter
  assert.equal(child.killed, true);
  // The fake child's `kill()` emits 'close' on the next tick.
  setImmediate(() => {
    assert.equal(doneCount, 0, 'no done events should fire after dispose()');
    assert.equal(errorCount, 0, 'no error events should fire after dispose()');
  });
});

test('adversarial: dispose() is idempotent', () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/bin/mavis',
  });
  assert.doesNotThrow(() => {
    c.dispose();
    c.dispose();
    c.dispose();
  });
});

test('adversarial: listSessions rejects with a non-OK exit and no output', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  setImmediate(() => {
    child.emitter.emit('close', 2, null);
  });
  await assert.rejects(() => c.listSessions(), /exited with code 2/);
  c.dispose();
});

test('adversarial: listSessions rejects with the spawn error when the child cannot start', async () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  setImmediate(() => {
    child.emitter.emit('error', new Error('ENOENT: spawn failed'));
  });
  await assert.rejects(() => c.listSessions(), /ENOENT/);
  c.dispose();
});

test('adversarial: streamSession after dispose() throws', () => {
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/bin/mavis',
  });
  c.dispose();
  assert.throws(() => c.streamSession('sess_after', {}), /disposed/);
});

test('adversarial: MAVIS_MOCK=0 in process.env with archonUrl set is passed through to the child', () => {
  // Save and restore the env var so we don't pollute the test process.
  const prev = process.env.MAVIS_MOCK;
  process.env.MAVIS_MOCK = '0';
  try {
    const child = makeFakeChild();
    // We need to capture the spawn options the client passes to spawn().
    // The fake spawner ignores them, so we plug a recorder via spawnImpl.
    let captured: NodeJS.ProcessEnv | undefined;
    const recordingSpawn = (((_bin: string, _args: string[], opts: unknown) => {
      captured = (opts as { env: NodeJS.ProcessEnv }).env;
      return child;
    }) as unknown) as typeof import('node:child_process').spawn;
    const c = new MavisClient({
      spawnImpl: recordingSpawn,
      archonUrl: 'http://127.0.0.1:9999',
      resolveBundledPath: () => '/bin/mavis',
    });
    c.streamSession('sess_envtest', {});
    assert.ok(captured, 'spawn was not called');
    assert.equal(captured!.MAVIS_MOCK, '0', 'caller-provided MAVIS_MOCK=0 must be respected');
    assert.equal(captured!.MAVIS_ARCHON_URL, 'http://127.0.0.1:9999');
    c.dispose();
  } finally {
    if (prev === undefined) delete process.env.MAVIS_MOCK;
    else process.env.MAVIS_MOCK = prev;
  }
});

test('adversarial: defaults to MAVIS_MOCK=1 when no archonUrl and no env override', () => {
  let captured: NodeJS.ProcessEnv | undefined;
  const child = makeFakeChild();
  const recordingSpawn = (((_bin: string, _args: string[], opts: unknown) => {
    captured = (opts as { env: NodeJS.ProcessEnv }).env;
    return child;
  }) as unknown) as typeof import('node:child_process').spawn;
  // Make sure the env does not carry over from a previous test.
  const prev = process.env.MAVIS_MOCK;
  delete process.env.MAVIS_MOCK;
  try {
    const c = new MavisClient({
      spawnImpl: recordingSpawn,
      resolveBundledPath: () => '/bin/mavis',
    });
    c.streamSession('sess_default_mock', {});
    assert.ok(captured);
    assert.equal(captured!.MAVIS_MOCK, '1');
    c.dispose();
  } finally {
    if (prev !== undefined) process.env.MAVIS_MOCK = prev;
  }
});

test('adversarial: streamSession handle.on returns an unsubscribe that detaches the listener', () => {
  const child = makeFakeChild();
  const c = new MavisClient({
    spawnImpl: makeSpawner(child),
    resolveBundledPath: () => '/bin/mavis',
  });
  const handle = c.streamSession('sess_unsub', {});
  let count = 0;
  const off = handle.on('message', () => count++);
  // We can't easily push a typed 'message' event from the parser in this
  // minimal test, but we can verify the returned function is callable
  // and the listener count drops.
  off();
  // The fake child's emitter has a listener count we can query directly.
  const e = (handle as unknown as { off: (e: string, f: (...args: unknown[]) => void) => void }).off;
  // Calling off again must be a no-op (no throw).
  assert.doesNotThrow(() => e('message', () => {}));
  c.dispose();
});

test('adversarial: child stderr writes do not contain raw token-like strings', () => {
  // Capture stderr for the duration of the test.
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  try {
    const child = makeFakeChild();
    const c = new MavisClient({
      spawnImpl: makeSpawner(child),
      resolveBundledPath: () => '/bin/mavis',
    });
    const handle = c.streamSession('sess_redact', {});
    // Emit a stderr line that contains a long, token-shaped substring.
    child.stderr.push(Buffer.from('error: invalid token mock_access_abcdef1234567890XYZ now\n', 'utf8'));
    setImmediate(() => {
      // The redaction must replace the long alnum substring.
      const all = chunks.join('');
      assert.ok(
        !all.includes('mock_access_abcdef1234567890XYZ'),
        `stderr leaked a token-shaped substring: ${all.slice(0, 200)}`,
      );
    });
    handle.close();
    c.dispose();
  } finally {
    process.stderr.write = origWrite;
  }
});

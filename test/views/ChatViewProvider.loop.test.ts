// Tests for B.6+ loop functionality in ChatViewProvider.
//
// The /loop command starts an iteration: the host re-sends the
// same prompt N times after each `done` event, so the model sees
// its previous work and refines. After the last iteration (or a
// cancelLoop), the loop is closed and a `loopStatus` `done` (or
// `cancelled`) message is posted to the webview.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChatViewProvider, ChatViewDeps as ChatDeps } from '../../src/views/ChatViewProvider';
import { StreamHandle } from '../../src/client/types';

function makeDeps(): ChatDeps & { posts: Array<Record<string, unknown>>; handle?: StreamHandle } {
  const posts: Array<Record<string, unknown>> = [];
  const handle: StreamHandle = {
    sendPrompt: () => {},
    cancel: () => {},
    on: () => {},
  } as unknown as StreamHandle;
  const deps: ChatDeps = {
    client: {
      getApiKey: () => 'sk-test',
      setActiveSession: () => {},
      setActiveAgent: () => {},
      streamSession: () => handle,
    } as unknown as ChatDeps['client'],
    newSessionId: () => 'sess_test_' + Math.random().toString(36).slice(2, 8),
    defaultAgent: 'mavis',
    onLog: () => {},
    getTools: () => [],
    getAvailableModels: () => ['MiniMax-M3'],
    getAgents: () => [{ name: 'mavis', description: 'default', model: 'MiniMax-M3', systemPrompt: '', tools: ['all'] }],
    onOpenSettings: () => {},
  } as unknown as ChatDeps;
  return Object.assign(deps, { posts, handle }) as unknown as ChatDeps & { posts: Array<Record<string, unknown>>; handle?: StreamHandle };
}

test('loopPrompt: starts a loop and sends the first prompt', async () => {
  const deps = makeDeps();
  const provider = new ChatViewProvider({ extensionPath: "/ext", extensionUri: {}, subscriptions: [], secrets: {} } as never, deps);
  // Mock currentSession
  (provider as unknown as { currentSession: { id: string } }).currentSession = { id: 'sess_1' };
  // Mock currentHandle
  (provider as unknown as { currentHandle: StreamHandle | null | undefined }).currentHandle = deps.handle;
  // Mock the postToWebview to capture messages
  const posts: Array<Record<string, unknown>> = [];
  (provider as unknown as { postToWebview: (m: unknown) => void }).postToWebview = (m) => posts.push(m as Record<string, unknown>);

  // Simulate a webview message
  await (provider as unknown as { handleWebviewMessage: (m: unknown) => Promise<void> }).handleWebviewMessage({
    type: 'loopPrompt',
    sessionId: 'sess_1',
    text: 'refactor fib',
    iterations: 3,
  });

  // Should have a loopStatus running and a userMessage
  const loopStatus = posts.find((p) => p.type === 'loopStatus') as { iteration: number; total: number; status: string } | undefined;
  assert.ok(loopStatus, 'expected a loopStatus message');
  assert.equal(loopStatus.iteration, 0);
  assert.equal(loopStatus.total, 3);
  assert.equal(loopStatus.status, 'running');
  const userMessage = posts.find((p) => p.type === 'userMessage') as { msg: { text: string } } | undefined;
  assert.ok(userMessage, 'expected a userMessage echo');
  assert.equal(userMessage.msg.text, 'refactor fib');
});

test('loopPrompt: clamps iterations to [1, 10]', async () => {
  const deps = makeDeps();
  const provider = new ChatViewProvider({ extensionPath: "/ext", extensionUri: {}, subscriptions: [], secrets: {} } as never, deps);
  (provider as unknown as { currentSession: { id: string } }).currentSession = { id: 'sess_1' };
  (provider as unknown as { currentHandle: StreamHandle | null | undefined }).currentHandle = deps.handle;
  const posts: Array<Record<string, unknown>> = [];
  (provider as unknown as { postToWebview: (m: unknown) => void }).postToWebview = (m) => posts.push(m as Record<string, unknown>);

  await (provider as unknown as { handleWebviewMessage: (m: unknown) => Promise<void> }).handleWebviewMessage({
    type: 'loopPrompt',
    sessionId: 'sess_1',
    text: 'task',
    iterations: 50,
  });
  const loopStatus = posts.find((p) => p.type === 'loopStatus') as { total: number };
  assert.equal(loopStatus.total, 10, 'clamped to 10');
});

test('cancelLoop: posts cancelled status and removes the loop', async () => {
  const deps = makeDeps();
  const provider = new ChatViewProvider({ extensionPath: "/ext", extensionUri: {}, subscriptions: [], secrets: {} } as never, deps);
  (provider as unknown as { currentSession: { id: string } }).currentSession = { id: 'sess_1' };
  (provider as unknown as { currentHandle: StreamHandle | null | undefined }).currentHandle = deps.handle;
  const posts: Array<Record<string, unknown>> = [];
  (provider as unknown as { postToWebview: (m: unknown) => void }).postToWebview = (m) => posts.push(m as Record<string, unknown>);

  // Start a loop
  await (provider as unknown as { handleWebviewMessage: (m: unknown) => Promise<void> }).handleWebviewMessage({
    type: 'loopPrompt', sessionId: 'sess_1', text: 'task', iterations: 5,
  });
  posts.length = 0;
  // Cancel it
  await (provider as unknown as { handleWebviewMessage: (m: unknown) => Promise<void> }).handleWebviewMessage({
    type: 'cancelLoop', sessionId: 'sess_1',
  });
  const cancel = posts.find((p) => p.type === 'loopStatus') as { status: string } | undefined;
  assert.ok(cancel, 'expected a loopStatus message after cancel');
  assert.equal(cancel.status, 'cancelled');
});

test('advanceLoop: replays prompt until total, then marks done', async () => {
  const deps = makeDeps();
  const provider = new ChatViewProvider({ extensionPath: "/ext", extensionUri: {}, subscriptions: [], secrets: {} } as never, deps);
  (provider as unknown as { currentSession: { id: string } }).currentSession = { id: 'sess_1' };
  let sentPrompts = 0;
  (provider as unknown as { currentHandle: StreamHandle | null | undefined }).currentHandle = {
    sendPrompt: () => { sentPrompts += 1; },
    cancel: () => {},
    on: () => {},
  } as unknown as StreamHandle;
  const posts: Array<Record<string, unknown>> = [];
  (provider as unknown as { postToWebview: (m: unknown) => void }).postToWebview = (m) => posts.push(m as Record<string, unknown>);

  // Start a 3-iteration loop. handleSendPrompt will be called once
  // (the first iteration), then 2 more replays after each `done`.
  // We need to give the loop's first handleSendPrompt a chance to
  // run before counting sends.
  await (provider as unknown as { handleWebviewMessage: (m: unknown) => Promise<void> }).handleWebviewMessage({
    type: 'loopPrompt', sessionId: 'sess_1', text: 'refactor', iterations: 3,
  });
  posts.length = 0;
  const initialSends = sentPrompts;

  // Simulate `done` events one at a time, then flush the
  // microtask queue (advanceLoop's `void replayPrompt` is
  // async — we need to wait for the awaited sendPrompt to fire
  // before counting).
  for (let i = 0; i < 3; i++) {
    (provider as unknown as { advanceLoop: (s: string) => boolean }).advanceLoop('sess_1');
    // Flush microtasks so the async replayPrompt completes.
    await new Promise((r) => setImmediate(r));
  }

  // After all 3 done events, we should have 2 more sends (replays 1+2).
  // The first iteration was sent when the loopPrompt was dispatched.
  assert.equal(sentPrompts, initialSends + 2, 'expected 2 replays for a 3-iteration loop');
  const done = posts.find((p) => p.type === 'loopStatus' && (p as { status: string }).status === 'done');
  assert.ok(done, 'expected a done loopStatus');
});

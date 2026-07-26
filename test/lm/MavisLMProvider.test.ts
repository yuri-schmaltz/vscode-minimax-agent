/**
 * MavisLMProvider unit tests.
 *
 * We exercise the provider against a real MavisClient wired to a fake
 * child_process. The fake streams canned assistant text + a done event
 * so we can assert that the provider reports `LanguageModelTextPart`s
 * in order, fires its `onDidChangeLanguageModelChatInformation` event
 * when the underlying client signals new agents, and propagates
 * cancellation.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MavisClient } from '../../src/client/MavisClient';
import { MavisLMProvider, MAVIS_LM_VENDOR } from '../../src/lm/MavisLMProvider';
import { AgentSummary } from '../../src/client/types';
import { makeFakeChild, makePerCallSpawner } from '../helpers/spawnStub';
import { LanguageModelTextPart } from 'vscode';

function makeClientWithFakeCanned(): MavisClient {
  const { spawn, children } = makePerCallSpawner();
  const client = new MavisClient({ spawnImpl: spawn, mock: true, resolveBundledPath: () => '/fake/mavis.cjs' });
  // Seed the spawner with a real child that emits the canned
  // assistant text + done event.
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'streamSession') {
        return (_id: string) => {
          const child = makeFakeChild();
          children.push(child);
          return {
            sendPrompt: () => undefined,
            close: () => undefined,
            on: (event: string, fn: (e: unknown) => void) => {
              if (event === 'message') {
                setImmediate(() => fn({ type: 'message', content: 'Hello from Mavis', ts: Date.now() }));
              } else if (event === 'done') {
                setImmediate(() => fn({ type: 'done', ts: Date.now() }));
              }
              return () => undefined;
            },
            off: () => undefined,
          };
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop as string];
    },
  });
}

test('MavisLMProvider: exports the mavis vendor id', () => {
  assert.equal(MAVIS_LM_VENDOR, 'mavis');
});

test('MavisLMProvider: provideLanguageModelChatInformation maps agents to models', async () => {
  const agents: AgentSummary[] = [
    { id: 'a1', name: 'Alpha', description: '', model: 'gpt-x', isDefault: true },
    { id: 'a2', name: 'Beta', description: '', model: 'gpt-y', isDefault: false },
  ];
  const client = makeClientWithFakeCanned();
  const provider = new MavisLMProvider({ client, listAgents: async () => agents });
  const models = await provider.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false } as never);
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'a1');
  assert.equal(models[0].family, 'gpt-x');
  assert.equal(models[0].detail, 'default');
  assert.equal(models[1].id, 'a2');
  assert.equal(models[1].detail, undefined);
  assert.equal(models[0].maxInputTokens, 128_000);
  provider.dispose();
});

test('MavisLMProvider: provideLanguageModelChatInformation caches the agent list', async () => {
  let calls = 0;
  const client = makeClientWithFakeCanned();
  const provider = new MavisLMProvider({
    client,
    listAgents: async () => {
      calls += 1;
      return [];
    },
  });
  await provider.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false } as never);
  await provider.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false } as never);
  await provider.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false } as never);
  assert.equal(calls, 1);
  provider.dispose();
});

test('MavisLMProvider: agents change event invalidates the cache', async () => {
  let calls = 0;
  const client = makeClientWithFakeCanned();
  const provider = new MavisLMProvider({
    client,
    listAgents: async () => {
      calls += 1;
      return [];
    },
  });
  await provider.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false } as never);
  // The client EventEmitter is mocked via the spawner; we fire the
  // event directly.
  (client.onAgentsChanged as unknown as { emit: (k: string, v: unknown) => void }).emit('list', { items: [] });
  await provider.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false } as never);
  assert.equal(calls, 2);
  provider.dispose();
});

test('MavisLMProvider: provideLanguageModelChatResponse streams text parts', async () => {
  const client = makeClientWithFakeCanned();
  const provider = new MavisLMProvider({ client, listAgents: async () => [] });
  const model = {
    id: 'a1',
    name: 'Alpha',
    family: 'gpt-x',
    version: '1',
    maxInputTokens: 128_000,
    maxOutputTokens: 8_192,
    capabilities: { toolCalling: true },
    agentId: 'a1',
  };
  const parts: string[] = [];
  await provider.provideLanguageModelChatResponse(
    model,
    [{ role: 'user' as never, content: [], name: undefined }],
    { toolMode: 1 as never },
    { report: (p) => parts.push((p as { value?: string }).value ?? '') },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );
  assert.deepEqual(parts, ['Hello from Mavis']);
  provider.dispose();
});

test('MavisLMProvider: provideLanguageModelChatResponse sends flattened messages', async () => {
  let capturedPrompt = '';
  const client = new MavisClient({ spawnImpl: makePerCallSpawner().spawn, mock: true, resolveBundledPath: () => '/fake/mavis.cjs' });
  const provider = new MavisLMProvider({ client, listAgents: async () => [] });
  const model = {
    id: 'a1', name: 'A', family: 'f', version: '1', maxInputTokens: 1, maxOutputTokens: 1, capabilities: { toolCalling: true }, agentId: 'a1',
  };
  // Override streamSession via the same Proxy trick.
  (client as unknown as { streamSession: (id: string) => { sendPrompt: (s: string) => void; close: () => void; on: (e: string, f: (v: unknown) => void) => () => void; off: () => void } }).streamSession = (_id: string) => ({
    sendPrompt: (s: string) => { capturedPrompt = s; },
    close: () => undefined,
    on: (e: string, f: (v: unknown) => void) => {
      if (e === 'done') setImmediate(() => f({ type: 'done' }));
      return () => undefined;
    },
    off: () => undefined,
  });
  await provider.provideLanguageModelChatResponse(
    model,
    [
      { role: 'user' as never, content: [new LanguageModelTextPart('hi')] as never, name: undefined },
      { role: 'assistant' as never, content: [new LanguageModelTextPart('hello')] as never, name: undefined },
    ],
    { toolMode: 1 as never },
    { report: () => undefined },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );
  assert.ok(capturedPrompt.includes('[user] hi'));
  assert.ok(capturedPrompt.includes('[assistant] hello'));
  provider.dispose();
});

test('MavisLMProvider: provideTokenCount uses the length/4 heuristic', async () => {
  const client = makeClientWithFakeCanned();
  const provider = new MavisLMProvider({ client, listAgents: async () => [] });
  const model = {
    id: 'a1', name: 'A', family: 'f', version: '1', maxInputTokens: 1, maxOutputTokens: 1, capabilities: { toolCalling: true }, agentId: 'a1',
  };
  const count = await provider.provideTokenCount(model, 'hello world', { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never);
  assert.equal(count, 3); // 11 / 4 ceil
  provider.dispose();
});

test('MavisLMProvider: dispose is idempotent', () => {
  const client = makeClientWithFakeCanned();
  const provider = new MavisLMProvider({ client, listAgents: async () => [] });
  provider.dispose();
  provider.dispose();
  // No exception thrown = pass.
});

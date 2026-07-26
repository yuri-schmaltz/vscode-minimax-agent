/**
 * MavisInlineCompletionProvider unit tests.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MavisClient } from '../../src/client/MavisClient';
import { MavisInlineCompletionProvider, INLINE_EDIT_SELECTOR } from '../../src/inline/InlineEditProvider';
import { CodeActionResult, CodeActionTaskHandle } from '../../src/client/types';
import { makePerCallSpawner } from '../helpers/spawnStub';

function makeClient(cannedResult: CodeActionResult): { client: MavisClient; tasks: CodeActionTaskHandle[] } {
  const { spawn } = makePerCallSpawner();
  const client = new MavisClient({ spawnImpl: spawn, mock: true, resolveBundledPath: () => '/fake/mavis.cjs' });
  const tasks: CodeActionTaskHandle[] = [];
  (client as unknown as { createCodeActionTask: (...args: never[]) => CodeActionTaskHandle }).createCodeActionTask = (..._args: never[]) => {
    const handle: CodeActionTaskHandle = {
      result: Promise.resolve(cannedResult),
      cancel: () => undefined,
    };
    tasks.push(handle);
    return handle;
  };
  return { client, tasks };
}

function fakeDocument(): { document: unknown; position: { line: number; character: number } } {
  const document = {
    uri: { scheme: 'file', fsPath: '/repo/foo.ts' },
    fileName: '/repo/foo.ts',
    languageId: 'typescript',
    lineAt: (_line: number) => ({ text: 'function f() {' }),
    getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
      if (!range) return 'function f() {';
      return '';
    },
  };
  return { document, position: { line: 0, character: 16 } };
}

test('MavisInlineCompletionProvider: INLINE_EDIT_SELECTOR includes typescript + wildcard', () => {
  const hasTs = INLINE_EDIT_SELECTOR.some((s) => 'language' in s && s.language === 'typescript');
  const hasStar = INLINE_EDIT_SELECTOR.some((s) => 'language' in s && s.language === '*');
  assert.ok(hasTs, 'expected typescript in selector');
  assert.ok(hasStar, 'expected wildcard in selector');
});

test('MavisInlineCompletionProvider: provideInlineCompletionItems returns list when text result', async () => {
  const { client } = makeClient({ kind: 'text', text: 'return 42;\n}' });
  const provider = new MavisInlineCompletionProvider({ client });
  const { document, position } = fakeDocument();
  const result = await provider.provideInlineCompletionItems(
    document as never,
    position as never,
    {} as never,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );
  assert.ok(result);
  const list = result as { items: { insertText: string }[] };
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].insertText, 'return 42;\n}');
  provider.dispose();
});

test('MavisInlineCompletionProvider: cleans fenced markdown from the agent', async () => {
  const { client } = makeClient({ kind: 'text', text: '```typescript\nreturn 1;\n```' });
  const provider = new MavisInlineCompletionProvider({ client });
  const { document, position } = fakeDocument();
  const result = await provider.provideInlineCompletionItems(
    document as never,
    position as never,
    {} as never,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );
  const list = result as { items: { insertText: string }[] };
  assert.equal(list.items[0].insertText, 'return 1;');
});

test('MavisInlineCompletionProvider: returns undefined for empty text result', async () => {
  const { client } = makeClient({ kind: 'text', text: '   ' });
  const provider = new MavisInlineCompletionProvider({ client });
  const { document, position } = fakeDocument();
  const result = await provider.provideInlineCompletionItems(
    document as never,
    position as never,
    {} as never,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );
  assert.equal(result, undefined);
});

test('MavisInlineCompletionProvider: returns undefined for huge documents', async () => {
  const { client } = makeClient({ kind: 'text', text: 'x' });
  const provider = new MavisInlineCompletionProvider({ client });
  const hugeDoc = {
    uri: { scheme: 'file', fsPath: '/repo/foo.ts' },
    fileName: '/repo/foo.ts',
    languageId: 'typescript',
    lineAt: () => ({ text: '' }),
    getText: () => 'x'.repeat(200_000),
  };
  const result = await provider.provideInlineCompletionItems(
    hugeDoc as never,
    { line: 0, character: 0 } as never,
    {} as never,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );
  assert.equal(result, undefined);
});

test('MavisInlineCompletionProvider: returns undefined for non-file documents', async () => {
  const { client } = makeClient({ kind: 'text', text: 'x' });
  const provider = new MavisInlineCompletionProvider({ client });
  const doc = {
    uri: { scheme: 'output', fsPath: '/output' },
    fileName: '/output',
    languageId: 'typescript',
    lineAt: () => ({ text: '' }),
    getText: () => 'x',
  };
  const result = await provider.provideInlineCompletionItems(
    doc as never,
    { line: 0, character: 0 } as never,
    {} as never,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );
  assert.equal(result, undefined);
});

test('MavisInlineCompletionProvider: handles patch result by emitting diff as text', async () => {
  const { client } = makeClient({ kind: 'patch', file: 'foo.ts', diff: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new' });
  const provider = new MavisInlineCompletionProvider({ client });
  const { document, position } = fakeDocument();
  const result = await provider.provideInlineCompletionItems(
    document as never,
    position as never,
    {} as never,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );
  const list = result as { items: { insertText: string }[] };
  assert.ok(list.items[0].insertText.includes('+new'));
});

test('MavisInlineCompletionProvider: returns undefined when the code-action throws', async () => {
  const { spawn } = makePerCallSpawner();
  const client = new MavisClient({ spawnImpl: spawn, mock: true, resolveBundledPath: () => '/fake/mavis.cjs' });
  (client as unknown as { createCodeActionTask: () => CodeActionTaskHandle }).createCodeActionTask = () => ({
    result: Promise.reject(new Error('boom')),
    cancel: () => undefined,
  });
  const provider = new MavisInlineCompletionProvider({ client });
  const { document, position } = fakeDocument();
  const result = await provider.provideInlineCompletionItems(
    document as never,
    position as never,
    {} as never,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );
  assert.equal(result, undefined);
});

test('MavisInlineCompletionProvider: cancellation propagates and aborts task', async () => {
  const { client } = makeClient({ kind: 'text', text: 'x' });
  let cancelled = false;
  (client as unknown as { createCodeActionTask: () => CodeActionTaskHandle }).createCodeActionTask = () => ({
    result: new Promise(() => undefined), // never resolves
    cancel: () => { cancelled = true; },
  });
  const provider = new MavisInlineCompletionProvider({ client });
  const { document, position } = fakeDocument();
  const tokenSource = { isCancellationRequested: false, onCancellationRequested: (_l: (e: unknown) => void) => ({ dispose: () => undefined }) };
  // Override the onCancellationRequested to flip a flag:
  let triggered: (() => void) | undefined;
  tokenSource.onCancellationRequested = (l: unknown) => {
    triggered = () => (l as (e: unknown) => void)({});
    return { dispose: () => undefined };
  };
  // We do NOT await the promise (it would hang). We schedule the
  // cancellation on the next tick and give the microtask queue time
  // to drain the synchronous bits.
  const promise = provider.provideInlineCompletionItems(
    document as never,
    position as never,
    {} as never,
    tokenSource as never,
  );
  // Trigger the cancellation listener.
  triggered?.();
  assert.ok(cancelled, 'expected task.cancel to have been called');
  // Reject the promise so the test doesn't hang.
  (promise as unknown as { catch: (fn: (e: unknown) => void) => void }).catch(() => undefined);
  // Yield to the event loop once so the .then() chain has a chance to
  // observe the rejection; we don't assert on the result, only on the
  // side-effect of the cancel call.
  await new Promise((r) => setImmediate(r));
});

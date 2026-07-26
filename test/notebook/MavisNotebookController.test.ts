/**
 * MavisNotebookController unit tests.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MavisClient } from '../../src/client/MavisClient';
import { MavisNotebookControllerProvider, JUPYTER_NOTEBOOK_TYPE, MAVIS_NOTEBOOK_TYPE } from '../../src/notebook/MavisNotebookController';
import { makePerCallSpawner, makeFakeChild } from '../helpers/spawnStub';

function makeClient(): { client: MavisClient; children: ReturnType<typeof makeFakeChild>[] } {
  const { spawn, children } = makePerCallSpawner();
  const client = new MavisClient({ spawnImpl: spawn, mock: true, resolveBundledPath: () => '/fake/mavis.cjs' });
  return { client, children };
}

test('MavisNotebookControllerProvider: exports the expected notebook type ids', () => {
  assert.equal(JUPYTER_NOTEBOOK_TYPE, 'jupyter-notebook');
  assert.equal(MAVIS_NOTEBOOK_TYPE, 'mavis-notebook');
});

test('MavisNotebookControllerProvider: constructor registers one controller', () => {
  const { client } = makeClient();
  const ctrls: unknown[] = [];
  const provider = new MavisNotebookControllerProvider({
    client,
    createController: (id, type, label) => {
      const c = { id, notebookType: type, label, supportedLanguages: [], dispose: () => undefined, updateNotebookAffinity: () => undefined, createNotebookCellExecution: () => ({}) };
      ctrls.push(c);
      return c as never;
    },
  });
  assert.equal(provider.getControllers().length, 1);
  assert.equal(ctrls[0] && (ctrls[0] as { id: string }).id, 'mavis');
  assert.equal(ctrls[0] && (ctrls[0] as { notebookType: string }).notebookType, JUPYTER_NOTEBOOK_TYPE);
  provider.dispose();
});

test('MavisNotebookControllerProvider: default affinity accepts jupyter + mavis-notebook', () => {
  const { client } = makeClient();
  const calls: { affinity: number; notebookType: string }[] = [];
  const ctrl = { id: 'm', notebookType: 'jupyter-notebook', label: 'Mavis', supportedLanguages: [], dispose: () => undefined, updateNotebookAffinity: (nb: { notebookType: string }, affinity: number) => calls.push({ affinity, notebookType: nb.notebookType }), createNotebookCellExecution: () => ({}) };
  const provider = new MavisNotebookControllerProvider({ client, createController: () => ctrl as never });
  // Mock workspace.notebookDocuments:
  (provider as unknown as { controllers: unknown[] }).controllers = [ctrl];
  // Call the affinity decision directly via the test override:
  const acceptedJupyter = (provider as unknown as { shouldAccept: (n: { notebookType: string }) => boolean }).shouldAccept({ notebookType: 'jupyter-notebook' });
  const acceptedMavis = (provider as unknown as { shouldAccept: (n: { notebookType: string }) => boolean }).shouldAccept({ notebookType: 'mavis-notebook' });
  const acceptedOther = (provider as unknown as { shouldAccept: (n: { notebookType: string }) => boolean }).shouldAccept({ notebookType: 'gitlens' });
  assert.equal(acceptedJupyter, true);
  assert.equal(acceptedMavis, true);
  assert.equal(acceptedOther, false);
  provider.dispose();
});

test('MavisNotebookControllerProvider: dispose clears controllers', () => {
  const { client } = makeClient();
  let disposed = false;
  const ctrl = { id: 'm', notebookType: 'jupyter-notebook', label: 'Mavis', supportedLanguages: [], dispose: () => { disposed = true; }, updateNotebookAffinity: () => undefined, createNotebookCellExecution: () => ({}) };
  const provider = new MavisNotebookControllerProvider({ client, createController: () => ctrl as never });
  provider.dispose();
  assert.equal(disposed, true);
  assert.equal(provider.getControllers().length, 0);
  // Idempotent
  provider.dispose();
});

test('MavisNotebookControllerProvider: empty cell short-circuits without spawning a stream', async () => {
  const { client, children } = makeClient();
  let executed = false;
  const execution = {
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    start: () => { executed = true; },
    end: () => undefined,
    appendOutput: () => undefined,
    replaceOutput: (out: unknown) => { (execution as unknown as { _out: unknown })._out = out; },
  };
  const ctrl = {
    id: 'm', notebookType: 'jupyter-notebook', label: 'Mavis', supportedLanguages: [],
    dispose: () => undefined,
    updateNotebookAffinity: () => undefined,
    createNotebookCellExecution: () => execution,
  };
  const provider = new MavisNotebookControllerProvider({ client, createController: () => ctrl as never });
  const cell = {
    index: 0,
    document: { getText: () => '   \n' },
    notebook: { uri: { fsPath: '/tmp/nb' }, notebookType: 'jupyter-notebook' },
  } as never;
  const notebook = { uri: { fsPath: '/tmp/nb' }, notebookType: 'jupyter-notebook' } as never;
  // The executeHandler was set on the ctrl in the constructor:
  const handler = (ctrl as { executeHandler?: (cells: unknown[], nb: unknown, c: unknown) => unknown }).executeHandler;
  assert.ok(handler);
  await handler([cell], notebook, ctrl);
  assert.equal(children.length, 0, 'should not have spawned a stream for empty cell');
  assert.equal(executed, true);
  provider.dispose();
});

test('MavisNotebookControllerProvider: executes cell and streams content', async () => {
  const { spawn, children } = makePerCallSpawner();
  const client = new MavisClient({ spawnImpl: spawn, mock: true, resolveBundledPath: () => '/fake/mavis.cjs' });
  const outputs: unknown[] = [];
  let startedAt: number | undefined;
  let endedOk: boolean | undefined;
  const execution = {
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    start: (d: number) => { startedAt = d; },
    end: (ok: boolean, _d: number) => { endedOk = ok; },
    appendOutput: (out: unknown) => { outputs.push(out); },
    replaceOutput: () => undefined,
  };
  const ctrl = {
    id: 'm', notebookType: 'jupyter-notebook', label: 'Mavis', supportedLanguages: [],
    dispose: () => undefined,
    updateNotebookAffinity: () => undefined,
    createNotebookCellExecution: () => execution,
  };
  const provider = new MavisNotebookControllerProvider({ client, createController: () => ctrl as never });
  const cell = {
    index: 1,
    document: { getText: () => 'echo hello' },
    notebook: { uri: { fsPath: '/tmp/nb' }, notebookType: 'jupyter-notebook' },
  } as never;
  const notebook = { uri: { fsPath: '/tmp/nb' }, notebookType: 'jupyter-notebook' } as never;
  const handler = (ctrl as { executeHandler?: (cells: unknown[], nb: unknown, c: unknown) => unknown }).executeHandler;
  // The handler synchronously calls client.streamSession, which calls
  // the spawner synchronously. So by the time handler returns, the
  // child is already minted. We just need to drive it.
  const beforeCount = children.length;
  const promise = handler!([cell], notebook, ctrl);
  assert.equal(children.length, beforeCount + 1, 'expected exactly one new child');
  const child = children[children.length - 1];
  // Drive the child: send a message + a done event, then close.
  child.stdout.write(JSON.stringify({ type: 'message', content: 'first line' }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'done' }) + '\n');
  child.stdout.end();
  await new Promise((r) => setImmediate(r));
  child.emit('close', 0, null);
  await promise;
  assert.ok(outputs.length >= 1, `expected at least one output, got ${outputs.length}`);
  assert.equal(endedOk, true);
  assert.ok(typeof startedAt === 'number');
  provider.dispose();
});

test('MavisNotebookControllerProvider: error mid-stream ends the cell as failed', async () => {
  const { spawn, children } = makePerCallSpawner();
  const client = new MavisClient({ spawnImpl: spawn, mock: true, resolveBundledPath: () => '/fake/mavis.cjs' });
  const outputs: unknown[] = [];
  let endedOk: boolean | undefined;
  const execution = {
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    start: () => undefined,
    end: (ok: boolean) => { endedOk = ok; },
    appendOutput: (out: unknown) => { outputs.push(out); },
    replaceOutput: () => undefined,
  };
  const ctrl = {
    id: 'm', notebookType: 'jupyter-notebook', label: 'Mavis', supportedLanguages: [],
    dispose: () => undefined,
    updateNotebookAffinity: () => undefined,
    createNotebookCellExecution: () => execution,
  };
  const provider = new MavisNotebookControllerProvider({ client, createController: () => ctrl as never });
  const cell = {
    index: 0,
    document: { getText: () => 'fail here' },
    notebook: { uri: { fsPath: '/tmp/nb' }, notebookType: 'jupyter-notebook' },
  } as never;
  const notebook = { uri: { fsPath: '/tmp/nb' }, notebookType: 'jupyter-notebook' } as never;
  const handler = (ctrl as { executeHandler?: (cells: unknown[], nb: unknown, c: unknown) => unknown }).executeHandler;
  const beforeCount = children.length;
  const promise = handler!([cell], notebook, ctrl);
  assert.equal(children.length, beforeCount + 1, 'expected exactly one new child');
  const child = children[children.length - 1];
  child.stdout.write(JSON.stringify({ type: 'error', message: 'synthetic failure' }) + '\n');
  child.stdout.end();
  await new Promise((r) => setImmediate(r));
  child.emit('close', 0, null);
  await promise;
  assert.equal(endedOk, false);
  assert.ok(outputs.length >= 1, `expected at least one output, got ${outputs.length}`);
  provider.dispose();
});

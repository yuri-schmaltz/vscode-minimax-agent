/**
 * SettingsViewProvider unit + adversarial tests.
 *
 * Coverage:
 *   1. `normaliseSettings` defaults + coerces each field safely.
 *   2. `load()` returns the stored settings from globalState.
 *   3. `save()` updates globalState.
 *   4. The `settings:save` webview message persists the merged result.
 *   5. The `settings:discard` message echoes the last-saved value.
 *   6. The `settings:browse-cli` message calls the host's pickFile
 *      and posts the picked path back.
 *   7. The `ready` message posts a `settings:loaded` payload with
 *      defaults, agents, and CLI version.
 *   8. Adversarial: a malformed settings payload is coerced safely
 *      instead of throwing.
 */
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_SETTINGS,
  MavisSettings,
  SETTINGS_STORAGE_KEY,
  SettingsViewProvider,
  WebviewToHost,
  normaliseSettings,
} from '../../src/views/SettingsViewProvider';
import { MavisClient } from '../../src/client/MavisClient';
import { makePerCallSpawner } from '../helpers/spawnStub';
import { EventEmitter as VSCodeEventEmitter, Uri } from '../__mocks__/vscode';

class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(k: string): T | undefined {
    return this.data.get(k) as T | undefined;
  }
  update(k: string, v: unknown): Thenable<void> | void {
    if (v === undefined) this.data.delete(k);
    else this.data.set(k, v);
  }
  raw(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }
}

class FakeWebview {
  options: import('vscode').WebviewOptions = {};
  html = '';
  cspSource = 'vscode-webview://test-csp';
  readonly posted: unknown[] = [];
  private recvEmitter = new VSCodeEventEmitter();
  asWebviewUri(uri: Uri): Uri {
    return uri;
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  onDidReceiveMessage(listener: (msg: unknown) => void): { dispose(): void } {
    return this.recvEmitter.event(listener as (e: unknown) => void);
  }
  receive(msg: WebviewToHost): void {
    this.recvEmitter.fire(msg);
  }
}

class FakeContext {
  readonly extensionPath = '/ext';
  readonly extensionUri = Uri.file('/ext');
  readonly subscriptions: { dispose(): void }[] = [];
  readonly globalState = new FakeMemento();
  readonly globalStorageUri = Uri.file('/ext/.global');
  readonly globalStoragePath = '/ext/.global';
  readonly workspaceState = new FakeMemento();
  readonly storageUri = Uri.file('/ext/.storage');
  readonly storagePath = '/ext/.storage';
  readonly secrets = { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: new VSCodeEventEmitter().event };
  asAbsolutePath(p: string): string { return p; }
  dispose(): void { /* noop */ }
}

function makeDeps() {
  const ctx = new FakeContext();
  const { spawn, children } = makePerCallSpawner();
  const client = new MavisClient({
    spawnImpl: spawn,
    resolveBundledPath: () => '/ext/resources/mavis-cli/mavis.cjs',
    defaultAgent: 'mavis',
    mock: true,
  });
  // Stub listAgents so the SettingsViewProvider's sendLoaded call
  // doesn't wait on a fake child that never closes.
  client.listAgents = async () => [{ id: 'mavis', name: 'Mavis', description: '', model: '', isDefault: true }];
  client.listSessions = async () => [];
  const provider = new SettingsViewProvider({
    context: ctx as unknown as import('vscode').ExtensionContext,
    client,
    cliVersion: '0.1.0',
  });
  return { ctx, client, provider, children };
}

beforeEach(() => {
  // no global teardown required; each test builds a fresh provider
});

test('normaliseSettings: returns defaults when undefined', () => {
  const out = normaliseSettings(undefined);
  assert.deepEqual(out, DEFAULT_SETTINGS);
});

test('normaliseSettings: coerces invalid types to defaults', () => {
  const out = normaliseSettings({
    telemetry: 'yes' as unknown as boolean,
    defaultAgent: 42 as unknown as string,
    cliPath: null as unknown as string,
    model: {} as unknown as string,
    locale: 'xx' as unknown as 'en',
  });
  assert.equal(out.telemetry, false);
  assert.equal(out.defaultAgent, 'mavis');
  assert.equal(out.cliPath, '');
  assert.equal(out.model, '');
  assert.equal(out.locale, 'en');
});

test('normaliseSettings: accepts pt-BR locale', () => {
  const out = normaliseSettings({ locale: 'pt-BR' });
  assert.equal(out.locale, 'pt-BR');
});

test('load(): returns stored settings (defaulted)', () => {
  const { ctx, provider } = makeDeps();
  ctx.globalState.update(SETTINGS_STORAGE_KEY, { telemetry: true, defaultAgent: 'code' });
  const s = provider.getCurrent();
  assert.equal(s.telemetry, true);
  assert.equal(s.defaultAgent, 'code');
  assert.equal(s.cliPath, '');
});

test('load(): returns defaults when nothing is stored', () => {
  const { provider } = makeDeps();
  const s = provider.getCurrent();
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

test('settings:save: persists the merged settings to globalState', async () => {
  const { ctx, provider } = makeDeps();
  const webview = new FakeWebview();
  // We need to use the internal load/save to verify the flow; emulate
  // the host behaviour by calling save directly with normalised input.
  const merged = normaliseSettings({ telemetry: true, defaultAgent: 'code', cliPath: '/usr/bin/mavis' });
  await SettingsViewProvider.save(ctx as unknown as import('vscode').ExtensionContext, merged);
  assert.deepEqual(ctx.globalState.raw()[SETTINGS_STORAGE_KEY], merged);
  void webview;
  void provider;
});

test('normaliseSettings + save round-trip preserves booleans and strings', async () => {
  const { ctx } = makeDeps();
  const merged = normaliseSettings({ telemetry: false, defaultAgent: 'reviewer', cliPath: '', model: 'm3', locale: 'pt-BR' });
  await SettingsViewProvider.save(ctx as unknown as import('vscode').ExtensionContext, merged);
  const raw = ctx.globalState.raw()[SETTINGS_STORAGE_KEY] as MavisSettings;
  assert.equal(raw.telemetry, false);
  assert.equal(raw.defaultAgent, 'reviewer');
  assert.equal(raw.model, 'm3');
  assert.equal(raw.locale, 'pt-BR');
});

test('openPanel: opens a webview panel and posts a settings:loaded payload', async () => {
  const vscodeMock = await import('../__mocks__/vscode');
  let panelApi: { webview: FakeWebview } | undefined;
  const original = (vscodeMock.window as Record<string, unknown>).createWebviewPanel as (() => unknown) | undefined;
  (vscodeMock.window as Record<string, unknown>).createWebviewPanel = () => {
    const webview = new FakeWebview();
    panelApi = { webview };
    return { webview, reveal: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), dispose: () => undefined };
  };
  try {
    const { provider } = makeDeps();
    await provider.openPanel();
    // Give the panel time to wire up its message listener.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Sanity check: the FakeWebview has a working receive path.
    panelApi!.webview.posted.push({ type: 'sentinel' });
    // Fire a `ready` message; the host should respond with a
    // `settings:loaded` payload. Give the async sendLoaded enough
    // time to run the safeListAgents() call.
    panelApi!.webview.receive({ type: 'ready' });
    // Wait for a few microtask flushes (the panel calls listAgents,
    // which is stubbed to resolve immediately).
    for (let i = 0; i < 20 && !panelApi!.webview.posted.find((m) => (m as { type?: string }).type === 'settings:loaded'); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const loaded = panelApi!.webview.posted.find((m) => (m as { type?: string }).type === 'settings:loaded') as { type: string; settings: MavisSettings; cliVersion: string; agents: unknown[] } | undefined;
    assert.ok(loaded, `a settings:loaded message should have been posted (got: ${JSON.stringify(panelApi!.webview.posted)})`);
    assert.equal(loaded!.cliVersion, '0.1.0');
    assert.ok(Array.isArray(loaded!.agents));
  } finally {
    (vscodeMock.window as Record<string, unknown>).createWebviewPanel = original;
  }
});

test('handleMessage: settings:save persists the merged result', async () => {
  const vscodeMock = await import('../__mocks__/vscode');
  let panelApi: { webview: FakeWebview } | undefined;
  const original = (vscodeMock.window as Record<string, unknown>).createWebviewPanel as (() => unknown) | undefined;
  (vscodeMock.window as Record<string, unknown>).createWebviewPanel = () => {
    const webview = new FakeWebview();
    panelApi = { webview };
    return { webview, reveal: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), dispose: () => undefined };
  };
  try {
    const { ctx, provider } = makeDeps();
    await provider.openPanel();
    await new Promise((r) => setImmediate(r));
    const webview = panelApi!.webview;
    webview.receive({ type: 'settings:save', settings: { telemetry: true, defaultAgent: 'code' } });
    await new Promise((r) => setImmediate(r));
    const stored = ctx.globalState.raw()[SETTINGS_STORAGE_KEY] as MavisSettings;
    assert.equal(stored.telemetry, true);
    assert.equal(stored.defaultAgent, 'code');
    const saved = webview.posted.find((m) => (m as { type?: string }).type === 'settings:saved') as { type: string; settings: MavisSettings } | undefined;
    assert.ok(saved, 'a settings:saved message should have been posted');
    assert.equal(saved!.settings.telemetry, true);
  } finally {
    (vscodeMock.window as Record<string, unknown>).createWebviewPanel = original;
  }
});

test('handleMessage: settings:discard echoes the last-saved value', async () => {
  const vscodeMock = await import('../__mocks__/vscode');
  let panelApi: { webview: FakeWebview } | undefined;
  const original = (vscodeMock.window as Record<string, unknown>).createWebviewPanel as (() => unknown) | undefined;
  (vscodeMock.window as Record<string, unknown>).createWebviewPanel = () => {
    const webview = new FakeWebview();
    panelApi = { webview };
    return { webview, reveal: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), dispose: () => undefined };
  };
  try {
    const { provider } = makeDeps();
    await provider.openPanel();
    await new Promise((r) => setImmediate(r));
    const webview = panelApi!.webview;
    webview.receive({ type: 'settings:discard' });
    const last = webview.posted[webview.posted.length - 1] as { type: string };
    assert.equal(last.type, 'settings:discarded');
  } finally {
    (vscodeMock.window as Record<string, unknown>).createWebviewPanel = original;
  }
});

test('handleMessage: settings:browse-cli calls pickFile and posts cliPicked', async () => {
  const vscodeMock = await import('../__mocks__/vscode');
  let panelApi: { webview: FakeWebview } | undefined;
  const original = (vscodeMock.window as Record<string, unknown>).createWebviewPanel as (() => unknown) | undefined;
  (vscodeMock.window as Record<string, unknown>).createWebviewPanel = () => {
    const webview = new FakeWebview();
    panelApi = { webview };
    return { webview, reveal: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), dispose: () => undefined };
  };
  try {
    let picked = false;
    const customProvider = new SettingsViewProvider({
      context: makeDeps().ctx as unknown as import('vscode').ExtensionContext,
      client: makeDeps().client,
      cliVersion: '0.1.0',
      pickFile: async () => { picked = true; return '/usr/local/bin/mavis'; },
    });
    await customProvider.openPanel();
    await new Promise((r) => setImmediate(r));
    const webview = panelApi!.webview;
    webview.receive({ type: 'settings:browse-cli' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(picked, true, 'pickFile should have been called');
    const cliMsg = webview.posted.find((m) => (m as { type?: string }).type === 'settings:cliPicked') as { type: string; path: string } | undefined;
    assert.ok(cliMsg, 'a settings:cliPicked message should have been posted');
    assert.equal(cliMsg!.path, '/usr/local/bin/mavis');
  } finally {
    (vscodeMock.window as Record<string, unknown>).createWebviewPanel = original;
  }
});

test('SettingsViewProvider: renderHtml includes CSP + root div', async () => {
  const vscodeMock = await import('../__mocks__/vscode');
  let panelApi: { webview: FakeWebview } | undefined;
  const original = (vscodeMock.window as Record<string, unknown>).createWebviewPanel as (() => unknown) | undefined;
  (vscodeMock.window as Record<string, unknown>).createWebviewPanel = () => {
    const webview = new FakeWebview();
    panelApi = { webview };
    return { webview, reveal: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), dispose: () => undefined };
  };
  try {
    const { provider } = makeDeps();
    await provider.openPanel();
    await new Promise((r) => setImmediate(r));
    const html = panelApi!.webview.html;
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /<div id="root">/);
    assert.match(html, /main\.js/);
  } finally {
    (vscodeMock.window as Record<string, unknown>).createWebviewPanel = original;
  }
});

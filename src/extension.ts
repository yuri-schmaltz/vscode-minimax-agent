/**
 * Mavis extension entry point.
 *
 * Wires together:
 *   - MavisClient (CLI bridge)
 *   - SecretStore + OAuthManager (auth)
 *   - StatusBarController (bottom-bar item)
 *   - ChatViewProvider (sidebar webview)
 *   - SessionCache (globalState persistence)
 *   - MavisCodeActionProvider (editor code actions)
 *   - Command palette commands (mavis.*)
 *
 * Lifecycle: `onStartupFinished` triggers activate(); deactivate() is
 * responsible for cleanly disposing every long-lived resource.
 */
import { commands, env, ExtensionContext, languages, StatusBarAlignment, Uri, window, workspace } from 'vscode';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { MavisClient } from './client/MavisClient';
import { SecretStore } from './auth/SecretStore';
import { OAuthManager } from './auth/OAuth';
import { StatusBarController } from './statusbar/StatusBar';
import { startQuotaPoller } from './statusbar/quota';
import { ChatViewProvider } from './views/ChatViewProvider';
import { DriveViewProvider, writeTempDriveFile, encodeDrivePayload } from './views/DriveViewProvider';
import { SessionCache, createSessionCache } from './util/SessionCache';
import {
  CodeActionProviderDeps,
  defaultSendTextToChat,
  registerCodeActionProvider,
  runCodeAction,
} from './codeactions/Provider';
import { CodeActionKind as MavisActionKind, DriveItem } from './client/types';
import { CronForm } from './cron/CronForm';
import { CronListProvider } from './cron/CronListProvider';
import { SettingsViewProvider } from './views/SettingsViewProvider';
import { detectLocale, t as i18n } from './i18n';
import { Telemetry, makeDefaultTelemetryHost } from './telemetry/Telemetry';
import { MavisLMProvider, MAVIS_LM_VENDOR } from './lm/MavisLMProvider';
import { MavisInlineCompletionProvider, INLINE_EDIT_SELECTOR } from './inline/InlineEditProvider';
import { MavisNotebookControllerProvider } from './notebook/MavisNotebookController';
import { MavisTaskProvider } from './tasks/MavisTaskProvider';
import { getToolManifest } from './agent/manifest';

let client: MavisClient | undefined;
let secretStore: SecretStore | undefined;
let oauth: OAuthManager | undefined;
let statusBar: StatusBarController | undefined;
let chatView: ChatViewProvider | undefined;
let driveView: DriveViewProvider | undefined;
let sessionCounter = 0;
let sessionCache: SessionCache | undefined;
let codeActionDisposable: { dispose(): void } | undefined;
let settingsView: SettingsViewProvider | undefined;
let telemetry: Telemetry | undefined;
let mavisOutput: import('vscode').OutputChannel | undefined;
let lmProvider: MavisLMProvider | undefined;
let inlineDisposable: { dispose(): void } | undefined;
let notebookProvider: MavisNotebookControllerProvider | undefined;
let taskProvider: MavisTaskProvider | undefined;

function newSessionId(): string {
  sessionCounter += 1;
  const t = Date.now().toString(36);
  return `sess_${t}_${sessionCounter}`;
}

export function activate(context: ExtensionContext): void {
  const config = workspace.getConfiguration('mavis');
  const cliPath = config.get<string>('cliPath', '').trim() || undefined;
  // The default archon URL is the public MiniMax API. The user can
  // override it from settings if they self-host the archon-server.
  const archonUrl = (config.get<string>('archonUrl', '').trim() || 'https://api.minimax.io');
  const apiBase = config.get<string>('apiBase', '/v1').trim() || '/v1';
  // Default model: the first entry of mavis.models, falling
  // back to the legacy mavis.model setting, then 'MiniMax-M3'.
  const modelsList = config.get<string[]>('models', []);
  const legacyModel = config.get<string>('model', 'MiniMax-M3').trim() || 'MiniMax-M3';
  const model = modelsList.length > 0 ? modelsList[0] : legacyModel;
  const stream = config.get<boolean>('stream', false);
  const defaultAgent = config.get<string>('defaultAgent', 'mavis') || 'mavis';
  const oauthFlowRaw = config.get<string>('oauthFlow', 'auto');

  // Hydrate cache BEFORE constructing the client so the first
  // setActiveAgent/setActiveSession calls are no-ops (the cache hydrates
  // synchronously and persists on each change).
  sessionCache = createSessionCache(context);
  const hydrated = sessionCache.hydrate();
  const initialAgent = hydrated.agent || defaultAgent;

  // Read the API key synchronously off the SecretStorage. SecretStorage
  // is async in production, but for activation we tolerate a short
  // synchronous read by deferring client construction; the client will
  // pick the key up on the next spawnEnv() call. We use the key here
  // only when it is already cached in memory.
  const initialApiKey = (context.globalState.get<string>('mavis.cachedApiKey') || undefined);
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath;

  client = new MavisClient({
    cliPath,
    archonUrl,
    apiBase,
    model,
    stream,
    defaultAgent: initialAgent,
    apiKey: initialApiKey,
    extensionPath: context.extensionPath,
    globalStoragePath: context.globalStorageUri.fsPath,
    workspace: workspaceRoot,
    bashAllow: config.get<string[]>('tools.bashAllow', []),
    onStderr: (text) => {
      // Stream shim stderr into the shared Mavis output channel.
      // Each line is prefixed with [mavis:cli] for easy filtering.
      if (!mavisOutput) return;
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) mavisOutput.appendLine(`[mavis:cli] ${line}`);
      }
    },
    // Mock mode is opt-in: if the user explicitly forces MAVIS_MOCK=1
    // via `mavis.cliPath` to a non-shim binary, mock is fine. Otherwise
    // we go real and let the shim tell the user about the missing key.
    mock: false,
  });
  // Apply hydrated state so the UI is consistent from the first paint.
  if (hydrated.sessionId) client.setActiveSession(hydrated.sessionId);

  // Asynchronously hydrate the API key and rebuild the client if it
  // was set after activation. Without this, the very first chat would
  // race the user's first "Set API key" command.
  void (async () => {
    const k = await secretStoreReadApiKey(context);
    if (k) {
      client!.setApiKey(k);
    }
  })();

  secretStore = new SecretStore(context.secrets);
  oauth = new OAuthManager(client, secretStore, {
    clientId: 'minimax-vscode-agent',
    scope: 'group_id profile model.completion',
    openExternal: async (url) => {
      await env.openExternal(Uri.parse(url));
      return true;
    },
  });
  statusBar = new StatusBarController({
    host: {
      createStatusBarItem: (alignment, priority) => {
        // Map our numeric alignment to the vscode enum at the boundary.
        const ali = alignment === 2 ? StatusBarAlignment.Right : StatusBarAlignment.Left;
        const item = window.createStatusBarItem(ali, priority);
        return {
          get text() { return typeof item.text === 'string' ? item.text : ''; },
          set text(v: string) { item.text = v; },
          get tooltip() { return typeof item.tooltip === 'string' ? item.tooltip : ''; },
          set tooltip(v: string | undefined) { item.tooltip = v; },
          get command() { return item.command as string | undefined; },
          set command(v: string | undefined) { item.command = v; },
          show: () => item.show(),
          hide: () => item.hide(),
          dispose: () => item.dispose(),
        };
      },
      showQuickPick: async (items, options) => {
        const mapped = items.map((i) => ({ label: i.label, description: i.description }));
        const pick = await window.showQuickPick(mapped, options);
        return pick as { label: string; description?: string } | undefined;
      },
      executeCommand: (cmd, ...rest) => Promise.resolve(commands.executeCommand(cmd, ...rest)),
    },
    client,
    oauth,
    priority: 100,
    initialAgent,
  });
  statusBar.bind();

  // B.4 — Quota poller. Best-effort; chat works regardless of
  // whether the endpoint is reachable.
  const stopQuota = startQuotaPoller(client, archonUrl, (info) => {
    if (!info) return;
    if (info.empty) {
      statusBar?.setQuota(null);
    } else {
      statusBar?.setQuota(info);
    }
  });
  context.subscriptions.push({ dispose: stopQuota });

  // Persist active context on every change. Wrap the original listeners
  // so we get a single source of truth for "what's the current agent /
  // session" regardless of which path triggered the change.
  client.onContextChanged.on('agent', (a: string) => { void sessionCache?.setLastAgent(a); });
  client.onContextChanged.on('session', (s: string | undefined) => { void sessionCache?.setLastSessionId(s); });
  client.onSessionCreated.on('event', ((entry: unknown) => {
    const e = entry as { id?: string; agent?: string; title?: string };
    if (e && e.id && e.agent) {
      void sessionCache?.pushRecent({ id: e.id, agent: e.agent, title: e.title });
    }
  }) as (...args: unknown[]) => void);

  chatView = new ChatViewProvider(context, {
    client,
    defaultAgent: initialAgent,
    newSessionId,
    onOpenSettings: () => commands.executeCommand('workbench.action.openSettings', 'mavis'),
    onLog: (line) => mavisOutput?.appendLine(`[mavis:chat] ${line}`),
    getTools: (mode) => getToolManifest(mode),
    getAvailableModels: () => config.get<string[]>('models', []),
    recentSessions: () => (sessionCache?.getRecents() ?? []).map((r) => ({ id: r.id, agent: r.agent, title: r.title ?? '' })),
    onTabClosed: (id: string) => { void sessionCache?.removeRecent(id); },
    onNewSession: (id: string, agent: string) => {
      // Auto-created on first open; persist so it shows up in the
      // session list and survives reloads.
      void sessionCache?.pushRecent({ id, agent, title: 'New chat' });
    },
  });
  // B.4 — Webview theme.
  chatView.setTheme(config.get<string>('webviewTheme', 'default'));
  context.subscriptions.push(
    config.onDidChangeConfiguration((e: import('vscode').ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('mavis.webviewTheme')) {
        if (chatView) chatView.setTheme(config.get<string>('webviewTheme', 'default'));
      }
    }),
    window.registerWebviewViewProvider('mavis.chatView', chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Drive tree view. The provider is hosted as a regular
  // TreeDataProvider (not a WebviewViewProvider). The actual data fetch
  // happens when the user opens the view; the provider's constructor
  // only wires the change listener.
  driveView = new DriveViewProvider({
    client,
    openItem: async (item: DriveItem) => {
      try {
        const file = await client!.getDriveFile(item.id);
        const local = await writeTempDriveFile(file);
        await commands.executeCommand('vscode.open', Uri.file(local));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void window.showErrorMessage(`Mavis: open drive item failed: ${message}`);
      }
    },
    attachToChat: async (item: DriveItem) => {
      const payload = encodeDrivePayload(item);
      chatView?.addAttachment({
        id: `att_drive_${item.id}`,
        name: item.name,
        source: 'drive',
        driveId: item.id,
        mimeType: item.mimeType,
      });
      void window.showInformationMessage(`Attached "${item.name}" to chat.`);
      void payload;
    },
  });
  context.subscriptions.push(
    window.registerTreeDataProvider('mavis.driveView', driveView),
  );
  // Prime the list so the tree has something to show when first opened.
  void driveView.refresh();

  // Code actions. The host (`sendTextToChat`) injects assistant text
  // into the active chat so the user sees it inline.
  const codeDeps: CodeActionProviderDeps = {
    client,
    askCustomPrompt: async () => {
      return await window.showInputBox({
        prompt: 'Custom Mavis prompt',
        placeHolder: 'e.g. Translate this snippet to Python',
      });
    },
    sendTextToChat: (text: string, fileUri: Uri): void => {
      if (!chatView) { void defaultSendTextToChat(text, fileUri); return; }
      chatView.injectAssistantMessage(`**Mavis** (${fileUri.fsPath}):\n\n${text}`);
    },
  };
  codeActionDisposable = registerCodeActionProvider(context, client, codeDeps);
  context.subscriptions.push({ dispose: () => codeActionDisposable?.dispose() });

  // --- Settings (Fase 5, Bloco C) ---------------------------------------
  // The settings view exposes a form for telemetry, default agent, CLI
  // path, model, locale, and the read-only CLI version. Settings are
  // persisted to `globalState` under `mavis.settings`.
  const settings = SettingsViewProvider.load(context);
  const initialLocale = settings.locale || detectLocale(env.language);
  const extensionVersion = readExtensionVersion(context);
  settingsView = new SettingsViewProvider({
    context,
    client,
    cliVersion: extensionVersion,
    pickFile: async () => {
      const picked = await window.showOpenDialog({
        title: 'Select mavis CLI',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select',
      });
      return picked && picked[0] ? picked[0].fsPath : undefined;
    },
  });

  // --- Telemetry (Fase 5, Bloco A) --------------------------------------
  // Single output channel for diagnostics (test connection, stream
  // lifecycle, shim stderr). Surfaced via the 'Mavis: Open Output'
  // command and from the test connection command.
  mavisOutput = window.createOutputChannel('Mavis');
  context.subscriptions.push(mavisOutput);

  // We initialise the singleton only after the user has had a chance to
  // see the chat; the singleton itself decides whether to show the
  // opt-in notice. Network errors are best-effort.
  telemetry = Telemetry.init(makeDefaultTelemetryHost({
    memento: context.globalState,
    env: { machineId: env.machineId, language: env.language, sessionId: env.sessionId },
    version: extensionVersion,
    showNotice: async () => {
      const pick = await window.showInformationMessage(
        i18n('telemetry.notice.message', initialLocale),
        i18n('telemetry.notice.enable', initialLocale),
        i18n('telemetry.notice.later', initialLocale),
        i18n('telemetry.notice.never', initialLocale),
      );
      if (pick === i18n('telemetry.notice.enable', initialLocale)) return 'enable';
      if (pick === i18n('telemetry.notice.never', initialLocale)) return 'never';
      if (pick === i18n('telemetry.notice.later', initialLocale)) return 'later';
      return undefined;
    },
    send: async (events) => {
      // Best-effort: post to the mock endpoint. In real life this would
      // be a fetch() with a short timeout. We never throw.
      try {
        if (typeof globalThis.fetch !== 'function') return false;
        // The endpoint is intentionally local and may not resolve; we
        // don't want a console error if it doesn't. The telemetry queue
        // handles failures gracefully anyway.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        try {
          const res = await globalThis.fetch('https://telemetry.minimax.local/v1/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ events }),
            signal: ctrl.signal,
          });
          return res.status >= 200 && res.status < 300;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return false;
      }
    },
    getSetting: () => {
      const cfg = workspace.getConfiguration('mavis');
      const v = cfg.get<unknown>('telemetry', false);
      if (v === 'ask-once' || v === 'true') return 'ask-once' as const;
      if (v === true || v === 'true') return true as const;
      if (v === false || v === 'false') return false as const;
      return false as const;
    },
    setSetting: async (v) => {
      const cfg = workspace.getConfiguration('mavis');
      // Persist as string for marketplace-friendliness.
      const stored = v === true ? 'true' : v === 'ask-once' ? 'ask-once' : 'false';
      await cfg.update('telemetry', stored, true);
    },
  }));

  context.subscriptions.push(
    commands.registerCommand('mavis.hello', () => {
      window.showInformationMessage(i18n('auth.signedIn', initialLocale));
    }),
    commands.registerCommand('mavis.signIn', async () => {
      try {
        await oauth!.signIn({
          archonUrl: archonUrl,
          clientId: 'minimax-vscode-agent',
          scope: 'group_id profile model.completion',
          openExternal: async (url) => env.openExternal(Uri.parse(url)),
          flow: oauthFlowRaw as 'auto' | 'deviceCode' | 'pkce',
        });
        const has = await oauth!.hasToken();
        window.showInformationMessage(has ? i18n('auth.signedIn', initialLocale) : i18n('auth.signInUnknown', initialLocale));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.showErrorMessage(`Mavis sign-in failed: ${message}`);
      }
    }),
    commands.registerCommand('mavis.signOut', async () => {
      await oauth!.signOut({ archonUrl });
      window.showInformationMessage(i18n('auth.signedOut', initialLocale));
    }),
    commands.registerCommand('mavis.setApiKey', async () => {
      if (!secretStore) return;
      const existing = client?.getApiKey();
      const input = await window.showInputBox({
        title: 'Mavis: Set API key',
        prompt:
          'Cole aqui a sua Subscription Key do MiniMax (prefixo `sk-cp-…`). ' +
          'Você encontra em platform.minimax.io → Console → Subscription → Plan Details. ' +
          'Deixe vazio para limpar.',
        placeHolder: 'sk-cp-...',
        password: true,
        ignoreFocusOut: true,
        value: existing ? '••••••••••••' : '',
        validateInput: (v) => {
          if (v && v.length > 0 && !v.startsWith('sk-')) {
            return 'A chave do MiniMax geralmente começa com `sk-`. Você colou o valor correto?';
          }
          if (v && v.startsWith('sk-api-')) {
            return 'Essa parece ser uma API Key pay-as-you-go (sk-api-…), que precisa de créditos pré-pagos. Se você tem um Token Plan ativo, use a Subscription Key `sk-cp-…` que está em Plan Details.';
          }
          return undefined;
        },
      });
      if (input === undefined) return; // user pressed Esc
      const key = input.trim();
      await secretStore.writeApiKey(key);
      client?.setApiKey(key || undefined);
      if (key) {
        await context.globalState.update('mavis.cachedApiKey', key);
        window.showInformationMessage('Mavis: chave de API salva. Você já pode conversar com o Mavis.');
      } else {
        await context.globalState.update('mavis.cachedApiKey', undefined);
        window.showInformationMessage('Mavis: chave de API removida. O chat volta ao modo local (mock).');
      }
      statusBar?.render?.();
    }),
    commands.registerCommand('mavis.testConnection', async () => {
      // Diagnóstico: bate em /v1/models E /v1/chat/completions (não-stream)
      // e mostra exatamente o que o servidor responde. Usa a chave
      // persistida; se não tiver, pede.
      if (!client) {
        window.showErrorMessage('Mavis: cliente não inicializou ainda. Tenta recarregar a janela.');
        return;
      }
      let key = client.getApiKey();
      if (!key && secretStore) {
        key = await secretStore.readApiKey();
        if (key) client.setApiKey(key);
      }
      if (!key) {
        const pick = await window.showWarningMessage(
          'Mavis: você ainda não definiu a API key. Quer definir agora?',
          'Definir',
          'Cancelar',
        );
        if (pick === 'Definir') {
          await commands.executeCommand('mavis.setApiKey');
        }
        return;
      }
      const archonUrl = (config.get<string>('archonUrl', '').trim() || 'https://api.minimax.io');
      const apiBase = config.get<string>('apiBase', '/v1').trim() || '/v1';
      // Default model: the first entry of mavis.models, falling
  // back to the legacy mavis.model setting, then 'MiniMax-M3'.
  const modelsList = config.get<string[]>('models', []);
  const legacyModel = config.get<string>('model', 'MiniMax-M3').trim() || 'MiniMax-M3';
  const model = modelsList.length > 0 ? modelsList[0] : legacyModel;
      const output = mavisOutput ?? window.createOutputChannel('Mavis');
      output.clear();
      output.appendLine(`[mavis] === Diagnóstico de conexão Mavis ===`);
      output.appendLine(`[mavis] archonUrl: ${archonUrl}`);
      output.appendLine(`[mavis] apiBase:   ${apiBase}`);
      output.appendLine(`[mavis] model:     ${model}`);
      output.appendLine(`[mavis] key:       ${key.slice(0, 10)}…${key.slice(-4)} (length=${key.length})`);

      // Round 1: GET /v1/models
      const modelsUrl = archonUrl.replace(/\/+$/, '') + apiBase + '/models';
      output.appendLine('');
      output.appendLine(`[mavis] --- 1) GET ${modelsUrl} ---`);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15_000);
        const res = await globalThis.fetch(modelsUrl, {
          method: 'GET',
          headers: { authorization: 'Bearer ' + key },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        output.appendLine(`[mavis] HTTP ${res.status} ${res.statusText}`);
        const body = await res.text();
        if (res.status === 200) {
          try {
            const json = JSON.parse(body);
            if (json && Array.isArray(json.data)) {
              const models = json.data.map((m: { id?: string }) => m.id).filter(Boolean).slice(0, 12);
              output.appendLine(`[mavis] Models: ${models.join(', ')}${json.data.length > 12 ? '…' : ''}`);
            }
          } catch { /* not JSON, ignore */ }
        } else {
          output.appendLine(`[mavis] Body: ${body.slice(0, 400)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[mavis] Network error: ${msg}`);
      }

      // Round 2: POST /v1/chat/completions (não-stream, payload mínimo)
      const chatUrl = archonUrl.replace(/\/+$/, '') + apiBase + '/chat/completions';
      output.appendLine('');
      output.appendLine(`[mavis] --- 2) POST ${chatUrl} (non-stream) ---`);
      const chatBody = JSON.stringify({
        model,
        stream: false,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'olá' }],
      });
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30_000);
        const res = await globalThis.fetch(chatUrl, {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + key,
            'content-type': 'application/json',
          },
          body: chatBody,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        output.appendLine(`[mavis] HTTP ${res.status} ${res.statusText}`);
        const body = await res.text();
        if (res.status === 200) {
          try {
            const json = JSON.parse(body);
            const text = json.choices?.[0]?.message?.content || json.choices?.[0]?.text || '(sem content)';
            output.appendLine(`[mavis] Content: ${String(text).slice(0, 200)}`);
            window.showInformationMessage(`Mavis: chat OK. Resposta: "${String(text).slice(0, 60)}"`);
          } catch {
            output.appendLine(`[mavis] Body (raw): ${body.slice(0, 400)}`);
          }
        } else {
          output.appendLine(`[mavis] Body: ${body.slice(0, 400)}`);
          if (res.status === 401 || res.status === 403) {
            window.showErrorMessage(`Mavis: chave rejeitada no chat (HTTP ${res.status}).`);
          } else if (res.status === 404) {
            window.showErrorMessage(`Mavis: endpoint de chat não encontrado (HTTP ${res.status}).`);
          } else if (res.status === 429) {
            window.showWarningMessage(`Mavis: rate-limited (HTTP 429). Aguarde alguns segundos.`);
          } else if (res.status === 402 && /insufficient_balance_error/.test(body)) {
            window.showWarningMessage(
              `Mavis: conta sem saldo. Adicione créditos em platform.minimax.io/user-center/payment/token-plan.`,
            );
          } else {
            window.showWarningMessage(`Mavis: chat respondeu HTTP ${res.status}. Veja Output.`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[mavis] Network error: ${msg}`);
        window.showErrorMessage(`Mavis: falha de rede no chat — ${msg}`);
      }

      output.appendLine('');
      output.appendLine(`[mavis] === Fim ===`);
      output.show(true);
    }),
    commands.registerCommand('mavis.openOutput', () => {
      // Surface the shared output channel so the user can see the shim
      // stderr + the test-connection diagnostic without hunting for it.
      mavisOutput?.show(true);
    }),
    commands.registerCommand('mavis.welcome', async () => {
      const hasKey = !!(client?.getApiKey() || await secretStore?.readApiKey());
      const choice = await window.showInformationMessage(
        hasKey
          ? 'Mavis está pronto. Use Cmd/Ctrl+Shift+M para abrir o chat, ou escolha uma ação abaixo.'
          : 'Bem-vindo ao Mavis! Para começar, vincule sua conta MiniMax (a chave `sk-cp-…` fica em platform.minimax.io → Subscription → Plan Details).',
        { modal: false },
        hasKey ? 'Abrir chat' : 'Definir API key',
        hasKey ? 'Testar conexão' : 'Abrir Plan Details',
        'Abrir configurações',
      );
      if (choice === 'Definir API key') {
        await commands.executeCommand('mavis.setApiKey');
      } else if (choice === 'Abrir chat') {
        await commands.executeCommand('mavis.toggleChat');
      } else if (choice === 'Abrir Plan Details') {
        await env.openExternal(Uri.parse('https://platform.minimax.io/console/plan'));
        await commands.executeCommand('mavis.setApiKey');
      } else if (choice === 'Testar conexão') {
        await commands.executeCommand('mavis.testConnection');
      } else if (choice === 'Abrir configurações') {
        await commands.executeCommand('workbench.action.openSettings', 'mavis');
      }
    }),
    commands.registerCommand('mavis.newChat', () => {
      const id = newSessionId();
      chatView?.setSession(id, initialAgent);
      client?.setActiveSession(id);
      void sessionCache?.pushRecent({ id, agent: initialAgent, title: 'New chat' });
    }),
    commands.registerCommand('mavis.sendSelection', async () => {
      const editor = window.activeTextEditor;
      if (!editor) {
        window.showWarningMessage('No active editor');
        return;
      }
      const selection = editor.document.getText(editor.selection);
      if (!selection) {
        window.showWarningMessage('No selection');
        return;
      }
      const id = newSessionId();
      chatView?.setSession(id, initialAgent);
      client?.setActiveSession(id);
      void sessionCache?.pushRecent({ id, agent: initialAgent, title: 'Selection' });
      // Stash the selection in a pending prompt — the chat view will pick it
      // up the next time it sees a sessionChanged (simplest: sendPrompt
      // directly via a hidden channel).
      await chatView?.postError('(Selection captured. Type your question and press Enter.)');
      // For cycle 1 we don't auto-send; user still has to press Enter.
    }),
    commands.registerCommand('mavis.toggleChat', () => {
      // Ensure the auxiliary bar (right side, where Copilot Chat lives)
      // is visible, then focus the Mavis chat view. The view id is the
      // same as the container id (`mavis-side`), and we pass
      // `mavis.chatView` as the second argument to focus the chat
      // specifically (not the drive tab).
      void commands.executeCommand('workbench.action.toggleAuxiliaryBar');
      void commands.executeCommand('workbench.view.mavis-side');
      void commands.executeCommand('workbench.action.focusAuxiliaryGroup');
    }),
    commands.registerCommand('mavis.openSettings', async () => {
      // Open the in-extension settings panel if we have a view provider;
      // fall back to the native VSCode settings UI.
      if (settingsView) {
        await settingsView.openPanel();
        return;
      }
      await commands.executeCommand('workbench.action.openSettings', 'mavis');
    }),
    commands.registerCommand('mavis._statusBarClick', () => {
      statusBar?.onClick();
    }),
    commands.registerCommand('mavis.switchSession', async () => {
      const sessions = await client!.listSessions();
      const recents = sessionCache?.getRecents() ?? [];
      // Merge server-side + recent. De-dupe by id, prefer the recent
      // (since it has the friendlier title).
      const byId = new Map<string, { id: string; agent: string; title: string }>();
      for (const r of recents) byId.set(r.id, { id: r.id, agent: r.agent, title: r.title || '' });
      for (const s of sessions) {
        if (!byId.has(s.id)) byId.set(s.id, { id: s.id, agent: s.agent, title: s.title || '' });
      }
      const items = Array.from(byId.values()).map((s) => ({
        label: s.id,
        description: `${s.agent} | ${s.title || '(no title)'}`,
      }));
      const pick = await window.showQuickPick(items, { placeHolder: 'Switch session' });
      if (!pick) return;
      await client!.switchSession(pick.label);
      chatView?.setSession(pick.label, byId.get(pick.label)?.agent ?? initialAgent);
    }),
    commands.registerCommand('mavis.switchAgent', async () => {
      const agents = await client!.listAgents();
      const items = agents.map((a) => ({
        label: a.id,
        description: a.name + (a.isDefault ? ' (default)' : ''),
      }));
      const pick = await window.showQuickPick(items, { placeHolder: 'Switch agent' });
      if (!pick) return;
      const created = await client!.switchAgent(pick.label);
      chatView?.setSession(created.id, created.agent);
      void sessionCache?.pushRecent({ id: created.id, agent: created.agent, title: created.title || 'New chat' });
    }),
    commands.registerCommand('mavis.listSessions', async () => {
      const sessions = await client!.listSessions();
      const items = sessions.map((s) => ({
        label: s.id,
        description: `${s.agent} | ${s.title || '(no title)'}`,
      }));
      await window.showQuickPick(items, { placeHolder: `Mavis sessions (${sessions.length})` });
    }),
    commands.registerCommand('mavis.listAgents', async () => {
      const agents = await client!.listAgents();
      const items = agents.map((a) => ({
        label: a.id,
        description: a.name + (a.isDefault ? ' (default)' : ''),
      }));
      await window.showQuickPick(items, { placeHolder: `Mavis agents (${agents.length})` });
    }),
    commands.registerCommand('mavis._runCodeAction', async (rawArgs: unknown) => {
      const args = rawArgs as { uri?: string; kind?: MavisActionKind } | undefined;
      if (!args || typeof args.uri !== 'string' || typeof args.kind !== 'string') return;
      try {
        await runCodeAction(client!, codeDeps, { uri: args.uri, kind: args.kind });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.showErrorMessage(`Mavis code action failed: ${message}`);
      }
    }),
    commands.registerCommand('mavis.refreshDrive', async () => {
      await driveView?.refresh();
    }),
    commands.registerCommand('mavis.openDriveItem', async (id: unknown) => {
      if (typeof id !== 'string') return;
      const items = driveView?.getItems() ?? [];
      const item = items.find((i) => i.id === id);
      if (!item) {
        // Refresh and try again; the user may have opened the view
        // before the initial list resolved.
        await driveView?.refresh();
        const refreshed = driveView?.getItems() ?? [];
        const found = refreshed.find((i) => i.id === id);
        if (!found) {
          void window.showErrorMessage(`Mavis: drive item ${id} not found.`);
          return;
        }
        await driveView?.openItem(found);
        return;
      }
      await driveView?.openItem(item);
    }),
    commands.registerCommand('mavis.downloadDriveItem', async (id: unknown) => {
      if (typeof id !== 'string') return;
      const items = driveView?.getItems() ?? [];
      const item = items.find((i) => i.id === id);
      if (!item) {
        void window.showErrorMessage(`Mavis: drive item ${id} not found.`);
        return;
      }
      try {
        const file = await client!.getDriveFile(item.id);
        const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath;
        const targetDir = path.join(workspaceRoot, 'mavis-drive');
        await fs.mkdir(targetDir, { recursive: true });
        const safe = file.name.replace(/[\\/:*?"<>|]+/g, '_');
        const target = path.join(targetDir, safe);
        const data = file.contentIsBase64
          ? Buffer.from(file.content, 'base64')
          : Buffer.from(file.content, 'utf8');
        await fs.writeFile(target, data);
        void window.showInformationMessage(`Saved to ${target}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void window.showErrorMessage(`Mavis: download failed: ${message}`);
      }
    }),
    commands.registerCommand('mavis.deleteDriveItem', async (id: unknown) => {
      if (typeof id !== 'string') return;
      const items = driveView?.getItems() ?? [];
      const item = items.find((i) => i.id === id);
      if (!item) {
        void window.showErrorMessage(`Mavis: drive item ${id} not found.`);
        return;
      }
      const choice = await window.showWarningMessage(
        `Delete "${item.name}" from the Drive? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (choice !== 'Delete') return;
      try {
        await client!.deleteDriveFile(item.id);
        await driveView?.refresh();
        void window.showInformationMessage(`Deleted "${item.name}".`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void window.showErrorMessage(`Mavis: delete failed: ${message}`);
      }
    }),
    commands.registerCommand('mavis.attachToChat', async (id: unknown) => {
      if (typeof id !== 'string') return;
      const items = driveView?.getItems() ?? [];
      const item = items.find((i) => i.id === id);
      if (!item) {
        void window.showErrorMessage(`Mavis: drive item ${id} not found.`);
        return;
      }
      await driveView?.attachToChat(item);
    }),
    commands.registerCommand('mavis._attachToChat', async (payload: unknown) => {
      // Fired by the Drive view's default attachToChat when the host
      // hasn't supplied a custom handler. We treat the payload as a
      // {file:<id>:<name>} reference and add it to the chat.
      if (typeof payload !== 'string') return;
      const m = /^\{file:([^:}]+):([^:}]+)\}$/.exec(payload);
      if (!m) return;
      chatView?.addAttachment({
        id: `att_drive_${m[1]}`,
        name: m[2],
        source: 'drive',
        driveId: m[1],
      });
    }),
    commands.registerCommand('mavis.scheduleCron', async () => {
      if (!client) return;
      const form = new CronForm({
        client,
        host: {
          showInputBox: async (options) => await window.showInputBox(options),
          showQuickPick: async (items, options) => {
            const pick = await window.showQuickPick(items as never, options);
            return pick as { label: string; description?: string; detail?: string } | undefined;
          },
          showInformationMessage: async (m) => (await window.showInformationMessage(m)) as string | undefined,
          showErrorMessage: async (m) => (await window.showErrorMessage(m)) as string | undefined,
        },
        defaultAgent: client.getActiveAgent(),
      });
      await form.run();
    }),
    commands.registerCommand('mavis.listCrons', async () => {
      if (!client) return;
      const provider = new CronListProvider({
        client,
        host: {
          showInputBox: async (options) => await window.showInputBox(options),
          showQuickPick: async (items, options) => {
            const pick = await window.showQuickPick(items as never, options);
            return pick as { label: string; description?: string; detail?: string } | undefined;
          },
          showInformationMessage: async (m) => (await window.showInformationMessage(m)) as string | undefined,
          showErrorMessage: async (m) => (await window.showErrorMessage(m)) as string | undefined,
        },
      });
      await provider.run();
    }),
  );

  // --- Fase 6: Advanced integration (LM API, inline edit, notebooks, tasks)
  // The four providers wire into VSCode's APIs. They are constructed
  // against the active `client` so all Mavis I/O is funnelled through
  // the same bridge as the rest of the extension.

  // 1) Language Model API. The vendor id is `mavis`; consumers query
  // via `vscode.lm.selectChatModels({ vendor: 'mavis' })`.
  lmProvider = new MavisLMProvider({ client });
  context.subscriptions.push(lmProvider);
  try {
    const disp = vscode.lm.registerLanguageModelChatProvider(MAVIS_LM_VENDOR, lmProvider);
    context.subscriptions.push(disp);
  } catch {
    // Older VSCode without the LM API → the provider just stays dormant.
  }

  // 2) Inline edit (Cmd+K). Registered for all languages and document
  // types listed in `INLINE_EDIT_SELECTOR`.
  inlineDisposable = languages.registerInlineCompletionItemProvider(
    INLINE_EDIT_SELECTOR,
    new MavisInlineCompletionProvider({ client }),
  );
  context.subscriptions.push(inlineDisposable);

  // 3) Notebook controller. Auto-attaches to any `jupyter-notebook`
  // document and to our custom `mavis-notebook` type.
  notebookProvider = new MavisNotebookControllerProvider({ client });
  context.subscriptions.push({ dispose: () => notebookProvider?.dispose() });
  notebookProvider.refreshAffinity();
  context.subscriptions.push(workspace.onDidOpenNotebookDocument(() => notebookProvider?.refreshAffinity()));
  // Track notebooks so Mavis shows up in their kernel pickers.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { notebooks } = require('vscode');
    // The notebook type is also declared in `package.json` under
    // `notebookProvider`. We keep the type list here in sync.
    void notebooks;
  } catch { /* ignore */ }

  // 4) Tasks provider. The three built-in tasks (`test`, `lint`,
  // `package`) appear under the "Mavis" source in the Tasks panel.
  taskProvider = new MavisTaskProvider();
  taskProvider.registerWithVSCode();
  context.subscriptions.push({ dispose: () => taskProvider?.dispose() });

  // On activation, surface "Hello" once. If the user has never set an
  // API key we offer the welcome action so they can link their MiniMax
  // account without digging through the command palette.
  if (!context.globalState.get<boolean>('mavis.welcomed')) {
    void context.globalState.update('mavis.welcomed', true);
    void commands.executeCommand('mavis.welcome');
  } else {
    // B.4 user request: the post-activation "ready" popup was too
    // noisy. Welcome flow already runs on first activation; the
    // every-activation toast added no value and blocked input.
    // The status bar item ("Mavis: <agent> | <session>") is the
    // persistent signal that the extension is loaded. Leaving the
    // toast in place only for first-time users (handled above).
    void 0; // intentional no-op
  }
}

export function deactivate(): void {
  statusBar?.dispose();
  statusBar = undefined;
  driveView?.dispose();
  driveView = undefined;
  chatView = undefined;
  codeActionDisposable?.dispose();
  codeActionDisposable = undefined;
  settingsView = undefined;
  telemetry?.dispose();
  telemetry = undefined;
  lmProvider?.dispose();
  lmProvider = undefined;
  inlineDisposable?.dispose();
  inlineDisposable = undefined;
  notebookProvider?.dispose();
  notebookProvider = undefined;
  taskProvider?.dispose();
  taskProvider = undefined;
  client?.dispose();
  client = undefined;
  secretStore = undefined;
  oauth = undefined;
  sessionCache = undefined;
}

/**
 * Reads the extension version from `package.json`. Falls back to
 * `0.0.0` if it can't be resolved (e.g. tests). The version is shown
 * in the settings UI and stamped on every telemetry event.
 */
function readExtensionVersion(context: ExtensionContext): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(path.join(context.extensionPath, 'package.json'));
    if (pkg && typeof pkg.version === 'string') return pkg.version;
  } catch {
    /* fall through */
  }
  return '0.0.0';
}

/**
 * Reads the persisted MiniMax API key off the SecretStorage. We do
 * not surface the value to the UI (the webview only sees a boolean);
 * the key is read once at activation and re-read whenever the user
 * runs `Mavis: Set API key`. The latest value is also mirrored into
 * `globalState[mavis.cachedApiKey]` so it is available synchronously
 * on next activation.
 */
async function secretStoreReadApiKey(context: ExtensionContext): Promise<string | undefined> {
  if (!secretStore) return undefined;
  const k = await secretStore.readApiKey();
  if (k) await context.globalState.update('mavis.cachedApiKey', k);
  return k;
}

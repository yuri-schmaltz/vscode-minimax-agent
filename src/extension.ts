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
import { commands, env, ExtensionContext, StatusBarAlignment, Uri, window, workspace } from 'vscode';
import { MavisClient } from './client/MavisClient';
import { SecretStore } from './auth/SecretStore';
import { OAuthManager } from './auth/OAuth';
import { StatusBarController } from './statusbar/StatusBar';
import { ChatViewProvider } from './views/ChatViewProvider';
import { SessionCache, createSessionCache } from './util/SessionCache';
import {
  CodeActionProviderDeps,
  defaultSendTextToChat,
  registerCodeActionProvider,
  runCodeAction,
} from './codeactions/Provider';
import { CodeActionKind as MavisActionKind } from './client/types';

let client: MavisClient | undefined;
let secretStore: SecretStore | undefined;
let oauth: OAuthManager | undefined;
let statusBar: StatusBarController | undefined;
let chatView: ChatViewProvider | undefined;
let sessionCounter = 0;
let sessionCache: SessionCache | undefined;
let codeActionDisposable: { dispose(): void } | undefined;

function newSessionId(): string {
  sessionCounter += 1;
  const t = Date.now().toString(36);
  return `sess_${t}_${sessionCounter}`;
}

export function activate(context: ExtensionContext): void {
  const config = workspace.getConfiguration('mavis');
  const cliPath = config.get<string>('cliPath', '').trim() || undefined;
  const archonUrl = config.get<string>('archonUrl', '').trim() || undefined;
  const defaultAgent = config.get<string>('defaultAgent', 'mavis') || 'mavis';
  const oauthFlowRaw = config.get<string>('oauthFlow', 'auto');

  // Hydrate cache BEFORE constructing the client so the first
  // setActiveAgent/setActiveSession calls are no-ops (the cache hydrates
  // synchronously and persists on each change).
  sessionCache = createSessionCache(context);
  const hydrated = sessionCache.hydrate();
  const initialAgent = hydrated.agent || defaultAgent;

  client = new MavisClient({
    cliPath,
    archonUrl,
    defaultAgent: initialAgent,
    extensionPath: context.extensionPath,
    globalStoragePath: context.globalStorageUri.fsPath,
    mock: !archonUrl,
  });
  // Apply hydrated state so the UI is consistent from the first paint.
  if (hydrated.sessionId) client.setActiveSession(hydrated.sessionId);

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
    recentSessions: () => (sessionCache?.getRecents() ?? []).map((r) => ({ id: r.id, agent: r.agent, title: r.title ?? '' })),
    onTabClosed: (id: string) => { void sessionCache?.removeRecent(id); },
  });
  context.subscriptions.push(
    window.registerWebviewViewProvider('mavis.chatView', chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

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

  context.subscriptions.push(
    commands.registerCommand('mavis.hello', () => {
      window.showInformationMessage('Hello from Mavis');
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
        window.showInformationMessage(has ? 'Signed in to Mavis' : 'Sign-in failed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.showErrorMessage(`Mavis sign-in failed: ${message}`);
      }
    }),
    commands.registerCommand('mavis.signOut', async () => {
      await oauth!.signOut({ archonUrl });
      window.showInformationMessage('Signed out of Mavis');
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
      commands.executeCommand('workbench.view.mavis-chat');
    }),
    commands.registerCommand('mavis.openSettings', () => {
      commands.executeCommand('workbench.action.openSettings', 'mavis');
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
  );

  // On activation, surface "Hello" once (Fase 0 placeholder).
  window.showInformationMessage('MiniMax Agent (Mavis) ready. Cmd/Ctrl+Shift+M to open chat.');
}

export function deactivate(): void {
  statusBar?.dispose();
  statusBar = undefined;
  chatView = undefined;
  codeActionDisposable?.dispose();
  codeActionDisposable = undefined;
  client?.dispose();
  client = undefined;
  secretStore = undefined;
  oauth = undefined;
  sessionCache = undefined;
}

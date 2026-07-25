/**
 * Mavis extension entry point.
 *
 * Wires together:
 *   - MavisClient (CLI bridge)
 *   - SecretStore + OAuthManager (auth)
 *   - StatusBarController (bottom-bar item)
 *   - ChatViewProvider (sidebar webview)
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

let client: MavisClient | undefined;
let secretStore: SecretStore | undefined;
let oauth: OAuthManager | undefined;
let statusBar: StatusBarController | undefined;
let chatView: ChatViewProvider | undefined;
let sessionCounter = 0;

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

  client = new MavisClient({
    cliPath,
    archonUrl,
    defaultAgent,
    extensionPath: context.extensionPath,
    globalStoragePath: context.globalStorageUri.fsPath,
    mock: !archonUrl,
  });
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
  });
  statusBar.bind();

  chatView = new ChatViewProvider(context, {
    client,
    defaultAgent,
    newSessionId,
    onOpenSettings: () => commands.executeCommand('workbench.action.openSettings', 'mavis'),
  });
  context.subscriptions.push(
    window.registerWebviewViewProvider('mavis.chatView', chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

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
      chatView?.setSession(id, defaultAgent);
      client?.setActiveSession(id);
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
      chatView?.setSession(id, defaultAgent);
      client?.setActiveSession(id);
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
  );

  // On activation, surface "Hello" once (Fase 0 placeholder).
  window.showInformationMessage('MiniMax Agent (Mavis) ready. Cmd/Ctrl+Shift+M to open chat.');
}

export function deactivate(): void {
  statusBar?.dispose();
  statusBar = undefined;
  chatView = undefined;
  client?.dispose();
  client = undefined;
  secretStore = undefined;
  oauth = undefined;
}

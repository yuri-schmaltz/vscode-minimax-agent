/**
 * ChatViewProvider — the sidebar webview that hosts the React chat UI.
 *
 * Responsibilities:
 *   - Resolve the bundled webview assets (dist/webview/main.js + styles.css)
 *     with a strict CSP that allows only the extension's own origin.
 *   - Forward webview → host messages onto the MavisClient (sendPrompt,
 *     newSession, loadHistory, openSettings).
 *   - Forward MavisClient events → webview via postMessage
 *     (sessionChanged, userMessage, assistantMessage, error, done).
 *
 * The provider is registered as a WebviewViewProvider for the
 * `mavis.chatView` view id. The Drive view is registered separately and
 * is hidden by default in this cycle.
 */
import * as path from 'node:path';
import {
  CancellationToken,
  EventEmitter as VSCodeEventEmitter,
  ExtensionContext,
  Uri,
  Webview,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
} from 'vscode';
import { EventEmitter } from 'node:events';
import { MavisClient } from '../client/MavisClient';
import { StreamHandle } from '../client/types';
import { StreamEvent } from '../client/types';

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'newSession'; agent?: string }
  | { type: 'sendPrompt'; sessionId: string; text: string }
  | { type: 'loadHistory'; sessionId: string }
  | { type: 'openSettings' }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'closeTab'; sessionId: string }
  | { type: 'injectAssistantMessage'; text: string };

export type HostToWebview =
  | { type: 'sessionChanged'; session: { id: string; agent: string } | null }
  | { type: 'userMessage'; msg: { id: string; text: string; ts: number } }
  | { type: 'assistantMessage'; delta: { text: string; sessionId: string; ts: number; done?: boolean } }
  | { type: 'error'; message: string }
  | { type: 'history'; messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; text: string; ts: number }> }
  | { type: 'tabs'; tabs: Array<{ id: string; agent: string; title: string; active: boolean }> };

export interface ChatViewDeps {
  client: MavisClient;
  /** Called when the webview wants to open VSCode settings. */
  onOpenSettings?: () => void;
  /** Generates a new session id (caller decides strategy). */
  newSessionId: () => string;
  /** Default agent for new sessions. */
  defaultAgent: string;
  /** LRU list of recent sessions (max 5). When omitted, defaults to []. */
  recentSessions?: () => Array<{ id: string; agent: string; title: string }>;
  /** Called when the user closes a tab in the webview (not the server). */
  onTabClosed?: (sessionId: string) => void;
}

export class ChatViewProvider implements WebviewViewProvider {
  public readonly onMessageFromWebview = new VSCodeEventEmitter<WebviewToHost>();
  private view: WebviewView | undefined;
  private currentHandle: StreamHandle | undefined;
  private currentSession: { id: string; agent: string } | undefined;
  private boundSessionListener = false;

  constructor(
    private readonly context: ExtensionContext,
    private readonly deps: ChatViewDeps,
  ) {}

  resolveWebviewView(
    webviewView: WebviewView,
    _resolveContext: WebviewViewResolveContext<unknown>,
    _token: CancellationToken,
  ): void {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.file(path.join(this.context.extensionPath, 'dist', 'webview')),
        Uri.file(path.join(this.context.extensionPath, 'resources')),
      ],
    };
    webview.html = this.renderHtml(webview);

    webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      try {
        await this.handleWebviewMessage(msg);
      } catch (err) {
        const message = (err instanceof Error) ? err.message : String(err);
        this.postError(message);
      }
    });

    this.wireClientEvents();
  }

  /**
   * Subscribes to MavisClient events so the chat tabs reflect context
   * changes triggered elsewhere (status bar, commands, code actions).
   * Idempotent: a second `resolveWebviewView` won't double-bind.
   */
  private wireClientEvents(): void {
    if (this.boundSessionListener) return;
    this.boundSessionListener = true;
    (this.deps.client.onSessionCreated as unknown as EventEmitter).on('session', () => this.broadcastTabs());
    (this.deps.client.onSessionSwitched as unknown as EventEmitter).on('session', () => this.broadcastTabs());
    this.deps.client.onContextChanged.on('session', () => this.broadcastTabs());
    this.deps.client.onContextChanged.on('agent', () => this.broadcastTabs());
  }

  /** Returns the current session, or undefined. */
  getCurrentSession(): { id: string; agent: string } | undefined {
    return this.currentSession;
  }

  /** Push an error to the webview (e.g. CLI crashed). */
  postError(message: string): void {
    this.postToWebview({ type: 'error', message });
  }

  /**
   * Sends an assistant text message into the active chat. Used by
   * CodeActionProvider when a "text" result (e.g. "Find bugs") needs to
   * land in the webview.
   */
  injectAssistantMessage(text: string): void {
    this.postToWebview({
      type: 'assistantMessage',
      delta: { text, sessionId: this.currentSession?.id ?? '', ts: Date.now(), done: true },
    });
  }

  /** Push a fresh `tabs` snapshot to the webview. */
  broadcastTabs(): void {
    const recents = this.deps.recentSessions?.() ?? [];
    const tabs = recents.map((s) => ({
      id: s.id,
      agent: s.agent,
      title: s.title || s.id.slice(0, 8),
      active: this.currentSession?.id === s.id,
    }));
    this.postToWebview({ type: 'tabs', tabs });
  }

  /** Programmatic helper for the host: announce a new session. */
  setSession(sessionId: string, agent: string): void {
    this.currentSession = { id: sessionId, agent };
    this.postToWebview({ type: 'sessionChanged', session: { id: sessionId, agent } });
    this.broadcastTabs();
  }

  // ----------------------------------------------------------------- private

  private async handleWebviewMessage(msg: WebviewToHost): Promise<void> {
    this.onMessageFromWebview.fire(msg);
    switch (msg.type) {
      case 'ready': {
        // Echo the current session so the UI can render without a refresh.
        if (this.currentSession) {
          this.postToWebview({
            type: 'sessionChanged',
            session: { id: this.currentSession.id, agent: this.currentSession.agent },
          });
        }
        return;
      }
      case 'newSession': {
        const id = this.deps.newSessionId();
        const agent = msg.agent || this.deps.defaultAgent;
        this.setSession(id, agent);
        this.deps.client.setActiveSession(id);
        return;
      }
      case 'sendPrompt': {
        const sessionId = msg.sessionId;
        if (!sessionId) return;
        const userMsg = { id: 'u_' + Date.now().toString(36), text: msg.text, ts: Date.now() };
        this.postToWebview({ type: 'userMessage', msg: userMsg });
        await this.ensureStream(sessionId);
        this.currentHandle?.sendPrompt(msg.text);
        return;
      }
      case 'loadHistory': {
        // No persistence in cycle 1; reply with an empty list.
        this.postToWebview({ type: 'history', messages: [] });
        return;
      }
      case 'openSettings': {
        this.deps.onOpenSettings?.();
        return;
      }
      case 'copyToClipboard': {
        // Defer to vscode.env; host should listen to onMessageFromWebview.
        return;
      }
      case 'switchSession': {
        this.deps.client.setActiveSession(msg.sessionId);
        this.setSession(msg.sessionId, this.currentSession?.agent ?? this.deps.defaultAgent);
        return;
      }
      case 'closeTab': {
        this.deps.onTabClosed?.(msg.sessionId);
        // If the closed tab is the active one, clear the chat.
        if (this.currentSession?.id === msg.sessionId) {
          this.currentSession = undefined;
          this.postToWebview({ type: 'sessionChanged', session: null });
        }
        this.broadcastTabs();
        return;
      }
      case 'injectAssistantMessage': {
        this.injectAssistantMessage(msg.text);
        return;
      }
    }
  }

  private async ensureStream(sessionId: string): Promise<void> {
    if (this.currentHandle && this.currentSession?.id === sessionId) {
      return;
    }
    if (this.currentHandle) {
      this.currentHandle.close();
      this.currentHandle = undefined;
    }
    this.deps.client.setActiveSession(sessionId);
    this.currentHandle = this.deps.client.streamSession(sessionId, {
      message: (e) => this.onStreamEvent('message', e),
      tool_call: (e) => this.onStreamEvent('tool_call', e),
      tool_result: (e) => this.onStreamEvent('tool_result', e),
      error: (e) => this.onStreamEvent('error', e),
      done: (e) => this.onStreamEvent('done', e),
    });
    this.deps.client.setActiveAgent(this.currentSession?.agent ?? this.deps.defaultAgent);
  }

  private onStreamEvent(kind: 'message' | 'tool_call' | 'tool_result' | 'error' | 'done', e: StreamEvent): void {
    if (kind === 'error') {
      const evt = e as { type: 'error'; message: string; sessionId?: string };
      this.postError(evt.message);
      return;
    }
    if (kind === 'message') {
      const evt = e as { type: 'message'; role: 'assistant' | 'system' | 'tool'; content: string; sessionId?: string; ts?: number };
      this.postToWebview({
        type: 'assistantMessage',
        delta: {
          text: evt.content,
          sessionId: evt.sessionId ?? this.currentSession?.id ?? '',
          ts: evt.ts ?? Date.now(),
          done: false,
        },
      });
      return;
    }
    if (kind === 'done') {
      this.postToWebview({
        type: 'assistantMessage',
        delta: {
          text: '',
          sessionId: this.currentSession?.id ?? '',
          ts: Date.now(),
          done: true,
        },
      });
    }
  }

  private postToWebview(msg: HostToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private renderHtml(webview: Webview): string {
    const scriptUri = webview.asWebviewUri(
      Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'main.js')),
    );
    const stylesUri = webview.asWebviewUri(
      Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'styles.css')),
    );
    const cspSource = webview.cspSource;
    // Strict CSP: only allow scripts/styles from the extension's own origin.
    // The webview bundles all React + shiki in main.js, so no 'unsafe-inline'.
    const csp = [
      `default-src 'none'`,
      `script-src 'self' ${cspSource}`,
      `style-src 'self' 'unsafe-inline' ${cspSource}`,
      `img-src 'self' data: ${cspSource}`,
      `font-src 'self' data:`,
      `connect-src 'none'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${stylesUri}" />
  <title>Mavis</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

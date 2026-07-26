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
  commands,
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
  | { type: 'requestSetApiKey' }
  | { type: 'testConnection' }
  | { type: 'openOutput' }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'closeTab'; sessionId: string }
  | { type: 'injectAssistantMessage'; text: string }
  | { type: 'addAttachment'; attachment: Attachment }
  | { type: 'removeAttachment'; id: string };

/** A pending attachment shown as a chip above the chat textarea. */
export interface Attachment {
  /** Local id used as the React key + removal handle. */
  id: string;
  /** Human label (filename or item name). */
  name: string;
  /**
   * Source kind:
   *   - 'os': a file dropped from the OS file explorer (local path).
   *   - 'drive': an item dragged from the Mavis Drive tree.
   */
  source: 'os' | 'drive';
  /** Local file path (set when source === 'os'). */
  path?: string;
  /** Drive item id (set when source === 'drive'). */
  driveId?: string;
  /** MIME type if known. */
  mimeType?: string;
}

export type HostToWebview =
  | { type: 'sessionChanged'; session: { id: string; agent: string } | null }
  | { type: 'userMessage'; msg: { id: string; text: string; ts: number } }
  | { type: 'assistantMessage'; delta: { text: string; sessionId: string; ts: number; done?: boolean } }
  | { type: 'error'; message: string }
  | { type: 'apiKeyMissing' }
  | { type: 'history'; messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; text: string; ts: number }> }
  | { type: 'tabs'; tabs: Array<{ id: string; agent: string; title: string; active: boolean }> }
  | { type: 'attachments'; attachments: Attachment[] }
  | { type: 'focusInput' };

export interface ChatViewDeps {
  client: MavisClient;
  /** Called when the webview wants to open VSCode settings. */
  onOpenSettings?: () => void;
  /** Optional log sink for stream lifecycle (used for the Mavis output channel). */
  onLog?: (line: string) => void;
  /** Generates a new session id (caller decides strategy). */
  newSessionId: () => string;
  /** Default agent for new sessions. */
  defaultAgent: string;
  /** LRU list of recent sessions (max 5). When omitted, defaults to []. */
  recentSessions?: () => Array<{ id: string; agent: string; title: string }>;
  /** Called when the user closes a tab in the webview (not the server). */
  onTabClosed?: (sessionId: string) => void;
  /** Called when the chat view auto-creates a session on open. Lets
   * the host persist it in the SessionCache. */
  onNewSession?: (sessionId: string, agent: string) => void;
}

export class ChatViewProvider implements WebviewViewProvider {
  public readonly onMessageFromWebview = new VSCodeEventEmitter<WebviewToHost>();
  private view: WebviewView | undefined;
  private currentHandle: StreamHandle | undefined;
  private currentSession: { id: string; agent: string } | undefined;
  private boundSessionListener = false;
  private attachments: Attachment[] = [];

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

    // Always have an active session ready — no "click New first" needed.
    // If the client already has a session from activation (the
    // SessionCache hydrates one), reuse it. Otherwise mint a fresh
    // one so the input is immediately usable.
    if (!this.currentSession) {
      const id = this.deps.newSessionId();
      this.setSession(id, this.deps.defaultAgent);
      try { this.deps.client.setActiveSession(id); } catch { /* noop */ }
      try { void this.deps.client.setActiveAgent(this.deps.defaultAgent); } catch { /* noop */ }
      void this.deps.onNewSession?.(id, this.deps.defaultAgent);
    }
    // Defer the focus so the webview is mounted before we touch it.
    setTimeout(() => { try { this.view?.webview.postMessage({ type: 'focusInput' }); } catch { /* noop */ } }, 80);

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

  /**
   * Adds an attachment (called by the host when files are dropped on the
   * webview). Returns the resulting attachment for tests.
   */
  addAttachment(attachment: Attachment): Attachment {
    // Dedupe by id (for drive items) or by path (for OS files).
    const existingIdx = this.attachments.findIndex((a) =>
      a.id === attachment.id || (a.path && attachment.path && a.path === attachment.path),
    );
    if (existingIdx >= 0) {
      this.attachments[existingIdx] = attachment;
    } else {
      this.attachments.push(attachment);
    }
    this.broadcastAttachments();
    return attachment;
  }

  /** Removes an attachment by id. Returns true if removed. */
  removeAttachment(id: string): boolean {
    const before = this.attachments.length;
    this.attachments = this.attachments.filter((a) => a.id !== id);
    const removed = this.attachments.length < before;
    if (removed) this.broadcastAttachments();
    return removed;
  }

  /** Returns a snapshot of the current attachments (for tests). */
  getAttachments(): Attachment[] {
    return this.attachments.slice();
  }

  /**
   * Handles a raw drag-and-drop event from the webview. The webview
   * pre-parses OS file paths; Drive items arrive as `{file:<id>:<name>}`
   * payloads produced by the Drive view's drag controller.
   */
  handleDroppedFiles(payloads: Array<{ name: string; path?: string; payload?: string; mimeType?: string }>): Attachment[] {
    const added: Attachment[] = [];
    for (const p of payloads) {
      const m = typeof p.payload === 'string' ? /^\{file:([^:}]+):([^:}]+)\}$/.exec(p.payload) : null;
      if (m) {
        added.push(this.addAttachment({
          id: `att_drive_${m[1]}`,
          name: p.name || m[2],
          source: 'drive',
          driveId: m[1],
        }));
        continue;
      }
      if (p.path) {
        const fileName = p.name || p.path.split(/[\\/]/).pop() || p.path;
        added.push(this.addAttachment({
          id: `att_os_${p.path}_${added.length}`,
          name: fileName,
          source: 'os',
          path: p.path,
          mimeType: p.mimeType,
        }));
        continue;
      }
      // Unknown payload — surface as a text chip.
      added.push(this.addAttachment({
        id: `att_text_${added.length}_${Date.now().toString(36)}`,
        name: p.name || 'attachment',
        source: 'os',
        mimeType: p.mimeType,
      }));
    }
    return added;
  }

  /** Push the current attachments list to the webview. */
  broadcastAttachments(): void {
    this.postToWebview({ type: 'attachments', attachments: this.attachments.slice() });
  }

  /**
   * Returns the attachments formatted as text appended to a prompt
   * (e.g. `[file: name1 (id1), name2 (path2)]`). The webview sends its
   * own markup; this is a host-side helper for forwarding to a stream
   * when needed.
   */
  formatAttachmentsForPrompt(): string {
    if (this.attachments.length === 0) return '';
    return this.attachments
      .map((a) => {
        if (a.source === 'drive' && a.driveId) return `{file:${a.driveId}:${a.name}}`;
        if (a.path) return `${a.path}`;
        return a.name;
      })
      .join(', ');
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
        // Pre-flight: if no API key is set, tell the user before
        // the shim ever tries to talk to the backend. This avoids
        // a confusing "no response" UI when the only problem is the
        // missing key.
        if (!this.deps.client.getApiKey?.()) {
          this.postToWebview({ type: 'apiKeyMissing' });
        }
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
      case 'requestSetApiKey': {
        // Forward to the host extension so the input box opens in the
        // editor (not inside the webview, which can't show password
        // fields safely).
        void commands.executeCommand('mavis.setApiKey');
        return;
      }
      case 'testConnection': {
        // Defer to the host's diagnostic command. The webview doesn't
        // need the result — the test-connection handler already writes
        // its output to the Mavis output channel.
        void commands.executeCommand('mavis.testConnection');
        return;
      }
      case 'openOutput': {
        // Surface the Mavis output channel so the user can see the
        // shim stderr + diagnostic trail.
        void commands.executeCommand('mavis.openOutput');
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
      case 'addAttachment': {
        this.addAttachment(msg.attachment);
        return;
      }
      case 'removeAttachment': {
        this.removeAttachment(msg.id);
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
    this.deps.onLog?.(`[stream] start sessionId=${sessionId}`);
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
      this.deps.onLog?.(`[stream] error sessionId=${evt.sessionId ?? '?'} ${evt.message}`);
      this.postError(evt.message);
      return;
    }
    if (kind === 'done') {
      this.deps.onLog?.(`[stream] done`);
      this.postToWebview({
        type: 'assistantMessage',
        delta: {
          text: '',
          sessionId: this.currentSession?.id ?? '',
          ts: Date.now(),
          done: true,
        },
      });
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

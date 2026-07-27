/**
 * Mavis chat webview (React). Renders a simple two-pane chat:
 *
 *   - Header: agent name, short session id, action buttons (New, Settings)
 *   - Body:   list of messages (user/assistant/system) with markdown + shiki
 *   - Footer: textarea + Enter-to-send (Shift+Enter for newline)
 *
 * Streaming: each `assistantMessage` delta is appended to the most recent
 * assistant message until `{done: true}` arrives.
 */
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

type Role = 'user' | 'assistant' | 'system' | 'tool';

interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  ts: number;
}

type WebviewToHost =
  | { type: 'ready' }
  | { type: 'newSession'; agent?: string }
  | { type: 'sendPrompt'; sessionId: string; text: string; mode?: 'builder' | 'plan'; toolsEnabled?: boolean; contextFiles?: string[]; model?: string }
  | { type: 'loadHistory'; sessionId: string }
  | { type: 'openSettings' }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'closeTab'; sessionId: string }
  | { type: 'injectAssistantMessage'; text: string };

type HostToWebview =
  | { type: 'sessionChanged'; session: { id: string; agent: string } | null }
  | { type: 'userMessage'; msg: { id: string; text: string; ts: number } }
  | {
      type: 'assistantMessage';
      delta: { text: string; sessionId: string; ts: number; done?: boolean };
    }
  | { type: 'reasoning'; content: string; sessionId: string; ts: number }
  | { type: 'toolCall'; id: string; name: string; args: unknown; sessionId: string; ts: number }
  | { type: 'toolResult'; id: string; name: string; result: unknown; sessionId: string; ts: number }
  | { type: 'modelChanged'; sessionId: string; model: string }
  | { type: 'availableModels'; models: string[]; default: string }
  | { type: 'agentChanged'; sessionId: string; agent: string }
  | { type: 'availableAgents'; agents: Array<{ name: string; description: string }>; default: string }
  | { type: 'error'; message: string }
  | {
      type: 'history';
      messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; text: string; ts: number }>;
    }
  | {
      type: 'tabs';
      tabs: Array<{ id: string; agent: string; title: string; active: boolean }>;
    };

// VSCode acquires a global `acquireVsCodeApi()` only inside an actual webview;
// outside of one (e.g. in a Storybook) we fall back to a no-op shim.
declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
  }
}

const vscode = (typeof window !== 'undefined' && window.acquireVsCodeApi)
  ? window.acquireVsCodeApi()
  : { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };

function postToHost(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

function shortSessionId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length <= 8 ? id : id.slice(0, 8);
}

// B.9 (diagnostic) — Error boundary that surfaces React render
// errors to the user instead of leaving the webview in a
// perpetual 'loading' state. Shows the error message and a
// 'Reload Webview' button.
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Mavis webview error:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="mavis-error" role="alert" style={{ padding: 16 }}>
          <div className="mavis-error-body">
            ⚠ Mavis webview crashed: {this.state.error.message}
          </div>
          <button
            className="mavis-error-action"
            onClick={() => location.reload()}
          >
            Reload Webview
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App(): JSX.Element {
  const [session, setSession] = useState<{ id: string; agent: string } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // B.7 — pending is a counter (not a boolean) so the user can
  // send multiple messages while the shim is processing earlier
  // ones. The shim's for-await loop processes prompts in order,
  // so each one is acknowledged with a separate assistantMessage.
  const [pending, setPending] = useState(0);
  const [tabs, setTabs] = useState<Array<{ id: string; agent: string; title: string; active: boolean }>>([]);
  const [tools, setTools] = useState<Array<{ id: string; name: string; args: unknown; result?: unknown; status: 'running' | 'done' | 'error' }>>([]);
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [mode, setMode] = useState<'builder' | 'plan'>('builder');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState<string>('');
  const [availableAgents, setAvailableAgents] = useState<Array<{ name: string; description: string }>>([]);
  const [currentAgent, setCurrentAgent] = useState<string>('');
  const [contextFiles] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Wire host → webview messages.
  useEffect(() => {
    function onMessage(ev: MessageEvent<HostToWebview>) {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'sessionChanged':
          setSession(msg.session);
          // Reset the message list when the session changes (we don't have
          // local persistence in cycle 1).
          setMessages([]);
          break;
        case 'userMessage':
          setMessages((m) => [
            ...m,
            { id: msg.msg.id, role: 'user', text: msg.msg.text, ts: msg.msg.ts },
          ]);
          // Mark the chat as waiting for a response so the user sees
          // a spinner / pending indicator. The pending flag is cleared
          // by the next assistantMessage, by an error, or by the
          // 15-second timeout below.
          setPending((p) => p + 1);
          setError(null);
          break;
        case 'assistantMessage':
          setPending((p) => Math.max(0, p - 1));
          setMessages((m) => {
            if (msg.delta.done) return m; // last chunk already appended
            const text = msg.delta.text;
            if (!text) return m;
            const last = m[m.length - 1];
            if (last && last.role === 'assistant' && last.id.startsWith('a_')) {
              const merged = [...m];
              merged[merged.length - 1] = { ...last, text: last.text + text };
              return merged;
            }
            return [
              ...m,
              {
                id: 'a_' + msg.delta.ts.toString(36),
                role: 'assistant',
                text,
                ts: msg.delta.ts,
              },
            ];
          });
          break;
        case 'error':
          setPending((p) => Math.max(0, p - 1));
          setError(msg.message);
          break;
        case 'reasoning':
          setReasoning((prev) => (prev ? prev + msg.content : msg.content));
          break;
        case 'toolCall':
          setTools((prev) => [
            ...prev,
            { id: msg.id, name: msg.name, args: msg.args, status: 'running' },
          ]);
          break;
        case 'availableModels':
          setAvailableModels(msg.models);
          if (msg.default) setCurrentModel(msg.default);
          break;
        case 'availableAgents':
          setAvailableAgents(msg.agents);
          if (msg.default) setCurrentAgent(msg.default);
          break;
        case 'modelChanged':
          setCurrentModel(msg.model);
          break;
        case 'agentChanged':
          setCurrentAgent(msg.agent);
          break;
        case 'toolResult':
          setTools((prev) =>
            prev.map((t) =>
              t.id === msg.id
                ? {
                    ...t,
                    result: msg.result,
                    status:
                      msg.result && typeof msg.result === 'object' && 'error' in (msg.result as Record<string, unknown>)
                        ? 'error'
                        : 'done',
                  }
                : t,
            ),
          );
          break;
        case 'apiKeyMissing':
          setError(
            'Sua chave de API do MiniMax não está configurada. Clique em "Definir API key" abaixo para conectar sua conta.',
          );
          break;
        case 'history':
          setMessages(
            msg.messages.map((mm) => ({
              id: mm.id,
              role: mm.role,
              text: mm.text,
              ts: mm.ts,
            })),
          );
          break;
        case 'tabs':
          setTabs(msg.tabs);
          break;
        case 'focusInput':
          // Triggered by the host when the panel becomes visible so
          // the user can type immediately without clicking the
          // textarea first. Deferred via setTimeout because the
          // webview might not be fully mounted yet.
          setTimeout(() => {
            const ta = document.querySelector('textarea.mavis-input') as HTMLTextAreaElement | null;
            if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
          }, 0);
          break;
      }
    }
    window.addEventListener('message', onMessage);
    postToHost({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // 15-second timeout: if pending is still on after 15s, surface a
  // banner with a Test Connection button so the user can diagnose
  // without having to dig through the Mavis output channel.
  useEffect(() => {
    if (pending === 0) return;
    const handle = window.setTimeout(() => {
      setPending((p) => Math.max(0, p - 1));
      setError(
        'O Mavis demorou demais pra responder. Rode "Mavis: Test connection" no Command Palette para diagnosticar a rede, ou abra "Mavis: Open Output" para ver o stderr do shim.',
      );
    }, 15000);
    return () => window.clearTimeout(handle);
  }, [pending]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages.length]);

  const sendDraft = useCallback(() => {
    const text = draft.trim();
    if (!text || !session) return;
    postToHost({
      type: 'sendPrompt',
      sessionId: session.id,
      text,
      mode,
      toolsEnabled: true,
      model: currentModel || undefined,
      agent: currentAgent || undefined,
      // B.1: chips for @-mentions are not yet wired in the webview
      // (autocomplete is B.5). The host will accept contextFiles and
      // forward them to the shim when present.
      contextFiles: contextFiles,
    });
    setDraft('');
    setTools([]);
    setReasoning(null);
  }, [draft, session, mode, contextFiles, currentModel, currentAgent]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === 'builder' ? 'plan' : 'builder'));
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendDraft();
      }
    },
    [sendDraft],
  );

  const newSession = useCallback(() => {
    postToHost({ type: 'newSession' });
  }, []);

  const openSettings = useCallback(() => {
    postToHost({ type: 'openSettings' });
  }, []);

  const copySession = useCallback(() => {
    if (session) {
      postToHost({ type: 'copyToClipboard', text: session.id });
    }
  }, [session]);

  const switchTo = useCallback((sessionId: string) => {
    postToHost({ type: 'switchSession', sessionId });
  }, []);

  const closeTab = useCallback((sessionId: string, ev: React.MouseEvent) => {
    ev.stopPropagation();
    postToHost({ type: 'closeTab', sessionId });
  }, []);

  const headerSession = useMemo(() => shortSessionId(session?.id), [session]);

  return (
    <div className="mavis-root">
      <header className="mavis-header">
        <div className="mavis-header-left">
          <span className="mavis-agent" title={session?.agent ?? ''}>
            {session?.agent ?? 'mavis'}
          </span>
          <button
            className="mavis-session-id"
            type="button"
            title={`Full id: ${session?.id ?? ''} (click to copy)`}
            onClick={copySession}
          >
            {headerSession}
          </button>
        </div>
        <div className="mavis-header-right">
          <select
            className="mavis-model-select"
            value={currentModel}
            onChange={(e) => postToHost({ type: 'setModel', model: e.target.value, sessionId: session?.id })}
            title="Model used for this session"
            disabled={!session || availableModels.length === 0}
          >
            {availableModels.length === 0 && <option value="">loading…</option>}
            {availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <select
            className="mavis-agent-select"
            value={currentAgent}
            onChange={(e) => postToHost({ type: 'setAgent', agent: e.target.value, sessionId: session?.id })}
            title="Agent persona for this session (see mavis.agents setting)"
            disabled={!session || availableAgents.length === 0}
          >
            {availableAgents.length === 0 && <option value="">loading…</option>}
            {availableAgents.map((a) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
          <button
            type="button"
            className={'mavis-mode-toggle' + (mode === 'plan' ? ' mavis-mode-plan' : '')}
            onClick={toggleMode}
            title={
              mode === 'builder'
                ? 'Builder mode (read + tool access). Click to switch to Plan (read-only).'
                : 'Plan mode (read-only). Click to switch to Builder.'
            }
          >
            {mode === 'builder' ? '🛠 Builder' : '👁 Plan'}
          </button>
          <button type="button" onClick={newSession} title="New chat">
            New
          </button>
          <button type="button" onClick={openSettings} title="Open settings">
            Settings
          </button>
        </div>
      </header>
      <nav className="mavis-tabs" aria-label="Recent sessions">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={'mavis-tab' + (t.active ? ' mavis-tab-active' : '')}
            onClick={() => switchTo(t.id)}
            title={t.id}
          >
            <span className="mavis-tab-title">{t.title || shortSessionId(t.id)}</span>
            <button
              type="button"
              className="mavis-tab-close"
              aria-label="Close tab"
              onClick={(e) => closeTab(t.id, e)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="mavis-tab mavis-tab-new"
          onClick={newSession}
          title="New chat"
          aria-label="New chat"
        >
          +
        </button>
      </nav>

      <div className="mavis-body" ref={bodyRef}>
        {messages.length === 0 && !error && (
          <div className="mavis-empty">
            <h2>Ask anything about your code.</h2>
            <p>Cmd/Ctrl+Shift+M toggles the chat.</p>
            <p className="mavis-empty-tip">Press Enter to send, Shift+Enter for a new line.</p>
          </div>
        )}
        {error && (
          <div className="mavis-error" role="alert">
            <div className="mavis-error-body">⚠ {error}</div>
            {/API[ _]?key|API key|MAVIS_API_KEY/i.test(error) && (
              <button
                className="mavis-error-action"
                onClick={() => postToHost({ type: 'requestSetApiKey' })}
              >
                Definir API key
              </button>
            )}
            {(pending === 0) && (/demorou|timeout|Test connection|Testar conexão|Teste a conexão|conexão|connection/i.test(error) || /demorou/i.test(error)) && (
              <>
                <button
                  className="mavis-error-action"
                  onClick={() => postToHost({ type: 'testConnection' })}
                >
                  Testar conexão
                </button>
                <button
                  className="mavis-error-action"
                  onClick={() => postToHost({ type: 'openOutput' })}
                >
                  Abrir Output
                </button>
              </>
            )}
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {reasoning && (
          <details className="mavis-reasoning">
            <summary>💭 thinking</summary>
            <pre>{reasoning}</pre>
          </details>
        )}
        {tools.length > 0 && (
          <ul className="mavis-tools">
            {tools.map((t) => (
              <li
                key={t.id}
                className={
                  'mavis-tool mavis-tool-' +
                  (t.status === 'running' ? 'running' : t.status === 'error' ? 'error' : 'done')
                }
              >
                <span className="mavis-tool-name">
                  {t.status === 'running' ? '⏳' : t.status === 'error' ? '✖' : '✓'} {t.name}
                </span>
                <code className="mavis-tool-args">{JSON.stringify(t.args)}</code>
                {t.result !== undefined && (
                  <ToolResult name={t.name} result={t.result} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="mavis-footer">
        <textarea
          className="mavis-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            session
              ? (pending > 0 ? `Processando… (${pending} na fila)` : 'Type a message…')
              : 'Press “New” to start a session.'
          }
          rows={3}
          disabled={!session}
        />
        <button
          type="button"
          className="mavis-send"
          onClick={sendDraft}
          disabled={!session || !draft.trim()}
        >
          Send
        </button>
      </footer>
    </div>
  );
}

function Message({ message }: { message: ChatMessage }): JSX.Element {
  const cls = `mavis-msg mavis-msg-${message.role}`;
  return (
    <div className={cls}>
      <div className="mavis-msg-role">{message.role}</div>
      <div className="mavis-msg-body">
        {message.role === 'assistant' ? (
          <ReactMarkdown>{message.text || ' '}</ReactMarkdown>
        ) : (
          <pre className="mavis-msg-plain">{message.text}</pre>
        )}
      </div>
    </div>
  );
}

// B.2 — Render the result of a tool call. For write_file / edit_file
// we render a color-coded diff so the user can review the change.
// For other tools we render a truncated JSON dump.
function ToolResult({ name, result }: { name: string; result: unknown }): JSX.Element {
  if (!result || typeof result !== 'object') {
    return <pre className="mavis-tool-result">{String(result)}</pre>;
  }
  const r = result as Record<string, unknown>;
  // Write tools: render a diff.
  if ((name === 'write_file' || name === 'edit_file') && Array.isArray(r.diff)) {
    const hunks = r.diff as Array<{ kind: 'context' | 'add' | 'remove'; lines: string[] }>;
    const action = (r.action as string) ?? 'modified';
    return (
      <div className="mavis-tool-diff">
        <div className="mavis-tool-diff-meta">
          <span className="mavis-tool-diff-action">{action}</span>
          {typeof r.bytes === 'number' && <span className="mavis-tool-diff-bytes">{r.bytes} B</span>}
        </div>
        <pre className="mavis-tool-diff-body">
          {hunks.map((h, i) => (
            <div key={i} className={`mavis-diff-hunk mavis-diff-${h.kind}`}>
              {h.lines.map((line, j) => (
                <div key={j} className="mavis-diff-line">
                  <span className="mavis-diff-marker">
                    {h.kind === 'add' ? '+' : h.kind === 'remove' ? '-' : ' '}
                  </span>
                  <span className="mavis-diff-text">{line || ' '}</span>
                </div>
              ))}
            </div>
          ))}
        </pre>
      </div>
    );
  }
  // Read tools / generic: truncated JSON.
  return (
    <pre className="mavis-tool-result">
      {JSON.stringify(result, null, 2).slice(0, 1500)}
    </pre>
  );
}

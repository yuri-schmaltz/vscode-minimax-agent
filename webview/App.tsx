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
  | { type: 'sendPrompt'; sessionId: string; text: string }
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

export function App(): JSX.Element {
  const [session, setSession] = useState<{ id: string; agent: string } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [tabs, setTabs] = useState<Array<{ id: string; agent: string; title: string; active: boolean }>>([]);
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
          break;
        case 'assistantMessage':
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
          setError(msg.message);
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
      }
    }
    window.addEventListener('message', onMessage);
    postToHost({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages.length]);

  const sendDraft = useCallback(() => {
    const text = draft.trim();
    if (!text || !session) return;
    postToHost({ type: 'sendPrompt', sessionId: session.id, text });
    setDraft('');
  }, [draft, session]);

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
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
      </div>

      <footer className="mavis-footer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={session ? 'Type a message…' : 'Press “New” to start a session.'}
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

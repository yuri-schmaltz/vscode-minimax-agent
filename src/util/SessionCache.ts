/**
 * SessionCache — tiny LRU cache persisted in `ExtensionContext.globalState`.
 *
 * Two responsibilities:
 *   1. Stash the active `agent`, `sessionId`, and the LRU list of
 *      recent sessions (max 5) so they survive a window reload.
 *   2. Expose mutators that keep the recent list in MRU order, dedupe,
 *      and trim to the size cap.
 *
 * Persistence is keyed by:
 *   - `mavis.lastAgent`        → string
 *   - `mavis.lastSessionId`    → string | undefined
 *   - `mavis.recentSessions`   → Array<{id, agent, title}>
 *
 * All writes are no-ops if the new value equals the current value.
 */
import { ExtensionContext, Memento } from 'vscode';

const KEY_LAST_AGENT = 'mavis.lastAgent';
const KEY_LAST_SESSION = 'mavis.lastSessionId';
const KEY_RECENTS = 'mavis.recentSessions';

const MAX_RECENTS = 5;

export interface SessionEntry {
  id: string;
  agent: string;
  title?: string;
}

export class SessionCache {
  constructor(private readonly state: Memento) {}

  /** Default agent to use when no value is stored. */
  static readonly DEFAULT_AGENT = 'mavis';

  /** Returns the cached agent or the default. */
  getLastAgent(): string {
    return this.state.get<string>(KEY_LAST_AGENT) ?? SessionCache.DEFAULT_AGENT;
  }

  /** Persist the active agent. No-op if unchanged. */
  async setLastAgent(agent: string): Promise<void> {
    if (this.getLastAgent() === agent) return;
    await this.state.update(KEY_LAST_AGENT, agent);
  }

  /** Returns the cached session id or undefined. */
  getLastSessionId(): string | undefined {
    return this.state.get<string>(KEY_LAST_SESSION);
  }

  /** Persist the active session id. No-op if unchanged. */
  async setLastSessionId(id: string | undefined): Promise<void> {
    if (this.getLastSessionId() === id) return;
    await this.state.update(KEY_LAST_SESSION, id);
  }

  /** Returns the LRU list (most-recent first). */
  getRecents(): SessionEntry[] {
    const raw = this.state.get<SessionEntry[]>(KEY_RECENTS);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r): r is SessionEntry => !!r && typeof r.id === 'string' && typeof r.agent === 'string')
      .slice(0, MAX_RECENTS);
  }

  /**
   * Pushes a session to the front of the recents list. Dedupe by id
   * (move-to-front semantics). Trims to MAX_RECENTS.
   */
  async pushRecent(entry: SessionEntry): Promise<void> {
    if (!entry || !entry.id) return;
    const cur = this.getRecents().filter((e) => e.id !== entry.id);
    cur.unshift({ id: entry.id, agent: entry.agent, title: entry.title });
    if (cur.length > MAX_RECENTS) cur.length = MAX_RECENTS;
    await this.state.update(KEY_RECENTS, cur);
  }

  /**
   * Removes a session from the recents list without touching the
   * server-side session. Returns true if the entry was present.
   */
  async removeRecent(id: string): Promise<boolean> {
    const cur = this.getRecents();
    const next = cur.filter((e) => e.id !== id);
    if (next.length === cur.length) return false;
    await this.state.update(KEY_RECENTS, next);
    return true;
  }

  /**
   * Hydrate the cache from stored values. Safe to call once at
   * `activate()`. Returns the resolved `{agent, sessionId}`.
   */
  hydrate(): { agent: string; sessionId: string | undefined } {
    return { agent: this.getLastAgent(), sessionId: this.getLastSessionId() };
  }
}

/** Helper to bind the cache to a given `ExtensionContext`. */
export function createSessionCache(context: ExtensionContext): SessionCache {
  return new SessionCache(context.globalState);
}

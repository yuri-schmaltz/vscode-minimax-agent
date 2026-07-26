/**
 * MavisClient — the bridge between the VSCode extension host and the
 * `mavis` CLI. Responsible for:
 *
 *   - Resolving which binary to spawn (settings > bundled > error).
 *   - Spawning long-lived child processes for `session stream`.
 *   - Parsing NDJSON from stdout and dispatching typed events.
 *   - Exposing simple `listSessions()` / `listAgents()` one-shot calls.
 *   - Cleanup on `dispose()` (kills all streams, detaches listeners).
 *
 * The class deliberately takes a `deps` object in the constructor so
 * tests can inject a fake child_process implementation.
 */
import { spawn, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { NDJSONParser } from './ndjson';
import { redactString } from '../util/redact';
import {
  AgentSummary,
  ClientEvent,
  CodeActionKind,
  CodeActionResult,
  CodeActionTaskHandle,
  CronInput,
  CronSummary,
  DriveCategory,
  DriveFile,
  DriveItem,
  PromptMessage,
  SessionSummary,
  StreamEvent,
  StreamHandle,
} from './types';

export const PROTOCOL_VERSION = 1;

/**
 * Thrown when neither `mavis.cliPath` is set nor the bundled shim is
 * resolvable (e.g. extension package is missing the `resources/` folder).
 *
 * Code that wants to surface a "please install the CLI" message to the
 * user should `instanceof` this rather than parsing `err.message`.
 */
export class MavisCliNotFoundError extends Error {
  override readonly name = 'MavisCliNotFoundError';
  constructor(message = 'Mavis CLI not found. Set `mavis.cliPath` in settings or install the bundled shim.') {
    super(message);
  }
}

/**
 * Thrown when a caller tries to interact with a stream handle after the
 * underlying child has already been closed (either explicitly via
 * `handle.close()` or implicitly via `MavisClient.dispose()`).
 */
export class SessionClosedError extends Error {
  override readonly name = 'SessionClosedError';
  constructor(public readonly sessionId: string) {
    super(`stream for ${sessionId} is closed`);
  }
}

export interface MavisClientOptions {
  /** Override path to the mavis binary. Takes priority over the bundled shim. */
  cliPath?: string;
  /** archon-server base URL. Empty means use the shim/mock. */
  archonUrl?: string;
  /** API base path prefix (e.g. `/v1`). Defaults to `/v1`. */
  apiBase?: string;
  /** Default agent to use when none is specified. */
  defaultAgent?: string;
  /** Model used for completions. Defaults to `MiniMax-M3`. */
  model?: string;
  /** When true, the shim uses SSE streaming (MAVIS_STREAM=1). Default: false. */
  stream?: boolean;
  /** MiniMax / archon-server API key. Passed through as MAVIS_API_KEY. */
  apiKey?: string;
  /** Optional callback to receive redacted shim stderr (for Output Channel). */
  onStderr?: (text: string) => void;
  /** Workspace root (used by tool sandboxing + agent.md lookup). */
  workspace?: string;
  /** Force mock mode (sets MAVIS_MOCK=1 in env). Defaults to true when archonUrl is empty. */
  mock?: boolean;
  /** Override child_process.spawn (for tests). */
  spawnImpl?: typeof spawn;
  /** Resolve the bundled shim path. Defaults to `resources/mavis-cli/mavis.cjs`. */
  resolveBundledPath?: () => string;
  /** Extension context path (used to locate the bundled shim). */
  extensionPath?: string;
  /** Workspace storage path. */
  globalStoragePath?: string;
}

interface RunningStream {
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  emitter: EventEmitter;
  closed: boolean;
}

export class MavisClient {
  private readonly options: Required<Omit<MavisClientOptions, 'extensionPath' | 'globalStoragePath' | 'archonUrl' | 'cliPath' | 'defaultAgent' | 'apiKey' | 'apiBase' | 'model' | 'stream' | 'onStderr' | 'workspace'>> & {
    cliPath: string | undefined;
    archonUrl: string | undefined;
    defaultAgent: string | undefined;
    extensionPath: string | undefined;
    globalStoragePath: string | undefined;
    apiKey: string | undefined;
    apiBase: string;
    model: string;
    stream: boolean;
    onStderr?: (text: string) => void;
    workspace?: string;
  };
  private readonly spawnImpl: typeof spawn;
  private readonly streams = new Set<RunningStream>();
  private disposed = false;

  /** Fires when the set of available agents changes (or once on first list). */
  readonly onAgentsChanged = new EventEmitter();
  /** Fires when sessions list changes. */
  readonly onSessionsChanged = new EventEmitter();
  /** Fires when the active agent or session changes (UI hook). */
  readonly onContextChanged = new EventEmitter();
  /** Fires immediately after a new session is created via createSession(). */
  readonly onSessionCreated = new EventEmitter();
  /** Fires after the active session id is updated (alias of contextChanged 'session'). */
  readonly onSessionSwitched = new EventEmitter();
  /** Fires when the Drive contents change (after listDrive, getDriveFile, deleteDriveFile). */
  readonly onDriveChanged = new EventEmitter();
  /** Fires when the cron list changes (after listCrons, createCron, deleteCron, enable/disable). */
  readonly onCronChanged = new EventEmitter();

  private activeAgent: string;
  private activeSession: string | undefined;

  constructor(opts: MavisClientOptions = {}) {
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.options = {
      cliPath: opts.cliPath,
      archonUrl: opts.archonUrl,
      apiBase: opts.apiBase ?? '/v1',
      defaultAgent: opts.defaultAgent,
      model: opts.model ?? 'MiniMax-M3',
      apiKey: opts.apiKey,
      stream: opts.stream ?? false,
      mock: opts.mock ?? !opts.archonUrl,
      spawnImpl: opts.spawnImpl ?? spawn,
      resolveBundledPath:
        opts.resolveBundledPath ??
        (() => path.join(opts.extensionPath ?? '', 'resources', 'mavis-cli', 'mavis.cjs')),
      extensionPath: opts.extensionPath,
      globalStoragePath: opts.globalStoragePath,
    };
    this.activeAgent = opts.defaultAgent ?? 'mavis';
  }

  // ------------------------------------------------------------------ public

  /** Returns the resolved binary path (settings > bundled). Throws if none. */
  resolveBinary(): string {
    const fromSettings = this.options.cliPath;
    if (fromSettings && fromSettings.trim().length > 0) {
      return fromSettings;
    }
    const bundled = this.options.resolveBundledPath();
    if (!bundled) {
      throw new MavisCliNotFoundError();
    }
    return bundled;
  }

  /** Returns true if calls will run in mock mode (no real archon-server). */
  isMock(): boolean {
    return Boolean(this.options.mock);
  }

  /** Active agent id (e.g. "mavis"). Mutable via `setActiveAgent`. */
  getActiveAgent(): string {
    return this.activeAgent;
  }

  setActiveAgent(agent: string): void {
    if (agent === this.activeAgent) return;
    this.activeAgent = agent;
    this.onContextChanged.emit('agent', agent);
  }

  /** Currently streamed session id, or undefined. */
  getActiveSession(): string | undefined {
    return this.activeSession;
  }

  setActiveSession(sessionId: string | undefined): void {
    if (sessionId === this.activeSession) return;
    this.activeSession = sessionId;
    this.onContextChanged.emit('session', sessionId);
    this.onSessionSwitched.emit('session', sessionId as string);
  }

  /**
   * Sets (or clears) the MiniMax / archon-server API key. Subsequent
   * child processes spawned by this client will receive the key as
   * `MAVIS_API_KEY` in their environment. Idempotent: passing the
   * same key is a no-op.
   */
  setApiKey(key: string | undefined): void {
    this.options.apiKey = key || undefined;
  }

  /**
   * Toggles SSE streaming on the shim. When `true`, the shim sets
   * `MAVIS_STREAM=1` and tries to parse the response as SSE.
   */
  setStream(on: boolean): void {
    this.options.stream = Boolean(on);
  }

  /** Currently configured API key, or `undefined`. */
  getApiKey(): string | undefined {
    return this.options.apiKey;
  }

  /**
   * Spawns `mavis session new [--agent <name>]` and resolves with the new
   * session summary. Emits `onSessionCreated` once the spawn is successful
   * and the first `{type:"session"}` event has been parsed.
   *
   * The shim emits a `session` row followed by a `done` sentinel. The
   * list parser already filters sentinels, so the raw parser here only
   * needs to pick the first data row.
   */
  async createSession(agent?: string): Promise<SessionSummary> {
    if (this.disposed) throw new Error('MavisClient is disposed');
    const bin = this.resolveBinary();
    const args: string[] = ['session', 'new'];
    const effectiveAgent = agent ?? this.activeAgent;
    if (effectiveAgent) {
      args.push('--agent', effectiveAgent);
    }
    return new Promise<SessionSummary>((resolve, reject) => {
      const child = this.spawnImpl(bin, args, this.spawnEnv()) as ChildProcessWithoutNullStreams;
      let resolved: SessionSummary | undefined;
      const parser = new NDJSONParser();
      child.stdout.pipe(parser);
      parser.on('data', (row: { type?: string } & SessionSummary) => {
        if (row && typeof row === 'object' && (row as { type?: string }).type === 'session') {
          if (!resolved) {
            const session: SessionSummary = {
              id: (row as SessionSummary).id,
              agent: (row as SessionSummary).agent || effectiveAgent,
              title: (row as SessionSummary).title || '',
              createdAt: (row as SessionSummary).createdAt || Date.now(),
            };
            resolved = session;
            this.onSessionCreated.emit('session', session as never);
          }
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = redactString(chunk.toString('utf8'));
        process.stderr.write(`[mavis:cli] ${text}`);
        // Forward to the host's Output Channel if it set one. The
        // channel is a no-op when the host hasn't wired it up.
        if (this.options.onStderr) this.options.onStderr(text);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (resolved) {
          resolve(resolved);
        } else {
          reject(new Error(`mavis session new exited (code=${code}) without a session row`));
        }
      });
    });
  }

  /**
   * Spawns a long-running `mavis session stream` child and returns a handle
   * the caller can use to send prompts and listen for events.
   *
   * The handle is the canonical place to attach the `'message' | 'error' |
   * 'done' | 'tool_call' | 'tool_result'` listeners. The MavisClient also
   * tracks the underlying child process for cleanup on `dispose()`.
   */
  streamSession(sessionId: string, listeners: Partial<Record<ClientEvent, (e: StreamEvent) => void>> = {}): StreamHandle {
    if (this.disposed) {
      throw new Error('MavisClient is disposed');
    }
    const bin = this.resolveBinary();
    const args = ['session', 'stream', '--session-id', sessionId];
    const child = this.spawnImpl(bin, args, this.spawnEnv()) as ChildProcessWithoutNullStreams;
    const emitter = new EventEmitter();

    // Apply caller listeners eagerly.
    for (const [evt, fn] of Object.entries(listeners)) {
      if (fn) emitter.on(evt, fn);
    }

    const running: RunningStream = { sessionId, child, emitter, closed: false };
    this.streams.add(running);
    this.setActiveSession(sessionId);

    const parser = child.stdout!.pipe(new NDJSONParser());
    parser.on('data', (evt: StreamEvent) => {
      const eventType = (evt as { type?: string }).type;
      if (eventType && (eventType === 'message' || eventType === 'tool_call' || eventType === 'tool_result' || eventType === 'reasoning' || eventType === 'error' || eventType === 'done')) {
        emitter.emit(eventType, evt);
      } else if (eventType === 'ready') {
        // Inform listeners via the emitter too.
        emitter.emit('ready', evt);
      } else {
        // Unknown type → ignore (forward-compat).
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = redactString(chunk.toString('utf8'));
      process.stderr.write(`[mavis:cli] ${text}`);
      if (this.options.onStderr) this.options.onStderr(text);
    });

    child.on('error', (err) => {
      emitter.emit('error', { type: 'error', message: err.message, sessionId, ts: Date.now() });
    });

    child.on('close', (code, signal) => {
      if (!running.closed) {
        running.closed = true;
        this.streams.delete(running);
        if (code !== 0 && code !== null) {
          emitter.emit('error', {
            type: 'error',
            message: `mavis stream exited (code=${code}, signal=${signal})`,
            sessionId,
            ts: Date.now(),
          });
        }
        emitter.emit('done', { type: 'done', sessionId });
      }
    });

    const handle: StreamHandle = {
      sendPrompt: (envelope) => {
        if (running.closed) {
          throw new SessionClosedError(sessionId);
        }
        // Back-compat: accept a plain string (just the text) or a
        // structured envelope. B.1+ uses the envelope to forward
        // tool manifests, mode, and @-mentioned context files.
        const msg: PromptMessage = typeof envelope === 'string'
          ? { type: 'prompt', text: envelope }
          : { type: 'prompt', ...envelope };
        child.stdin.write(JSON.stringify(msg) + '\n');
      },
      close: () => {
        if (running.closed) return;
        running.closed = true;
        try {
          child.stdin.end();
        } catch {
          /* ignore */
        }
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        this.streams.delete(running);
      },
      on: (event, fn) => {
        emitter.on(event, fn);
        return () => emitter.off(event, fn);
      },
      off: (event, fn) => {
        emitter.off(event, fn);
      },
    };
    return handle;
  }

  /** One-shot `mavis session list`. Resolves to the array of sessions. */
  async listSessions(): Promise<SessionSummary[]> {
    return this.runList<SessionSummary>(['session', 'list']);
  }

  /** One-shot `mavis agent list`. Resolves to the array of agents. */
  async listAgents(): Promise<AgentSummary[]> {
    return this.runList<AgentSummary>(['agent', 'list']);
  }

  /**
   * Switches the active context to a different session/agent via the
   * shim. Emits `onContextChanged` for both session and agent (when
   * applicable) so any UI (status bar, chat view, code actions) can
   * react. Resolves to the resulting session id.
   */
  async switchSession(sessionId: string): Promise<string | undefined> {
    if (this.disposed) throw new Error('MavisClient is disposed');
    if (sessionId === this.activeSession) return sessionId;
    const bin = this.resolveBinary();
    return new Promise<string | undefined>((resolve, reject) => {
      const child = this.spawnImpl(bin, ['session', 'switch', sessionId], this.spawnEnv()) as ChildProcessWithoutNullStreams;
      let switched: string | undefined;
      const parser = new NDJSONParser();
      child.stdout.pipe(parser);
      parser.on('data', (row: { type?: string; sessionId?: string; agent?: string }) => {
        if (row && row.type === 'contextChanged') {
          if (row.agent) this.setActiveAgent(row.agent);
          if (row.sessionId) {
            this.setActiveSession(row.sessionId);
            switched = row.sessionId;
          }
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = redactString(chunk.toString('utf8'));
        process.stderr.write(`[mavis:cli] ${text}`);
        if (this.options.onStderr) this.options.onStderr(text);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        // Treat close(0) as success even if the shim didn't emit
        // contextChanged — fall back to applying the requested id
        // optimistically so the UI stays consistent.
        if (code === 0 || code === null) {
          if (!switched) this.setActiveSession(sessionId);
          resolve(switched ?? sessionId);
        } else {
          reject(new Error(`mavis session switch exited (code=${code})`));
        }
      });
    });
  }

  /**
   * Switches the active agent. Spawns a session new under the new agent
   * and resolves to the resulting session id. Also fires
   * `onContextChanged` for the agent change.
   */
  async switchAgent(agent: string): Promise<SessionSummary> {
    if (this.disposed) throw new Error('MavisClient is disposed');
    this.setActiveAgent(agent);
    return this.createSession(agent);
  }

  /**
   * Spawns `mavis code-action run --kind <k> --file <path> --prompt <text>`.
   * Resolves with a {@link CodeActionResult} when the shim emits a
   * `patch` or `text` event. The returned handle exposes a `cancel()` to
   * kill the underlying child.
   */
  createCodeActionTask(kind: CodeActionKind, prompt: string, file: string): CodeActionTaskHandle {
    if (this.disposed) throw new Error('MavisClient is disposed');
    const bin = this.resolveBinary();
    const args = [
      'code-action',
      'run',
      '--kind',
      kind,
      '--file',
      file,
      '--prompt',
      prompt,
    ];
    const child = this.spawnImpl(bin, args, this.spawnEnv()) as ChildProcessWithoutNullStreams;
    let done = false;
    const resultPromise = new Promise<CodeActionResult>((resolve, reject) => {
      const parser = new NDJSONParser();
      child.stdout.pipe(parser);
      let first: CodeActionResult | undefined;
      parser.on('data', (row: { type?: string } & Partial<CodeActionResult>) => {
        if (done) return;
        if (!row || typeof row !== 'object' || !('type' in row)) return;
        if (row.type === 'patch' && typeof (row as { diff?: unknown }).diff === 'string' && typeof (row as { file?: unknown }).file === 'string') {
          first = {
            kind: 'patch',
            file: (row as { file: string }).file,
            diff: (row as { diff: string }).diff,
          };
        } else if (row.type === 'text' && typeof (row as { text?: unknown }).text === 'string') {
          first = { kind: 'text', text: (row as { text: string }).text };
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = redactString(chunk.toString('utf8'));
        process.stderr.write(`[mavis:cli] ${text}`);
        if (this.options.onStderr) this.options.onStderr(text);
      });
      child.on('error', (err) => {
        if (done) return;
        done = true;
        reject(err);
      });
      child.on('close', (code) => {
        if (done) return;
        done = true;
        if (first) {
          resolve(first);
        } else {
          reject(new Error(`mavis code-action exited (code=${code}) without a result row`));
        }
      });
    });
    return {
      result: resultPromise,
      cancel: () => {
        if (done) return;
        try {
          child.stdin.end();
        } catch {
          /* ignore */
        }
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        done = true;
      },
    };
  }

  // ---------------------------------------------------------- Drive (Fase 4)

  /**
   * Spawns `mavis drive list [--category <cat>]` and resolves to the list
   * of {@link DriveItem}s. Emits `onDriveChanged` when the call completes
   * successfully so tree views can refresh.
   */
  async listDrive(category?: DriveCategory): Promise<DriveItem[]> {
    const args = ['drive', 'list'];
    if (category) args.push('--category', category);
    const items = await this.runList<DriveItem>(args);
    this.onDriveChanged.emit('list', { category, items });
    return items;
  }

  /**
   * Spawns `mavis drive get <id>` and resolves to the {@link DriveFile}
   * detail row. Emits `onDriveChanged` for the `'get'` event when done.
   */
  async getDriveFile(id: string): Promise<DriveFile> {
    if (this.disposed) throw new Error('MavisClient is disposed');
    if (!id || typeof id !== 'string') {
      throw new Error('getDriveFile: id is required');
    }
    const bin = this.resolveBinary();
    return new Promise<DriveFile>((resolve, reject) => {
      const child = this.spawnImpl(bin, ['drive', 'get', id], this.spawnEnv()) as ChildProcessWithoutNullStreams;
      let resolvedFile: DriveFile | undefined;
      const parser = new NDJSONParser();
      child.stdout.pipe(parser);
      parser.on('data', (row: { type?: string } & Partial<DriveFile>) => {
        if (!row || typeof row !== 'object') return;
        if (row.type === 'file' && typeof (row as Partial<DriveFile>).id === 'string') {
          const r = row as DriveFile;
          resolvedFile = {
            id: r.id,
            name: r.name,
            category: r.category,
            sizeBytes: r.sizeBytes,
            mimeType: r.mimeType,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            url: r.url,
            content: r.content,
            contentIsBase64: r.contentIsBase64,
          };
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = redactString(chunk.toString('utf8'));
        process.stderr.write(`[mavis:cli] ${text}`);
        if (this.options.onStderr) this.options.onStderr(text);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (resolvedFile) {
          this.onDriveChanged.emit('get', { id, file: resolvedFile });
          resolve(resolvedFile);
        } else {
          reject(new Error(`mavis drive get ${id} exited (code=${code}) without a file row`));
        }
      });
    });
  }

  /**
   * Spawns `mavis drive delete <id>` and resolves when the shim emits a
   * `deleted` row. Emits `onDriveChanged` for the `'delete'` event so the
   * tree can refresh.
   */
  async deleteDriveFile(id: string): Promise<void> {
    if (this.disposed) throw new Error('MavisClient is disposed');
    if (!id || typeof id !== 'string') {
      throw new Error('deleteDriveFile: id is required');
    }
    const bin = this.resolveBinary();
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnImpl(bin, ['drive', 'delete', id], this.spawnEnv()) as ChildProcessWithoutNullStreams;
      let deleted = false;
      const parser = new NDJSONParser();
      child.stdout.pipe(parser);
      parser.on('data', (row: { type?: string; id?: string }) => {
        if (row && row.type === 'deleted' && row.id === id) {
          deleted = true;
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = redactString(chunk.toString('utf8'));
        process.stderr.write(`[mavis:cli] ${text}`);
        if (this.options.onStderr) this.options.onStderr(text);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (deleted || code === 0 || code === null) {
          this.onDriveChanged.emit('delete', { id });
          resolve();
        } else {
          reject(new Error(`mavis drive delete ${id} exited (code=${code}) without a deleted row`));
        }
      });
    });
  }

  // ---------------------------------------------------------- Cron (Fase 4)

  /** Spawns `mavis cron list` and resolves to the list of {@link CronSummary}s. */
  async listCrons(): Promise<CronSummary[]> {
    const items = await this.runList<CronSummary>(['cron', 'list']);
    this.onCronChanged.emit('list', { items });
    return items;
  }

  /**
   * Spawns `mavis cron create` with the supplied args and resolves to
   * the created {@link CronSummary} row.
   */
  async createCron(input: CronInput): Promise<CronSummary> {
    if (this.disposed) throw new Error('MavisClient is disposed');
    if (!input || typeof input !== 'object') {
      throw new Error('createCron: input is required');
    }
    if (!input.name || !input.schedule || !input.prompt) {
      throw new Error('createCron: name, schedule and prompt are required');
    }
    const bin = this.resolveBinary();
    const args = [
      'cron', 'create',
      '--name', input.name,
      '--schedule', input.schedule,
      '--prompt', input.prompt,
      '--agent', input.agent || this.activeAgent,
    ];
    if (input.enabled === false) args.push('--disabled');
    return new Promise<CronSummary>((resolve, reject) => {
      const child = this.spawnImpl(bin, args, this.spawnEnv()) as ChildProcessWithoutNullStreams;
      let created: CronSummary | undefined;
      const parser = new NDJSONParser();
      child.stdout.pipe(parser);
      parser.on('data', (row: { type?: string } & Partial<CronSummary>) => {
        if (row && row.type === 'cron' && typeof (row as Partial<CronSummary>).id === 'string') {
          const r = row as CronSummary;
          created = {
            id: r.id,
            name: r.name,
            schedule: r.schedule,
            prompt: r.prompt,
            agent: r.agent,
            enabled: r.enabled !== false,
            lastRunAt: r.lastRunAt,
            nextRunAt: r.nextRunAt,
            createdAt: r.createdAt,
          };
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = redactString(chunk.toString('utf8'));
        process.stderr.write(`[mavis:cli] ${text}`);
        if (this.options.onStderr) this.options.onStderr(text);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (created) {
          this.onCronChanged.emit('create', { cron: created });
          resolve(created);
        } else {
          reject(new Error(`mavis cron create exited (code=${code}) without a cron row`));
        }
      });
    });
  }

  /**
   * Spawns `mavis cron delete <id>` and resolves when the shim emits a
   * `deleted` row. Emits `onCronChanged` for the `'delete'` event.
   */
  async deleteCron(id: string): Promise<void> {
    if (this.disposed) throw new Error('MavisClient is disposed');
    if (!id || typeof id !== 'string') {
      throw new Error('deleteCron: id is required');
    }
    const bin = this.resolveBinary();
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnImpl(bin, ['cron', 'delete', id], this.spawnEnv()) as ChildProcessWithoutNullStreams;
      let deleted = false;
      const parser = new NDJSONParser();
      child.stdout.pipe(parser);
      parser.on('data', (row: { type?: string; id?: string }) => {
        if (row && row.type === 'deleted' && row.id === id) deleted = true;
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = redactString(chunk.toString('utf8'));
        process.stderr.write(`[mavis:cli] ${text}`);
        if (this.options.onStderr) this.options.onStderr(text);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (deleted || code === 0 || code === null) {
          this.onCronChanged.emit('delete', { id });
          resolve();
        } else {
          reject(new Error(`mavis cron delete ${id} exited (code=${code}) without a deleted row`));
        }
      });
    });
  }

  /**
   * Spawns `mavis cron enable <id>` (or `disable`) and resolves when the
   * shim echoes the updated cron row. Emits `onCronChanged` for
   * `'enable'` or `'disable'`.
   */
  async enableCron(id: string, enabled: boolean): Promise<CronSummary> {
    if (this.disposed) throw new Error('MavisClient is disposed');
    if (!id || typeof id !== 'string') {
      throw new Error('enableCron: id is required');
    }
    const bin = this.resolveBinary();
    const args = ['cron', enabled ? 'enable' : 'disable', id];
    return new Promise<CronSummary>((resolve, reject) => {
      const child = this.spawnImpl(bin, args, this.spawnEnv()) as ChildProcessWithoutNullStreams;
      let updated: CronSummary | undefined;
      const parser = new NDJSONParser();
      child.stdout.pipe(parser);
      parser.on('data', (row: { type?: string } & Partial<CronSummary>) => {
        if (row && row.type === 'cron' && typeof (row as Partial<CronSummary>).id === 'string') {
          const r = row as CronSummary;
          updated = {
            id: r.id,
            name: r.name,
            schedule: r.schedule,
            prompt: r.prompt,
            agent: r.agent,
            enabled: r.enabled !== false,
            lastRunAt: r.lastRunAt,
            nextRunAt: r.nextRunAt,
            createdAt: r.createdAt,
          };
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = redactString(chunk.toString('utf8'));
        process.stderr.write(`[mavis:cli] ${text}`);
        if (this.options.onStderr) this.options.onStderr(text);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (updated) {
          this.onCronChanged.emit(enabled ? 'enable' : 'disable', { cron: updated });
          resolve(updated);
        } else {
          reject(new Error(`mavis cron ${enabled ? 'enable' : 'disable'} ${id} exited (code=${code}) without a cron row`));
        }
      });
    });
  }

  /** Convenience helper: disables a cron. Same as `enableCron(id, false)`. */
  disableCron(id: string): Promise<CronSummary> {
    return this.enableCron(id, false);
  }

  /** Tears down all running streams. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.streams) {
      // Mark closed first so any in-flight sendPrompt throws SessionClosedError
      // synchronously instead of writing to a torn-down stdin.
      s.closed = true;
      try {
        s.child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        s.child.kill();
      } catch {
        /* ignore */
      }
      s.emitter.removeAllListeners();
    }
    this.streams.clear();
    this.onAgentsChanged.removeAllListeners();
    this.onSessionsChanged.removeAllListeners();
    this.onContextChanged.removeAllListeners();
    this.onSessionCreated.removeAllListeners();
    this.onSessionSwitched.removeAllListeners();
    this.onDriveChanged.removeAllListeners();
    this.onCronChanged.removeAllListeners();
  }

  // ------------------------------------------------------------------ internals

  private spawnEnv(): SpawnOptions {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Respect an explicit caller-provided MAVIS_MOCK value (e.g. MAVIS_MOCK=0
    // to force the real CLI path even when archonUrl is empty). Only set the
    // default to '1' when the caller did not opt in either way.
    if (env.MAVIS_MOCK === undefined) {
      if (this.options.mock || !this.options.archonUrl) {
        env.MAVIS_MOCK = '1';
      }
    }
    if (this.options.archonUrl) {
      env.MAVIS_ARCHON_URL = this.options.archonUrl;
    }
    env.MAVIS_API_BASE = this.options.apiBase;
    env.MAVIS_MODEL = this.options.model;
    if (this.options.stream) env.MAVIS_STREAM = '1';
    if (this.options.apiKey) {
      env.MAVIS_API_KEY = this.options.apiKey;
    }
    if (this.options.workspace) {
      env.MAVIS_WORKSPACE = this.options.workspace;
    }
    return {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
  }

  private async runList<T>(args: string[]): Promise<T[]> {
    if (this.disposed) throw new Error('MavisClient is disposed');
    const bin = this.resolveBinary();
    return new Promise<T[]>((resolve, reject) => {
      const child = this.spawnImpl(bin, args, this.spawnEnv()) as ChildProcessWithoutNullStreams;
      const out: T[] = [];
      const parser = new NDJSONParser();
      child.stdout.pipe(parser);
      parser.on('data', (row: T & { type?: string }) => {
        // Drop sentinels like {type:"done"} — list callers want only data rows.
        if (row && typeof row === 'object' && (row as { type?: string }).type) return;
        out.push(row);
      });
      parser.on('end', () => resolve(out));
      parser.on('error', (err) => reject(err));
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = redactString(chunk.toString('utf8'));
        process.stderr.write(`[mavis:cli] ${text}`);
        if (this.options.onStderr) this.options.onStderr(text);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code !== 0 && out.length === 0) {
          reject(new Error(`mavis ${args.join(' ')} exited with code ${code}`));
        } else {
          resolve(out);
        }
      });
    });
  }
}

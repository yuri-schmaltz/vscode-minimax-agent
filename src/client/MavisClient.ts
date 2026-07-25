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
import {
  AgentSummary,
  ClientEvent,
  PromptMessage,
  SessionSummary,
  StreamEvent,
  StreamHandle,
} from './types';

export const PROTOCOL_VERSION = 1;

export interface MavisClientOptions {
  /** Override path to the mavis binary. Takes priority over the bundled shim. */
  cliPath?: string;
  /** archon-server base URL. Empty means use the shim/mock. */
  archonUrl?: string;
  /** Default agent to use when none is specified. */
  defaultAgent?: string;
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
  private readonly options: Required<Omit<MavisClientOptions, 'extensionPath' | 'globalStoragePath' | 'archonUrl' | 'cliPath' | 'defaultAgent'>> & {
    cliPath: string | undefined;
    archonUrl: string | undefined;
    defaultAgent: string | undefined;
    extensionPath: string | undefined;
    globalStoragePath: string | undefined;
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

  private activeAgent: string;
  private activeSession: string | undefined;

  constructor(opts: MavisClientOptions = {}) {
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.options = {
      cliPath: opts.cliPath,
      archonUrl: opts.archonUrl,
      defaultAgent: opts.defaultAgent,
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
      throw new Error(
        'Mavis CLI not found. Set `mavis.cliPath` in settings or install the bundled shim.',
      );
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
      if (eventType && (eventType === 'message' || eventType === 'tool_call' || eventType === 'tool_result' || eventType === 'error' || eventType === 'done')) {
        emitter.emit(eventType, evt);
      } else if (eventType === 'ready') {
        // Inform listeners via the emitter too.
        emitter.emit('ready', evt);
      } else {
        // Unknown type → ignore (forward-compat).
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(`[mavis:cli] ${chunk.toString('utf8')}`);
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
      sendPrompt: (text: string) => {
        if (running.closed) {
          throw new Error(`stream for ${sessionId} is closed`);
        }
        const msg: PromptMessage = { type: 'prompt', text };
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

  /** Tears down all running streams. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.streams) {
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
  }

  // ------------------------------------------------------------------ internals

  private spawnEnv(): SpawnOptions {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.options.mock || !this.options.archonUrl) {
      env.MAVIS_MOCK = '1';
    }
    if (this.options.archonUrl) {
      env.MAVIS_ARCHON_URL = this.options.archonUrl;
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
        process.stderr.write(`[mavis:cli] ${chunk.toString('utf8')}`);
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

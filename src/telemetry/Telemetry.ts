/**
 * Telemetry — opt-in anonymous usage telemetry for the Mavis extension.
 *
 * Design goals (Fase 5, Bloco A):
 *   1. **Default off.** No events are ever sent until the user explicitly
 *      enables `mavis.telemetry` (or accepts the one-time opt-in notice).
 *   2. **One-time notice.** The first time the extension is used with
 *      telemetry off, surface a non-blocking notice with three buttons:
 *      "Enable", "Maybe later", "Never ask again". The decision is
 *      persisted in `globalState` so we never re-prompt after a
 *      definitive answer.
 *   3. **No PII ever.** Only the event name, a couple of coarse
 *      dimensions (command id, kind, length bucket, cron id, etc.),
 *      and the anonymous `vscode.env.machineId`. No message content,
 *      file paths, tokens, prompts, or file contents leave the host.
 *   4. **Best-effort delivery.** The endpoint is mocked
 *      (`https://telemetry.minimax.local/v1/events`) and the producer
 *      has a no-op fallback if the network is unreachable. We never
 *      block the UI on telemetry.
 *
 * The class is intentionally engine-agnostic: a `TelemetryHost` interface
 * provides the small slice of `vscode` we need (configuration, secret-less
 * global state, machineId, env.language, and a one-shot notice
 * function). Tests inject a host to drive behaviour without a real
 * VSCode instance.
 */

import { EventEmitter } from 'node:events';

/** Coarse values for `mavis.telemetry` setting. */
export type TelemetrySetting = false | true | 'ask-once';

/** Coarse event names. The schema is intentionally tiny. */
export type TelemetryEventName =
  | 'command_invoked'
  | 'chat_message_sent'
  | 'code_action_applied'
  | 'cron_fired';

/** A single telemetry record. */
export interface TelemetryEvent {
  name: TelemetryEventName;
  ts: number;
  machineId: string;
  extensionVersion: string;
  vscodeVersion: string;
  locale: string;
  dims?: Record<string, string | number | boolean>;
}

export interface TelemetryHost {
  /** Returns the current value of `mavis.telemetry` (with a sensible default). */
  getTelemetrySetting(): TelemetrySetting;
  /** Returns the anonymous machine id (we never send it paired with a user identity). */
  getMachineId(): string;
  /** Returns the VSCode locale (e.g. "en", "pt-br"). */
  getLanguage(): string;
  /** Extension version (from package.json). */
  getExtensionVersion(): string;
  /** VSCode version (from vscode.version). */
  getVscodeVersion(): string;
  /** Persisted "never ask again" / "answered" flag. Survives reloads. */
  getNoticeState(): 'unasked' | 'later' | 'never';
  setNoticeState(state: 'unasked' | 'later' | 'never'): void;
  /** Persisted enabled override. The setting wins when set; this is the
   *  cached value of the user's choice in the notice. */
  getEnabledOverride(): boolean | undefined;
  setEnabledOverride(enabled: boolean | undefined): void;
  /** Update the underlying setting. */
  setSetting(value: TelemetrySetting): Promise<void>;
  /** Show the one-time opt-in notice. Resolves with the user's pick. */
  showNotice(): Promise<'enable' | 'later' | 'never' | undefined>;
  /** Network send. Resolves to true if the server accepted the batch
   *  (2xx), false on any other outcome. The host should never throw. */
  send(events: TelemetryEvent[]): Promise<boolean>;
  /** Light-weight logger; defaults to console. Tests can stub. */
  log?(...args: unknown[]): void;
}

/** Coarse length buckets for `chat_message_sent`. */
export function bucketLength(n: number): 'xs' | 's' | 'm' | 'l' | 'xl' {
  if (n < 10) return 'xs';
  if (n < 50) return 's';
  if (n < 200) return 'm';
  if (n < 1000) return 'l';
  return 'xl';
}

const KEY_ALLOWED_KEYS: ReadonlyArray<string> = [
  'command',
  'kind',
  'length_bucket',
  'cron_id',
  'session_kind',
];

const ALLOWED_DIMS_PER_EVENT: Record<TelemetryEventName, ReadonlyArray<string>> = {
  command_invoked: ['command', 'session_kind'],
  chat_message_sent: ['length_bucket', 'session_kind'],
  code_action_applied: ['kind', 'session_kind'],
  cron_fired: ['cron_id', 'session_kind'],
};

const ALLOWED_COMMAND_PREFIXES = ['mavis.'];

/**
 * The Telemetry singleton. It listens to its host for the current
 * setting and the persisted notice state, and exposes `track()` to the
 * rest of the extension.
 *
 * The instance is intentionally lazy: nothing happens until `init()`
 * is called, and the queue is a no-op when disabled. Tracks are
 * bounded so a long-running session can't blow up memory.
 */
export class Telemetry {
  private static instance: Telemetry | undefined;
  private host: TelemetryHost;
  /** Internal queue, flushed opportunistically. */
  private queue: TelemetryEvent[] = [];
  /** Maximum queued events. Older ones are dropped on overflow. */
  private readonly maxQueueSize = 256;
  /** Flush interval in ms. The host may also call flush() externally. */
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly flushIntervalMs = 5_000;
  /** Flushing in flight (so we don't enqueue concurrent flushes). */
  private flushing = false;
  /** Notice-once was shown this session (so even if state lost we don't re-prompt). */
  private noticeShownThisSession = false;
  /** Emits when the enabled state changes (for tests + UI). */
  readonly onEnabledChanged = new EventEmitter();

  private constructor(host: TelemetryHost) {
    this.host = host;
  }

  /** Returns the singleton. The host is set on the first `init()` call. */
  static getInstance(): Telemetry {
    if (!Telemetry.instance) {
      throw new Error('Telemetry: not initialised; call Telemetry.init(host) first.');
    }
    return Telemetry.instance;
  }

  /** Initialise the singleton. Idempotent — a second call with the same
   *  host is a no-op; a second call with a different host replaces the
   *  reference and re-evaluates state. */
  static init(host: TelemetryHost): Telemetry {
    if (!Telemetry.instance) {
      Telemetry.instance = new Telemetry(host);
    } else {
      Telemetry.instance.host = host;
    }
    Telemetry.instance.maybeShowNotice();
    Telemetry.instance.startFlushTimer();
    return Telemetry.instance;
  }

  /** Test helper: drops the singleton so each test starts clean. */
  static resetForTests(): void {
    if (Telemetry.instance) {
      Telemetry.instance.dispose();
    }
    Telemetry.instance = undefined;
  }

  /** Resolves the effective enabled state (setting + persisted override). */
  isEnabled(): boolean {
    const override = this.host.getEnabledOverride();
    if (typeof override === 'boolean') return override;
    return this.host.getTelemetrySetting() === true;
  }

  /** Track a single event. No-op when disabled. The event is filtered
   *  against an allow-list of dim keys so accidental PII never leaks. */
  track(name: TelemetryEventName, dims?: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    const sanitized = this.sanitizeDims(name, dims);
    if (sanitized === null) {
      // PII detected → drop silently. Don't even queue.
      this.host.log?.('[telemetry] dropped event with disallowed dims:', name, dims);
      return;
    }
    const event: TelemetryEvent = {
      name,
      ts: Date.now(),
      machineId: this.host.getMachineId(),
      extensionVersion: this.host.getExtensionVersion(),
      vscodeVersion: this.host.getVscodeVersion(),
      locale: this.host.getLanguage(),
      dims: sanitized,
    };
    if (this.queue.length >= this.maxQueueSize) {
      // Drop oldest, keep newest.
      this.queue.shift();
    }
    this.queue.push(event);
  }

  /** Force a flush attempt. Safe to call when disabled (it's a no-op). */
  async flush(): Promise<boolean> {
    if (this.flushing) return false;
    if (this.queue.length === 0) return true;
    if (!this.isEnabled()) {
      this.queue.length = 0;
      return false;
    }
    this.flushing = true;
    const batch = this.queue.slice();
    this.queue.length = 0;
    try {
      const ok = await this.host.send(batch);
      if (!ok) {
        // On failure, re-queue at the front (cap by maxQueueSize).
        const merged = batch.concat(this.queue).slice(-this.maxQueueSize);
        this.queue = merged;
        return false;
      }
      return true;
    } catch (err) {
      // The host's send should never throw, but be defensive.
      this.queue = batch.concat(this.queue).slice(-this.maxQueueSize);
      this.host.log?.('[telemetry] flush failed', err);
      return false;
    } finally {
      this.flushing = false;
    }
  }

  /** Returns a snapshot of the current queue (for tests). */
  getQueueLength(): number {
    return this.queue.length;
  }

  /** Trigger the one-time notice if conditions are met. */
  maybeShowNotice(): void {
    if (this.noticeShownThisSession) return;
    if (this.host.getNoticeState() !== 'unasked') return;
    const setting = this.host.getTelemetrySetting();
    // Show the notice when telemetry is explicitly off (false) or
    // set to 'ask-once' — both states want the user to make a choice.
    if (setting !== false && setting !== 'ask-once') return;
    this.noticeShownThisSession = true;
    void this.showNoticeFlow();
  }

  /** Explicit opt-in (e.g. from the notice or the settings UI). */
  async enable(): Promise<void> {
    this.host.setEnabledOverride(true);
    this.onEnabledChanged.emit('enabled', true);
    try {
      await this.host.setSetting(true);
    } catch {
      /* best-effort */
    }
  }

  /** Explicit opt-out (user changed their mind). */
  async disable(): Promise<void> {
    this.host.setEnabledOverride(false);
    // Clear the queue immediately so callers that don't await still
    // see a deterministic post-condition.
    this.queue.length = 0;
    this.onEnabledChanged.emit('enabled', false);
    try {
      await this.host.setSetting(false);
    } catch {
      /* best-effort */
    }
  }

  /** Permanently dismiss the notice. */
  setNeverAsk(): void {
    this.host.setNoticeState('never');
  }

  /** Stop the flush timer and drop the queue. */
  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.queue.length = 0;
    this.onEnabledChanged.removeAllListeners();
  }

  // ---------------------------------------------------------------- private

  private async showNoticeFlow(): Promise<void> {
    const pick = await this.host.showNotice();
    if (pick === 'enable') {
      await this.enable();
    } else if (pick === 'never') {
      this.host.setNoticeState('never');
    } else if (pick === 'later') {
      this.host.setNoticeState('later');
    }
    // pick === undefined: user dismissed the notice (Esc, X). Treat as "later"
    // so we don't spam them, but also don't disable explicitly.
    if (pick === undefined) {
      this.host.setNoticeState('later');
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Don't keep the Node process alive for the flush.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  private sanitizeDims(
    name: TelemetryEventName,
    dims: Record<string, unknown> | undefined,
  ): Record<string, string | number | boolean> | null {
    if (!dims) return {};
    const allowed = new Set(ALLOWED_DIMS_PER_EVENT[name] ?? []);
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(dims)) {
      if (!KEY_ALLOWED_KEYS.includes(k)) {
        this.host.log?.('[telemetry] dropped unknown dim key:', k);
        return null;
      }
      if (!allowed.has(k)) {
        this.host.log?.('[telemetry] dim not allowed for event', name, ':', k);
        return null;
      }
      if (k === 'command' && typeof v === 'string') {
        if (!v.startsWith('mavis.')) {
          this.host.log?.('[telemetry] command id must be mavis.* :', v);
          return null;
        }
        if (!ALLOWED_COMMAND_PREFIXES.includes('mavis.')) {
          return null;
        }
        out[k] = v;
        continue;
      }
      if (k === 'cron_id' && typeof v === 'string') {
        // Cron ids look like "cron_<36 chars>"; keep only the first 8.
        if (v.length > 64) return null;
        out[k] = v;
        continue;
      }
      if (k === 'kind' && typeof v === 'string') {
        if (v.length > 32) return null;
        out[k] = v;
        continue;
      }
      if (k === 'length_bucket' && typeof v === 'string') {
        if (!['xs', 's', 'm', 'l', 'xl'].includes(v)) return null;
        out[k] = v;
        continue;
      }
      if (k === 'session_kind' && typeof v === 'string') {
        if (!['webview', 'command', 'codeaction', 'cron'].includes(v)) return null;
        out[k] = v;
        continue;
      }
      // Anything else is dropped silently.
    }
    return out;
  }
}

/**
 * Build a default `TelemetryHost` that talks to the real `vscode` API.
 * Use this in `extension.ts`. Tests should build their own host.
 */
export function makeDefaultTelemetryHost(opts: {
  memento: { get<T>(k: string): T | undefined; update(k: string, v: unknown): Thenable<void> | void };
  env: { machineId: string; language: string; sessionId?: string };
  version: string;
  showNotice: () => Promise<'enable' | 'later' | 'never' | undefined>;
  send: (events: TelemetryEvent[]) => Promise<boolean>;
  getSetting: () => TelemetrySetting;
  setSetting: (v: TelemetrySetting) => Promise<void>;
}): TelemetryHost {
  const NOTICE_KEY = 'mavis.telemetry.notice';
  const ENABLED_OVERRIDE_KEY = 'mavis.telemetry.enabledOverride';
  return {
    getTelemetrySetting: () => opts.getSetting(),
    getMachineId: () => opts.env.machineId,
    getLanguage: () => opts.env.language,
    getExtensionVersion: () => opts.version,
    getVscodeVersion: () => opts.version,
    getNoticeState: () => opts.memento.get<'unasked' | 'later' | 'never'>(NOTICE_KEY) ?? 'unasked',
    setNoticeState: (s) => {
      void opts.memento.update(NOTICE_KEY, s);
    },
    getEnabledOverride: () => opts.memento.get<boolean>(ENABLED_OVERRIDE_KEY),
    setEnabledOverride: (v) => {
      void opts.memento.update(ENABLED_OVERRIDE_KEY, v);
    },
    setSetting: (v) => opts.setSetting(v),
    showNotice: opts.showNotice,
    send: opts.send,
  };
}

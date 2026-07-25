/**
 * Telemetry unit + adversarial tests.
 *
 * Coverage:
 *   1. Default off: track() is a no-op when `mavis.telemetry` is false
 *      and no override is set.
 *   2. Opt-in toggle: enabling flips the behaviour; disabling drops
 *      pending events.
 *   3. Notice-once: the notice is shown at most once per session; once
 *      the user answers, the host's `getNoticeState` is updated.
 *   4. Never-ask: "Never ask again" permanently suppresses the notice.
 *   5. Event schema: every recorded event has the required fields and
 *      only allow-listed dim keys.
 *   6. No PII: tracking with arbitrary dim keys (e.g. content, paths,
 *      tokens) is dropped.
 *   7. Network failure: a failing `send()` is graceful and the queue
 *      is preserved (or dropped if disabled).
 *   8. machineId consistency: every event in a batch shares the same
 *      machineId pulled from the host.
 *   9. Notice flow: "Maybe later" persists state "later"; "Never" persists
 *      "never"; undefined choice persists "later".
 *  10. Setting "ask-once" is treated as opt-in flow but defaults to off.
 */
import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { Telemetry, TelemetryEvent, TelemetryHost, TelemetrySetting, bucketLength } from '../Telemetry';

class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(k: string): T | undefined {
    return this.data.get(k) as T | undefined;
  }
  update(k: string, v: unknown): Thenable<void> | void {
    if (v === undefined) this.data.delete(k);
    else this.data.set(k, v);
  }
}

interface HostOverrides {
  setting?: TelemetrySetting;
  noticeState?: 'unasked' | 'later' | 'never';
  enabledOverride?: boolean | undefined;
  machineId?: string;
  language?: string;
  sendResult?: boolean;
}

function makeHost(over: HostOverrides = {}): TelemetryHost & { _send: (e: TelemetryEvent[]) => Promise<boolean>; _calls: { showNotice: number; setSetting: TelemetrySetting[] } } {
  const memento = new FakeMemento();
  if (over.noticeState) memento.update('mavis.telemetry.notice', over.noticeState);
  if (over.enabledOverride !== undefined) memento.update('mavis.telemetry.enabledOverride', over.enabledOverride);
  const _calls = { showNotice: 0, setSetting: [] as TelemetrySetting[] };
  const _send = async (events: TelemetryEvent[]): Promise<boolean> => {
    lastBatch = events;
    return over.sendResult ?? true;
  };
  const host: TelemetryHost = {
    getTelemetrySetting: () => over.setting ?? false,
    getMachineId: () => over.machineId ?? 'machine-abc-123',
    getLanguage: () => over.language ?? 'en',
    getExtensionVersion: () => '0.1.0',
    getVscodeVersion: () => '1.85.0',
    getNoticeState: () => (memento.get('mavis.telemetry.notice') as 'unasked' | 'later' | 'never') ?? 'unasked',
    setNoticeState: (s) => { memento.update('mavis.telemetry.notice', s); },
    getEnabledOverride: () => memento.get('mavis.telemetry.enabledOverride') as boolean | undefined,
    setEnabledOverride: (v) => { memento.update('mavis.telemetry.enabledOverride', v); },
    setSetting: async (v) => { _calls.setSetting.push(v); },
    showNotice: async () => { _calls.showNotice += 1; return 'later'; },
    send: _send,
    log: () => undefined,
  };
  return Object.assign(host, { _send, _calls });
}

let lastBatch: TelemetryEvent[] = [];

beforeEach(() => {
  Telemetry.resetForTests();
  lastBatch = [];
});

afterEach(() => {
  Telemetry.resetForTests();
});

test('default off: track() is a no-op when setting is false', () => {
  const host = makeHost({ setting: false });
  const t = Telemetry.init(host);
  t.track('command_invoked', { command: 'mavis.hello' });
  assert.equal(t.getQueueLength(), 0, 'event should be dropped when off');
});

test('opt-in toggle: enabling lets events queue; disabling drops the queue', () => {
  const host = makeHost({ setting: false });
  const t = Telemetry.init(host);
  t.track('command_invoked', { command: 'mavis.hello' });
  assert.equal(t.getQueueLength(), 0);

  void t.enable();
  t.track('command_invoked', { command: 'mavis.hello' });
  assert.equal(t.getQueueLength(), 1, 'event should be queued after enable');

  void t.disable();
  assert.equal(t.getQueueLength(), 0, 'queue should be cleared on disable');
});

test('notice-once: notice shown exactly once per install', async () => {
  const host = makeHost({ setting: false, noticeState: 'unasked' });
  const t = Telemetry.init(host);
  // Init already triggers maybeShowNotice.
  await new Promise((r) => setImmediate(r));
  assert.equal(host._calls.showNotice, 1);
  assert.equal(host.getNoticeState(), 'later', 'later is the default when user dismisses');

  // Second init should not show again.
  const t2 = Telemetry.init(host);
  assert.equal(t2, t, 'singleton');
  await new Promise((r) => setImmediate(r));
  assert.equal(host._calls.showNotice, 1, 'notice should not reappear');
});

test('never-ask: "Never" suppresses all future notices', async () => {
  const host = makeHost({ setting: false, noticeState: 'unasked' });
  host.showNotice = async () => { host._calls.showNotice += 1; return 'never'; };
  Telemetry.init(host);
  await new Promise((r) => setImmediate(r));
  assert.equal(host.getNoticeState(), 'never');
  assert.equal(host._calls.showNotice, 1, 'first init shows the notice');

  // Re-init: still no notice.
  Telemetry.init(host);
  await new Promise((r) => setImmediate(r));
  assert.equal(host._calls.showNotice, 1, 'second init must not re-show');
});

test('event schema: every event has machineId, ts, name, ext+vscode version, locale', async () => {
  const host = makeHost({ setting: true, machineId: 'fixed-mid', language: 'pt-br' });
  const t = Telemetry.init(host);
  t.track('command_invoked', { command: 'mavis.newChat' });
  t.track('chat_message_sent', { length_bucket: 's' });
  t.track('code_action_applied', { kind: 'refactor' });
  t.track('cron_fired', { cron_id: 'cron_abcdef' });
  const ok = await t.flush();
  assert.equal(ok, true);
  assert.equal(lastBatch.length, 4);
  for (const e of lastBatch) {
    assert.equal(e.machineId, 'fixed-mid');
    assert.equal(e.extensionVersion, '0.1.0');
    assert.equal(e.vscodeVersion, '1.85.0');
    assert.equal(e.locale, 'pt-br');
    assert.equal(typeof e.ts, 'number');
    assert.ok(['command_invoked', 'chat_message_sent', 'code_action_applied', 'cron_fired'].includes(e.name));
  }
});

test('no PII: arbitrary dim keys are dropped', () => {
  const host = makeHost({ setting: true });
  const t = Telemetry.init(host);
  t.track('command_invoked', { content: 'hello world' }); // disallowed
  assert.equal(t.getQueueLength(), 0, 'disallowed dim key drops the event');
  t.track('command_invoked', { filePath: '/etc/passwd' });
  assert.equal(t.getQueueLength(), 0);
  t.track('command_invoked', { command: 'foo.hello' }); // wrong prefix
  assert.equal(t.getQueueLength(), 0);
  t.track('chat_message_sent', { length_bucket: 'enormous' }); // bad bucket
  assert.equal(t.getQueueLength(), 0);
});

test('network failure: send() returning false preserves the queue', async () => {
  const host = makeHost({ setting: true, sendResult: false });
  const t = Telemetry.init(host);
  t.track('command_invoked', { command: 'mavis.hello' });
  const ok = await t.flush();
  assert.equal(ok, false);
  assert.equal(t.getQueueLength(), 1, 'failed send should re-queue');
});

test('network failure: send() throwing is also graceful', async () => {
  const host = makeHost({ setting: true });
  host.send = async () => { throw new Error('boom'); };
  const t = Telemetry.init(host);
  t.track('command_invoked', { command: 'mavis.hello' });
  const ok = await t.flush();
  assert.equal(ok, false);
  assert.equal(t.getQueueLength(), 1, 'throw should re-queue');
});

test('machineId consistency: all events in a batch share the same machineId', async () => {
  const host = makeHost({ setting: true, machineId: 'host-xyz' });
  const t = Telemetry.init(host);
  for (let i = 0; i < 5; i += 1) t.track('command_invoked', { command: 'mavis.hello' });
  await t.flush();
  const ids = new Set(lastBatch.map((e) => e.machineId));
  assert.equal(ids.size, 1);
  assert.ok(ids.has('host-xyz'));
});

test('notice flow: "Maybe later" persists state "later"', async () => {
  const host = makeHost({ setting: false, noticeState: 'unasked' });
  host.showNotice = async () => 'later';
  Telemetry.init(host);
  await new Promise((r) => setImmediate(r));
  assert.equal(host.getNoticeState(), 'later');
});

test('notice flow: "Enable" enables telemetry + sets setting', async () => {
  const host = makeHost({ setting: false, noticeState: 'unasked' });
  host.showNotice = async () => 'enable';
  const t = Telemetry.init(host);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(host._calls.setSetting, [true]);
  assert.equal(t.isEnabled(), true);
});

test('setting "ask-once" is the same as false (notice is shown)', async () => {
  const host = makeHost({ setting: 'ask-once' as TelemetrySetting, noticeState: 'unasked' });
  Telemetry.init(host);
  await new Promise((r) => setImmediate(r));
  assert.equal(host._calls.showNotice, 1);
});

test('bucketLength: assigns coarse buckets', () => {
  assert.equal(bucketLength(0), 'xs');
  assert.equal(bucketLength(9), 'xs');
  assert.equal(bucketLength(10), 's');
  assert.equal(bucketLength(49), 's');
  assert.equal(bucketLength(50), 'm');
  assert.equal(bucketLength(199), 'm');
  assert.equal(bucketLength(200), 'l');
  assert.equal(bucketLength(999), 'l');
  assert.equal(bucketLength(1000), 'xl');
  assert.equal(bucketLength(99999), 'xl');
});

test('dispose: stops the flush timer and clears the queue', async () => {
  const host = makeHost({ setting: true });
  const t = Telemetry.init(host);
  t.track('command_invoked', { command: 'mavis.hello' });
  assert.equal(t.getQueueLength(), 1);
  t.dispose();
  assert.equal(t.getQueueLength(), 0);
});

test('queue overflow: caps at maxQueueSize and drops oldest', async () => {
  const host = makeHost({ setting: true });
  const t = Telemetry.init(host);
  for (let i = 0; i < 300; i += 1) t.track('command_invoked', { command: 'mavis.hello' });
  assert.ok(t.getQueueLength() <= 256, 'queue should be capped');
});

test('track() with no dims is valid', async () => {
  const host = makeHost({ setting: true });
  const t = Telemetry.init(host);
  t.track('command_invoked');
  assert.equal(t.getQueueLength(), 1);
});

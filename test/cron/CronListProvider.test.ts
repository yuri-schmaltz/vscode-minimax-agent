/**
 * CronListProvider tests (Fase 4).
 *
 * The provider orchestrates a listCrons call + a QuickPick flow that
 * surfaces a toggle/delete action. We stub the host and the client,
 * then assert the right client methods are called and the right
 * info/error messages are emitted.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MavisClient } from '../../src/client/MavisClient';
import { CronListProvider, cronListIsEmpty, CronListHost } from '../../src/cron/CronListProvider';
import { QuickPickItem, InputBoxOptions } from '../../src/cron/CronForm';
import { CronSummary } from '../../src/client/types';
import { makeFakeChild, makeSpawner } from '../helpers/spawnStub';

class StubHost implements CronListHost {
  public picks: Array<QuickPickItem | undefined> = [];
  public confirmResults: boolean[] = [];
  public infos: string[] = [];
  public errors: string[] = [];
  private pickIdx = 0;
  private confirmIdx = 0;
  async showInputBox(_options?: InputBoxOptions): Promise<string | undefined> { return undefined; }
  async showQuickPick(_items: QuickPickItem[], _options?: { placeHolder?: string }): Promise<QuickPickItem | undefined> {
    return this.picks[this.pickIdx++];
  }
  async showInformationMessage(message: string): Promise<string | undefined> { this.infos.push(message); return undefined; }
  async showErrorMessage(message: string): Promise<string | undefined> { this.errors.push(message); return undefined; }
  async confirm(_msg: string, _accept?: string, _decline?: string): Promise<boolean> {
    return this.confirmResults[this.confirmIdx++] ?? false;
  }
}

function makeClient() {
  return new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/bin/mavis',
  });
}

const SAMPLE_CRONS: CronSummary[] = [
  { id: 'c1', name: 'morning', schedule: '0 8 * * *', prompt: 'p', agent: 'mavis', enabled: true },
  { id: 'c2', name: 'evening', schedule: '0 20 * * *', prompt: 'p', agent: 'mavis', enabled: false },
];

test('CronListProvider: cronListIsEmpty predicate', () => {
  assert.equal(cronListIsEmpty([]), true);
  assert.equal(cronListIsEmpty(undefined), true);
  assert.equal(cronListIsEmpty(null), true);
  assert.equal(cronListIsEmpty(SAMPLE_CRONS), false);
});

test('CronListProvider: empty list → info message and no action', async () => {
  const c = makeClient();
  c.listCrons = async () => [];
  const host = new StubHost();
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.equal(out, undefined);
  assert.equal(host.infos.length, 1);
  assert.match(host.infos[0], /No crons scheduled/);
});

test('CronListProvider: list error → error message and no action', async () => {
  const c = makeClient();
  c.listCrons = async () => { throw new Error('network down'); };
  const host = new StubHost();
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.equal(out, undefined);
  assert.equal(host.errors.length, 1);
  assert.match(host.errors[0], /network down/);
});

test('CronListProvider: select cron → pick Disable → calls enableCron(false)', async () => {
  const c = makeClient();
  c.listCrons = async () => SAMPLE_CRONS;
  let enabledId: string | undefined;
  let enabledTo: boolean | undefined;
  c.enableCron = (async (id: string, to: boolean) => {
    enabledId = id;
    enabledTo = to;
    return { ...SAMPLE_CRONS.find((x) => x.id === id)!, enabled: to };
  }) as typeof c.enableCron;
  const host = new StubHost();
  // First pick: the cron (label = "morning"). Second pick: action "Disable".
  host.picks = [
    { label: 'morning' },
    { label: 'Disable' },
  ];
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.ok(out);
  assert.equal(out!.cron.id, 'c1');
  assert.equal(out!.action, 'toggle');
  assert.equal(enabledId, 'c1');
  assert.equal(enabledTo, false);
  assert.match(host.infos[0] ?? '', /disabled/);
});

test('CronListProvider: select cron → pick Enable → calls enableCron(true)', async () => {
  const c = makeClient();
  c.listCrons = async () => SAMPLE_CRONS;
  let enabledTo: boolean | undefined;
  c.enableCron = (async (id: string, to: boolean) => {
    enabledTo = to;
    return { ...SAMPLE_CRONS.find((x) => x.id === id)!, enabled: to };
  }) as typeof c.enableCron;
  const host = new StubHost();
  // Pick "evening" (currently disabled), then "Enable".
  host.picks = [
    { label: 'evening' },
    { label: 'Enable' },
  ];
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.ok(out);
  assert.equal(out!.cron.id, 'c2');
  assert.equal(enabledTo, true);
});

test('CronListProvider: pick Cancel action returns undefined', async () => {
  const c = makeClient();
  c.listCrons = async () => SAMPLE_CRONS;
  let called = 0;
  c.enableCron = (async () => { called++; throw new Error('should not be called'); }) as typeof c.enableCron;
  c.deleteCron = (async () => { called++; throw new Error('should not be called'); }) as typeof c.deleteCron;
  const host = new StubHost();
  host.picks = [
    { label: 'morning' },
    { label: 'Cancel' },
  ];
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.equal(out, undefined);
  assert.equal(called, 0);
});

test('CronListProvider: pick Delete with confirm=true calls deleteCron', async () => {
  const c = makeClient();
  c.listCrons = async () => SAMPLE_CRONS;
  let deletedId: string | undefined;
  c.deleteCron = (async (id: string) => { deletedId = id; }) as typeof c.deleteCron;
  const host = new StubHost();
  host.picks = [
    { label: 'morning' },
    { label: 'Delete' },
  ];
  host.confirmResults = [true];
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.ok(out);
  assert.equal(out!.action, 'delete');
  assert.equal(deletedId, 'c1');
  assert.match(host.infos[0] ?? '', /Deleted cron/);
});

test('CronListProvider: pick Delete with confirm=false does NOT call deleteCron', async () => {
  const c = makeClient();
  c.listCrons = async () => SAMPLE_CRONS;
  let called = 0;
  c.deleteCron = (async () => { called++; }) as typeof c.deleteCron;
  const host = new StubHost();
  host.picks = [
    { label: 'morning' },
    { label: 'Delete' },
  ];
  host.confirmResults = [false];
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.equal(out, undefined);
  assert.equal(called, 0);
});

test('CronListProvider: pick without an action pick returns undefined (no second pick)', async () => {
  const c = makeClient();
  c.listCrons = async () => SAMPLE_CRONS;
  let called = 0;
  c.enableCron = (async () => { called++; throw new Error('should not be called'); }) as typeof c.enableCron;
  const host = new StubHost();
  host.picks = [
    { label: 'morning' },
    undefined, // user dismissed the action menu
  ];
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.equal(out, undefined);
  assert.equal(called, 0);
});

test('CronListProvider: enableCron error is surfaced', async () => {
  const c = makeClient();
  c.listCrons = async () => SAMPLE_CRONS;
  c.enableCron = (async () => { throw new Error('shim disabled'); }) as typeof c.enableCron;
  const host = new StubHost();
  host.picks = [{ label: 'morning' }, { label: 'Disable' }];
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.equal(out, undefined);
  assert.equal(host.errors.length, 1);
  assert.match(host.errors[0], /shim disabled/);
});

test('CronListProvider: pick whose label does not match a cron is treated as cancel', async () => {
  const c = makeClient();
  c.listCrons = async () => SAMPLE_CRONS;
  let called = 0;
  c.enableCron = (async () => { called++; throw new Error('should not be called'); }) as typeof c.enableCron;
  const host = new StubHost();
  host.picks = [{ label: 'not-a-cron' }];
  const provider = new CronListProvider({ client: c, host });
  const out = await provider.run();
  assert.equal(out, undefined);
  assert.equal(called, 0);
});

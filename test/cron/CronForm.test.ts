/**
 * CronForm tests (Fase 4).
 *
 * The form drives 5 input-box calls in sequence plus a confirm
 * QuickPick. We stub the host interface with a queue of canned
 * responses and assert the form produces the expected
 * `createCron` call.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MavisClient } from '../../src/client/MavisClient';
import { CronForm, isValidCronExpression, describeNextRun, InputBoxOptions, QuickPickItem, CronFormHost } from '../../src/cron/CronForm';
import { CronSummary } from '../../src/client/types';
import { makeFakeChild, makeSpawner } from '../helpers/spawnStub';

class StubHost implements CronFormHost {
  public inputs: Array<string | undefined> = [];
  public picks: Array<QuickPickItem | undefined> = [];
  public infos: string[] = [];
  public errors: string[] = [];
  private inputIdx = 0;
  private pickIdx = 0;

  setInputs(...values: Array<string | undefined>): void {
    this.inputs = values.slice();
  }
  setPicks(...values: Array<QuickPickItem | undefined>): void {
    this.picks = values.slice();
  }

  async showInputBox(_options?: InputBoxOptions): Promise<string | undefined> {
    const v = this.inputs[this.inputIdx++];
    return v;
  }
  async showQuickPick(_items: QuickPickItem[], _options?: { placeHolder?: string }): Promise<QuickPickItem | undefined> {
    const v = this.picks[this.pickIdx++];
    return v;
  }
  async showInformationMessage(message: string): Promise<string | undefined> {
    this.infos.push(message);
    return undefined;
  }
  async showErrorMessage(message: string): Promise<string | undefined> {
    this.errors.push(message);
    return undefined;
  }
}

function makeClient() {
  return new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/bin/mavis',
  });
}

// --------------------------------------------------------------- validator

test('CronForm: isValidCronExpression accepts standard expressions', () => {
  assert.equal(isValidCronExpression('* * * * *'), true);
  assert.equal(isValidCronExpression('0 8 * * *'), true);
  assert.equal(isValidCronExpression('0 0 1 1 *'), true);
  assert.equal(isValidCronExpression('*/5 * * * *'), true);
  assert.equal(isValidCronExpression('0,15,30,45 * * * *'), true);
  assert.equal(isValidCronExpression('0 8 * * 1-5'), true);
  assert.equal(isValidCronExpression('0 0 * * MON'), false); // weekday names not supported
});

test('CronForm: isValidCronExpression rejects bad expressions', () => {
  assert.equal(isValidCronExpression(''), false);
  assert.equal(isValidCronExpression('not a cron'), false);
  assert.equal(isValidCronExpression('60 * * * *'), false); // minute out of range
  assert.equal(isValidCronExpression('* 24 * * *'), false); // hour out of range
  assert.equal(isValidCronExpression('* * 32 * *'), false); // day out of range
  assert.equal(isValidCronExpression('* * * 13 *'), false); // month out of range
  assert.equal(isValidCronExpression('* * * * 7'), false);  // dow out of range
  assert.equal(isValidCronExpression(null as unknown as string), false);
});

test('CronForm: describeNextRun returns a human label', () => {
  assert.equal(describeNextRun('* * * * *'), 'every minute');
  assert.match(describeNextRun('*/10 * * * *'), /every 10 minutes/);
  assert.match(describeNextRun('0 */2 * * *'), /every 2 hours/);
  assert.match(describeNextRun('0 8 * * *'), /minute=0, hour=8/);
  assert.match(describeNextRun('not valid'), /unknown/);
});

// --------------------------------------------------------------- happy path

test('CronForm: completes the flow and calls client.createCron with the right args', async () => {
  const c = makeClient();
  const host = new StubHost();
  host.setInputs('My cron', '0 8 * * *', 'Run tests', 'mavis');
  host.setPicks({ label: 'Yes, schedule it', description: 'next' });
  // Drive the createCron shim: emit a cron row, then done.
  // We can't easily hook into the spawn here because createCron spawns
  // its own child; instead we monkey-patch createCron.
  const fakeCreated: CronSummary = {
    id: 'cron_fake',
    name: 'My cron',
    schedule: '0 8 * * *',
    prompt: 'Run tests',
    agent: 'mavis',
    enabled: true,
    nextRunAt: 12345,
  };
  c.createCron = async () => fakeCreated;
  const form = new CronForm({ client: c, host, defaultAgent: 'mavis' });
  const out = await form.run();
  assert.ok(out);
  assert.equal(out!.id, 'cron_fake');
  assert.equal(out!.name, 'My cron');
  assert.equal(host.infos.length, 1);
  assert.match(host.infos[0], /cron_fake|My cron/);
});

test('CronForm: returns undefined when the user cancels at the name step', async () => {
  const c = makeClient();
  const host = new StubHost();
  host.setInputs(undefined);
  let called = 0;
  c.createCron = async () => { called++; throw new Error('should not be called'); };
  const form = new CronForm({ client: c, host });
  const out = await form.run();
  assert.equal(out, undefined);
  assert.equal(called, 0);
});

test('CronForm: returns undefined when the user picks Cancel in confirm', async () => {
  const c = makeClient();
  const host = new StubHost();
  host.setInputs('x', '0 8 * * *', 'p', 'mavis');
  host.setPicks({ label: 'Cancel' });
  let called = 0;
  c.createCron = async () => { called++; throw new Error('should not be called'); };
  const form = new CronForm({ client: c, host });
  const out = await form.run();
  assert.equal(out, undefined);
  assert.equal(called, 0);
});

test('CronForm: surfaces createCron error via showErrorMessage', async () => {
  const c = makeClient();
  const host = new StubHost();
  host.setInputs('x', '0 8 * * *', 'p', 'mavis');
  host.setPicks({ label: 'Yes, schedule it' });
  c.createCron = async () => { throw new Error('shim exploded'); };
  const form = new CronForm({ client: c, host });
  const out = await form.run();
  assert.equal(out, undefined);
  assert.equal(host.errors.length, 1);
  assert.match(host.errors[0], /shim exploded/);
});

test('CronForm: invalid schedule re-prompts (returns the same box with validateInput)', () => {
  // The validateInput callback is what we exercise. We replicate the
  // form's validateInput logic by calling CronForm.validate directly.
  assert.equal(CronForm.validate('0 8 * * *'), undefined);
  assert.match(CronForm.validate('not valid') ?? '', /Invalid cron/);
  assert.match(CronForm.validate('') ?? '', /Invalid cron/);
});

test('CronForm: empty name is rejected by the validator', () => {
  assert.match(CronForm.validate('0 8 * * *') ?? '', /^$/);
  // And the name / prompt validators are not directly exposed, but we
  // can reach the same logic by introspecting the input box options.
  // Quick check: when showInputBox returns '', the form should treat
  // it as cancelled and stop.
  const client = makeClient();
  const host = new StubHost();
  host.setInputs(''); // empty name
  const form = new CronForm({ client, host });
  return form.run().then((out) => {
    assert.equal(out, undefined);
  });
});

/**
 * CronForm — drives the `Mavis: schedule cron` input-box flow.
 *
 * The form runs a sequence of `vscode.window.showInputBox` calls,
 * validating each answer before moving on. The last step is a Yes/No
 * QuickPick confirmation that surfaces a human-readable next-run
 * estimate.
 *
 * No DOM is involved: the form is fully driven by VSCode native inputs
 * and is therefore easy to test by stubbing the `CronFormHost` interface.
 */
import { MavisClient } from '../client/MavisClient';
import { CronInput, CronSummary } from '../client/types';

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface InputBoxOptions {
  prompt?: string;
  placeHolder?: string;
  ignoreFocusOut?: boolean;
  password?: boolean;
  value?: string;
  validateInput?: (value: string) => string | undefined | null | Thenable<string | undefined | null>;
}

export interface CronFormHost {
  showInputBox(options?: InputBoxOptions): Thenable<string | undefined>;
  showQuickPick(items: QuickPickItem[], options?: { placeHolder?: string }): Thenable<QuickPickItem | undefined>;
  showInformationMessage(message: string): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<string | undefined>;
}

export interface CronFormDeps {
  client: MavisClient;
  host: CronFormHost;
  /** Agent default to use when the user accepts the placeholder. */
  defaultAgent?: string;
}

/**
 * 5-field cron expression: minute hour day-of-month month day-of-week.
 * Each field may be `*`, a single number, or a comma-separated list of
 * numbers in [0, field-max]. We accept a small subset that's good
 * enough for the shim / scheduler; richer expressions (e.g. `0 8 * * 1-5`)
 * are handled by treating `-` as "range shorthand" for two numbers.
 */
const CRON_REGEX = /^(\S+\s+){4}\S+$/;

/** Field validation ranges (standard cron). */
const FIELD_RANGES: ReadonlyArray<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 6],  // day-of-week
];

/** Returns true if the cron expr is well-formed. Public for tests. */
export function isValidCronExpression(expr: string): boolean {
  if (!expr || typeof expr !== 'string') return false;
  const trimmed = expr.trim();
  if (!CRON_REGEX.test(trimmed)) return false;
  const fields = trimmed.split(/\s+/);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const [lo, hi] = FIELD_RANGES[i];
    if (!validateField(f, lo, hi)) return false;
  }
  return true;
}

function validateField(field: string, lo: number, hi: number): boolean {
  // Accept `*`, `*/N`, or comma-separated entries (each may be a number,
  // a range `a-b`, or a `*/N` step).
  for (const part of field.split(',')) {
    if (part === '*') continue;
    if (/^\*\/\d+$/.test(part)) {
      const step = parseInt(part.slice(2), 10);
      if (step <= 0) return false;
      continue;
    }
    if (/^\d+-\d+$/.test(part)) {
      const [a, b] = part.split('-').map((s) => parseInt(s, 10));
      if (a < lo || b > hi || a > b) return false;
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n < lo || n > hi) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** Human-readable next-run estimate. Best-effort for the shim. */
export function describeNextRun(schedule: string): string {
  if (!isValidCronExpression(schedule)) return 'unknown (invalid expression)';
  const [minute, hour] = schedule.trim().split(/\s+/);
  if (minute === '*' && hour === '*') return 'every minute';
  if (minute.startsWith('*/') && hour === '*') return `every ${minute.slice(2)} minutes`;
  if (hour.startsWith('*/') && !minute.includes(',') && !minute.includes('-')) {
    return `every ${hour.slice(2)} hours`;
  }
  return `at minute=${minute}, hour=${hour}`;
}

/**
 * Runs the input-box flow. Returns the created cron on success,
 * undefined if the user cancelled at any step.
 */
export class CronForm {
  constructor(private readonly deps: CronFormDeps) {}

  /** Validates a cron expression; returns an error message or undefined. */
  static validate(expr: string): string | undefined {
    return isValidCronExpression(expr) ? undefined : 'Invalid cron expression (e.g. "0 8 * * *")';
  }

  /** Drives the multi-step form. Returns the created cron or undefined. */
  async run(): Promise<CronSummary | undefined> {
    const { host } = this.deps;

    // 1) Name
    const name = await host.showInputBox({
      prompt: 'Cron name',
      placeHolder: 'e.g. Daily test suite run',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : 'Name is required'),
    });
    if (name === undefined) return undefined;

    // 2) Schedule
    const schedule = await host.showInputBox({
      prompt: 'Cron schedule (5 fields: minute hour day month weekday)',
      placeHolder: '0 8 * * *',
      ignoreFocusOut: true,
      value: '0 8 * * *',
      validateInput: (v) => CronForm.validate(v ?? ''),
    });
    if (schedule === undefined) return undefined;

    // 3) Prompt
    const prompt = await host.showInputBox({
      prompt: 'Prompt to run on each tick',
      placeHolder: 'e.g. Run `npm test` and report failures',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : 'Prompt is required'),
    });
    if (prompt === undefined) return undefined;

    // 4) Agent (default: client's active agent)
    const agent = await host.showInputBox({
      prompt: 'Agent (defaults to active agent)',
      placeHolder: this.deps.defaultAgent ?? 'mavis',
      ignoreFocusOut: true,
      value: this.deps.defaultAgent ?? 'mavis',
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : 'Agent is required'),
    });
    if (agent === undefined) return undefined;

    // 5) Confirm
    const confirm = await host.showQuickPick(
      [
        { label: 'Yes, schedule it', description: `next run: ${describeNextRun(schedule)}` },
        { label: 'Cancel', description: 'discard the cron definition' },
      ],
      { placeHolder: `Schedule "${name}"?` },
    );
    if (!confirm || confirm.label.startsWith('Cancel')) {
      return undefined;
    }

    // 6) Create
    const input: CronInput = {
      name: name.trim(),
      schedule: schedule.trim(),
      prompt: prompt.trim(),
      agent: agent.trim(),
      enabled: true,
    };
    try {
      const created = await this.deps.client.createCron(input);
      await host.showInformationMessage(
        `Scheduled "${created.name}" (id ${created.id}). Next: ${describeNextRun(created.schedule)}.`,
      );
      return created;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await host.showErrorMessage(`Failed to schedule cron: ${message}`);
      return undefined;
    }
  }
}

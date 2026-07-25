/**
 * CronListProvider — QuickPick-based list / management UI for the
 * user's crons. Not a TreeView (the spec doesn't require one); just a
 * single QuickPick with one "action" sub-menu per cron.
 *
 * Behaviour:
 *   - `Mavis: List crons` → shows the crons in a QuickPick; selecting
 *     one opens an action QuickPick (toggle / delete / nothing).
 *   - Toggle enable / disable calls `client.enableCron(id, !enabled)`.
 *   - Delete asks for confirmation and calls `client.deleteCron(id)`.
 *
 * Both flows are pure host functions driven by a `CronListHost` shim so
 * tests can exercise the orchestration without a real editor.
 */
import { MavisClient } from '../client/MavisClient';
import { CronSummary } from '../client/types';
import { CronFormHost, QuickPickItem } from './CronForm';

export interface CronListHost extends CronFormHost {
  /** Shows a confirm dialog (returns true if the user accepted). */
  confirm?(message: string, accept?: string, decline?: string): Thenable<boolean>;
}

export interface CronListDeps {
  client: MavisClient;
  host: CronListHost;
}

export class CronListProvider {
  constructor(private readonly deps: CronListDeps) {}

  /**
   * Drives the QuickPick flow. Returns the cron that the user took an
   * action on, or undefined if the user cancelled.
   */
  async run(): Promise<{ cron: CronSummary; action: 'toggle' | 'delete' } | undefined> {
    const { host } = this.deps;
    let crons: CronSummary[];
    try {
      crons = await this.deps.client.listCrons();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await host.showErrorMessage(`Failed to list crons: ${message}`);
      return undefined;
    }
    if (cronListIsEmpty(crons)) {
      await host.showInformationMessage('No crons scheduled. Use "Mavis: Schedule cron" to add one.');
      return undefined;
    }
    const items: QuickPickItem[] = crons.map((c) => ({
      label: c.name,
      description: c.schedule,
      detail: `${c.enabled ? '● enabled' : '○ disabled'} | ${describeSummary(c)}`,
    }));
    const pick = await host.showQuickPick(items, { placeHolder: `${cronListIsEmpty(crons) ? 0 : crons.length} cron${crons.length === 1 ? '' : 's'}` });
    if (!pick) return undefined;
    const cron = crons.find((c) => c.name === pick.label);
    if (!cron) return undefined;
    const action = await host.showQuickPick(
      [
        { label: cron.enabled ? 'Disable' : 'Enable', description: 'Toggle enabled flag' },
        { label: 'Delete', description: 'Remove the cron (with confirmation)' },
        { label: 'Cancel', description: 'Do nothing' },
      ],
      { placeHolder: `Cron: ${cron.name}` },
    );
    if (!action || action.label === 'Cancel') return undefined;
    if (action.label === 'Enable' || action.label === 'Disable') {
      try {
        const updated = await this.deps.client.enableCron(cron.id, action.label === 'Enable');
        await host.showInformationMessage(`Cron "${updated.name}" ${updated.enabled ? 'enabled' : 'disabled'}.`);
        return { cron: updated, action: 'toggle' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await host.showErrorMessage(`Failed to toggle cron: ${message}`);
        return undefined;
      }
    }
    if (action.label === 'Delete') {
      const confirmed = this.deps.host.confirm
        ? await this.deps.host.confirm(`Delete cron "${cron.name}"?`, 'Delete', 'Cancel')
        : true;
      if (!confirmed) return undefined;
      try {
        await this.deps.client.deleteCron(cron.id);
        await host.showInformationMessage(`Deleted cron "${cron.name}".`);
        return { cron: { ...cron, name: cron.name, schedule: cron.schedule, prompt: cron.prompt, agent: cron.agent, enabled: cron.enabled }, action: 'delete' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await host.showErrorMessage(`Failed to delete cron: ${message}`);
        return undefined;
      }
    }
    return undefined;
  }
}

/** Predicate exposed for tests. */
export function cronListIsEmpty(crons: CronSummary[] | undefined | null): boolean {
  return !crons || crons.length === 0;
}

/** Compact one-liner shown in the QuickPick detail. */
function describeSummary(c: CronSummary): string {
  const last = c.lastRunAt ? new Date(c.lastRunAt).toISOString() : 'never';
  const next = c.nextRunAt ? new Date(c.nextRunAt).toISOString() : '—';
  return `agent=${c.agent} | last: ${last} | next: ${next}`;
}

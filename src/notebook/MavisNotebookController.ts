/**
 * MavisNotebookController — Jupyter cell integration.
 *
 * Registers a `NotebookController` for `jupyter-notebook` documents so
 * the user can pick "Mavis" as the kernel for a notebook. Executing a
 * cell sends the cell's source as a prompt to the Mavis backend and
 * streams the response back into the cell output.
 *
 * Failure modes:
 *   - If the cell source is empty we mark the execution as failed with
 *     a clear "empty cell" message — no Mavis call is made.
 *   - If the Mavis stream errors mid-flight we surface the error in
 *     the cell output (no exception bubbles out, the cell is marked
 *     failed in a controlled way).
 *   - Cancellation is honoured: we close the stream when the cell's
 *     `token` is cancelled.
 *
 * Tests construct the provider directly with a fake `MavisClient`,
 * so the controller does NOT depend on `vscode.workspace.notebooks`
 * being real.
 */
import {
  CancellationToken,
  NotebookCell,
  NotebookCellExecution,
  NotebookCellOutput,
  NotebookCellOutputItem,
  NotebookController,
  NotebookControllerAffinity,
  NotebookDocument,
  workspace,
} from 'vscode';
import { MavisClient } from '../client/MavisClient';

/** Notebook type id; matches the `notebookType` in the `package.json` contribution. */
export const MAVIS_NOTEBOOK_TYPE = 'mavis-notebook';
/** The "default" notebook type we also auto-attach to for ad-hoc usage. */
export const JUPYTER_NOTEBOOK_TYPE = 'jupyter-notebook';

export interface NotebookControllerDeps {
  client: MavisClient;
  /**
   * Function used to mint a `NotebookController`. The real VSCode call
   * is `vscode.notebooks.createNotebookController`; tests inject a
   * fake factory that returns a stub.
   */
  createController?: (id: string, notebookType: string, label: string) => NotebookController;
  /**
   * Override for the `resolveNotebookAffinity` call. VSCode calls this
   * to decide whether to surface "Mavis" in the kernel picker for a
   * given notebook; by default we accept any `jupyter-notebook` and
   * the custom `mavis-notebook` type.
   */
  shouldAccept?: (notebook: NotebookDocument) => boolean;
}

export class MavisNotebookControllerProvider {
  private readonly client: MavisClient;
  private readonly shouldAccept: (notebook: NotebookDocument) => boolean;
  private readonly controllers: NotebookController[] = [];
  private disposed = false;

  constructor(deps: NotebookControllerDeps) {
    this.client = deps.client;
    this.shouldAccept = deps.shouldAccept ?? defaultAffinity;
    const factory = deps.createController ?? defaultCreateController;
    const ctrl = factory('mavis', JUPYTER_NOTEBOOK_TYPE, 'Mavis');
    ctrl.supportedLanguages = ['*'];
    ctrl.executeHandler = (cells, notebook, controller) => {
      this.run(cells, notebook, controller).catch((err) => {
        // The error already surfaces inside the cell; this catch is
        // only here to keep the handler returning Thenable<void>.
        // eslint-disable-next-line no-console
        console.error('[mavis] notebook execution failed:', err);
      });
    };
    this.controllers.push(ctrl);
  }

  /**
   * Executes a batch of cells. Each cell is opened as its own Mavis
   * session so the streams don't share state. We process cells
   * sequentially; in practice VSCode hands us a contiguous range.
   */
  private async run(
    cells: NotebookCell[],
    _notebook: NotebookDocument,
    controller: NotebookController,
  ): Promise<void> {
    for (const cell of cells) {
      if (this.disposed) return;
      const execution = controller.createNotebookCellExecution(cell);
      if (!execution) continue;
      await this.executeCell(cell, execution);
    }
  }

  private async executeCell(cell: NotebookCell, execution: NotebookCellExecution): Promise<void> {
    const token: CancellationToken = execution.token;
    execution.start(Date.now());
    const text = cell.document.getText();
    if (!text.trim()) {
      execution.replaceOutput([new NotebookCellOutput([
        new NotebookCellOutputItem(new TextEncoder().encode('(empty cell — nothing to send to Mavis)'), 'application/vnd.code.notebook.error'),
      ])]);
      execution.end(false, Date.now());
      return;
    }
    const sessionId = `nb_${cell.notebook.uri.fsPath}_${cell.index}_${Date.now().toString(36)}`;
    let stream: ReturnType<MavisClient['streamSession']> | undefined;
    // Track whether the stream finished cleanly. An error event flips
    // this to `false` so `execution.end` reports failure.
    let succeeded = true;
    try {
      stream = this.client.streamSession(sessionId, {});
      const sub = token.onCancellationRequested(() => {
        try { stream?.close(); } catch { /* ignore */ }
      });
      stream.sendPrompt(text);
      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };
        stream!.on('message', (evt: unknown) => {
          const e = evt as { content?: unknown };
          if (typeof e.content === 'string' && e.content.length > 0) {
            execution.appendOutput(buildTextOutput(e.content));
          }
        });
        stream!.on('error', (evt: unknown) => {
          const e = evt as { message?: unknown };
          const message = typeof e.message === 'string' ? e.message : 'unknown error';
          execution.appendOutput(buildErrorOutput(message));
          succeeded = false;
          finish();
        });
        stream!.on('done', () => finish());
        if (token.isCancellationRequested) {
          succeeded = false;
          finish();
        }
      });
      sub.dispose();
      execution.end(succeeded, Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      execution.appendOutput(buildErrorOutput(message));
      execution.end(false, Date.now());
    } finally {
      try { stream?.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Hook called by VSCode for every notebook document open in the
   * workspace; we update the controller's affinity accordingly.
   */
  refreshAffinity(): void {
    if (this.disposed) return;
    for (const ctrl of this.controllers) {
      for (const nb of workspace.notebookDocuments) {
        const accepted = this.shouldAccept(nb);
        // The public enum only exposes Default + Preferred; we use the
        // numeric 0 to signal "ignore" since the runtime supports it.
        ctrl.updateNotebookAffinity(nb, accepted ? NotebookControllerAffinity.Preferred : 0 as NotebookControllerAffinity);
      }
    }
  }

  /** Returns the underlying controllers (mostly for tests). */
  getControllers(): readonly NotebookController[] {
    return this.controllers;
  }

  /** Tears down controllers; safe to call multiple times. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ctrl of this.controllers) {
      try { ctrl.dispose(); } catch { /* ignore */ }
    }
    this.controllers.length = 0;
  }
}

// ----------------------------------------------------------------- helpers

function defaultAffinity(notebook: NotebookDocument): boolean {
  if (!notebook) return false;
  return notebook.notebookType === JUPYTER_NOTEBOOK_TYPE || notebook.notebookType === MAVIS_NOTEBOOK_TYPE;
}

function defaultCreateController(id: string, notebookType: string, label: string): NotebookController {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { notebooks } = require('vscode');
  return notebooks.createNotebookController(id, notebookType, label);
}

function buildTextOutput(text: string): NotebookCellOutput {
  return new NotebookCellOutput([
    new NotebookCellOutputItem(new TextEncoder().encode(text), 'application/vnd.code.notebook.stdout'),
  ]);
}

function buildErrorOutput(message: string): NotebookCellOutput {
  return new NotebookCellOutput([
    new NotebookCellOutputItem(new TextEncoder().encode(message), 'application/vnd.code.notebook.error'),
  ]);
}

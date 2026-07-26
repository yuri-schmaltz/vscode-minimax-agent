/**
 * MavisTaskProvider — VSCode Tasks integration.
 *
 * Registers a `tasks.registerTaskProvider('mavis', ...)` so the user
 * can run common Mavis workflows from the Tasks panel:
 *
 *   - `npm test`    → `Mavis: Test workspace`
 *   - `npm run lint` → `Mavis: Lint workspace`
 *   - `npm run package` → `Mavis: Package extension`
 *
 * All three are wired to a `ShellExecution` so they behave like the
 * regular npm tasks — VSCode's terminal UI, problem matchers, and
 * termination support all work out of the box.
 *
 * The provider also exposes a `resolveTask` implementation that fills
 * in the execution for tasks defined in `tasks.json` (with type
 * `mavis`). This lets power users drop `mavis`-typed tasks into their
 * repo without our code running on activation.
 */
import {
  CancellationToken,
  ProviderResult,
  ShellExecution,
  Task,
  TaskDefinition,
  TaskGroup,
  TaskProvider,
  TaskScope,
  workspace,
} from 'vscode';

/** Type id used in the `taskDefinitions` contribution. */
export const MAVIS_TASK_TYPE = 'mavis';

export interface MavisTaskDefinition extends TaskDefinition {
  type: 'mavis';
  /** The script name to run inside the workspace (e.g. "test"). */
  script: 'test' | 'lint' | 'package' | string;
  /** Optional override for the displayed label. */
  label?: string;
}

export interface MavisTaskProviderDeps {
  /**
   * Override for `tasks.registerTaskProvider`. The real implementation
   * is `vscode.tasks.registerTaskProvider`; tests inject a fake.
   */
  register?: (type: string, provider: MavisTaskProvider) => { dispose(): void };
  /**
   * Override for the workspace root used to build ShellExecutions.
   * Defaults to `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`.
   */
  resolveCwd?: () => string | undefined;
  /**
   * Optional override for npm binary resolution. The default is just
   * `npm` (relies on the user's PATH).
   */
  npmCommand?: string;
}

/**
 * Concrete TaskProvider. Constructed once at activation; the
 * caller registers it with VSCode via `register()`.
 */
export class MavisTaskProvider implements TaskProvider {
  private readonly register: (type: string, provider: MavisTaskProvider) => { dispose(): void };
  private readonly resolveCwd: () => string | undefined;
  private readonly npmCommand: string;
  private disposable: { dispose(): void } | undefined;

  constructor(deps: MavisTaskProviderDeps = {}) {
    this.register = deps.register ?? defaultRegister;
    this.resolveCwd = deps.resolveCwd ?? defaultResolveCwd;
    this.npmCommand = deps.npmCommand ?? 'npm';
  }

  /** Registers the provider with VSCode. Idempotent. */
  registerWithVSCode(): void {
    if (this.disposable) return;
    this.disposable = this.register(MAVIS_TASK_TYPE, this);
  }

  /**
   * Provides the three built-in Mavis tasks whenever VSCode asks for
   * them. We only emit tasks for the first workspace folder — if the
   * user has multiple, they can still pick the tasks; the per-folder
   * scope ensures the working directory resolves correctly.
   */
  provideTasks(_token: CancellationToken): ProviderResult<Task[]> {
    const cwd = this.resolveCwd();
    const scope = cwd ? TaskScope.Workspace : TaskScope.Global;
    const out: Task[] = [];
    for (const spec of DEFAULT_TASKS) {
      const def: MavisTaskDefinition = { type: MAVIS_TASK_TYPE, script: spec.script };
      const task = new Task(
        def,
        scope,
        spec.label,
        'Mavis',
        new ShellExecution(`${this.npmCommand} run ${spec.script}`, { cwd }),
        spec.problemMatchers,
      );
      task.detail = spec.detail;
      task.group = spec.group;
      out.push(task);
    }
    return out;
  }

  /**
   * Resolves a `mavis`-typed task that came in from `tasks.json`. We
   * just need to fill in the execution; everything else is already
   * present on the input.
   */
  resolveTask(task: Task, _token: CancellationToken): ProviderResult<Task> {
    const def = task.definition as Partial<MavisTaskDefinition>;
    if (!def || def.type !== MAVIS_TASK_TYPE || typeof def.script !== 'string') {
      return undefined;
    }
    const cwd = this.resolveCwd();
    const execution = task.execution
      ?? new ShellExecution(`${this.npmCommand} run ${def.script}`, { cwd });
    const resolved = new Task(
      def as TaskDefinition,
      task.scope ?? TaskScope.Workspace,
      task.name,
      task.source || 'Mavis',
      execution,
      task.problemMatchers,
    );
    resolved.detail = task.detail;
    resolved.group = task.group;
    resolved.presentationOptions = task.presentationOptions;
    return resolved;
  }

  /** Unregisters the provider. Idempotent. */
  dispose(): void {
    try { this.disposable?.dispose(); } catch { /* ignore */ }
    this.disposable = undefined;
  }
}

// ----------------------------------------------------------------- helpers

interface TaskSpec {
  script: string;
  label: string;
  detail: string;
  problemMatchers: string[];
  group: TaskGroup;
}

const DEFAULT_TASKS: TaskSpec[] = [
  {
    script: 'test',
    label: 'Mavis: Test workspace',
    detail: 'Run the Mavis extension test suite (mocha/node:test).',
    problemMatchers: ['$tsc'],
    group: TaskGroup.Test,
  },
  {
    script: 'lint',
    label: 'Mavis: Lint workspace',
    detail: 'Run ESLint over the extension source.',
    problemMatchers: ['$eslint-stylish'],
    group: TaskGroup.Clean,
  },
  {
    script: 'package',
    label: 'Mavis: Package extension',
    detail: 'Build and produce a .vsix artifact.',
    problemMatchers: [],
    group: TaskGroup.Build,
  },
];

function defaultResolveCwd(): string | undefined {
  return workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function defaultRegister(type: string, provider: MavisTaskProvider): { dispose(): void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tasks } = require('vscode');
  return tasks.registerTaskProvider(type, provider) as { dispose(): void };
}

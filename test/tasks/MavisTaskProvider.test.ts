/**
 * MavisTaskProvider unit tests.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MavisTaskProvider, MAVIS_TASK_TYPE } from '../../src/tasks/MavisTaskProvider';
import { Task, TaskGroup } from 'vscode';

test('MavisTaskProvider: exports the expected task type id', () => {
  assert.equal(MAVIS_TASK_TYPE, 'mavis');
});

test('MavisTaskProvider: provideTasks returns the three built-in tasks', () => {
  const provider = new MavisTaskProvider({ register: () => ({ dispose: () => undefined }) });
  const tasks = provider.provideTasks({ isCancellationRequested: false } as never) as Task[];
  assert.equal(tasks.length, 3);
  const labels = tasks.map((t) => t.name);
  assert.ok(labels.some((l) => l.includes('Test')));
  assert.ok(labels.some((l) => l.includes('Lint')));
  assert.ok(labels.some((l) => l.includes('Package')));
  for (const t of tasks) {
    assert.equal((t.definition as { type: string }).type, 'mavis');
    assert.equal(t.source, 'Mavis');
    assert.ok(t.execution);
  }
  provider.dispose();
});

test('MavisTaskProvider: tasks are wired to npm run <script>', () => {
  const provider = new MavisTaskProvider({ register: () => ({ dispose: () => undefined }) });
  const tasks = provider.provideTasks({ isCancellationRequested: false } as never) as Task[];
  for (const t of tasks) {
    const script = (t.definition as unknown as { script: string }).script;
    const exec = t.execution as { command: string };
    assert.ok(exec.command.includes(`npm run ${script}`), `expected "npm run ${script}" in ${exec.command}`);
  }
  provider.dispose();
});

test('MavisTaskProvider: registerWithVSCode calls register and is idempotent', () => {
  let calls = 0;
  const provider = new MavisTaskProvider({
    register: (type, p) => {
      calls += 1;
      assert.equal(type, 'mavis');
      assert.equal(p, provider);
      return { dispose: () => undefined };
    },
  });
  provider.registerWithVSCode();
  provider.registerWithVSCode();
  provider.registerWithVSCode();
  assert.equal(calls, 1);
  provider.dispose();
});

test('MavisTaskProvider: dispose is idempotent and does not throw without register', () => {
  const provider = new MavisTaskProvider({ register: () => ({ dispose: () => undefined }) });
  provider.dispose();
  provider.dispose();
  // No throw = pass.
});

test('MavisTaskProvider: resolveTask fills in execution for a mavis-typed task', () => {
  const provider = new MavisTaskProvider({ register: () => ({ dispose: () => undefined }) });
  const input = new Task({ type: 'mavis', script: 'test' }, 'Test', 'Mavis');
  const resolved = provider.resolveTask(input, { isCancellationRequested: false } as never) as Task;
  assert.ok(resolved.execution);
  const exec = resolved.execution as { command: string };
  assert.ok(exec.command.includes('npm run test'));
  provider.dispose();
});

test('MavisTaskProvider: resolveTask returns undefined for non-mavis tasks', () => {
  const provider = new MavisTaskProvider({ register: () => ({ dispose: () => undefined }) });
  const input = new Task({ type: 'npm', script: 'test' }, 'Test', 'npm');
  const resolved = provider.resolveTask(input, { isCancellationRequested: false } as never);
  assert.equal(resolved, undefined);
  provider.dispose();
});

test('MavisTaskProvider: groups are set so tasks appear in their section', () => {
  const provider = new MavisTaskProvider({ register: () => ({ dispose: () => undefined }) });
  const tasks = provider.provideTasks({ isCancellationRequested: false } as never) as Task[];
  const testTask = tasks.find((t) => t.name.includes('Test'))!;
  const lintTask = tasks.find((t) => t.name.includes('Lint'))!;
  const packageTask = tasks.find((t) => t.name.includes('Package'))!;
  assert.equal(testTask.group, TaskGroup.Test);
  assert.equal(lintTask.group, TaskGroup.Clean);
  assert.equal(packageTask.group, TaskGroup.Build);
  provider.dispose();
});

test('MavisTaskProvider: npm command can be overridden', () => {
  const provider = new MavisTaskProvider({
    register: () => ({ dispose: () => undefined }),
    npmCommand: 'pnpm',
  });
  const tasks = provider.provideTasks({ isCancellationRequested: false } as never) as Task[];
  for (const t of tasks) {
    const exec = t.execution as { command: string };
    assert.ok(exec.command.startsWith('pnpm '));
  }
  provider.dispose();
});

test('MavisTaskProvider: cwd is forwarded to the execution', () => {
  const provider = new MavisTaskProvider({
    register: () => ({ dispose: () => undefined }),
    resolveCwd: () => '/repo/root',
  });
  const tasks = provider.provideTasks({ isCancellationRequested: false } as never) as Task[];
  for (const t of tasks) {
    const exec = t.execution as { options?: { cwd?: string } };
    assert.equal(exec.options?.cwd, '/repo/root');
  }
  provider.dispose();
});

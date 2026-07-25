/**
 * Reusable fake `spawn` for tests. Returns a child-like object whose
 * stdin/stdout/stderr are normal streams so the production code can wire
 * them up the same way it would a real child.
 */
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';

export interface FakeChild {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  emitter: EventEmitter;
  on: EventEmitter['on'];
  once: EventEmitter['once'];
  emit: EventEmitter['emit'];
  kill(signal?: string): boolean;
  killed: boolean;
  pid: number;
}

export function makeFakeChild(): FakeChild {
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  let killed = false;
  const child: FakeChild = {
    stdin,
    stdout,
    stderr,
    emitter,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    kill: () => {
      killed = true;
      setImmediate(() => emitter.emit('close', null, 'SIGTERM'));
      return true;
    },
    get killed() { return killed; },
    pid: 99999,
  };
  return child;
}

export function makeSpawner(child: FakeChild): typeof spawn {
  return (() => child) as unknown as typeof spawn;
}

/**
 * Returns a spawn function that mints a fresh FakeChild on every call.
 * Use this when the test exercises code that creates more than one child
 * (e.g. two sessions in parallel); `makeSpawner` always returns the same
 * child, which makes the second `streamSession` share the (ended) stdin.
 */
export function makePerCallSpawner(): { spawn: typeof spawn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  function spawnFn(_bin: string, _args: string[], _opts: unknown): ReturnType<typeof spawn> {
    const c = makeFakeChild();
    children.push(c);
    return c as unknown as ReturnType<typeof spawn>;
  }
  return { spawn: spawnFn as unknown as typeof spawn, children };
}

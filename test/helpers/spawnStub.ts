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

/**
 * Minimal vscode mock for unit tests. Provides only the surface the
 * production code touches.
 *
 * Tests construct mocks explicitly and pass them to the production class
 * constructors (which are typed against the real `vscode` types), relying
 * on TypeScript's structural typing.
 */
import { EventEmitter as NodeEventEmitter } from 'node:events';

export class Uri {
  scheme: string;
  path: string;
  private constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.path = path;
  }
  static file(p: string): Uri {
    return new Uri('file', p);
  }
  static parse(s: string): Uri {
    const idx = s.indexOf(':');
    return new Uri(idx === -1 ? 'file' : s.slice(0, idx), idx === -1 ? s : s.slice(idx + 1));
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}:${this.path}`;
  }
  with(): Uri {
    return this;
  }
}

export interface WebviewOptions {
  enableScripts?: boolean;
  enableForms?: boolean;
  localResourceRoots?: readonly Uri[];
}

export interface Webview {
  options: WebviewOptions;
  html: string;
  cspSource: string;
  asWebviewUri(uri: Uri): Uri;
  postMessage(msg: unknown): void;
  onDidReceiveMessage(listener: (msg: unknown) => void): { dispose(): void };
}

export class SecretStorage {
  private data = new Map<string, string>();
  private emitter = new NodeEventEmitter();
  // The real vscode.SecretStorage.onDidChange is an Event<SecretStorageChangeEvent>.
  // The mock exposes a Node-style EventEmitter so tests can both subscribe and fire.
  onDidChange: import('vscode').Event<import('vscode').SecretStorageChangeEvent> = ((listener: (e: unknown) => void) => {
    this.emitter.on('change', listener);
    return { dispose: () => { this.emitter.off('change', listener); } };
  }) as unknown as import('vscode').Event<import('vscode').SecretStorageChangeEvent>;
  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    this.emitter.emit('change', { key });
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
    this.emitter.emit('change', { key });
  }
  async keys(): Promise<string[]> {
    return Array.from(this.data.keys());
  }
}

export class EventEmitter<T = unknown> {
  private listeners: Array<(e: T) => void> = [];
  get event() {
    return (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
  }
  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

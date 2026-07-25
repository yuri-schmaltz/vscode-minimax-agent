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

// Minimal CodeActionKind + CodeAction for tests. The real `vscode`
// module is not available in the test environment; tests that need
// more fidelity stub the rest via test-local helpers.
export class CodeActionKind {
  static readonly Empty: CodeActionKind = new CodeActionKind('empty');
  static readonly QuickFix: CodeActionKind = new CodeActionKind('quickfix');
  static readonly Refactor: CodeActionKind = new CodeActionKind('refactor');
  static readonly RefactorExtract: CodeActionKind = new CodeActionKind('refactor.extract');
  static readonly RefactorInline: CodeActionKind = new CodeActionKind('refactor.inline');
  static readonly RefactorMove: CodeActionKind = new CodeActionKind('refactor.move');
  static readonly RefactorRewrite: CodeActionKind = new CodeActionKind('refactor.rewrite');
  static readonly Source: CodeActionKind = new CodeActionKind('source');
  static readonly SourceFixAll: CodeActionKind = new CodeActionKind('source.fixAll');
  static readonly SourceOrganizeImports: CodeActionKind = new CodeActionKind('source.organizeImports');
  private constructor(public readonly value: string) {}
  append(parts: string): CodeActionKind {
    return new CodeActionKind(this.value + (parts.startsWith('.') ? parts : '.' + parts));
  }
  intersects(other: CodeActionKind): boolean {
    return this.value === other.value || other.value.startsWith(this.value + '.') || this.value.startsWith(other.value + '.');
  }
  contains(other: CodeActionKind): boolean {
    return other.value.startsWith(this.value + '.') || other.value === this.value;
  }
}

export class CodeAction {
  title: string;
  command?: { title: string; command: string; arguments?: unknown[] };
  diagnostics?: unknown[];
  edit?: unknown;
  kind?: CodeActionKind;
  isPreferred?: boolean;
  disabled?: { reason: string };
  constructor(title: string, kind?: CodeActionKind) {
    this.title = title;
    this.kind = kind;
  }
}

export interface Command {
  title: string;
  command: string;
  tooltip?: string;
  arguments?: unknown[];
}

export interface CodeActionProvider<T = CodeAction> {
  provideCodeActions(
    document: unknown,
    range: unknown,
    context: unknown,
    token: unknown,
  ): T[] | undefined | Promise<T[] | undefined>;
  resolveCodeAction?(action: T, token: unknown): T | Promise<T>;
}

export class WorkspaceEdit {
  private map = new Map<string, Array<{ range: unknown; newText: string }>>();
  replace(uri: { toString(): string }, range: unknown, newText: string): void {
    const key = uri.toString();
    const arr = this.map.get(key) ?? [];
    arr.push({ range, newText });
    this.map.set(key, arr);
  }
  get(uri: { toString(): string }): Array<{ range: unknown; newText: string }> | undefined {
    return this.map.get(uri.toString());
  }
  entries(): Array<{ resource: { toString(): string }; edits: Array<{ range: unknown; newText: string }> }> {
    const out: Array<{ resource: { toString(): string }; edits: Array<{ range: unknown; newText: string }> }> = [];
    for (const [k, edits] of this.map.entries()) {
      out.push({ resource: { toString: () => k, fsPath: k.replace('file://', ''), scheme: 'file', path: k.replace('file://', '') } as unknown as { toString(): string }, edits });
    }
    return out;
  }
}

export const languages = {
  registerCodeActionsProvider: () => ({ dispose: () => undefined }),
};

export const window = {
  activeTextEditor: undefined as unknown,
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  createStatusBarItem: () => ({
    text: '',
    tooltip: undefined,
    command: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  registerWebviewViewProvider: () => ({ dispose: () => undefined }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: async () => undefined,
};

export const env = {
  openExternal: async () => true,
};

// Test-only injection point: tests can pre-load documents into this map
// (keyed by file uri) so the production code can look them up via
// `workspace.openTextDocument`. The mock only models the small surface
// the production code touches.
const documents = new Map<string, unknown>();
export const _testMock = {
  registerDocument(uri: string, doc: unknown): void {
    documents.set(uri, doc);
  },
  clear(): void {
    documents.clear();
  },
};

// Mutable workspace object. Tests can monkey-patch the methods to
// observe calls (e.g. `workspace.applyEdit = async () => ...`).
const workspaceMutable: {
  openTextDocument(uri: { toString(): string }): Promise<unknown>;
  applyEdit(edit: unknown): Promise<boolean>;
  getConfiguration: (...args: unknown[]) => unknown;
  workspaceFolders: unknown[];
  onDidChangeConfiguration: (...args: unknown[]) => unknown;
} = {
  async openTextDocument(uri: { toString(): string }): Promise<unknown> {
    return documents.get(uri.toString());
  },
  async applyEdit(_edit: unknown): Promise<boolean> {
    return true;
  },
  getConfiguration: () => ({
    get: () => undefined,
    update: async () => undefined,
  }),
  workspaceFolders: [],
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
};
export const workspace = workspaceMutable;

export class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(
    startLine: number | { line: number; character: number },
    startCharOrEnd?: number | { line: number; character: number },
    endLine?: number,
    endChar?: number,
  ) {
    if (typeof startLine === 'object') {
      this.start = startLine;
      this.end = (startCharOrEnd as { line: number; character: number }) ?? startLine;
    } else {
      this.start = { line: startLine, character: (startCharOrEnd as number) ?? 0 };
      this.end = { line: endLine ?? startLine, character: endChar ?? 0 };
    }
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
  contains(pos: { line: number; character: number }): boolean {
    if (pos.line < this.start.line || pos.line > this.end.line) return false;
    if (pos.line === this.start.line && pos.character < this.start.character) return false;
    if (pos.line === this.end.line && pos.character > this.end.character) return false;
    return true;
  }
}

export class Position {
  readonly line: number;
  readonly character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

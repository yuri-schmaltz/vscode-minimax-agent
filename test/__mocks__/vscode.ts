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
  registerInlineCompletionItemProvider: (_selector: unknown, _provider: unknown) => ({ dispose: () => undefined }),
};

export const window = {
  activeTextEditor: undefined as unknown,
  showInformationMessage: async (_msg?: unknown, _options?: unknown, ..._items: unknown[]) => undefined,
  showErrorMessage: async (_msg?: unknown, _options?: unknown, ..._items: unknown[]) => undefined,
  showWarningMessage: async (_msg?: unknown, _options?: unknown, ..._items: unknown[]) => undefined,
  showInputBox: async (_options?: unknown) => undefined,
  showQuickPick: async (_items?: unknown, _options?: unknown) => undefined,
  showSaveDialog: async () => undefined,
  showOpenDialog: async () => undefined,
  createStatusBarItem: () => ({
    text: '',
    tooltip: undefined,
    command: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  createTreeView: <T>(_id: string, _options?: unknown) => {
    const view = {
      reveal: async (_item?: T) => undefined,
      dispose: () => undefined,
    };
    return view;
  },
  registerWebviewViewProvider: () => ({ dispose: () => undefined }),
  registerTreeDataProvider: (_id: string, _provider: unknown) => ({ dispose: () => undefined }),
  createWebviewPanel: (_id: string, _title: string, _options?: unknown, _panelOptions?: unknown) => ({
    webview: {
      options: {} as WebviewOptions,
      html: '',
      cspSource: 'vscode-webview://test-csp',
      asWebviewUri: (u: import('vscode').Uri) => u,
      postMessage: (_m: unknown) => undefined,
      onDidReceiveMessage: (_l: (m: unknown) => void) => ({ dispose: () => undefined }),
    } as unknown as Webview,
    reveal: () => undefined,
    onDidDispose: () => ({ dispose: () => undefined }),
    dispose: () => undefined,
  }),
  withProgress: async (_opts: unknown, task: (progress: { report: (v: unknown) => void }, token: unknown) => Promise<unknown>) => {
    return await task({ report: () => undefined }, { isCancellationRequested: false });
  },
};

export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: async () => undefined,
  registerTextEditorCommand: () => ({ dispose: () => undefined }),
};

export const env = {
  openExternal: async (_uri: unknown) => true,
  machineId: 'test-machine-id-0000',
  sessionId: 'test-session-id-0000',
  language: 'en',
  clipboard: {
    writeText: async (_text: string) => undefined,
  },
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

export class ThemeIcon {
  static readonly File: ThemeIcon = new ThemeIcon('file');
  static readonly Folder: ThemeIcon = new ThemeIcon('folder');
  static readonly Loading: ThemeIcon = new ThemeIcon('loading');
  readonly id: string;
  readonly color?: { id: string };
  constructor(id: string, color?: { id: string }) {
    this.id = id;
    this.color = color;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string;
  iconPath?: { id: string } | string;
  resourceUri?: Uri;
  command?: { command: string; title: string; arguments?: unknown[] };
  contextValue?: string;
  collapsibleState: TreeItemCollapsibleState;
  id?: string;
  constructor(label: string | { label: string }, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    if (typeof label === 'string') {
      this.label = label;
    } else {
      this.label = label.label;
    }
    this.collapsibleState = collapsibleState;
  }
}

export interface TreeDataProvider<T> {
  onDidChangeTreeData?: import('vscode').Event<T | T[] | undefined | null>;
  getTreeItem(element: T): import('vscode').TreeItem | Thenable<import('vscode').TreeItem>;
  getChildren(element?: T): T[] | Thenable<T[]>;
  getParent?(element: T): T | undefined | Thenable<T | undefined>;
  // The interface is parameterised by the user; we leave T opaque to
  // avoid coupling this mock to the production types.
  readonly __phantom?: T;
}

export class RelativePattern {
  base: string;
  pattern: string;
  constructor(base: string, pattern: string) {
    this.base = base;
    this.pattern = pattern;
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export const FileTypeModule = FileType;
export const RelativePatternModule = RelativePattern;

export interface DataTransferItem {
  asString(): Thenable<string>;
  asFile(): { name?: string; uri?: Uri; data?: unknown };
  value: unknown;
  types: ReadonlyArray<string>;
}

export class DataTransfer {
  private items = new Map<string, DataTransferItem>();
  set(mimeType: string, value: unknown): void {
    this.items.set(mimeType, {
      asString: async () => String(value),
      asFile: () => ({ data: value }),
      value,
      types: [mimeType],
    } as DataTransferItem);
  }
  get(mimeType: string): DataTransferItem | undefined {
    return this.items.get(mimeType);
  }
  forEach(cb: (item: DataTransferItem, mime: string) => void): void {
    for (const [mime, item] of this.items.entries()) cb(item, mime);
  }
  has(mimeType: string): boolean {
    return this.items.has(mimeType);
  }
}

export class EventEmitterImpl<T = unknown> {
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

// Drag-and-drop controller shim for the production code. The real vscode
// type is `vscode.DragAndDropController<T>`; tests can construct a fake
// that exposes the same shape without needing a real editor.
export class TreeDragAndDropController<T> {
  onWillAcceptDrop?: (e: unknown) => unknown;
  onWillDrop?: (e: unknown) => unknown;
  onDidDrop?: (e: unknown) => unknown;
  dragMimeTypes: readonly string[] = [];
  dropMimeTypes: readonly string[] = [];
  constructor(init?: {
    onWillAcceptDrop?: (e: unknown) => unknown;
    onWillDrop?: (e: unknown) => unknown;
    onDidDrop?: (e: unknown) => unknown;
    dragMimeTypes?: readonly string[];
    dropMimeTypes?: readonly string[];
  }) {
    if (init) {
      this.onWillAcceptDrop = init.onWillAcceptDrop;
      this.onWillDrop = init.onWillDrop;
      this.onDidDrop = init.onDidDrop;
      this.dragMimeTypes = init.dragMimeTypes ?? [];
      this.dropMimeTypes = init.dropMimeTypes ?? [];
    }
    void (null as unknown as T);
  }
}

export class CancellationTokenSource {
  token: import('vscode').CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: (_l: unknown) => ({ dispose: () => undefined }),
  };
  cancel(): void {
    this.token = { ...this.token, isCancellationRequested: true };
  }
  dispose(): void {
    /* noop */
  }
}

// ---------------------------------------------------------------- Fase 6 mocks
// Minimal mocks for the Language Model, Notebook, Tasks, and Inline
// Completion APIs. The real classes from `@types/vscode` are rich; we
// only need just enough surface for the production code to call into.

export class InlineCompletionItem {
  insertText: string;
  range?: unknown;
  command?: unknown;
  constructor(insertText: string, range?: unknown, command?: unknown) {
    this.insertText = insertText;
    this.range = range;
    this.command = command;
  }
}

export class InlineCompletionList {
  items: InlineCompletionItem[];
  constructor(items: InlineCompletionItem[]) { this.items = items; }
}

export class LanguageModelTextPart {
  value: string;
  constructor(value: string) { this.value = value; }
}

export class LanguageModelToolCallPart {
  callId: string;
  name: string;
  input: unknown;
  constructor(callId: string, name: string, input: unknown) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

export class LanguageModelToolResultPart {
  callId: string;
  content: unknown[];
  constructor(callId: string, content: unknown[]) {
    this.callId = callId;
    this.content = content;
  }
}

export class LanguageModelDataPart {
  data: unknown;
  mimeType: string;
  constructor(data: unknown, mimeType: string) {
    this.data = data;
    this.mimeType = mimeType;
  }
}

export class LanguageModelChatMessage {
  role: string;
  content: unknown[];
  constructor(role: string, content: unknown[] | string) {
    this.role = role;
    this.content = Array.isArray(content) ? content : [new LanguageModelTextPart(content as string)];
  }
  static User(content: string | unknown[]): LanguageModelChatMessage {
    return new LanguageModelChatMessage('user', content);
  }
  static Assistant(content: string | unknown[]): LanguageModelChatMessage {
    return new LanguageModelChatMessage('assistant', content);
  }
}

export const lm = {
  registerLanguageModelChatProvider: (_vendor: string, _provider: unknown) => ({ dispose: () => undefined }),
  selectChatModels: async (_selector?: unknown) => [] as unknown[],
};

export const NotebookCellOutputItem = class NotebookCellOutputItem {
  static StdOut = 1;
  static StdErr = 2;
  mimeType: string;
  value: unknown;
  constructor(mimeOrErr: number | string | Error, value?: unknown) {
    if (mimeOrErr instanceof Error) {
      this.mimeType = 'application/x-notebook-error';
      this.value = mimeOrErr.message;
    } else if (typeof mimeOrErr === 'number') {
      this.mimeType = mimeOrErr === NotebookCellOutputItem.StdErr ? 'application/x-notebook-stderr' : 'application/x-notebook-stdout';
      this.value = value;
    } else {
      this.mimeType = mimeOrErr;
      this.value = value;
    }
  }
  static error(err: Error | string): NotebookCellOutputItem {
    return new NotebookCellOutputItem(err);
  }
};

export class NotebookCellOutput {
  items: unknown[];
  constructor(items: unknown[]) { this.items = items; }
}

export class NotebookCellExecution {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
  start(_d: number) { /* noop */ }
  end(_ok: boolean, _d: number) { /* noop */ }
  appendOutput(_o: unknown) { /* noop */ }
  replaceOutput(_o: unknown) { /* noop */ }
}

export class NotebookController {
  id: string;
  notebookType: string;
  label: string;
  supportedLanguages: string[] = [];
  executeHandler?: unknown;
  constructor(id: string, notebookType: string, label: string) {
    this.id = id;
    this.notebookType = notebookType;
    this.label = label;
  }
  createNotebookCellExecution(_cell: unknown): NotebookCellExecution { return new NotebookCellExecution(); }
  updateNotebookAffinity(_nb: unknown, _affinity: number) { /* noop */ }
  dispose() { /* noop */ }
}

export const notebooks = {
  createNotebookController: (id: string, notebookType: string, label: string) => new NotebookController(id, notebookType, label),
  notebookDocuments: [] as unknown[],
};

export enum TaskScope {
  Global = 1,
  Workspace = 2,
}

export class TaskGroup {
  static Test = new TaskGroup('test', 'Test');
  static Build = new TaskGroup('build', 'Build');
  static Clean = new TaskGroup('clean', 'Clean');
  static Rebuild = new TaskGroup('rebuild', 'Rebuild');
  static None = new TaskGroup('none', 'None');
  private constructor(public kind: string, public label: string) {}
  isDefault?: boolean;
}

export class ShellExecution {
  command: string;
  args?: string[];
  options?: { cwd?: string };
  constructor(command: string, argsOrOpts?: string | { cwd?: string } | string[], options?: { cwd?: string }) {
    this.command = command;
    if (typeof argsOrOpts === 'string') {
      this.options = options;
    } else if (Array.isArray(argsOrOpts)) {
      this.args = argsOrOpts;
      this.options = options;
    } else {
      this.options = argsOrOpts;
    }
  }
}

export class Task {
  definition: { type: string; [k: string]: unknown };
  scope?: unknown;
  name: string;
  source: string;
  execution?: ShellExecution;
  isBackground = false;
  detail?: string;
  group?: TaskGroup;
  presentationOptions: Record<string, unknown> = {};
  problemMatchers: string[] = [];
  runOptions: Record<string, unknown> = {};
  constructor(
    definition: { type: string; [k: string]: unknown },
    scopeOrName: unknown,
    nameOrSource: string,
    sourceOrExec?: string | ShellExecution,
    execOrMatchers?: ShellExecution | string[] | undefined,
    matchers?: string[] | undefined,
  ) {
    this.definition = definition;
    if (typeof scopeOrName === 'string') {
      this.name = scopeOrName;
      this.source = nameOrSource;
      this.execution = sourceOrExec as ShellExecution;
      this.problemMatchers = (execOrMatchers as string[] | undefined) ?? [];
    } else {
      this.scope = scopeOrName;
      this.name = nameOrSource;
      this.source = sourceOrExec as string;
      this.execution = execOrMatchers as ShellExecution;
      this.problemMatchers = matchers ?? [];
    }
  }
}

export const tasks = {
  registerTaskProvider: (_type: string, _provider: unknown) => ({ dispose: () => undefined }),
};

// Workspace extension for notebooks
(workspaceMutable as unknown as { onDidOpenNotebookDocument: (l: (e: unknown) => void) => { dispose(): void } }).onDidOpenNotebookDocument = (_l: (e: unknown) => void) => ({ dispose: () => undefined });
(workspaceMutable as unknown as { notebookDocuments: unknown[] }).notebookDocuments = [];

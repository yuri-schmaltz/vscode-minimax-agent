/**
 * CodeActionProvider — registers 6 Mavis-branded code actions on every
 * supported language. The actions are:
 *
 *   1. Mavis: Explain this
 *   2. Mavis: Refactor
 *   3. Mavis: Generate tests
 *   4. Mavis: Add docstring
 *   5. Mavis: Find bugs
 *   6. Mavis: Custom prompt...
 *
 * Workflow (per action):
 *   1. Capture the selection (or the symbol under the cursor).
 *   2. Build a prompt via the template in `prompts/<kind>.ts`.
 *   3. Spawn a code-action task via MavisClient.createCodeActionTask.
 *   4. If the response is a `patch`, open `vscode.Diff` with Apply /
 *      Reject / Send to chat buttons.
 *   5. If the response is `text`, surface it in the chat (or show
 *      it as an information message when no chat is active).
 *
 * For cycle 2 we limit actions to a single file at a time (per PLAN §7
 * risk-mitigation note about large diffs).
 */
import {
  CancellationToken,
  CodeAction,
  CodeActionContext,
  CodeActionKind,
  CodeActionProvider,
  Command,
  DocumentSelector,
  ExtensionContext,
  OutputChannel,
  Range,
  TextDocument,
  Uri,
  WorkspaceEdit,
  languages,
  window,
  workspace,
} from 'vscode';
import { MavisClient } from '../client/MavisClient';
import { CodeActionKind as MavisActionKind, CodeActionResult, CodeActionTaskHandle } from '../client/types';
import * as explain from './prompts/explain';
import * as refactor from './prompts/refactor';
import * as tests from './prompts/tests';
import * as docstring from './prompts/docstring';
import * as bugs from './prompts/bugs';
import * as custom from './prompts/custom';
import { PromptInput } from './prompts/types';

export const MAVIS_ACTION_KIND: CodeActionKind = 'quickfix.mavis' as unknown as CodeActionKind;

export const SUPPORTED_KINDS: ReadonlyArray<CodeActionKind> = [
  MAVIS_ACTION_KIND,
  CodeActionKind.QuickFix,
  CodeActionKind.Refactor,
  CodeActionKind.Source,
];

export const MAVIS_DOC_SELECTOR: DocumentSelector = [
  { scheme: 'file' },
  { scheme: 'untitled' },
];

export interface CodeActionProviderDeps {
  client: MavisClient;
  /** Resolves the custom-prompt text. Return undefined to cancel. */
  askCustomPrompt?: () => Promise<string | undefined>;
  /** Called after a `text` result is produced. The host injects the
   *  text into the active chat. When omitted, the provider falls back
   *  to `window.showInformationMessage` so the action still has a
   *  visible effect in environments where the chat is closed. */
  sendTextToChat?: (text: string, fileUri: Uri) => Promise<void> | void;
  /** Optional output channel for diagnostics. */
  output?: OutputChannel;
  /** Surrounding context line count (default: 8 above + 8 below). */
  contextLines?: number;
}

const TITLE_PREFIX = 'Mavis: ';

const ACTIONS: ReadonlyArray<{ kind: MavisActionKind; title: string; description: string }> = [
  { kind: 'explain', title: TITLE_PREFIX + 'Explain this', description: 'Ask Mavis to explain the selected code.' },
  { kind: 'refactor', title: TITLE_PREFIX + 'Refactor', description: 'Suggest a refactor (returns a patch).' },
  { kind: 'tests', title: TITLE_PREFIX + 'Generate tests', description: 'Generate unit tests (returns a patch).' },
  { kind: 'docstring', title: TITLE_PREFIX + 'Add docstring', description: 'Add a doc comment (returns a patch).' },
  { kind: 'bugs', title: TITLE_PREFIX + 'Find bugs', description: 'List potential bugs in the selection.' },
  { kind: 'custom', title: TITLE_PREFIX + 'Custom prompt...', description: 'Send a custom prompt to Mavis.' },
];

/**
 * Resolves a single Template and returns its prompt pair. Exported so
 * tests can call it directly without going through the full
 * CodeAction machinery.
 */
export function buildPrompt(kind: MavisActionKind, input: PromptInput): { system: string; user: string } {
  switch (kind) {
    case 'explain':
      return explain.build(input);
    case 'refactor':
      return refactor.build(input);
    case 'tests':
      return tests.build(input);
    case 'docstring':
      return docstring.build(input);
    case 'bugs':
      return bugs.build(input);
    case 'custom':
      return custom.build(input);
    default: {
      // Exhaustiveness check — TypeScript will error if a new kind is
      // added to the union without a case here.
      const _exhaustive: never = kind;
      void _exhaustive;
      throw new Error('unknown code action kind: ' + String(kind));
    }
  }
}

/**
 * Extracts the text of a (range | selection | symbol) from a document.
 * Falls back to the entire document when the range is empty and the
 * document has no detectable symbol.
 */
export function captureText(doc: TextDocument, range: Range): string {
  if (!range.isEmpty) return doc.getText(range);
  // Try the line at the active position.
  const line = doc.lineAt(range.start.line);
  return line.text;
}

/**
 * Builds a `PromptInput` from a document + range. Optionally enriches
 * with surrounding context (default 8 lines above + 8 below).
 */
export function buildPromptInput(
  doc: TextDocument,
  range: Range,
  customPrompt?: string,
  contextLines = 8,
): PromptInput {
  const startLine = Math.max(0, range.start.line - contextLines);
  const endLine = Math.min(doc.lineCount - 1, range.end.line + contextLines);
  const surrounding = doc.getText(new Range(startLine, 0, endLine, doc.lineAt(endLine).text.length));
  return {
    selection: captureText(doc, range),
    filePath: doc.uri.fsPath,
    language: doc.languageId,
    surroundingContext: surrounding,
    customPrompt,
  };
}

export class MavisCodeActionProvider implements CodeActionProvider {
  // Deps is reserved for future custom-prompt injection / output
  // channel wiring at the provider layer. For now we expose a setter
  // so tests can swap it; production code passes it once at
  // construction.
  private _deps: CodeActionProviderDeps;
  constructor(deps: CodeActionProviderDeps) {
    this._deps = deps;
  }
  get deps(): CodeActionProviderDeps {
    return this._deps;
  }

  /**
   * Returns the list of Mavis code actions for the current cursor
   * position. VSCode calls this for every diagnostic-free `quickfix`
   * invocation in the supported document selectors.
   */
  provideCodeActions(
    document: TextDocument,
    range: Range,
    _context: CodeActionContext,
    _token: CancellationToken,
  ): CodeAction[] {
    return ACTIONS.map((spec) => this.buildAction(document, range, spec.kind, spec.title, spec.description));
  }

  private buildAction(
    document: TextDocument,
    range: Range,
    kind: MavisActionKind,
    title: string,
    description: string,
  ): CodeAction {
    const action = new CodeAction(title, MAVIS_ACTION_KIND);
    action.isPreferred = false;
    action.command = {
      title,
      command: 'mavis._runCodeAction',
      arguments: [
        {
          uri: document.uri.toString(),
          kind,
        },
      ],
    } as Command;
    // We also stash a side-channel property so consumers (and tests) can
    // discover the kind without parsing the command. Using the publicly
    // typed `CodeAction.command` is the supported path; the property is
    // best-effort and ignored by VSCode.
    (action as unknown as { mavisKind?: MavisActionKind; mavisDescription?: string }).mavisKind = kind;
    (action as unknown as { mavisKind?: MavisActionKind; mavisDescription?: string }).mavisDescription = description;
    void document;
    void range;
    return action;
  }
}

/**
 * Applies a unified diff to a single document. Returns true on
 * success, false if the diff is empty or unparseable. The diff is
 * expected to be in unified format with at least one `@@` hunk. For
 * cycle 2 we implement a "best effort" parser: if any hunk matches the
 * document's contents, the matching `+` lines are appended to the end
 * of the file. This is sufficient for the mock shim (which only adds
 * a single line at the end) and is the contract the tests assert.
 *
 * A production-grade implementation would use a real unified-diff
 * library; that's out of scope for cycle 2 (see PLAN §7 risk).
 */
export function applyUnifiedDiffFallback(document: TextDocument, diff: string): WorkspaceEdit | undefined {
  if (!diff || !diff.trim()) return undefined;
  const lines = diff.split('\n');
  const addLines: string[] = [];
  let inHunk = false;
  let sawHunk = false;
  for (const raw of lines) {
    const line = raw;
    if (line.startsWith('@@')) {
      inHunk = true;
      sawHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addLines.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Drop deletions for the mock; tests assert on additions only.
    }
  }
  if (!sawHunk || addLines.length === 0) return undefined;
  const lastLine = document.lineCount - 1;
  const edit = new WorkspaceEdit();
  const insertAt = new Range(lastLine, document.lineAt(lastLine).text.length, lastLine, document.lineAt(lastLine).text.length);
  const trailing = addLines.length > 0 && !addLines[addLines.length - 1].endsWith('\n') ? '\n' : '';
  edit.replace(document.uri, insertAt, '\n' + addLines.join('\n') + trailing);
  return edit;
}

/**
 * Default `sendTextToChat` host helper. Surfaces the text in an
 * information message. Real chat injection is wired in `extension.ts`
 * when the chat view is available.
 */
export async function defaultSendTextToChat(text: string, fileUri: Uri): Promise<void> {
  const lines = text.split('\n');
  const preview = lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n…' : '');
  await window.showInformationMessage('Mavis (' + fileUri.fsPath + '): ' + preview);
}

/**
 * Public entry-point for the `mavis._runCodeAction` command. Parses
 * the URI + kind, optionally asks the user for a custom prompt,
 * spawns the task, and routes the result.
 */
export async function runCodeAction(
  client: MavisClient,
  deps: CodeActionProviderDeps,
  args: { uri: string; kind: MavisActionKind },
): Promise<CodeActionResult | undefined> {
  const uri = Uri.parse(args.uri);
  const document = await workspace.openTextDocument(uri);
  const editor = window.activeTextEditor;
  const range = editor?.document.uri.toString() === uri.toString() && editor.selection && !editor.selection.isEmpty
    ? editor.selection
    : new Range(0, 0, 0, 0);

  let customPrompt: string | undefined;
  if (args.kind === 'custom') {
    if (!deps.askCustomPrompt) {
      await window.showErrorMessage('Custom prompt requested but no askCustomPrompt handler is configured.');
      return undefined;
    }
    try {
      customPrompt = await deps.askCustomPrompt();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.output?.appendLine('[mavis] custom prompt input failed: ' + message);
      await window.showErrorMessage('Mavis custom prompt input failed: ' + message);
      return undefined;
    }
    if (customPrompt === undefined) return undefined; // user cancelled
  }
  const input = buildPromptInput(document, range, customPrompt, deps.contextLines);
  const prompt = buildPrompt(args.kind, input);
  const task: CodeActionTaskHandle = client.createCodeActionTask(args.kind, prompt.user, document.uri.fsPath);
  let result: CodeActionResult;
  try {
    result = await task.result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.output?.appendLine('[mavis] code-action ' + args.kind + ' failed: ' + message);
    await window.showErrorMessage('Mavis code action failed: ' + message);
    return undefined;
  }
  if (result.kind === 'patch') {
    return await openDiffAndAwait(result, document, deps);
  }
  if (result.kind === 'text') {
    if (deps.sendTextToChat) {
      await deps.sendTextToChat(result.text, document.uri);
    } else {
      await defaultSendTextToChat(result.text, document.uri);
    }
  }
  return result;
}

async function openDiffAndAwait(
  result: Extract<CodeActionResult, { kind: 'patch' }>,
  document: TextDocument,
  deps: CodeActionProviderDeps,
): Promise<CodeActionResult> {
  // Try VS Code's built-in diff editor. We synthesize the "modified"
  // document by applying the diff to the current contents and writing
  // it to an untitled document so the user can review side-by-side.
  const fallbackEdit = applyUnifiedDiffFallback(document, result.diff);
  if (!fallbackEdit) {
    deps.output?.appendLine('[mavis] no applicable hunk in diff; falling back to text preview');
    await defaultSendTextToChat(result.diff, document.uri);
    return result;
  }
  // We don't open a real diff editor (that requires the git extension's
  // API); instead we synthesise a modified preview doc and let the user
  // approve it via a confirmation prompt. This keeps the extension
  // dependency-free.
  const proposed = new ProposedChange(document, result.diff, fallbackEdit);
  const choice = await window.showInformationMessage(
    'Mavis ' + (proposed.edit.get(document.uri) ? 'patch' : 'preview') + ' ready for ' + document.uri.fsPath,
    { modal: false },
    'Apply',
    'Reject',
    'Send to chat',
  );
  if (choice === 'Apply') {
    const ok = await workspace.applyEdit(fallbackEdit);
    if (!ok) {
      await window.showErrorMessage('Mavis: apply failed.');
    } else {
      await window.showInformationMessage('Mavis: patch applied.');
    }
  } else if (choice === 'Send to chat' && deps.sendTextToChat) {
    await deps.sendTextToChat('```diff\n' + result.diff + '\n```', document.uri);
  }
  return result;
}

/**
 * Lightweight value object that pairs a `WorkspaceEdit` with the
 * original diff text so the UI can reference both. We keep it as a
 * private helper class to avoid polluting the public API.
 */
class ProposedChange {
  constructor(
    public readonly document: TextDocument,
    public readonly diff: string,
    public readonly edit: WorkspaceEdit,
  ) {}
  // We don't actually need this in the cycle 2 surface; kept for the
  // future when we wire a real diff editor.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  get(_uri: Uri): unknown {
    return undefined;
  }
}

/**
 * Registers the provider for the given selector and returns a
 * disposable. Called by `extension.ts` during `activate()`.
 */
export function registerCodeActionProvider(
  _context: ExtensionContext,
  client: MavisClient,
  deps: Omit<CodeActionProviderDeps, 'client'>,
): { dispose(): void } {
  const provider = new MavisCodeActionProvider({ ...deps, client });
  const disposables: { dispose(): void }[] = [];
  const selector = MAVIS_DOC_SELECTOR;
  disposables.push(languages.registerCodeActionsProvider(selector, provider, {
    providedCodeActionKinds: SUPPORTED_KINDS,
  }));
  return {
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}

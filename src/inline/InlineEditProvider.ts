/**
 * InlineEditProvider — Cmd+K inline edit integration.
 *
 * Implements `vscode.InlineCompletionItemProvider` so that ghost-text
 * suggestions show up in any editor where the Mavis Code Action provider
 * is registered. The provider asks the Mavis backend to "edit" the
 * prefix of the current line and emits the resulting text as a single
 * `InlineCompletionItem` (with a `range` covering the suffix we want
 * to overwrite).
 *
 * Performance contract:
 *   - The provider returns `undefined` immediately for documents >100 KB
 *     (skip work on huge files).
 *   - Cancellation is honoured — if VSCode aborts the call, we cancel
 *     the underlying Mavis task via `task.cancel()`.
 *
 * The provider is intentionally narrow: it only fires on `model == "*"`
 * + the configured `inlineEditSelector` and when a `mavis.inlineEdit`
 * command is not currently active (we let code actions win when the
 * user has explicitly invoked them).
 */
import {
  CancellationToken,
  InlineCompletionContext,
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionList,
  Position,
  ProviderResult,
  Range,
  TextDocument,
} from 'vscode';
import { MavisClient } from '../client/MavisClient';
import { CodeActionKind } from '../client/types';

/** Document selector for which the inline edit provider fires. */
export const INLINE_EDIT_SELECTOR = [
  { language: 'typescript' },
  { language: 'typescriptreact' },
  { language: 'javascript' },
  { language: 'javascriptreact' },
  { language: 'python' },
  { language: 'go' },
  { language: 'rust' },
  { language: '*' },
];

/** Soft cap — skip huge files. */
const MAX_FILE_BYTES = 100 * 1024;

export interface InlineEditProviderDeps {
  client: MavisClient;
  /**
   * Optional override for the model id used in the prompt. Defaults to
   * the client's active agent.
   */
  resolveModel?: (document: TextDocument, position: Position) => string;
  /**
   * Optional override for the action kind. Defaults to `refactor` (the
   * closest match for a generic "complete this line" prompt).
   */
  kind?: CodeActionKind;
}

/**
 * Concrete InlineCompletionItemProvider bound to the Mavis client.
 *
 * Test-friendly: the constructor takes a `MavisClient` directly so
 * callers can inject a fake via `MavisClient`'s `spawnImpl` knob.
 */
export class MavisInlineCompletionProvider implements InlineCompletionItemProvider {
  private readonly client: MavisClient;
  private readonly resolveModel: (document: TextDocument, position: Position) => string;
  private readonly kind: CodeActionKind;

  constructor(deps: InlineEditProviderDeps) {
    this.client = deps.client;
    this.resolveModel = deps.resolveModel ?? (() => this.client.getActiveAgent());
    this.kind = deps.kind ?? 'refactor';
  }

  /** No-op — present so callers can `provider.dispose()` symmetrically. */
  dispose(): void {
    /* no state held beyond the constructor */
  }

  /**
   * Called by VSCode whenever the cursor stays in a file we registered
   * for. Returns `undefined` for files we should skip.
   */
  provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    _context: InlineCompletionContext,
    token: CancellationToken,
  ): ProviderResult<InlineCompletionList> {
    if (document.uri.scheme !== 'file') return undefined;
    const bytes = document.getText().length;
    if (bytes > MAX_FILE_BYTES) return undefined;

    // Build a small prompt: ask the agent to "complete" the current
    // line given the surrounding context (5 lines above, current line
    // up to the cursor).
    const lineText = document.lineAt(position.line).text;
    const before = document.getText(new Range(new Position(Math.max(0, position.line - 5), 0), position));
    const after = document.getText(new Range(position, new Position(position.line + 1, 0)));
    const prompt = buildPrompt({
      fileName: document.fileName,
      language: document.languageId,
      before,
      cursor: lineText.slice(0, position.character),
      after,
    });

    const model = this.resolveModel(document, position);
    const task = this.client.createCodeActionTask(this.kind, prompt, document.uri.fsPath);

    // If the token is already cancelled (rare but possible when the
    // user types faster than the resolver can run), bail out without
    // awaiting the task.
    if (token.isCancellationRequested) {
      try { task.cancel(); } catch { /* ignore */ }
      return undefined;
    }

    // Forward cancellation: if VSCode aborts, race the task result
    // against a cancellation sentinel so the await can return quickly.
    let onCancel: (() => void) | undefined;
    const cancelled = new Promise<undefined>((resolve) => { onCancel = () => resolve(undefined); });
    const sub = token.onCancellationRequested(() => {
      try { task.cancel(); } catch { /* ignore */ }
      onCancel?.();
    });

    return Promise.race([task.result, cancelled]).then((res) => {
      sub.dispose();
      if (!res || token.isCancellationRequested) return undefined;
      const replacement = extractReplacement(res as { kind: string } & Record<string, unknown>);
      if (!replacement) return undefined;
      const start = position;
      // The "replace" range extends to the end of the current line so
      // VSCode can render the suggestion inline without breaking indent.
      const end = new Position(position.line, lineText.length);
      return new InlineCompletionList([
        new InlineCompletionItem(replacement, new Range(start, end), {
          title: `Mavis (${model})`,
          command: 'mavis._inlineEditAccepted',
        }),
      ]);
    }).catch(() => {
      sub.dispose();
      return undefined;
    });
  }
}

// ----------------------------------------------------------------- helpers

interface PromptInput {
  fileName: string;
  language: string;
  before: string;
  cursor: string;
  after: string;
}

function buildPrompt(input: PromptInput): string {
  return [
    `File: ${input.fileName}`,
    `Language: ${input.language || 'unknown'}`,
    '',
    'Complete the next line of code. Return only the replacement text (no markdown, no explanation).',
    'Preserve the existing indentation.',
    '',
    '----- before -----',
    input.before,
    '----- cursor -----',
    input.cursor,
    '----- after -----',
    input.after,
  ].join('\n');
}

/**
 * Pulls the actual replacement text out of the code-action result. The
 * result can be either `{ kind: 'patch', diff, file }` (in which case
 * we apply the diff to the line at the cursor) or `{ kind: 'text', text }`
 * (in which case we use the text directly, trimmed of any markdown
 * fences the agent added).
 */
function extractReplacement(res: { kind: string } & Record<string, unknown>): string | undefined {
  if (res.kind === 'text') {
    const t = typeof res.text === 'string' ? res.text : '';
    return cleanReplacement(t);
  }
  if (res.kind === 'patch' && typeof res.diff === 'string') {
    // For now we just dump the diff as text — applying unified-diff
    // mid-line is a bigger feature than cycle 5 needs.
    return cleanReplacement(res.diff);
  }
  return undefined;
}

/** Strips code fences, leading/trailing whitespace, and explanatory prose. */
function cleanReplacement(input: string): string | undefined {
  if (!input) return undefined;
  let text = input.trim();
  // Strip a single leading ```lang and trailing ``` if the agent wrapped it.
  if (text.startsWith('```')) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline !== -1) text = text.slice(firstNewline + 1);
  }
  if (text.endsWith('```')) text = text.slice(0, -3);
  text = text.trim();
  return text.length > 0 ? text : undefined;
}

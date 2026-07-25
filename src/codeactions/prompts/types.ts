/**
 * Shared types and helpers for the code-action prompt templates.
 *
 * Each template exports a `build(input)` function that returns a
 * `{system, user}` pair ready to be serialised and shipped to the
 * Mavis backend. Keeping the shape small + uniform means a single
 * tester can validate all 6 templates.
 */
export interface PromptInput {
  /** The exact text the user selected (or the symbol under the cursor). */
  selection: string;
  /** Path to the file the selection came from. */
  filePath: string;
  /** Language id reported by VSCode (typescript, python, …). */
  language: string;
  /**
   * Optional pre-computed surrounding context (e.g. 8 lines above +
   * 8 lines below). When omitted, the consumer should compute it
   * before calling `build()`.
   */
  surroundingContext?: string;
  /**
   * Optional user-provided text. Used by the "custom" prompt template
   * to override the canned user prompt.
   */
  customPrompt?: string;
}

export interface PromptOutput {
  system: string;
  user: string;
}

/**
 * Wraps a selection snippet for the prompt. Multi-line content gets
 * fenced with the file's language id when known. This keeps the
 * embedded snippet compact but easy for the model to re-parse.
 */
export function fence(input: PromptInput): string {
  const lang = (input.language || 'text').toLowerCase();
  const body = input.selection || '// (no selection)';
  return '```' + lang + '\n' + body + '\n```';
}

/**
 * Returns the surrounding-context block as a fenced snippet. If the
 * caller didn't pass one, we render a one-line hint instead of a huge
 * dump — keeps the prompt short for the common case where the user
 * picked a function and the test can assert on the file path only.
 */
export function contextBlock(input: PromptInput): string {
  if (!input.surroundingContext) return `File: ${input.filePath}`;
  return 'Surrounding context from `' + input.filePath + '`:\n```' +
    (input.language || 'text').toLowerCase() + '\n' +
    input.surroundingContext + '\n```';
}

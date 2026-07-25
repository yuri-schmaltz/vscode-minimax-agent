/**
 * "Find bugs" prompt template. Asks for a list of potential bugs.
 * Expected response is a plain-text report (no patch).
 */
import { contextBlock, fence, PromptInput, PromptOutput } from './types';

export const KIND = 'bugs' as const;

export function build(input: PromptInput): PromptOutput {
  return {
    system:
      'You are a senior engineer doing a code review. ' +
      'List potential bugs, edge cases, and reliability issues. ' +
      'Return plain text — do not produce a diff.',
    user: [
      'Find potential bugs in the following code from `' + input.filePath + '`.',
      '',
      contextBlock(input),
      '',
      'Selection:',
      fence(input),
      '',
      'Return a numbered list. Each item should cite the line and explain the risk.',
    ].join('\n'),
  };
}

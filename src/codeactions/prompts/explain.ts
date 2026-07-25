/**
 * "Explain this" prompt template. Asks the model to describe the
 * selected snippet in plain language.
 */
import { contextBlock, fence, PromptInput, PromptOutput } from './types';

export const KIND = 'explain' as const;

export function build(input: PromptInput): PromptOutput {
  return {
    system: 'You are a senior code reviewer. Explain the supplied snippet clearly and concisely.',
    user: [
      'Explain the following code from `' + input.filePath + '`.',
      '',
      contextBlock(input),
      '',
      'Selection:',
      fence(input),
    ].join('\n'),
  };
}

/**
 * "Refactor" prompt template. Asks for a refactor that preserves
 * observable behaviour. The expected response is a unified diff, but
 * the model is told to keep the response format explicit so the TS
 * client can decide whether to treat it as a patch or text.
 */
import { contextBlock, fence, PromptInput, PromptOutput } from './types';

export const KIND = 'refactor' as const;

export function build(input: PromptInput): PromptOutput {
  return {
    system:
      'You are an expert refactoring assistant. ' +
      'Return a unified diff against the original file. ' +
      'Do not change observable behaviour.',
    user: [
      'Refactor the following code from `' + input.filePath + '`.',
      '',
      contextBlock(input),
      '',
      'Selection:',
      fence(input),
      '',
      'Return only the unified diff. Keep the diff small and focused.',
    ].join('\n'),
  };
}

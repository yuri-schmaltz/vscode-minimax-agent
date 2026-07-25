/**
 * "Add docstring" prompt template. Asks for a doc comment that
 * documents the selected declaration. The expected response is a
 * unified diff that replaces the original declaration with a
 * doc-commented version.
 */
import { contextBlock, fence, PromptInput, PromptOutput } from './types';

export const KIND = 'docstring' as const;

export function build(input: PromptInput): PromptOutput {
  return {
    system:
      'You are a documentation assistant. ' +
      'Return a unified diff that adds a doc comment (JSDoc / docstring ' +
      'as idiomatic to the file language) to the supplied declaration. ' +
      'Do not change behaviour.',
    user: [
      'Add a doc comment to the following declaration from `' + input.filePath + '`.',
      '',
      contextBlock(input),
      '',
      'Selection:',
      fence(input),
      '',
      'Return only the unified diff.',
    ].join('\n'),
  };
}

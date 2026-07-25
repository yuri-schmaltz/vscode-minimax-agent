/**
 * "Generate tests" prompt template. Asks for unit tests that cover the
 * selected snippet. The expected response is a unified diff that adds
 * a new test file or extends an existing one.
 */
import { contextBlock, fence, PromptInput, PromptOutput } from './types';

export const KIND = 'tests' as const;

export function build(input: PromptInput): PromptOutput {
  return {
    system:
      'You are a test-generation assistant. ' +
      'Return a unified diff adding tests for the supplied code. ' +
      'Use the testing framework idiomatic to the file language.',
    user: [
      'Generate tests for the following code from `' + input.filePath + '`.',
      '',
      contextBlock(input),
      '',
      'Selection:',
      fence(input),
      '',
      'Return only the unified diff. New tests should compile and pass.',
    ].join('\n'),
  };
}

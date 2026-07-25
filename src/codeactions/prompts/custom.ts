/**
 * "Custom prompt" template. Lets the user type a free-form instruction
 * that is sent verbatim as the `user` half. The `system` half is a
 * short hand-off so the model knows it is being driven by Mavis.
 */
import { contextBlock, fence, PromptInput, PromptOutput } from './types';

export const KIND = 'custom' as const;

export function build(input: PromptInput): PromptOutput {
  const prompt = (input.customPrompt ?? '').trim() || '(no prompt provided)';
  return {
    system: 'You are Mavis, the Mavis coding assistant. Follow the user request faithfully.',
    user: [
      'User request: ' + prompt,
      '',
      'Apply it to the following snippet from `' + input.filePath + '`.',
      '',
      contextBlock(input),
      '',
      'Selection:',
      fence(input),
    ].join('\n'),
  };
}

/**
 * Prompt-template unit tests. Each template must include the selected
 * snippet, the file path, and the language id in the final prompt.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as explain from '../../src/codeactions/prompts/explain';
import * as refactor from '../../src/codeactions/prompts/refactor';
import * as tests from '../../src/codeactions/prompts/tests';
import * as docstring from '../../src/codeactions/prompts/docstring';
import * as bugs from '../../src/codeactions/prompts/bugs';
import * as custom from '../../src/codeactions/prompts/custom';
import { PromptInput } from '../../src/codeactions/prompts/types';

const BASE: PromptInput = {
  selection: 'const greeting = "hi";\nconsole.log(greeting);',
  filePath: '/workspace/proj/src/hello.ts',
  language: 'typescript',
};

test('explain prompt: includes the snippet, the file path, and the language', () => {
  const { system, user } = explain.build(BASE);
  assert.match(system, /code reviewer/i);
  assert.match(user, /\/workspace\/proj\/src\/hello\.ts/);
  assert.match(user, /typescript/);
  assert.match(user, /greeting/);
});

test('refactor prompt: includes the file path and asks for a unified diff', () => {
  const { system: _system, user } = refactor.build(BASE);
  assert.match(_system, /unified diff/i);
  assert.match(user, /Refactor/);
  assert.match(user, /\/workspace\/proj\/src\/hello\.ts/);
  assert.match(user, /typescript/);
});

test('tests prompt: includes the file path and the selection', () => {
  const { system, user } = tests.build(BASE);
  assert.match(system, /test/i);
  assert.match(user, /Generate tests/);
  assert.match(user, /\/workspace\/proj\/src\/hello\.ts/);
  assert.match(user, /greeting/);
});

test('docstring prompt: includes the file path and a doc-comment hint', () => {
  const { system: _system, user } = docstring.build(BASE);
  assert.match(_system, /docstring|doc comment/i);
  assert.match(user, /\/workspace\/proj\/src\/hello\.ts/);
  assert.match(user, /typescript/);
});

test('bugs prompt: includes the file path and asks for a numbered list', () => {
  const { system, user } = bugs.build(BASE);
  assert.match(system, /bug/i);
  assert.match(user, /Find potential bugs/);
  assert.match(user, /\/workspace\/proj\/src\/hello\.ts/);
});

test('custom prompt: includes the user-supplied text verbatim', () => {
  const { system: _system, user } = custom.build({ ...BASE, customPrompt: 'Translate to Python' });
  assert.match(user, /Translate to Python/);
  assert.match(user, /\/workspace\/proj\/src\/hello\.ts/);
  assert.match(user, /typescript/);
});

test('custom prompt: tolerates missing customPrompt by emitting a placeholder', () => {
  const { system: _system, user } = custom.build(BASE);
  assert.match(user, /\(no prompt provided\)/);
});

test('all prompt templates: include the language id as a fence hint', () => {
  const templates = [explain, refactor, tests, docstring, bugs, custom];
  for (const t of templates) {
    const { user } = t.build(BASE);
    assert.match(user, /```typescript/, `${t.KIND} did not fence with the language id`);
  }
});

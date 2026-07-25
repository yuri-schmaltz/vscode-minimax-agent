/**
 * E2E scaffold smoke test.
 *
 * Confirms that the e2e scaffold module is importable and exposes the
 * expected shape. It does NOT spawn a real VSCode (CI is sandboxed).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { __scaffold } from './extension.test';

test('e2e scaffold: module is importable', () => {
  assert.ok(__scaffold, 'scaffold object must be defined');
  assert.equal(typeof __scaffold.repoRoot, 'string');
  assert.equal(__scaffold.repoRoot, path.resolve(__dirname, '..', '..'));
  assert.equal(typeof __scaffold.vsixPath, 'string');
  assert.match(__scaffold.vsixPath, /vscode-agent-.*\.vsix$/);
});

test('e2e scaffold: hasTestElectron is a boolean', () => {
  assert.equal(typeof __scaffold.hasTestElectron, 'boolean');
});

/**
 * Registers the vscode mock loader. Imported by the test runner via
 * `--import test/helpers/registerVscodeMock.cjs`.
 *
 * The runner uses `node --test --import tsx` in CJS mode, so we patch
 * `Module._resolveFilename` to redirect `import 'vscode'` to the in-tree
 * mock at `test/__mocks__/vscode.ts`. This keeps the production source
 * code unchanged (it imports from `'vscode'` as normal) while the test
 * process never tries to resolve the real package.
 *
 * The mock file is `.ts`; tsx transpiles it on the fly during test
 * execution so the same loader works for both unit and integration tests.
 */
'use strict';
const path = require('node:path');
const Module = require('node:module');

const MOCK_TS = path.resolve(__dirname, '..', '__mocks__', 'vscode.ts');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return MOCK_TS;
  return origResolve.call(this, request, parent, ...rest);
};

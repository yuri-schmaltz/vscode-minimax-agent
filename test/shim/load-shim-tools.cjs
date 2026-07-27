// Helper: load the shim's tool functions in-process by reading the
// shim source, stripping the shebang and the bottom `main();` call,
// and exposing the named functions via `module.exports`. This lets
// the test process call the same code the production shim runs,
// without the brace-counting brittleness of regex extraction.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHIM_PATH = path.resolve(__dirname, '..', '..', 'resources', 'mavis-cli', 'mavis.cjs');

function loadShimTools() {
  let src = fs.readFileSync(SHIM_PATH, 'utf8');
  // Strip shebang.
  src = src.replace(/^#!.*\n/, '');
  // Strip the bottom `main();` call (or any `main()` invocation).
  // We trim trailing whitespace then ensure the file ends without
  // calling main.
  src = src.replace(/\nmain\(\);\s*$/, '\n');
  // Wrap so we can attach to module.exports.
  const wrapped = `${src}\nmodule.exports = { toolReadFile, toolGlob, toolGrep, toolListDirectory, toolWriteFile, toolEditFile, bashIsAllowed, toolBash, toolCwd, executeTool, lineDiff, loadAgentMd };\n`;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', 'process', 'console', '__dirname', '__filename', wrapped);
  fn(mod, mod.exports, require, process, console, __dirname, __filename);
  return mod.exports;
}

module.exports = { loadShimTools };

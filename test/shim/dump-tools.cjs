// Usage: node /tmp/dump-tools.cjs <name> [<args-json>]
// Spawns the shim's tools via a fresh Node process that REQUIRES
// the shim's source, exports the named function, and prints the
// result as JSON to stdout. stderr carries any exception.
const fs = require('fs');
const path = require('path');
const shimSrc = fs.readFileSync(path.resolve(__dirname, '..', 'resources', 'mavis-cli', 'mavis.cjs'), 'utf8');
// Strip the shebang and the main() call. The shim defines a bunch
// of top-level functions; we expose them via a temporary module.
const mod = { exports: {} };
const wrapped = `(function(exports, require, module, process, console){${shimSrc}; module.exports = { toolReadFile, toolGlob, toolGrep, toolListDirectory, toolWriteFile, toolEditFile, bashIsAllowed, toolBash, toolCwd, executeTool, lineDiff, loadAgentMd };})`;
const fn = eval(wrapped);
fn(mod.exports, require, mod, process, console);
const tool = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
if (!mod.exports[tool]) { process.stderr.write('unknown tool: ' + tool + '\n'); process.exit(2); }
try {
  const result = mod.exports[tool](args);
  process.stdout.write(JSON.stringify(result));
} catch (err) {
  process.stderr.write(String(err && err.message || err));
  process.exit(1);
}

// Tests for the shim's read-only tools (B.1).
//
// Strategy: the shim is a CJS file with top-level `main()` that exits
// 0 on no args. We extract the tool functions via a regex on the
// source (just like archonUrl.test.cjs does). For path-traversal
// tests we use a real on-disk fixture workspace under /tmp so
// realpathSync has something to canonicalize.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(REPO_ROOT, 'resources', 'mavis-cli', 'mavis.cjs');

// Extract a set of top-level functions from the shim source. We
// extract them all together so that helper functions (like
// resolveToolPath, walk, globToRegex) are available in the
// generated function scope.
function extractFns(...names) {
  const src = fs.readFileSync(SHIM, 'utf8');
  const blocks = [];
  for (const name of names) {
    const re = new RegExp(`function ${name}\\s*\\(`);
    const m = re.exec(src);
    if (!m) throw new Error(`function ${name} not found in shim`);
    const start = m.index;
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) { blocks.push(src.slice(start, i + 1)); break; }
      }
    }
  }
  return blocks.join('\n');
}

// Load all the tool-related functions into a single scope. Return
// an object with the entry points the tests need.
function loadToolScope() {
  const body = extractFns(
    'resolveToolPath',
    'globToRegex',
    'walk',
    'toolReadFile',
    'toolGlob',
    'toolGrep',
    'toolListDirectory',
    'executeTool',
    'loadAgentMd',
  );
  const fn = new Function('process', 'require', 'console', 'fs', 'path', body + '\nreturn { toolReadFile, toolGlob, toolGrep, toolListDirectory, executeTool, loadAgentMd };');
  return fn(process, require, console, fs, path);
}

function makeSandbox(extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-shim-'));
  for (const [name, content] of Object.entries(extraFiles)) {
    const abs = path.join(dir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  process.env.MAVIS_WORKSPACE = dir;
  return dir;
}

test('read_file: returns file content with line metadata', () => {
  const dir = makeSandbox({ 'hello.txt': 'a\nb\nc\nd' });
  try {
    const scope = loadToolScope();
    const result = scope.toolReadFile({ path: 'hello.txt' });
    assert.equal(result.path, 'hello.txt');
    assert.equal(result.totalLines, 4);
    assert.equal(result.content, 'a\nb\nc\nd');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('read_file: rejects path outside workspace', () => {
  const dir = makeSandbox();
  try {
    const scope = loadToolScope();
    assert.throws(
      () => scope.toolReadFile({ path: '../../etc/passwd' }),
      /escapes workspace/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('glob: matches ** patterns', () => {
  const dir = makeSandbox({
    'a.ts': '',
    'b.ts': '',
    'src/c.ts': '',
    'src/nested/d.ts': '',
  });
  try {
    const scope = loadToolScope();
    const result = scope.toolGlob({ pattern: '**/*.ts' });
    assert.equal(result.count, 4);
    assert.ok(result.paths.includes('a.ts'));
    assert.ok(result.paths.includes('src/c.ts'));
    assert.ok(result.paths.includes(path.join('src', 'nested', 'd.ts')));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('glob: skips node_modules and .git', () => {
  const dir = makeSandbox({
    'a.ts': '',
    'node_modules/lib/index.ts': '',
    '.git/config': '',
  });
  try {
    const scope = loadToolScope();
    const result = scope.toolGlob({ pattern: '**/*.ts' });
    assert.deepEqual(result.paths, ['a.ts']);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('grep: returns line-numbered matches', () => {
  const dir = makeSandbox({
    'a.ts': 'const x = 1;\nconst y = 2;\nconsole.log(x);',
    'b.ts': 'const z = 3;',
  });
  try {
    const scope = loadToolScope();
    const result = scope.toolGrep({ pattern: 'const ' });
    assert.equal(result.count, 3);
    assert.deepEqual(result.matches.map((m) => m.path), ['a.ts', 'a.ts', 'b.ts']);
    assert.equal(result.matches[0].line, 1);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('list_directory: returns non-recursive entries', () => {
  const dir = makeSandbox({
    'a.txt': '',
    'b/c.txt': '',
  });
  try {
    const scope = loadToolScope();
    const result = scope.toolListDirectory({ path: '.' });
    const names = result.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['a.txt', 'b']);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('executeTool: rejects unknown tools (B.1 whitelist)', () => {
  const scope = loadToolScope();
  assert.throws(() => scope.executeTool('write_file', {}), /unknown tool/);
  assert.throws(() => scope.executeTool('bash', {}), /unknown tool/);
});

test('agent.md: loaded into system prompt when present', () => {
  const dir = makeSandbox({ 'agent.md': 'Project uses 2-space indent.' });
  try {
    const scope = loadToolScope();
    const content = scope.loadAgentMd();
    assert.ok(content);
    assert.ok(content.includes('2-space indent'));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('agent.md: returns null when absent', () => {
  const dir = makeSandbox();
  try {
    const scope = loadToolScope();
    const content = scope.loadAgentMd();
    assert.equal(content, null);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

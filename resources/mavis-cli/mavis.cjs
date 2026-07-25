#!/usr/bin/env node
/* eslint-disable */
/**
 * mavis.cjs — MiniMax Agent CLI shim.
 *
 * This is a *mock* implementation that emits NDJSON that matches the
 * contract the VSCode extension expects. When the official `mavis` binary
 * is published, this file is swapped out without any other change needed.
 *
 * Mock mode is enabled by:
 *   - the `MAVIS_MOCK` env var being truthy, or
 *   - no `MAVIS_ARCHON_URL` being set in env.
 *
 * Subcommands:
 *   mavis --version
 *   mavis --help
 *   mavis agent list               (NDJSON of Agent objects, one per line)
 *   mavis agent switch <name>      (mock) emits contextChanged + done
 *   mavis session list             (NDJSON of Session objects, one per line)
 *   mavis session new [--agent <name>]
 *                                  (mock) emits {type:"session", ...} + done
 *   mavis session stream --session-id <id> [--dry-run]
 *                                  reads prompts from stdin (one JSON per
 *                                  line: {type:"prompt", text:"..."}) and
 *                                  emits NDJSON events on stdout.
 *   mavis session switch <id>      (mock) emits contextChanged + done
 *   mavis code-action run --kind <k> --file <path> --prompt <text>
 *                                  (mock) emits 1-3 {type:"patch"} or
 *                                  {type:"text"} events + done
 *   mavis oauth code               (mock) emits {user_code, verification_uri,
 *                                  device_code, interval, expires_in}
 *   mavis oauth token --device-code <dc>  (mock) emits
 *                                  {access_token, refresh_token, expires_in}
 *
 * Each NDJSON line is a self-contained JSON object; consumers MUST ignore
 * unknown event types so the protocol can grow.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// --- arg parsing -----------------------------------------------------------

const argv = process.argv.slice(2);

function arg(name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function flag(name) {
  return argv.includes(name);
}

const VERSION = (() => {
  // Try to read the bundled shim's own package.json; fall back to env or '0.0.0'.
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'),
    );
    if (pkg.version) return pkg.version;
  } catch {
    /* ignore */
  }
  return process.env.MAVIS_CLI_VERSION || '0.1.0';
})();

const MOCK = process.env.MAVIS_MOCK === '1' || !process.env.MAVIS_ARCHON_URL;

function logErr(msg) {
  process.stderr.write(`[mavis] ${msg}\n`);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// --- random helpers --------------------------------------------------------

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowTs() {
  return Date.now();
}

// --- main dispatch ---------------------------------------------------------

async function main() {
  // Version flag works even without a subcommand.
  if (flag('--version') || flag('-v')) {
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (flag('--help') || flag('-h') || argv.length === 0) {
    process.stdout.write(
      [
        `mavis ${VERSION} (shim, mock=${MOCK ? 'on' : 'off'})`,
        '',
        'Usage:',
        '  mavis --version',
        '  mavis agent list',
        '  mavis agent switch <name>',
        '  mavis session list',
        '  mavis session new [--agent <name>]',
        '  mavis session stream --session-id <id> [--dry-run]',
        '  mavis session switch <id>',
        '  mavis code-action run --kind <k> --file <path> --prompt <text>',
        '  mavis oauth code',
        '  mavis oauth token --device-code <dc>',
        '',
        'Reads prompts as NDJSON from stdin; writes NDJSON to stdout.',
        'Set MAVIS_MOCK=1 to force mock mode.',
        'Set MAVIS_ARCHON_URL to talk to a real archon-server (not implemented in the shim).',
        '',
      ].join('\n'),
    );
    return;
  }

  const sub = argv[0];
  const cmd = argv[1];

  try {
    if (sub === 'agent' && cmd === 'list') {
      return cmdAgentList();
    }
    if (sub === 'agent' && cmd === 'switch') {
      return cmdAgentSwitch();
    }
    if (sub === 'session' && cmd === 'list') {
      return cmdSessionList();
    }
    if (sub === 'session' && cmd === 'new') {
      return cmdSessionNew();
    }
    if (sub === 'session' && cmd === 'stream') {
      return cmdSessionStream();
    }
    if (sub === 'session' && cmd === 'switch') {
      return cmdSessionSwitch();
    }
    if (sub === 'code-action' && cmd === 'run') {
      return cmdCodeActionRun();
    }
    if (sub === 'oauth' && cmd === 'code') {
      return cmdOauthCode();
    }
    if (sub === 'oauth' && cmd === 'token') {
      return cmdOauthToken();
    }
    logErr(`unknown command: ${argv.join(' ')}`);
    process.exitCode = 2;
  } catch (err) {
    logErr((err && err.message) || String(err));
    process.exit(1);
  }
}

// --- subcommands -----------------------------------------------------------

function cmdAgentList() {
  // Default agent is always first; mocks are deterministic-friendly.
  const agents = [
    {
      id: 'mavis',
      name: 'Mavis',
      description: 'Default MiniMax agent (M3).',
      model: 'MiniMax-M3',
      isDefault: true,
    },
    {
      id: 'mavis-coder',
      name: 'Mavis Coder',
      description: 'Specialised for code refactor and generation tasks.',
      model: 'MiniMax-M3',
      isDefault: false,
    },
  ];
  for (const a of agents) emit(a);
  emit({ type: 'done', count: agents.length });
}

function cmdSessionList() {
  // Mock: zero or one session depending on env. Keeps tests deterministic
  // when MAVIS_MOCK_SESSIONS is set.
  const want = parseInt(process.env.MAVIS_MOCK_SESSIONS || '0', 10);
  const sessions = [];
  for (let i = 0; i < want; i++) {
    sessions.push({
      id: randomId('sess'),
      agent: 'mavis',
      title: `Mock session #${i + 1}`,
      createdAt: nowTs() - i * 1000,
    });
  }
  for (const s of sessions) emit(s);
  emit({ type: 'done', count: sessions.length });
}

function readStdinLines() {
  return new Promise((resolve, reject) => {
    const lines = [];
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        lines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    process.stdin.on('end', () => {
      if (buf.length) lines.push(buf);
      resolve(lines);
    });
    process.stdin.on('error', reject);
  });
}

async function cmdSessionStream() {
  const sessionId = arg('--session-id') || 'sess_unknown';
  const dryRun = flag('--dry-run');

  if (dryRun) {
    emit({ type: 'ready', sessionId });
    emit({ type: 'done' });
    return;
  }

  // Send a "ready" beacon so the consumer can wire UI before the first token.
  emit({ type: 'ready', sessionId, mock: MOCK, ts: nowTs() });

  const lines = await readStdinLines();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let prompt;
    try {
      prompt = JSON.parse(line);
    } catch {
      // Be liberal: treat raw lines as plain text prompts.
      prompt = { type: 'prompt', text: line };
    }
    if (prompt.type && prompt.type !== 'prompt') continue;
    const text = String(prompt.text || '');

    // Simulate a streaming response: emit one chunk then a "done" per prompt.
    const reply = `ok (mock: ${text.slice(0, 60)})`;
    emit({
      type: 'message',
      role: 'assistant',
      content: reply,
      sessionId,
      ts: nowTs(),
    });
    await sleep(rand(50, 200));
    emit({ type: 'message', role: 'assistant', content: ' ✔', sessionId, ts: nowTs() });
  }

  emit({ type: 'done', sessionId });
}

function cmdSessionNew() {
  const agent = arg('--agent') || 'mavis';
  const id = randomId('sess');
  const title = `Mock chat #${(nowTs() % 1000).toString().padStart(3, '0')}`;
  emit({ type: 'session', id, agent, title, createdAt: nowTs() });
  emit({ type: 'done', count: 1 });
}

function cmdSessionSwitch() {
  const id = argv[2];
  if (!id) {
    logErr('session switch requires a session id');
    process.exit(2);
  }
  emit({ type: 'contextChanged', sessionId: id, agent: 'mavis' });
  emit({ type: 'done' });
}

function cmdAgentSwitch() {
  const name = argv[2];
  if (!name) {
    logErr('agent switch requires an agent name');
    process.exit(2);
  }
  // Agent switch also starts a fresh session under the new agent.
  const newId = randomId('sess');
  emit({ type: 'contextChanged', sessionId: newId, agent: name });
  emit({ type: 'session', id: newId, agent: name, title: 'Mock chat', createdAt: nowTs() });
  emit({ type: 'done', count: 1 });
}

function cmdCodeActionRun() {
  const kind = arg('--kind');
  const file = arg('--file');
  const prompt = arg('--prompt') || '';
  if (!kind || !file) {
    logErr('code-action run requires --kind and --file');
    process.exit(2);
  }
  if (kind === 'refactor' || kind === 'tests' || kind === 'docstring') {
    // Emit a mock unified diff that adds a small comment at the bottom
    // of the file. The shim never actually reads `file`; the TS layer
    // applies the diff to the document.
    const diff = [
      '--- a/' + file,
      '+++ b/' + file,
      '@@ -1,1 +1,1 @@',
      ' // existing content preserved by mock',
      '+// ' + kind + ' by Mavis (mock, prompt: ' + truncate(prompt, 60) + ')',
      '',
    ].join('\n');
    emit({ type: 'patch', file, diff });
  } else if (kind === 'explain' || kind === 'bugs') {
    const text =
      kind === 'explain'
        ? 'Mock explanation: this code reads from `' + basename(file) + '` and applies a transformation. (Prompt: ' + truncate(prompt, 60) + ')'
        : 'Mock bug scan: no critical issues found in `' + basename(file) + '`. (Prompt: ' + truncate(prompt, 60) + ')';
    emit({ type: 'text', text });
  } else if (kind === 'custom') {
    // Custom prompts can be either patch or text; default to text.
    emit({ type: 'text', text: 'Mock custom response for `' + basename(file) + '`: ' + truncate(prompt, 120) });
  } else {
    logErr('unknown code-action kind: ' + kind);
    process.exit(2);
  }
  emit({ type: 'done' });
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function basename(p) {
  if (!p) return '';
  const m = p.replace(/\\/g, '/').split('/');
  return m[m.length - 1] || p;
}

function cmdOauthCode() {
  const device_code = randomId('dev');
  const user_code = `${rand(100, 999)}-${rand(1000, 9999)}`;
  emit({
    type: 'oauth-code',
    user_code,
    verification_uri: 'https://example.invalid/mavis/activate',
    device_code,
    interval: 5,
    expires_in: 600,
  });
  emit({ type: 'done' });
}

function cmdOauthToken() {
  const deviceCode = arg('--device-code');
  if (!deviceCode) {
    logErr('--device-code required');
    process.exit(2);
  }
  emit({
    type: 'oauth-token',
    access_token: 'mock_access_' + Math.random().toString(36).slice(2),
    refresh_token: 'mock_refresh_' + Math.random().toString(36).slice(2),
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'group_id profile model.completion',
  });
  emit({ type: 'done' });
}

main();

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
 *   mavis drive list [--category <cat>]   (mock) emits DriveItem rows
 *                                  + done. Items are distributed across
 *                                  7 categories (documents, excel, ppt,
 *                                  images, videos, audio, other) so
 *                                  tests can assert on category counts.
 *   mavis drive get <id>           (mock) emits {type:"file", id, name,
 *                                  category, sizeBytes, mimeType,
 *                                  content: "<base64 or path>", ...}
 *                                  + done.
 *   mavis drive delete <id>        (mock) emits {type:"deleted", id}
 *                                  + done.
 *   mavis cron list                (mock) emits CronSummary rows + done
 *                                  (mix of enabled / disabled + a funny
 *                                  "Morning standup summary" entry).
 *   mavis cron create --name <n> --schedule <s> --prompt <p> --agent <a>
 *                                  [--disabled]    (mock) emits
 *                                  {type:"cron", id:"cron_<rand>",
 *                                  name, schedule, prompt, agent,
 *                                  enabled, nextRunAt} + done.
 *   mavis cron delete <id>         (mock) emits {type:"deleted", id} + done.
 *   mavis cron enable <id>         (mock) emits {type:"cron", id, enabled:true} + done.
 *   mavis cron disable <id>        (mock) emits {type:"cron", id, enabled:false} + done.
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

// --- HTTP helper (Node 18+ has global fetch) ----------------------------

function archonUrl(path) {
  const base = (process.env.MAVIS_ARCHON_URL || '').replace(/\/+$/, '');
  const prefix = (process.env.MAVIS_API_BASE || '/v1').replace(/\/+$/, '');
  // If the caller already provided a full path starting with '/', just
  // append it. Otherwise prefix with MAVIS_API_BASE.
  const p = path.startsWith('/') ? path : prefix + (path.startsWith('/') ? '' : '/') + path;
  return base + p;
}

async function archonFetch(path, init) {
  const apiKey = process.env.MAVIS_API_KEY;
  if (!apiKey) {
    throw new Error('MAVIS_API_KEY is not set; run "Mavis: Set API key" to authenticate.');
  }
  const url = archonUrl(path);
  const headers = Object.assign(
    { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    (init && init.headers) || {},
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await globalThis.fetch(url, Object.assign({}, init, { headers, signal: ctrl.signal }));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`archon ${path} -> ${res.status}: ${body.slice(0, 200)}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

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
        '  mavis drive list [--category <cat>]',
        '  mavis drive get <id>',
        '  mavis drive delete <id>',
        '  mavis cron list',
        '  mavis cron create --name <n> --schedule <s> --prompt <p> --agent <a> [--disabled]',
        '  mavis cron delete <id>',
        '  mavis cron enable <id>',
        '  mavis cron disable <id>',
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
    if (sub === 'drive' && cmd === 'list') {
      return cmdDriveList();
    }
    if (sub === 'drive' && cmd === 'get') {
      return cmdDriveGet();
    }
    if (sub === 'drive' && cmd === 'delete') {
      return cmdDriveDelete();
    }
    if (sub === 'cron' && cmd === 'list') {
      return cmdCronList();
    }
    if (sub === 'cron' && cmd === 'create') {
      return cmdCronCreate();
    }
    if (sub === 'cron' && cmd === 'delete') {
      return cmdCronDelete();
    }
    if (sub === 'cron' && cmd === 'enable') {
      return cmdCronEnable();
    }
    if (sub === 'cron' && cmd === 'disable') {
      return cmdCronDisable();
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
  if (MOCK) {
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
    return;
  }
  // Real path: list the models the user's API key can see. We surface
  // MiniMax-M3 (the flagship) plus a couple of well-known siblings when
  // they are advertised by `/models`. We do NOT block on this endpoint;
  // if it fails we just emit the default agent so the UI stays alive.
  (async () => {
    let advertised = [];
    try {
      const res = await archonFetch('/models', { method: 'GET' });
      const json = await res.json();
      if (json && Array.isArray(json.data)) {
        advertised = json.data.map((m) => m && m.id).filter((id) => typeof id === 'string');
      }
    } catch {
      // /models is best-effort.
    }
    const model = process.env.MAVIS_MODEL || 'MiniMax-M3';
    const agents = [
      { id: 'mavis', name: 'Mavis', description: 'Default MiniMax agent (M3).', model, isDefault: true },
    ];
    for (const a of agents) emit(a);
    for (const id of advertised) {
      if (id === model) continue;
      agents.push({ id, name: id, description: `MiniMax model ${id}`, model: id, isDefault: false });
      emit({ id, name: id, description: `MiniMax model ${id}`, model: id, isDefault: false });
    }
    emit({ type: 'done', count: agents.length });
  })();
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

    if (MOCK) {
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
    } else {
      // Real path: OpenAI-compatible /chat/completions with stream=true.
      const model = process.env.MAVIS_MODEL || 'MiniMax-M3';
      let res;
      try {
        res = await archonFetch('/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: 'user', content: text }],
          }),
        });
      } catch (err) {
        const raw = (err && err.message) || String(err);
        // Detect the specific MiniMax "insufficient balance" 402
        // and surface a friendlier hint. Other errors pass through
        // as-is.
        const m = /->\s*(\d{3})\s*:\s*(\{[\s\S]*\})/.exec(raw);
        if (m && m[1] === '402' && /insufficient_balance_error/.test(m[2])) {
          emit({
            type: 'error',
            message: 'Conta MiniMax sem saldo. Adicione créditos em platform.minimax.io/user-center/payment/token-plan para usar o chat.',
            sessionId,
            ts: nowTs(),
          });
        } else {
          emit({ type: 'error', message: raw, sessionId, ts: nowTs() });
        }
        continue;
      }
      if (!res.body) {
        emit({ type: 'error', message: 'archon /chat/completions returned no body', sessionId, ts: nowTs() });
        continue;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf8');
      let buffer = '';
      let messageCount = 0;
      let usage = null;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const rawLine = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!rawLine) continue;
            // SSE format: lines starting with "data:" carry the JSON.
            // Stop sentinel: "data: [DONE]".
            if (!rawLine.startsWith('data:')) continue;
            const payload = rawLine.slice(5).trim();
            if (payload === '[DONE]') {
              buffer = '';
              break;
            }
            try {
              const json = JSON.parse(payload);
              const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
              const delta = choice && choice.delta ? choice.delta : {};
              // OpenAI-compat: most servers use `content`. MiniMax M3
              // sometimes streams reasoning via `reasoning_content`
              // when thinking is enabled — surface it too so the user
              // sees the model's thought process.
              const content = typeof delta.content === 'string' && delta.content.length > 0
                ? delta.content
                : (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '');
              if (content) {
                messageCount += 1;
                emit({ type: 'message', role: 'assistant', content, sessionId, ts: nowTs() });
              }
              if (json.usage && typeof json.usage === 'object') {
                usage = json.usage;
              }
            } catch {
              // Ignore malformed SSE chunks; upstream may inject comments.
            }
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
      if (messageCount === 0) {
        // The server returned 200 but no content streamed. Two likely
        // causes: (a) the model finished a refusal that didn't carry
        // any text, or (b) the response is non-streaming JSON. Try to
        // surface something so the user isn't staring at a silent chat.
        let hint = 'archon returned 200 with no streamed content';
        try {
          const tail = await res.clone().text();
          if (tail && tail.length > 0) {
            const sample = tail.slice(0, 200);
            hint = `archon returned 200 with no streamed content. Body sample: ${sample}`;
          }
        } catch {
          /* ignore */
        }
        emit({ type: 'error', message: hint, sessionId, ts: nowTs() });
      }
      if (usage) {
        emit({ type: 'usage', usage, sessionId, ts: nowTs() });
      }
    }
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

async function cmdOauthCode() {
  if (MOCK) {
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
    return;
  }
  // Real path: try the archon-server's device-code endpoint. If it
  // does not exist, we fall back to API-key auth (the user is already
  // running `Mavis: Set API key`).
  try {
    const res = await archonFetch('/oauth/code', { method: 'POST', body: JSON.stringify({ client_id: 'minimax-vscode-agent' }) });
    const json = await res.json();
    if (!json || typeof json.device_code !== 'string' || typeof json.user_code !== 'string') {
      throw new Error('archon /oauth/code returned an unexpected shape');
    }
    emit({
      type: 'oauth-code',
      user_code: json.user_code,
      verification_uri: json.verification_uri || 'https://platform.minimax.io/user-center/payment/token-plan',
      device_code: json.device_code,
      interval: json.interval || 5,
      expires_in: json.expires_in || 600,
    });
  } catch (err) {
    emit({ type: 'error', message: (err && err.message) || String(err) });
  } finally {
    emit({ type: 'done' });
  }
}

async function cmdOauthToken() {
  const deviceCode = arg('--device-code');
  if (!deviceCode) {
    logErr('--device-code required');
    process.exit(2);
  }
  if (MOCK) {
    emit({
      type: 'oauth-token',
      access_token: 'mock_access_' + Math.random().toString(36).slice(2),
      refresh_token: 'mock_refresh_' + Math.random().toString(36).slice(2),
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'group_id profile model.completion',
    });
    emit({ type: 'done' });
    return;
  }
  try {
    const res = await archonFetch('/oauth/token', {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'minimax-vscode-agent', device_code: deviceCode }),
    });
    const json = await res.json();
    if (!json || typeof json.access_token !== 'string') {
      throw new Error('archon /oauth/token returned an unexpected shape');
    }
    emit({
      type: 'oauth-token',
      access_token: json.access_token,
      refresh_token: json.refresh_token || '',
      expires_in: json.expires_in || 3600,
      token_type: json.token_type || 'Bearer',
      scope: json.scope || 'group_id profile model.completion',
    });
  } catch (err) {
    emit({ type: 'error', message: (err && err.message) || String(err) });
  } finally {
    emit({ type: 'done' });
  }
}

// --- Drive (Fase 4) --------------------------------------------------------

// The shim keeps an in-memory mock Drive so `get`/`delete` can find what
// `list` advertised. Each list command reseeds with a stable set of items
// across categories so the test suite gets deterministic counts.
const DRIVE_SEED = (() => {
  const now = nowTs();
  return [
    { id: 'drv_doc_1', name: 'project-spec.md', category: 'documents', sizeBytes: 12_345, mimeType: 'text/markdown', createdAt: now - 86_400_000, updatedAt: now - 3_600_000 },
    { id: 'drv_doc_2', name: 'meeting-notes.txt', category: 'documents', sizeBytes: 2_048, mimeType: 'text/plain', createdAt: now - 172_800_000, updatedAt: now - 7_200_000 },
    { id: 'drv_xls_1', name: 'q3-metrics.xlsx', category: 'excel', sizeBytes: 54_321, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdAt: now - 259_200_000, updatedAt: now - 1_800_000 },
    { id: 'drv_ppt_1', name: 'all-hands-deck.pptx', category: 'ppt', sizeBytes: 987_654, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', createdAt: now - 432_000_000, updatedAt: now - 86_400_000 },
    { id: 'drv_img_1', name: 'logo.png', category: 'images', sizeBytes: 8_192, mimeType: 'image/png', createdAt: now - 604_800_000, updatedAt: now - 604_800_000 },
    { id: 'drv_img_2', name: 'banner.jpg', category: 'images', sizeBytes: 65_536, mimeType: 'image/jpeg', createdAt: now - 345_600_000, updatedAt: now - 86_400_000 },
    { id: 'drv_vid_1', name: 'demo-walkthrough.mp4', category: 'videos', sizeBytes: 12_345_678, mimeType: 'video/mp4', createdAt: now - 864_000_000, updatedAt: now - 1_209_600_000 },
    { id: 'drv_aud_1', name: 'standup-recording.m4a', category: 'audio', sizeBytes: 1_234_567, mimeType: 'audio/mp4', createdAt: now - 172_800_000, updatedAt: now - 3_600_000 },
    { id: 'drv_oth_1', name: 'archive.zip', category: 'other', sizeBytes: 2_345_678, mimeType: 'application/zip', createdAt: now - 1_296_000_000, updatedAt: now - 259_200_000 },
  ];
})();

// Track which seeded ids have been deleted this process so subsequent
// `drive get` / `drive delete` calls reflect the current state.
const deletedDriveIds = new Set();

function cmdDriveList() {
  const wantCategory = arg('--category');
  const items = DRIVE_SEED
    .filter((it) => !deletedDriveIds.has(it.id))
    .filter((it) => !wantCategory || it.category === wantCategory)
    .map((it) => ({ ...it }));
  for (const it of items) emit(it);
  emit({ type: 'done', count: items.length });
}

function cmdDriveGet() {
  const id = argv[2];
  if (!id) {
    logErr('drive get requires an id');
    process.exit(2);
  }
  const found = DRIVE_SEED.find((it) => it.id === id && !deletedDriveIds.has(it.id));
  if (!found) {
    logErr('drive item not found: ' + id);
    process.exit(3);
  }
  // Mock content: 8 bytes of base64 representing the item. Real CLI would
  // stream the bytes; the TS layer treats the field as opaque.
  emit({
    type: 'file',
    id: found.id,
    name: found.name,
    category: found.category,
    sizeBytes: found.sizeBytes,
    mimeType: found.mimeType,
    createdAt: found.createdAt,
    updatedAt: found.updatedAt,
    url: 'https://example.invalid/drive/' + found.id,
    content: Buffer.from('mock-content-for-' + found.id).toString('base64'),
    contentIsBase64: true,
  });
  emit({ type: 'done' });
}

function cmdDriveDelete() {
  const id = argv[2];
  if (!id) {
    logErr('drive delete requires an id');
    process.exit(2);
  }
  if (!DRIVE_SEED.find((it) => it.id === id)) {
    logErr('drive item not found: ' + id);
    process.exit(3);
  }
  deletedDriveIds.add(id);
  emit({ type: 'deleted', id });
  emit({ type: 'done' });
}

// --- Cron (Fase 4) ---------------------------------------------------------

function nextRunIso(schedule) {
  // Cheap mock: add 1 hour for every `*` token. Real daemon will use
  // cron-parser; this is good enough for the shim's "nextRunAt" hint.
  const fields = (schedule || '* * * * *').trim().split(/\s+/);
  let delta = 3_600_000;
  for (const f of fields) {
    if (f !== '*') delta += 600_000;
  }
  return new Date(nowTs() + delta).toISOString();
}

const CRON_SEED = (() => {
  const now = nowTs();
  return [
    {
      id: 'cron_morning',
      name: 'Morning standup summary',
      schedule: '0 8 * * 1-5',
      prompt: 'Summarise the last 24h of commits and ping the team.',
      agent: 'mavis',
      enabled: true,
      lastRunAt: now - 86_400_000,
      nextRunAt: now + 3_600_000,
      createdAt: now - 7 * 86_400_000,
    },
    {
      id: 'cron_tests',
      name: 'Run test suite every 6h',
      schedule: '0 */6 * * *',
      prompt: 'Run `npm test` and report failures.',
      agent: 'mavis-coder',
      enabled: true,
      lastRunAt: now - 3 * 3_600_000,
      nextRunAt: now + 3 * 3_600_000,
      createdAt: now - 30 * 86_400_000,
    },
    {
      id: 'cron_disabled',
      name: 'Disabled nightly snapshot',
      schedule: '0 2 * * *',
      prompt: 'Take a snapshot of /var/log/mavis.',
      agent: 'mavis',
      enabled: false,
      lastRunAt: now - 2 * 86_400_000,
      nextRunAt: now + 22 * 3_600_000,
      createdAt: now - 14 * 86_400_000,
    },
  ];
})();

const deletedCronIds = new Set();

function cmdCronList() {
  const items = CRON_SEED
    .filter((c) => !deletedCronIds.has(c.id))
    .map((c) => ({ ...c }));
  for (const c of items) emit(c);
  emit({ type: 'done', count: items.length });
}

function cmdCronCreate() {
  const name = arg('--name');
  const schedule = arg('--schedule');
  const prompt = arg('--prompt');
  const agent = arg('--agent') || 'mavis';
  if (!name || !schedule || !prompt) {
    logErr('cron create requires --name, --schedule and --prompt');
    process.exit(2);
  }
  const id = randomId('cron');
  const enabled = !flag('--disabled');
  const row = {
    id,
    name,
    schedule,
    prompt,
    agent,
    enabled,
    lastRunAt: undefined,
    nextRunAt: nextRunIso(schedule),
    createdAt: nowTs(),
  };
  emit({ type: 'cron', ...row });
  emit({ type: 'done' });
}

function cmdCronDelete() {
  const id = argv[2];
  if (!id) {
    logErr('cron delete requires an id');
    process.exit(2);
  }
  if (!CRON_SEED.find((c) => c.id === id)) {
    logErr('cron not found: ' + id);
    process.exit(3);
  }
  deletedCronIds.add(id);
  emit({ type: 'deleted', id });
  emit({ type: 'done' });
}

function cmdCronEnable() {
  const id = argv[2];
  if (!id) {
    logErr('cron enable requires an id');
    process.exit(2);
  }
  const found = CRON_SEED.find((c) => c.id === id);
  if (!found) {
    logErr('cron not found: ' + id);
    process.exit(3);
  }
  emit({
    type: 'cron',
    id,
    name: found.name,
    schedule: found.schedule,
    prompt: found.prompt,
    agent: found.agent,
    enabled: true,
    lastRunAt: found.lastRunAt,
    nextRunAt: nextRunIso(found.schedule),
    createdAt: found.createdAt,
  });
  emit({ type: 'done' });
}

function cmdCronDisable() {
  const id = argv[2];
  if (!id) {
    logErr('cron disable requires an id');
    process.exit(2);
  }
  const found = CRON_SEED.find((c) => c.id === id);
  if (!found) {
    logErr('cron not found: ' + id);
    process.exit(3);
  }
  emit({
    type: 'cron',
    id,
    name: found.name,
    schedule: found.schedule,
    prompt: found.prompt,
    agent: found.agent,
    enabled: false,
    lastRunAt: found.lastRunAt,
    nextRunAt: found.nextRunAt,
    createdAt: found.createdAt,
  });
  emit({ type: 'done' });
}

main();

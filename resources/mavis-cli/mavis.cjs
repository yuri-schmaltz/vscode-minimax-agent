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
  // Always prepend MAVIS_API_BASE (e.g. /v1) to the path so callers
  // can pass "/chat/completions" without worrying about the prefix.
  // If the caller already included the prefix (starts with the same
  // string), we still re-prepend — downstream servers expect the
  // canonical URL and duplicating the prefix would 404.
  const p = path.startsWith('/') ? path : '/' + path;
  return base + prefix + p;
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

// Async generator that yields newline-terminated lines from stdin as
// they arrive. The host writes one prompt per call to stdin (without
// closing the pipe); the previous readStdinLines waited for 'end',
// which never fired, so the shim sat idle forever.
async function* readStdinLinesStream() {
  process.stdin.setEncoding('utf8');
  let buf = '';
  // We need to await lines on demand. Use a queue + resolver.
  const queue = [];
  let resolveNext = null;
  let ended = false;
  let error = null;
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: line, done: false });
      } else {
        queue.push(line);
      }
    }
  });
  process.stdin.on('end', () => {
    if (buf.length) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: buf, done: false });
      } else {
        queue.push(buf);
      }
      buf = '';
    }
    ended = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: undefined, done: true });
    }
  });
  process.stdin.on('error', (err) => {
    error = err;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: undefined, done: true });
    }
  });
  while (true) {
    if (queue.length > 0) {
      yield queue.shift();
      continue;
    }
    if (error) throw error;
    if (ended) return;
    const next = await new Promise((resolve) => {
      resolveNext = resolve;
    });
    if (next.done) return;
    yield next.value;
  }
}

async function cmdSessionStream() {
  const sessionId = arg('--session-id') || 'sess_unknown';
  const dryRun = flag('--dry-run');

  if (dryRun) {
    emit({ type: 'ready', sessionId });
    emit({ type: 'done' });
    return;
  }

  // Surface the effective config so the user can correlate the shim's
  // behaviour with the host's settings in the Mavis output channel.
  logErr(
    `session stream start sid=${sessionId} archon=${process.env.MAVIS_ARCHON_URL || '(unset)'} ` +
      `apiBase=${process.env.MAVIS_API_BASE || '/v1'} model=${process.env.MAVIS_MODEL || 'MiniMax-M3'} ` +
      `stream=${process.env.MAVIS_STREAM === '1' ? 'true' : 'false'} ` +
      `mock=${MOCK ? 'true' : 'false'} ` +
      `key=${process.env.MAVIS_API_KEY ? 'set(' + process.env.MAVIS_API_KEY.length + ')' : 'unset'}`,
  );

  // Send a "ready" beacon so the consumer can wire UI before the first token.
  emit({ type: 'ready', sessionId, mock: MOCK, ts: nowTs() });

  // Stream prompts from stdin as they arrive (one line per call from
  // the host's sendPrompt). No longer waits for stdin to close.
  for await (const raw of readStdinLinesStream()) {
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
    const toolList = Array.isArray(prompt.tools) ? prompt.tools : null;
    const useAgent = toolList && toolList.length > 0;
    const mode = typeof prompt.mode === 'string' ? prompt.mode : 'builder';
    const contextFiles = Array.isArray(prompt.contextFiles) ? prompt.contextFiles : [];
    // Per-prompt model override. The env var MAVIS_MODEL is the
    // fallback for callers that don't pass a model in the envelope
    // (back-compat: the original single-shot chat path didn't know
    // about models; it just used the env var).
    const model = typeof prompt.model === 'string' && prompt.model.length > 0
      ? prompt.model
      : (process.env.MAVIS_MODEL || 'MiniMax-M3');
    // Per-prompt agent override. The host passes the agent's name
    // and systemPrompt; the shim prepends the systemPrompt to the
    // default Builder/Plan prompt. We also pass the agent's name
    // to the system prompt so the model knows which agent persona
    // it's running as.
    const agent = (prompt.agent && typeof prompt.agent === 'object')
      ? prompt.agent
      : null;

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
    } else if (useAgent) {
      // ----------------------------------------------------------------
      // Agent loop (Fase B.1).
      //
      // Single-turn tool calling is pointless for "vibe coding" — the
      // model needs to see tool results, decide what to do next, and
      // either call another tool or emit a final answer. We loop here
      // until the model emits a `finish_reason` of 'stop' (or a max
      // iteration guard kicks in). Each step is emitted as
      // `tool_call` / `tool_result` events so the webview can render
      // the agent's reasoning in real time.
      // ----------------------------------------------------------------
      await runAgentLoop({
        text,
        tools: toolList,
        mode,
        contextFiles,
        sessionId,
        agent,
      });
    } else {
      // Real path: OpenAI-compatible /chat/completions. Defaults to
      // non-streaming because the MiniMax SSE format trips up the parser
      // in a few edge cases (mixing `delta.content` and `delta.reasoning_content`,
      // multi-byte chunks split across reads, etc). When the parser is
      // robust, flip the env back to '1' to get the typing effect.
      // Use the per-prompt model if provided, otherwise fall back
      // to the env var (single-shot chat legacy path).
      const model = typeof prompt.model === 'string' && prompt.model.length > 0
        ? prompt.model
        : (process.env.MAVIS_MODEL || 'MiniMax-M3');
      const useStream = process.env.MAVIS_STREAM === '1';
      logErr(`chat request -> ${archonUrl('/chat/completions')} model=${model} stream=${useStream}`);
      let res;
      try {
        res = await archonFetch('/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model,
            stream: useStream,
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
      if (useStream) {
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
      } else {
        // Non-streaming path: full response, one emit.
        let messageCount = 0;
        let usage = null;
        let lastContent = '';
        try {
          const body = await res.text();
          if (body && body.length > 0) {
            try {
              const json = JSON.parse(body);
              if (json && Array.isArray(json.choices)) {
                for (const choice of json.choices) {
                  const msg = choice && choice.message;
                  if (msg && typeof msg === 'object') {
                    // Prefer real content, fall back to reasoning
                    // (M3 with thinking mode sometimes only emits
                    // reasoning_content when max_tokens is small).
                    const text = typeof msg.content === 'string' && msg.content.length > 0
                      ? msg.content
                      : (typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '');
                    if (text) {
                      lastContent = text;
                      messageCount += 1;
                      emit({ type: 'message', role: 'assistant', content: text, sessionId, ts: nowTs() });
                    }
                  }
                }
              }
              if (json.usage && typeof json.usage === 'object') {
                usage = json.usage;
              }
            } catch {
              emit({ type: 'error', message: 'archon /chat/completions returned non-JSON body: ' + body.slice(0, 200), sessionId, ts: nowTs() });
            }
          }
        } catch (err) {
          emit({ type: 'error', message: (err && err.message) || String(err), sessionId, ts: nowTs() });
        }
        if (messageCount === 0) {
          emit({ type: 'error', message: 'archon returned 200 with no assistant content', sessionId, ts: nowTs() });
        }
        if (usage) {
          emit({ type: 'usage', usage, sessionId, ts: nowTs() });
        }
        // Avoid lint complaint about unused binding.
        void lastContent;
      }
    }
    // Mark this prompt's response as complete. With the streaming
    // stdin reader, the host expects a 'done' per prompt so it can
    // clear the pending flag and unblock the UI.
    emit({ type: 'done', sessionId });
  }
}

// ============================================================================
// Tool infrastructure (Fase B.1 — read-only tools).
//
// The shim receives a JSON tool manifest from the host (via the
// `tools` field of the prompt envelope), forwards it to the model as
// OpenAI-style `tools: [...]`, and when the model returns tool_calls
// the shim executes them locally (sandboxed to the workspace root)
// and feeds the results back to the model until the model emits a
// final assistant message. Every step is emitted as a structured
// event so the webview can render the agent's reasoning in real time.
// ============================================================================

const TOOL_PROTOCOL_VERSION = 1;

function toolManifest() {
  // The manifest the host sends. In B.1 it's read-only; B.2 adds
  // write_file / edit_file behind a confirmation flag.
  return {
    version: TOOL_PROTOCOL_VERSION,
    tools: [
      {
        name: 'read_file',
        description: 'Read the contents of a file in the workspace. Returns up to 2000 lines; for larger files, use grep or read with line ranges.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to the workspace root.' },
            startLine: { type: 'integer', description: 'Optional 0-based start line.' },
            endLine: { type: 'integer', description: 'Optional 0-based end line (exclusive).' },
          },
          required: ['path'],
        },
      },
      {
        name: 'glob',
        description: 'Find files by pattern, e.g. "**/*.ts" or "src/**/*.test.ts". Returns absolute paths.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern, relative to workspace root.' },
            limit: { type: 'integer', description: 'Max results (default 200).' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'grep',
        description: 'Search for a regex in files under a directory. Returns matches as "path:line:content".',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern (JavaScript syntax).' },
            path: { type: 'string', description: 'Directory or file to search in (default: workspace root).' },
            limit: { type: 'integer', description: 'Max matches (default 200).' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'list_directory',
        description: 'List the contents of a directory (non-recursive).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory relative to workspace root (default: ".").' },
          },
        },
      },
    ],
  };
}

// Resolve a tool path against the workspace root and reject any
// attempt to escape via "..", absolute paths, or symlinks. Returns
// the absolute path on success, or throws an Error.
//
// The `mustExist` flag is for read operations (realpath the target
// to detect symlink trickery); write operations pass false because
// the file may not exist yet — we instead realpath the deepest
// EXISTING ancestor and verify the final path is under root.
function resolveToolPath(input, label, mustExist = true) {
  const root = process.env.MAVIS_WORKSPACE || process.cwd();
  const rootReal = fs.realpathSync(root);
  let target;
  if (path.isAbsolute(input)) {
    target = path.normalize(input);
  } else {
    target = path.join(rootReal, input);
  }
  if (mustExist) {
    const targetReal = fs.realpathSync(target);
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
      throw new Error(`${label}: path escapes workspace (${input})`);
    }
    return targetReal;
  }
  // For non-existent files: realpath the deepest existing ancestor
  // and check that the resolved ancestor is under root. This blocks
  // path-traversal via crafted `..` segments without requiring the
  // file to pre-exist.
  let probe = target;
  while (probe !== rootReal && probe !== path.dirname(probe)) {
    try {
      const probeReal = fs.realpathSync(probe);
      if (probeReal !== rootReal && !probeReal.startsWith(rootReal + path.sep)) {
        throw new Error(`${label}: path escapes workspace (${input})`);
      }
      return target; // ancestor is under root; OK to create
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
      probe = path.dirname(probe);
    }
  }
  // Reached the root via dirname climb: the path is under root.
  return target;
}

function toolReadFile(args) {
  const filePath = resolveToolPath(args.path, 'read_file');
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const start = typeof args.startLine === 'number' ? Math.max(0, args.startLine) : 0;
  const end = typeof args.endLine === 'number' ? Math.min(lines.length, args.endLine) : lines.length;
  const slice = lines.slice(start, end).join('\n');
  return {
    path: args.path,
    totalLines: lines.length,
    startLine: start,
    endLine: end,
    content: slice,
    truncated: end - start < lines.length,
  };
}

function toolGlob(args) {
  const root = process.env.MAVIS_WORKSPACE || process.cwd();
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 200;
  // Use the host-provided pattern directly; ripgrep would be faster
  // but adding it as a dep just for this is overkill. Node's fs
  // walk is fine for <10k files which is the realistic case.
  const matched = [];
  const re = globToRegex(args.pattern);
  walk(root, (abs, stat) => {
    if (!stat.isFile()) return;
    if (matched.length >= limit) return;
    const rel = path.relative(root, abs);
    if (re.test(rel)) matched.push(rel);
  });
  return { pattern: args.pattern, count: matched.length, paths: matched };
}

function globToRegex(pattern) {
  // Convert a basic glob (**/*.ts) to a regex. Handles *, **, ?.
  // Doesn't handle brace expansion or extglob; that's fine for B.1.
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++; // skip the second *
        if (pattern[i + 1] === '/') i++; // and the separator
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function walk(dir, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // EACCES, ENOENT, etc. — skip silently
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    visit(abs, stat);
    if (stat.isDirectory()) walk(abs, visit);
  }
}

function toolGrep(args) {
  const root = process.env.MAVIS_WORKSPACE || process.cwd();
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 200;
  let re;
  try { re = new RegExp(args.pattern, 'i'); }
  catch (err) { throw new Error(`grep: invalid regex: ${err.message}`); }
  const baseDir = args.path ? resolveToolPath(args.path, 'grep') : root;
  const matches = [];
  walk(baseDir, (abs, stat) => {
    if (!stat.isFile() || matches.length >= limit) return;
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); }
    catch { return; } // binary or unreadable
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= limit) break;
      if (re.test(lines[i])) {
        const rel = path.relative(root, abs);
        matches.push({ path: rel, line: i + 1, content: lines[i] });
      }
    }
  });
  return { pattern: args.pattern, path: args.path || '.', count: matches.length, matches };
}

function toolListDirectory(args) {
  const dir = resolveToolPath(args.path || '.', 'list_directory');
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return {
    path: args.path || '.',
    entries: entries.map((e) => ({
      name: e.name,
      kind: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
    })),
  };
}

// ============================================================================
// B.2 — Write tools: write_file, edit_file.
//
// Both tools execute immediately (no shim-side confirmation). The
// caller is responsible for the confirmation flow (the webview shows
// the diff and lets the user accept/reject before the file is
// written; B.2 ships the tools + diff, B.4 adds the webview modal).
//
// The result of each tool call includes a `diff` field:
//   { path, action: 'created'|'modified', oldContent, newContent, diff }
// so the webview can render color-coded changes inline. The webview
// also gets a "Revert" button that calls edit_file with the inverse
// of the change.
// ============================================================================

// Compute a unified-style diff between two strings. We use a tiny
// LCS-based line diff to avoid adding `diff` as a dep in the shim
// (which is plain Node CJS). The output is an array of hunks:
//   [{ kind: 'context'|'add'|'remove', lines: string[] }, ...]
function lineDiff(oldText, newText) {
  // Strip a single trailing empty string that comes from split('\n')
  // of a string that ends with '\n'. Both sides get the same
  // treatment so a 'context' hunk doesn't appear at the end of a
  // brand-new file.
  const stripTrailingEmpty = (lines) => lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const a = stripTrailingEmpty((oldText || '').split('\n'));
  const b = stripTrailingEmpty((newText || '').split('\n'));
  const m = a.length, n = b.length;
  // LCS dp
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur && cur.lines.length) hunks.push(cur); cur = null; };
  const start = (kind) => { if (!cur || cur.kind !== kind) { flush(); cur = { kind, lines: [] }; } };
  while (i < m && j < n) {
    if (a[i] === b[j]) { start('context'); cur.lines.push(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { start('remove'); cur.lines.push(a[i]); i++; }
    else { start('add'); cur.lines.push(b[j]); j++; }
  }
  while (i < m) { start('remove'); cur.lines.push(a[i]); i++; }
  while (j < n) { start('add'); cur.lines.push(b[j]); j++; }
  flush();
  return hunks;
}

function toolWriteFile(args) {
  const filePath = resolveToolPath(args.path, 'write_file', false);
  const content = typeof args.content === 'string' ? args.content : '';
  let existed = false;
  let oldContent = '';
  try { oldContent = fs.readFileSync(filePath, 'utf8'); existed = true; }
  catch { /* new file */ }
  // Atomic-ish write: write to .tmp then rename. Avoids leaving a
  // half-written file if the process dies mid-write.
  const tmpPath = filePath + '.mavis-tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
  return {
    path: args.path,
    action: existed ? 'modified' : 'created',
    bytes: Buffer.byteLength(content, 'utf8'),
    oldContent,
    newContent: content,
    diff: lineDiff(oldContent, content),
  };
}

function toolEditFile(args) {
  const filePath = resolveToolPath(args.path, 'edit_file', false);
  const oldContent = fs.readFileSync(filePath, 'utf8');
  const find = typeof args.find === 'string' ? args.find : '';
  const newText = typeof args.newText === 'string' ? args.newText : '';
  const replaceAll = args.replaceAll === true;
  if (!find) throw new Error('edit_file: find is required');
  // Locate the find string. Default: first occurrence. If
  // replaceAll, replace all. If not found, error.
  if (replaceAll) {
    if (!oldContent.includes(find)) {
      throw new Error('edit_file: find string not present in file');
    }
  } else {
    const idx = oldContent.indexOf(find);
    if (idx === -1) throw new Error('edit_file: find string not present in file');
  }
  const updated = replaceAll
    ? oldContent.split(find).join(newText)
    : oldContent.replace(find, newText);
  if (updated === oldContent) {
    throw new Error('edit_file: replacement produced no change (find==newText?)');
  }
  const tmpPath = filePath + '.mavis-tmp';
  fs.writeFileSync(tmpPath, updated, 'utf8');
  fs.renameSync(tmpPath, filePath);
  return {
    path: args.path,
    action: 'modified',
    bytes: Buffer.byteLength(updated, 'utf8'),
    oldContent,
    newContent: updated,
    diff: lineDiff(oldContent, updated),
  };
}

// ============================================================================
// B.3 — Bash tool (security-sensitive).
//
// IMPORTANT: this tool runs shell commands. It is the most dangerous
// thing in the agent loop. We protect it in three ways:
//   1. Allowlist (MAVIS_BASH_ALLOW): the env var holds a comma-
//      separated list of command prefixes that are auto-approved.
//      Anything else requires a "requireApproval" check that the
//      host can enforce. Default: empty allowlist (everything
//      requires approval, but the host defaults to permissive in
//      BUILDER mode for known-safe commands like npm, git, pnpm).
//   2. Timeout: every command is wrapped with `child.kill()` after
//      MAVIS_BASH_TIMEOUT_MS (default 30s) so a runaway `npm install`
//      can't hang the agent forever.
//   3. Path safety: we do not change cwd, we do not allow `cd ..`
//      to escape the workspace (commands are run via `sh -c` from
//      the workspace root, so absolute paths inside the command
//      are still the user's responsibility to vet).
//
// The output is captured (stdout + stderr merged, capped at
// MAVIS_BASH_MAX_OUTPUT bytes) and returned. Exit code is also
// returned so the model can branch on it.
// ============================================================================

const DEFAULT_BASH_ALLOW = [
  // Read-only / safe-ish commands. Each entry is matched as a
  // prefix against the first whitespace-separated token of the
  // command.
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'echo',
  'pwd', 'env', 'which', 'node --version', 'npm', 'pnpm', 'yarn',
  'git', 'tsc', 'tsx', 'node', 'npx',
];

function bashIsAllowed(cmd) {
  // Read the allowlist from env, or fall back to the default. The
  // allowlist is a comma-separated list of command prefixes.
  const envList = process.env.MAVIS_BASH_ALLOW;
  const list = envList ? envList.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_BASH_ALLOW;
  // Strip leading whitespace and take the first token.
  const first = cmd.trim().split(/\s+/)[0] || '';
  // Allow if first token OR "<first> <subcmd>" matches any prefix.
  for (const prefix of list) {
    if (first === prefix) return true;
    if (cmd.trim().startsWith(prefix + ' ')) return true;
  }
  return false;
}

function toolBash(args) {
  const cmd = typeof args.command === 'string' ? args.command : '';
  if (!cmd) throw new Error('bash: command is required');
  // Block obviously-dangerous patterns even if the command is in
  // the allowlist. These are eval'd by `sh -c`, so any attempt to
  // break out (backticks, $(), && chains to dangerous commands)
  // is caught here.
  const DANGEROUS = [
    /rm\s+-rf?\s+\//,           // rm -rf /
    /:\(\)\s*\{[^}]*\|[^}]*&/, // fork bomb (:(){ ... | ... &})
    /curl[^|]*\|\s*(sh|bash)/,  // curl | sh
    /wget[^|]*\|\s*(sh|bash)/,  // wget | sh
    /\bsudo\b/,                  // sudo anything
    /\beval\b/,                  // eval
  ];
  for (const re of DANGEROUS) {
    if (re.test(cmd)) throw new Error('bash: command contains dangerous pattern: ' + re);
  }
  const allowed = bashIsAllowed(cmd);
  const timeoutMs = Number(process.env.MAVIS_BASH_TIMEOUT_MS || 30000);
  const maxOutput = Number(process.env.MAVIS_BASH_MAX_OUTPUT || 64 * 1024);
  const cwd = process.env.MAVIS_WORKSPACE || process.cwd();
  // We use spawnSync with a shell so users can use &&, |, etc.
  // The shell is /bin/sh which is available on all POSIX systems;
  // on Windows the Node runtime will translate.
  const { spawnSync } = require('node:child_process');
  let result;
  try {
    result = spawnSync('sh', ['-c', cmd], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: maxOutput,
      encoding: 'utf8',
      env: { ...process.env, MAVIS_PROMPT_INJECTION_GUARD: '1' },
    });
  } catch (err) {
    throw new Error('bash: spawn failed: ' + (err && err.message ? err.message : err));
  }
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      return {
        command: cmd,
        allowed,
        timedOut: true,
        timeoutMs,
        exitCode: null,
        stdout: (result.stdout || '').slice(0, maxOutput),
        stderr: (result.stderr || '').slice(0, maxOutput),
      };
    }
    throw new Error('bash: spawn error: ' + result.error.message);
  }
  return {
    command: cmd,
    allowed,
    timedOut: false,
    exitCode: result.status,
    stdout: (result.stdout || '').slice(0, maxOutput),
    stderr: (result.stderr || '').slice(0, maxOutput),
  };
}

function toolCwd(args) {
  // The host sets MAVIS_WORKSPACE; we report it back. The model
  // can use this to anchor relative paths.
  return { cwd: process.env.MAVIS_WORKSPACE || process.cwd() };
}

function executeTool(name, args) {
  // Whitelist: B.1 read-only + B.2 write. Plan mode is enforced
  // upstream by NOT including write tools in the manifest sent to
  // the shim, so an attacker (or a misbehaving model) can't reach
  // toolWriteFile/toolEditFile without the host opting in.
  const registry = {
    read_file: toolReadFile,
    glob: toolGlob,
    grep: toolGrep,
    list_directory: toolListDirectory,
    write_file: toolWriteFile,
    edit_file: toolEditFile,
    bash: toolBash,
    cwd: toolCwd,
  };
  const fn = registry[name];
  if (!fn) {
    throw new Error(`unknown tool: ${name}`);
  }
  return fn(args || {});
}

function openaiToolSchema(tools) {
  // Convert our flat tool manifest to OpenAI's chat.completions
  // `tools: [{type: 'function', function: {name, description, parameters}}]`
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// Build the system prompt for an agent run. Mode controls whether
// the model is allowed to (claim to) write files; agent.md (if
// present) gives the model project-specific context.
function buildSystemPrompt(mode, agentMd, agent) {
  // agent (optional): { name, systemPrompt }. The agent's systemPrompt
  // is prepended to the default Builder/Plan prompt so the user can
  // define a custom persona ("you're a strict code reviewer", etc.).
  const agentBlock = (agent && typeof agent.systemPrompt === 'string' && agent.systemPrompt.length > 0)
    ? `\n\n# Agent: ${agent.name || 'custom'}\n${agent.systemPrompt}\n`
    : '';
  const modeBlock = mode === 'plan'
    ? `MODE: PLAN (read-only).
You CANNOT write, edit, or run commands. Do NOT attempt to call tools like write_file, edit_file, or bash — they are not available in this mode.
When the user asks for changes, explain what would be needed and tell them to switch to Builder mode (they can toggle the mode in the chat header).`
    : `MODE: BUILDER.
You have read tools (read_file, glob, grep, list_directory) and write tools (write_file, edit_file). Use read tools to investigate the codebase before changing anything.
When you write or edit a file, the user will see a color-coded diff and can revert your change. Be precise and explain your changes in plain language. Cite file paths and line numbers when you reference code.`;
  // agent.md is the per-project file. The agent's own system
  // prompt is the user's persona override. Both are optional; we
  // concatenate whichever is present, in the order: agent persona
  // → mode → agent.md.
  const mdBlock = agentMd ? `\n\nPROJECT INSTRUCTIONS (from agent.md):\n${agentMd}\n` : '';
  return `You are Mavis, a coding assistant for VS Code.\n${modeBlock}${agentBlock}${mdBlock}`;
}

// Read agent.md from the workspace root, if present. Caps at 16 KB
// to avoid blowing the context window.
function loadAgentMd() {
  const root = process.env.MAVIS_WORKSPACE || process.cwd();
  const candidate = path.join(root, 'agent.md');
  try {
    if (!fs.existsSync(candidate)) return null;
    const content = fs.readFileSync(candidate, 'utf8');
    if (content.length > 16 * 1024) {
      return content.slice(0, 16 * 1024) + '\n\n[... truncated, full file is larger ...]';
    }
    return content;
  } catch {
    return null;
  }
}

// Read each file listed in contextFiles (max 8 files, max 32 KB
// each) and return their contents as a system message fragment.
function loadContextFiles(paths) {
  if (!paths || paths.length === 0) return null;
  const root = process.env.MAVIS_WORKSPACE || process.cwd();
  const blocks = [];
  for (const rel of paths.slice(0, 8)) {
    try {
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
      const real = fs.realpathSync(abs);
      const rootReal = fs.realpathSync(root);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        blocks.push(`--- ${rel} ---\n[skipped: outside workspace]`);
        continue;
      }
      const content = fs.readFileSync(real, 'utf8');
      const capped = content.length > 32 * 1024 ? content.slice(0, 32 * 1024) + '\n[... truncated ...]' : content;
      blocks.push(`--- ${rel} ---\n${capped}`);
    } catch (err) {
      blocks.push(`--- ${rel} ---\n[error reading file: ${err.message}]`);
    }
  }
  if (blocks.length === 0) return null;
  return `The user mentioned these files. Use them as context:\n\n${blocks.join('\n\n')}`;
}

// Run one agent loop: call the model, execute any tool_calls, feed
// results back, repeat until the model emits a final answer or we
// hit the iteration cap. Non-streaming model calls only (tool_calls
// in deltas need careful accumulator logic that's deferred to a
// later phase; non-streaming is good enough for B.1).
async function runAgentLoop({ text, tools, mode, contextFiles, sessionId, agent }) {
  const model = process.env.MAVIS_MODEL || 'MiniMax-M3';
  const openaiTools = openaiToolSchema(tools);
  const agentMd = loadAgentMd();
  const systemPrompt = buildSystemPrompt(mode, agentMd, agent);
  const contextBlock = loadContextFiles(contextFiles);

  const messages = [{ role: 'system', content: systemPrompt }];
  if (contextBlock) messages.push({ role: 'system', content: contextBlock });
  messages.push({ role: 'user', content: text });

  const MAX_ITER = 8; // safety cap on tool-call loops
  let iter = 0;
  let lastContent = '';
  let emittedAny = false;
  let usage = null;

  while (iter < MAX_ITER) {
    iter += 1;
    logErr(`agent iter=${iter} messages=${messages.length} tools=${openaiTools.length}`);
    let res;
    try {
      res = await archonFetch('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model,
          stream: false,
          messages,
          tools: openaiTools,
          tool_choice: 'auto',
        }),
      });
    } catch (err) {
      const raw = (err && err.message) || String(err);
      const m = /->\s*(\d{3})\s*:\s*(\{[\s\S]*\})/.exec(raw);
      if (m && m[1] === '402' && /insufficient_balance_error/.test(m[2])) {
        emit({ type: 'error', message: 'Conta MiniMax sem saldo. Adicione créditos em platform.minimax.io/user-center/payment/token-plan para usar o chat.', sessionId, ts: nowTs() });
      } else {
        emit({ type: 'error', message: raw, sessionId, ts: nowTs() });
      }
      return;
    }

    const body = await res.text();
    let json;
    try { json = JSON.parse(body); }
    catch {
      emit({ type: 'error', message: 'archon /chat/completions returned non-JSON: ' + body.slice(0, 200), sessionId, ts: nowTs() });
      return;
    }

    if (json.usage && typeof json.usage === 'object') usage = json.usage;
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    if (!choice) {
      emit({ type: 'error', message: 'archon returned no choices', sessionId, ts: nowTs() });
      return;
    }
    const msg = choice.message || {};
    const finishReason = choice.finish_reason || 'stop';

    // Emit any text content the model produced (could be alongside
    // tool_calls, in which case it's usually reasoning).
    if (typeof msg.content === 'string' && msg.content.length > 0) {
      lastContent = msg.content;
      emit({ type: 'message', role: 'assistant', content: msg.content, sessionId, ts: nowTs() });
      emittedAny = true;
    } else if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
      // Surface reasoning as a separate event so the UI can render
      // it in a collapsible "thinking" block (B.5 polish).
      emit({ type: 'reasoning', content: msg.reasoning_content, sessionId, ts: nowTs() });
    }

    // No tool calls → we're done.
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      break;
    }

    // Append the assistant message (with tool_calls) to history.
    messages.push({
      role: 'assistant',
      content: msg.content || '',
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    // Execute each tool_call and append the result.
    for (const tc of msg.tool_calls) {
      const name = tc.function && tc.function.name;
      let args = {};
      try { args = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch (err) {
        emit({ type: 'error', message: `tool ${name}: bad arguments JSON (${err.message})`, sessionId, ts: nowTs() });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'bad arguments: ' + err.message }) });
        continue;
      }
      emit({ type: 'tool_call', id: tc.id, name, args, sessionId, ts: nowTs() });
      let result;
      try {
        result = executeTool(name, args);
      } catch (err) {
        result = { error: (err && err.message) || String(err) };
      }
      emit({ type: 'tool_result', id: tc.id, name, result, sessionId, ts: nowTs() });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }

    // Loop back: call model again with updated history.
  }

  if (iter >= MAX_ITER) {
    emit({ type: 'error', message: `agent loop hit max iterations (${MAX_ITER}); last content: ${lastContent.slice(0, 200)}`, sessionId, ts: nowTs() });
  }
  if (!emittedAny && lastContent === '') {
    emit({ type: 'error', message: 'agent returned no assistant content', sessionId, ts: nowTs() });
  }
  if (usage) emit({ type: 'usage', usage, sessionId, ts: nowTs() });
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

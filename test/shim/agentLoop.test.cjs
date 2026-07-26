// End-to-end test of the agent loop in mock mode (no real MiniMax
// API call). The shim's cmdSessionStream now runs a multi-turn
// agent loop when the prompt envelope has `tools: [...]`. We mock
// the archonFetch by pre-seeding a fake server that returns a
// `tool_calls` response on the first call and a plain content
// response on the second call, and verify the shim:
//   1. executes the tool call
//   2. emits `tool_call` + `tool_result` events
//   3. feeds the result back to the model
//   4. emits the final assistant message
//   5. emits `done` for the prompt

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Writable } = require('node:stream');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(REPO_ROOT, 'resources', 'mavis-cli', 'mavis.cjs');

class LineParser extends Writable {
  constructor() { super(); this.events = []; this.buf = ''; }
  _write(chunk, _enc, cb) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try { this.events.push(JSON.parse(line)); } catch { /* ignore */ }
    }
    cb();
  }
}

// Start a tiny HTTP server that emulates /v1/chat/completions with
// two canned responses. The first request gets a tool_calls
// response (model decides to call list_directory), the second gets
// a plain content response (model answers the user).
function startFakeArchon() {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const reqJson = JSON.parse(body || '{}');
      callCount += 1;
      if (callCount === 1) {
        // First turn: model decides to call list_directory.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chat1', model: 'test', created: 0,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_abc',
                type: 'function',
                function: { name: 'list_directory', arguments: '{"path":"."}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      } else {
        // Second turn: model gives a final answer. Verify the model
        // saw the tool result we sent back.
        const messages = Array.isArray(reqJson.messages) ? reqJson.messages : [];
        const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
        const sawToolResult = lastTool && typeof lastTool.content === 'string' && /"entries"/.test(lastTool.content);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chat2', model: 'test', created: 0,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: sawToolResult
                ? 'OK, the directory is empty (well, the test fixture).'
                : 'ERROR: tool result missing from context',
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('agent loop: tool_calls → execute → feed back → final answer', async () => {
  const { server, port } = await startFakeArchon();
  // Create a tiny workspace so list_directory succeeds.
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-agent-'));
  fs.writeFileSync(path.join(workdir, 'agent.md'), '# Test project\nBe terse.');
  fs.writeFileSync(path.join(workdir, 'hello.txt'), 'hi');

  try {
    const child = spawn(
      process.execPath,
      [SHIM, 'session', 'stream', '--session-id', 'sess_agt_test'],
      {
        env: {
          ...process.env,
          MAVIS_ARCHON_URL: `http://127.0.0.1:${port}`,
          MAVIS_API_KEY: 'sk-test',
          MAVIS_API_BASE: '/v1',
          MAVIS_WORKSPACE: workdir,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const parser = new LineParser();
    child.stdout.pipe(parser);
    // Collect stderr for diagnostics.
    let stderrBuf = '';
    child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

    // Wait for ready before sending the prompt.
    await new Promise((resolve, reject) => {
      const onEvt = setInterval(() => {
        if (parser.events.some((e) => e.type === 'ready')) { clearInterval(onEvt); resolve(); }
      }, 10);
      setTimeout(() => { clearInterval(onEvt); reject(new Error('timeout waiting for ready. stderr=' + stderrBuf)); }, 3000);
    });

    // Send a prompt envelope with the read-only tool manifest.
    const tools = [
      {
        name: 'list_directory',
        description: 'list a dir',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
      },
    ];
    child.stdin.write(JSON.stringify({ type: 'prompt', text: 'list the workspace', tools, mode: 'builder' }) + '\n');

    // Wait for done.
    await new Promise((resolve, reject) => {
      const onDone = setInterval(() => {
        if (parser.events.some((e) => e.type === 'done')) { clearInterval(onDone); resolve(); }
      }, 10);
      setTimeout(() => { clearInterval(onDone); reject(new Error('timeout waiting for done. events=' + JSON.stringify(parser.events) + ' stderr=' + stderrBuf)); }, 8000);
    });
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 100));
    child.kill();

    const events = parser.events;
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    const messages = events.filter((e) => e.type === 'message' && e.content);
    const errors = events.filter((e) => e.type === 'error');
    const done = events.filter((e) => e.type === 'done');

    assert.equal(toolCalls.length, 1, `expected 1 tool_call, got ${toolCalls.length}. events=${JSON.stringify(events)}`);
    assert.equal(toolCalls[0].name, 'list_directory');
    assert.deepEqual(toolCalls[0].args, { path: '.' });
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].id, toolCalls[0].id);
    assert.ok(Array.isArray(toolResults[0].result.entries), 'tool_result should include entries array');
    assert.equal(messages.length, 1, `expected 1 final message, got ${messages.length}. events=${JSON.stringify(events)}`);
    assert.match(messages[0].content, /directory is empty/);
    assert.equal(done.length, 1, `expected 1 done, got ${done.length}. events=${JSON.stringify(events)}`);
    assert.equal(errors.length, 0, `expected no errors, got ${JSON.stringify(errors)}`);
  } finally {
    fs.rmSync(workdir, { recursive: true });
    server.close();
  }
});

// Test the startQuotaPoller: starts, hits the endpoint, emits
// QuotaInfo, and the stop() function tears down cleanly.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startQuotaPoller } = require('../../out/statusbar/quota.js');

function makeFakeClient(key) {
  return { getApiKey: () => key };
}

function startFakeCodingPlan(statusCode, body) {
  const server = http.createServer((req, res) => {
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('quota: parses the coding_plan/remains response', async () => {
  const { server, url } = await startFakeCodingPlan(200, {
    model_remains: [
      { current_interval_total_count: 100, current_interval_usage_count: 30, remains_time: 60_000 },
    ],
  });
  const client = makeFakeClient('sk-test');
  const updates = [];
  const stop = startQuotaPoller(client, url, (info) => updates.push(info));
  // Wait for the first poll.
  await new Promise((resolve) => setTimeout(resolve, 200));
  stop();
  server.close();

  assert.ok(updates.length >= 1, 'expected at least one update');
  const info = updates.find((u) => u && !u.empty);
  assert.ok(info, 'expected a non-empty info');
  assert.equal(info.used, 30);
  assert.equal(info.total, 100);
  assert.equal(info.remaining, 70);
  assert.equal(info.resetMinutes, 1);
});

test('quota: empty response (no model_remains) emits empty=true', async () => {
  const { server, url } = await startFakeCodingPlan(200, { model_remains: [] });
  const client = makeFakeClient('sk-test');
  const updates = [];
  const stop = startQuotaPoller(client, url, (info) => updates.push(info));
  await new Promise((resolve) => setTimeout(resolve, 200));
  stop();
  server.close();

  const info = updates.find((u) => u && u.empty);
  assert.ok(info, 'expected an empty info');
});

test('quota: 4xx/5xx invokes callback with null', async () => {
  const { server, url } = await startFakeCodingPlan(401, { error: 'unauthorized' });
  const client = makeFakeClient('sk-test');
  const updates = [];
  const stop = startQuotaPoller(client, url, (info) => updates.push(info));
  await new Promise((resolve) => setTimeout(resolve, 200));
  stop();
  server.close();
  // The very first invocation could be null (no key) or null (4xx) — we
  // just want to see at least one null.
  assert.ok(updates.some((u) => u === null), 'expected at least one null update');
});

test('quota: missing key invokes callback with null and keeps polling', async () => {
  const client = makeFakeClient(undefined);
  const updates = [];
  // We don't even start a server — without a key, the poller should
  // never even hit the network.
  const stop = startQuotaPoller(client, 'http://127.0.0.1:1', (info) => updates.push(info));
  await new Promise((resolve) => setTimeout(resolve, 100));
  stop();
  assert.ok(updates.some((u) => u === null), 'expected null update when key is missing');
});

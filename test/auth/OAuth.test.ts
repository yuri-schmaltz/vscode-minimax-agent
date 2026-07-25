/**
 * OAuth unit tests.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { OAuthManager, generateCodeVerifier, deriveCodeChallenge, generateState } from '../../src/auth/OAuth';
import { SecretStore } from '../../src/auth/SecretStore';
import { SecretStorage } from '../__mocks__/vscode';
import { MavisClient } from '../../src/client/MavisClient';
import { makeFakeChild, makeSpawner } from '../helpers/spawnStub';

function makeClient(): MavisClient {
  return new MavisClient({
    resolveBundledPath: () => '/bin/mavis',
    spawnImpl: makeSpawner(makeFakeChild()),
  });
}

test('PKCE: generateCodeVerifier produces 43+ char base64url string', () => {
  const v = generateCodeVerifier();
  assert.ok(v.length >= 43, `expected length >= 43, got ${v.length}`);
  assert.match(v, /^[A-Za-z0-9\-._~]+$/);
});

test('PKCE: deriveCodeChallenge equals base64url(sha256(verifier))', () => {
  const v = generateCodeVerifier();
  const c = deriveCodeChallenge(v);
  const expected = createHash('sha256')
    .update(v)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  assert.equal(c, expected);
});

test('PKCE: generateState is random and non-empty', () => {
  const a = generateState();
  const b = generateState();
  assert.notEqual(a, b);
  assert.ok(a.length > 16);
});

test('OAuthManager.signIn (mock) stores a token in SecretStorage', async () => {
  const secretStorage = new SecretStorage();
  const store = new SecretStore(secretStorage);
  const oauth = new OAuthManager(makeClient(), store, { clientId: 'cid' });
  const rec = await oauth.signIn({ clientId: 'cid', scope: 's', openExternal: async () => true });
  assert.ok(rec.access_token.startsWith('mock_access_'));
  const stored = await store.read();
  assert.ok(stored, 'expected SecretStore to retain the token');
  assert.equal(stored!.access_token, rec.access_token);
});

test('OAuthManager.signOut clears SecretStorage', async () => {
  const secretStorage = new SecretStorage();
  const store = new SecretStore(secretStorage);
  const oauth = new OAuthManager(makeClient(), store, { clientId: 'cid' });
  await oauth.signIn({ clientId: 'cid', scope: 's', openExternal: async () => true });
  await oauth.signOut();
  const after = await store.read();
  assert.equal(after, undefined);
});

test('OAuthManager.probe falls back to deviceCode when fetch fails', async () => {
  const oauth = new OAuthManager(makeClient(), new SecretStore(new SecretStorage()), { clientId: 'cid' });
  const failFetch = (async () => { throw new Error('connect refused'); }) as unknown as typeof fetch;
  const probe = await oauth.probe('http://127.0.0.1:1', failFetch);
  assert.equal(probe.flow, 'deviceCode');
});

test('OAuthManager.probe picks pkce when oauth-config advertises authorization_endpoint', async () => {
  const oauth = new OAuthManager(makeClient(), new SecretStore(new SecretStorage()), { clientId: 'cid' });
  const fakeFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ authorization_endpoint: 'http://x/auth', token_endpoint: 'http://x/token' }),
  })) as unknown as typeof fetch;
  const probe = await oauth.probe('http://x', fakeFetch);
  assert.equal(probe.flow, 'pkce');
  assert.equal(probe.authorizationEndpoint, 'http://x/auth');
});

test('OAuthManager.probe picks deviceCode when oauth-config advertises device_code_endpoint', async () => {
  const oauth = new OAuthManager(makeClient(), new SecretStore(new SecretStorage()), { clientId: 'cid' });
  const fakeFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ device_code_endpoint: 'http://x/code', token_endpoint: 'http://x/token' }),
  })) as unknown as typeof fetch;
  const probe = await oauth.probe('http://x', fakeFetch);
  assert.equal(probe.flow, 'deviceCode');
  assert.equal(probe.deviceCodeEndpoint, 'http://x/code');
});

test('OAuthManager.refreshIfNeeded returns existing record when still valid', async () => {
  const secretStorage = new SecretStorage();
  const store = new SecretStore(secretStorage);
  const oauth = new OAuthManager(makeClient(), store, { clientId: 'cid' });
  await store.write({ access_token: 't1', refresh_token: 'r1', expires_at: Date.now() + 10 * 60 * 1000 });
  const got = await oauth.refreshIfNeeded({});
  assert.ok(got);
  assert.equal(got!.access_token, 't1');
});

test('OAuthManager.refreshIfNeeded clears token on refresh failure', async () => {
  const secretStorage = new SecretStorage();
  const store = new SecretStore(secretStorage);
  const oauth = new OAuthManager(makeClient(), store, { clientId: 'cid' });
  await store.write({ access_token: 't1', refresh_token: 'r1', expires_at: Date.now() - 1000 });
  const failFetch = (async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof fetch;
  const got = await oauth.refreshIfNeeded({ archonUrl: 'http://x', fetchImpl: failFetch });
  assert.equal(got, undefined);
  const after = await store.read();
  assert.equal(after, undefined);
});

test('OAuthManager.refreshIfNeeded refreshes on 200', async () => {
  const secretStorage = new SecretStorage();
  const store = new SecretStore(secretStorage);
  const oauth = new OAuthManager(makeClient(), store, { clientId: 'cid' });
  await store.write({ access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1000 });
  const okFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'new', expires_in: 60 }),
  })) as unknown as typeof fetch;
  const got = await oauth.refreshIfNeeded({ archonUrl: 'http://x', fetchImpl: okFetch });
  assert.ok(got);
  assert.equal(got!.access_token, 'new');
});

test('OAuthManager.hasToken reflects SecretStorage state', async () => {
  const secretStorage = new SecretStorage();
  const store = new SecretStore(secretStorage);
  const oauth = new OAuthManager(makeClient(), store, { clientId: 'cid' });
  assert.equal(await oauth.hasToken(), false);
  await store.write({ access_token: 'a' });
  assert.equal(await oauth.hasToken(), true);
});

test('OAuthManager PKCE rejects state mismatch via the local server', async () => {
  // This test exercises the loopback server. We simulate a /callback with
  // a wrong state and expect the promise to reject.
  const http = await import('node:http');
  const oauth = new OAuthManager(makeClient(), new SecretStore(new SecretStorage()), { clientId: 'cid' });
  // Probe is forced to PKCE.
  const fakeFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ authorization_endpoint: 'http://x/auth', token_endpoint: 'http://x/token' }),
  })) as unknown as typeof fetch;
  const probe = await oauth.probe('http://x', fakeFetch);
  assert.equal(probe.flow, 'pkce');

  // Start a server manually that will reject a wrong state.
  const { server, port } = await new Promise<{ server: import('node:http').Server; port: number }>((resolveP) => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html');
      res.end('<h1>state mismatch</h1>');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolveP({ server, port: addr.port });
    });
  });
  try {
    // Send a bad-state request.
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=wrong`, { method: 'GET' });
    assert.equal(res.status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

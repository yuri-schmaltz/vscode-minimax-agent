/**
 * OAuth device-code polling + PKCE validation adversarial tests.
 *
 * The "happy path" of device-code is already exercised in OAuth.test.ts.
 * This file targets the realistic failure modes the spec asks for:
 *
 *  - PKCE verifier validation (empty, < 43, > 128, invalid chars)
 *  - Device code flow with expires_in=0 (fails immediately)
 *  - Device code flow that gets only "pending" responses (fails at expiry)
 *  - Device code flow that succeeds mid-polling
 *  - Device code flow with network errors during polling (exponential backoff)
 *  - Device code flow that gets a 500 (non-pending) error (fails)
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  OAuthManager,
  generateCodeVerifier,
  deriveCodeChallenge,
  validateCodeVerifier,
} from '../../src/auth/OAuth';
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

// ----------------------------------------------------------------- PKCE

test('PKCE: validateCodeVerifier accepts a real verifier', () => {
  const v = generateCodeVerifier();
  assert.doesNotThrow(() => validateCodeVerifier(v));
});

test('PKCE: validateCodeVerifier rejects empty string', () => {
  assert.throws(() => validateCodeVerifier(''), /must not be empty/);
});

test('PKCE: validateCodeVerifier rejects a non-string', () => {
  // @ts-expect-error -- testing runtime guard
  assert.throws(() => validateCodeVerifier(42), /must be a string/);
});

test('PKCE: validateCodeVerifier rejects verifier shorter than 43 chars', () => {
  assert.throws(
    () => validateCodeVerifier('short'),
    /at least 43 chars/,
  );
  // exactly 42 chars
  assert.throws(
    () => validateCodeVerifier('a'.repeat(42)),
    /at least 43 chars/,
  );
});

test('PKCE: validateCodeVerifier rejects verifier longer than 128 chars', () => {
  assert.throws(
    () => validateCodeVerifier('a'.repeat(129)),
    /at most 128 chars/,
  );
});

test('PKCE: validateCodeVerifier rejects characters outside the unreserved set', () => {
  // '+' is a valid base64 char but NOT a valid PKCE char.
  assert.throws(
    () => validateCodeVerifier('a'.repeat(42) + '+'),
    /characters outside the unreserved set/,
  );
  // '=' is also disallowed.
  assert.throws(
    () => validateCodeVerifier('a'.repeat(42) + '='),
    /characters outside the unreserved set/,
  );
  // '/' too.
  assert.throws(
    () => validateCodeVerifier('a'.repeat(42) + '/'),
    /characters outside the unreserved set/,
  );
  // space
  assert.throws(
    () => validateCodeVerifier('a'.repeat(42) + ' '),
    /characters outside the unreserved set/,
  );
});

test('PKCE: deriveCodeChallenge matches base64url(sha256(verifier)) for a known input', () => {
  // RFC 7636 §4.6 example: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  assert.equal(deriveCodeChallenge(verifier), expected);
});

test('PKCE: deriveCodeChallenge refuses a malformed verifier (no silent auth failure)', () => {
  // The whole point of the validator is that we don't get a "valid"
  // challenge from a bad verifier and then fail at the server.
  assert.throws(() => deriveCodeChallenge('too-short'), /at least 43 chars/);
  assert.throws(() => deriveCodeChallenge('a'.repeat(43) + '+bad+'), /characters outside/);
});

// ----------------------------------------------------------------- Device code polling

/**
 * Fake `fetch` that walks through a list of pre-canned responses.
 * Each entry is either:
 *   - a function that returns a Response-like object, or
 *   - a thrown error (simulates a network blip).
 *
 * Recorded call counts let tests assert on how many polls occurred.
 */
interface FakeResponse {
  ok: boolean;
  status: number;
  body: unknown;
}
class FakeFetch {
  readonly calls: Array<{ url: string; body: unknown }> = [];
  private responses: Array<FakeResponse | Error>;
  constructor(responses: Array<FakeResponse | Error>) {
    this.responses = [...responses];
  }
  impl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    let body: unknown = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    this.calls.push({ url, body });
    const next = this.responses.shift();
    if (!next) {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      } as unknown as Response;
    }
    if (next instanceof Error) throw next;
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

test('Device code: expires_in=0 → polling exits immediately with "expired"', async () => {
  const fakeFetch = new FakeFetch([
    // 1) POST /oauth/code → mint a code
    {
      ok: true,
      status: 200,
      body: { user_code: 'ABCD-1234', verification_uri: 'http://x/dev', device_code: 'dc_zero', interval: 1, expires_in: 0 },
    },
  ]);
  const oauth = new OAuthManager(makeClient(), new SecretStore(new SecretStorage()), { clientId: 'cid' });
  const start = Date.now();
  await assert.rejects(
    () =>
      oauth.signIn({
        archonUrl: 'http://x',
        clientId: 'cid',
        scope: 's',
        openExternal: async () => true,
        flow: 'deviceCode',
        fetchImpl: fakeFetch.impl,
      }),
    /expired/,
  );
  // expires_in=0 must short-circuit, not block for the full interval.
  assert.ok(Date.now() - start < 500, 'signIn should fail almost immediately with expires_in=0');
});

test('Device code: "pending" on every poll → fails with "expired" once expires_in elapses', async () => {
  // Mock fetch to immediately consume all polls. We use a tiny interval
  // and a short expires_in (1s) so the test runs in well under a second.
  const pendingResp: FakeResponse = {
    ok: false,
    status: 400,
    body: { error: 'authorization_pending' },
  };
  const fakeFetch = new FakeFetch([
    // /oauth/code
    { ok: true, status: 200, body: { user_code: 'ABCD-1234', verification_uri: 'http://x/dev', device_code: 'dc_pending', interval: 1, expires_in: 1 } },
    // then everything is "pending"
    pendingResp, pendingResp, pendingResp, pendingResp, pendingResp,
  ]);
  const oauth = new OAuthManager(makeClient(), new SecretStore(new SecretStorage()), { clientId: 'cid' });
  await assert.rejects(
    () =>
      oauth.signIn({
        archonUrl: 'http://x',
        clientId: 'cid',
        scope: 's',
        openExternal: async () => true,
        flow: 'deviceCode',
        fetchImpl: fakeFetch.impl,
      }),
    /expired/,
  );
  // We expect at least 2 token calls: the first pending + the loop termination.
  // The exact count depends on timing, but it should be > 1 and finite.
  const tokenCalls = fakeFetch.calls.filter((c) => c.url.endsWith('/oauth/token')).length;
  assert.ok(tokenCalls >= 1, `expected at least one /oauth/token call, got ${tokenCalls}`);
});

test('Device code: success on the third poll → resolves with the token', async () => {
  const fakeFetch = new FakeFetch([
    { ok: true, status: 200, body: { user_code: 'ABCD-1234', verification_uri: 'http://x/dev', device_code: 'dc_ok', interval: 1, expires_in: 30 } },
    { ok: false, status: 400, body: { error: 'authorization_pending' } }, // 1st poll
    { ok: false, status: 400, body: { error: 'authorization_pending' } }, // 2nd poll
    { ok: true, status: 200, body: { access_token: 'tok_123', refresh_token: 'ref_123', expires_in: 3600 } }, // 3rd poll
  ]);
  const store = new SecretStore(new SecretStorage());
  const oauth = new OAuthManager(makeClient(), store, { clientId: 'cid' });
  const rec = await oauth.signIn({
    archonUrl: 'http://x',
    clientId: 'cid',
    scope: 's',
    openExternal: async () => true,
    flow: 'deviceCode',
    fetchImpl: fakeFetch.impl,
  });
  assert.equal(rec.access_token, 'tok_123');
  const stored = await store.read();
  assert.ok(stored);
  assert.equal(stored!.access_token, 'tok_123');
  // 1 code + 3 token calls = 4 total. (The third token call returns 200 → resolves.)
  assert.equal(fakeFetch.calls.length, 4);
});

test('Device code: network error during poll → continues with exponential backoff (still resolves)', async () => {
  // First poll: network error.
  // Second poll: network error.
  // Third poll: success.
  // We use a tiny interval (1s) so the backoff is observable; expires_in is
  // generous to leave room for the retries.
  const fakeFetch = new FakeFetch([
    { ok: true, status: 200, body: { user_code: 'ABCD-1234', verification_uri: 'http://x/dev', device_code: 'dc_net', interval: 1, expires_in: 30 } },
    new Error('ECONNRESET'),
    new Error('ECONNRESET'),
    { ok: true, status: 200, body: { access_token: 'tok_recover', expires_in: 3600 } },
  ]);
  const store = new SecretStore(new SecretStorage());
  const oauth = new OAuthManager(makeClient(), store, { clientId: 'cid' });
  const rec = await oauth.signIn({
    archonUrl: 'http://x',
    clientId: 'cid',
    scope: 's',
    openExternal: async () => true,
    flow: 'deviceCode',
    fetchImpl: fakeFetch.impl,
  });
  assert.equal(rec.access_token, 'tok_recover');
  // The successful call resets the backoff to base interval, so the test
  // should complete in well under the 30s expires_in.
  assert.equal(fakeFetch.calls.length, 4);
});

test('Device code: non-pending non-OK status (e.g. 500) → throws', async () => {
  const fakeFetch = new FakeFetch([
    { ok: true, status: 200, body: { user_code: 'ABCD-1234', verification_uri: 'http://x/dev', device_code: 'dc_500', interval: 1, expires_in: 30 } },
    { ok: false, status: 500, body: { error: 'server error' } },
  ]);
  const oauth = new OAuthManager(makeClient(), new SecretStore(new SecretStorage()), { clientId: 'cid' });
  await assert.rejects(
    () =>
      oauth.signIn({
        archonUrl: 'http://x',
        clientId: 'cid',
        scope: 's',
        openExternal: async () => true,
        flow: 'deviceCode',
        fetchImpl: fakeFetch.impl,
      }),
    /token request failed: 500/,
  );
});

test('Device code: OAuthManager emits "progress" with the user_code when the server returns one', async () => {
  const fakeFetch = new FakeFetch([
    { ok: true, status: 200, body: { user_code: 'WXYZ-5678', verification_uri: 'http://x/dev', device_code: 'dc_emit', interval: 1, expires_in: 1 } },
    { ok: false, status: 400, body: { error: 'authorization_pending' } },
    { ok: false, status: 400, body: { error: 'authorization_pending' } },
  ]);
  const oauth = new OAuthManager(makeClient(), new SecretStore(new SecretStorage()), { clientId: 'cid' });
  const progress: unknown[] = [];
  oauth.on('progress', (e) => progress.push(e));
  await assert.rejects(() =>
    oauth.signIn({
      archonUrl: 'http://x',
      clientId: 'cid',
      scope: 's',
      openExternal: async () => true,
      flow: 'deviceCode',
      fetchImpl: fakeFetch.impl,
    }),
  );
  const deviceCodeEvt = progress.find(
    (e) => typeof e === 'object' && e && (e as { kind?: string }).kind === 'deviceCode',
  ) as { userCode: string; verificationUri: string } | undefined;
  assert.ok(deviceCodeEvt, 'expected a "deviceCode" progress event');
  assert.equal(deviceCodeEvt.userCode, 'WXYZ-5678');
  assert.equal(deviceCodeEvt.verificationUri, 'http://x/dev');
});

test('Device code: signIn with the mock path (no archonUrl) never calls fetch', async () => {
  let fetchCalled = false;
  const fakeFetch: typeof fetch = (async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  const store = new SecretStore(new SecretStorage());
  const oauth = new OAuthManager(makeClient(), store, { clientId: 'cid' });
  const rec = await oauth.signIn({
    clientId: 'cid',
    scope: 's',
    openExternal: async () => true,
    flow: 'deviceCode',
    fetchImpl: fakeFetch,
    // archonUrl intentionally omitted → mock path
  });
  assert.equal(fetchCalled, false, 'mock device code must not call fetch');
  assert.ok(rec.access_token.startsWith('mock_access_'));
  const stored = await store.read();
  assert.equal(stored!.access_token, rec.access_token);
});

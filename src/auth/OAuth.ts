/**
 * OAuth flows for the Mavis extension.
 *
 * Two flows are supported (per PLAN.md §4.4):
 *
 *   A) Device code  — `POST /oauth/code` → poll `POST /oauth/token`.
 *      Default for first-party sandboxes where the user has no embedded
 *      browser and the archon-server doesn't expose a PKCE authorize URL.
 *
 *   B) PKCE + redirect — generate `code_verifier`/`code_challenge`, open
 *      the system browser, run a tiny local HTTP server on
 *      `127.0.0.1:<random>`, validate `state`, exchange `code` for tokens.
 *
 * Auto-detection: a single `GET {archonUrl}/.well-known/oauth-config.json`
 * is performed the first time the user signs in. If it returns the
 * `device_code_endpoint` field, flow A is used; if it returns
 * `authorization_endpoint`, flow B is used. On any failure we fall back
 * to device code (flow A).
 *
 * Tokens are persisted via SecretStore. Refresh is handled in 60s
 * pre-expiry or on 401.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { MavisClient } from '../client/MavisClient';
import { SecretStore, AuthRecord } from './SecretStore';

export type OAuthFlowKind = 'deviceCode' | 'pkce';

export interface OAuthOptions {
  archonUrl?: string;
  clientId: string;
  scope: string;
  openExternal: (url: string) => Promise<boolean>;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Force a flow. Defaults to 'auto' → probe. */
  flow?: 'auto' | OAuthFlowKind;
}

export interface OAuthProbe {
  flow: OAuthFlowKind;
  deviceCodeEndpoint?: string;
  tokenEndpoint?: string;
  authorizationEndpoint?: string;
}

const DEFAULT_SCOPE = 'group_id profile model.completion';

/** PKCE helpers — exported for tests. */
export function generateCodeVerifier(): string {
  // RFC 7636: 43–128 chars, [A-Za-z0-9-._~]
  return base64UrlEncode(crypto.randomBytes(32));
}

/**
 * Validate a code verifier per RFC 7636 §4.1.
 *
 * Throws an Error with a descriptive message if the verifier is empty,
 * too short, too long, or contains characters outside the unreserved
 * set `[A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"`.
 *
 * The function is exported for downstream consumers (and tests) that
 * need to assert "this is a real RFC-7636-conformant verifier" before
 * passing it to a token endpoint.
 */
export function validateCodeVerifier(verifier: string): void {
  if (typeof verifier !== 'string') {
    throw new TypeError('code_verifier must be a string');
  }
  if (verifier.length === 0) {
    throw new RangeError('code_verifier must not be empty');
  }
  if (verifier.length < 43) {
    throw new RangeError(
      `code_verifier must be at least 43 chars (RFC 7636 §4.1); got ${verifier.length}`,
    );
  }
  if (verifier.length > 128) {
    throw new RangeError(
      `code_verifier must be at most 128 chars (RFC 7636 §4.1); got ${verifier.length}`,
    );
  }
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) {
    throw new RangeError(
      'code_verifier contains characters outside the unreserved set [A-Z a-z 0-9 - . _ ~]',
    );
  }
}

export function deriveCodeChallenge(verifier: string): string {
  // Refuse to produce a challenge from an obviously-bad verifier; the
  // alternative is a silent auth failure at the token endpoint, which is
  // harder to diagnose.
  validateCodeVerifier(verifier);
  return base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
}

export function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(16));
}

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export class OAuthManager extends EventEmitter {
  private currentClientId: string;
  private currentScope: string;
  // Reserved for future integrations that need to spawn a session before
  // exchanging the token. Kept as a constructor param for API stability.
  // The leading underscore + @ts-expect-error keeps the linter happy until
  // the first use case lands.
  // @ts-expect-error -- reserved; remove once consumed by token bootstrap.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly _mavis: MavisClient;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(
    _mavis: MavisClient,
    private readonly secrets: SecretStore,
    opts: Partial<OAuthOptions> = {},
  ) {
    super();
    this.currentClientId = opts.clientId ?? 'minimax-vscode-agent';
    this.currentScope = opts.scope ?? DEFAULT_SCOPE;
  }

  /** Event types: 'progress' (with human-readable status), 'token' (on success). */
  // inherited from EventEmitter

  /** Probe the archon-server to pick the right flow. Returns the kind + endpoints. */
  async probe(archonUrl: string, fetchImpl?: typeof fetch): Promise<OAuthProbe> {
    const f = fetchImpl ?? globalThis.fetch;
    if (!f) {
      return { flow: 'deviceCode' };
    }
    try {
      const url = `${archonUrl.replace(/\/$/, '')}/.well-known/oauth-config.json`;
      const res = await f(url, { method: 'GET' });
      if (!res.ok) return { flow: 'deviceCode' };
      const cfg = (await res.json()) as Record<string, string | undefined>;
      if (cfg.device_code_endpoint && cfg.token_endpoint) {
        return {
          flow: 'deviceCode',
          deviceCodeEndpoint: cfg.device_code_endpoint,
          tokenEndpoint: cfg.token_endpoint,
        };
      }
      if (cfg.authorization_endpoint && cfg.token_endpoint) {
        return {
          flow: 'pkce',
          authorizationEndpoint: cfg.authorization_endpoint,
          tokenEndpoint: cfg.token_endpoint,
        };
      }
    } catch {
      /* network errors → fall back */
    }
    return { flow: 'deviceCode' };
  }

  /**
   * High-level entry: probes (or uses override), runs the chosen flow, and
   * persists the result in SecretStore.
   */
  async signIn(opts: OAuthOptions): Promise<AuthRecord> {
    this.currentClientId = opts.clientId || this.currentClientId;
    this.currentScope = opts.scope || this.currentScope;

    let flow: OAuthFlowKind = opts.flow && opts.flow !== 'auto' ? opts.flow : 'deviceCode';
    if ((!opts.flow || opts.flow === 'auto') && opts.archonUrl) {
      const probe = await this.probe(opts.archonUrl, opts.fetchImpl);
      flow = probe.flow;
    }
    this.emit('progress', { kind: 'flow', flow });

    let result: AuthRecord;
    if (flow === 'pkce' && opts.archonUrl) {
      result = await this.runPkce(opts);
    } else {
      result = await this.runDeviceCode(opts);
    }
    await this.secrets.write(result);
    this.emit('token', result);
    return result;
  }

  /** Sign-out: clears SecretStore (and best-effort revocation). */
  async signOut(opts: { archonUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<void> {
    const existing = await this.secrets.read();
    if (existing && opts.archonUrl) {
      const f = opts.fetchImpl ?? globalThis.fetch;
      if (f) {
        try {
          await f(`${opts.archonUrl.replace(/\/$/, '')}/oauth/revoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: existing.access_token }),
          });
        } catch {
          /* revoke is best-effort */
        }
      }
    }
    await this.secrets.clear();
    this.emit('token', undefined);
  }

  /**
   * If we have a token that expires in <60s, attempt to refresh. Returns the
   * up-to-date record (or undefined if no token stored).
   */
  async refreshIfNeeded(opts: { archonUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<AuthRecord | undefined> {
    const rec = await this.secrets.read();
    if (!rec) return undefined;
    if (!rec.expires_at) return rec;
    const skew = 60_000;
    if (rec.expires_at - Date.now() > skew) return rec;
    if (!rec.refresh_token || !opts.archonUrl) {
      // Force re-login.
      await this.secrets.clear();
      return undefined;
    }
    const f = opts.fetchImpl ?? globalThis.fetch;
    if (!f) return rec;
    try {
      const res = await f(`${opts.archonUrl.replace(/\/$/, '')}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: this.currentClientId,
          refresh_token: rec.refresh_token,
        }),
      });
      if (!res.ok) {
        await this.secrets.clear();
        return undefined;
      }
      const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
      const next: AuthRecord = {
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? rec.refresh_token,
        expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
      };
      await this.secrets.write(next);
      return next;
    } catch {
      return rec;
    }
  }

  /** Returns true if a token is present (does NOT return the token itself). */
  async hasToken(): Promise<boolean> {
    const rec = await this.secrets.read();
    return Boolean(rec && rec.access_token);
  }

  // ------------------------------------------------------------------ internals

  private async runDeviceCode(opts: OAuthOptions): Promise<AuthRecord> {
    if (!opts.archonUrl) {
      // Pure mock path used by tests and the bundled shim.
      return this.runMockDeviceCode();
    }
    const f = opts.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('No fetch available and archonUrl not in mock mode');
    const codeRes = await f(`${opts.archonUrl.replace(/\/$/, '')}/oauth/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.currentClientId, scope: this.currentScope }),
    });
    if (!codeRes.ok) throw new Error(`device code request failed: ${codeRes.status}`);
    const codeBody = (await codeRes.json()) as {
      user_code: string;
      verification_uri: string;
      device_code: string;
      interval: number;
      expires_in: number;
    };
    this.emit('progress', {
      kind: 'deviceCode',
      userCode: codeBody.user_code,
      verificationUri: codeBody.verification_uri,
    });
    if (codeBody.verification_uri) {
      try {
        await opts.openExternal(codeBody.verification_uri);
      } catch {
        /* user can copy the code manually */
      }
    }
    const startedAt = Date.now();
    const intervalMs = Math.max(1, codeBody.interval) * 1000;
    const expiresAt = startedAt + codeBody.expires_in * 1000;
    // Exponential backoff for network errors. Reset to the base interval as
    // soon as a poll round succeeds (or the server replies with a real
    // status). Cap at 8× the base interval to stay well below expires_in.
    let backoff = intervalMs;
    const backoffCap = intervalMs * 8;
    let pendingAttempts = 0;
    while (Date.now() < expiresAt) {
      const remaining = expiresAt - Date.now();
      const wait = Math.min(remaining, backoff);
      if (wait <= 0) break;
      await sleep(wait);
      let res: Response;
      try {
        res = await f(`${opts.archonUrl.replace(/\/$/, '')}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'urn:mavis:params:oauth:grant-type:device_code',
            client_id: this.currentClientId,
            device_code: codeBody.device_code,
          }),
        });
        // A real round-trip (success or HTTP error) counts as a successful
        // reachability check; reset the backoff so a transient blip doesn't
        // permanently slow the poll loop.
        backoff = intervalMs;
      } catch (err) {
        // Network blip — exponential backoff, then keep polling until expiry.
        backoff = Math.min(backoffCap, backoff * 2);
        continue;
      }
      if (res.ok) {
        const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
        return {
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
        };
      }
      if (res.status === 400 || res.status === 401) {
        // authorization_pending or slow_down — keep polling.
        pendingAttempts += 1;
        continue;
      }
      throw new Error(`device code token request failed: ${res.status}`);
    }
    void pendingAttempts; // reserved for future telemetry
    throw new Error('device code flow expired');
  }

  private async runMockDeviceCode(): Promise<AuthRecord> {
    // Use the shim CLI to mint a code + token in mock mode.
    this.emit('progress', { kind: 'deviceCode', userCode: '----', verificationUri: 'mock://' });
    return {
      access_token: 'mock_access_' + crypto.randomBytes(8).toString('hex'),
      refresh_token: 'mock_refresh_' + crypto.randomBytes(8).toString('hex'),
      expires_at: Date.now() + 3600 * 1000,
    };
  }

  private async runPkce(opts: OAuthOptions): Promise<AuthRecord> {
    if (!opts.archonUrl) throw new Error('PKCE flow requires archonUrl');
    const f = opts.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('No fetch available');

    const verifier = generateCodeVerifier();
    const challenge = deriveCodeChallenge(verifier);
    const state = generateState();

    const { port, callbackPromise, close } = await startLoopbackServer(state);
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const authorizeUrl = new URL(`${opts.archonUrl.replace(/\/$/, '')}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', this.currentClientId);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('scope', this.currentScope);

    this.emit('progress', { kind: 'pkce', url: authorizeUrl.toString() });
    await opts.openExternal(authorizeUrl.toString());

    const code = await callbackPromise;
    close();

    const tokenRes = await f(`${opts.archonUrl.replace(/\/$/, '')}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.currentClientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) throw new Error(`pkce token exchange failed: ${tokenRes.status}`);
    const body = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface LoopbackHandle {
  port: number;
  callbackPromise: Promise<string>;
  close(): void;
}

async function startLoopbackServer(expectedState: string): Promise<LoopbackHandle> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  const callbackPromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    try {
      const port = (server.address() as AddressInfo | null)?.port ?? 0;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (state !== expectedState) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html');
        res.end('<h1>state mismatch</h1>');
        rejectCode?.(new Error('state mismatch'));
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html');
        res.end('<h1>missing code</h1>');
        rejectCode?.(new Error('missing code'));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end('<h1>You can close this tab.</h1><p>Mavis sign-in complete.</p>');
      resolveCode?.(code);
    } catch (err) {
      rejectCode?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const port = addr.port;

  // Safety net: abort if no callback within 5 minutes.
  const timer = setTimeout(() => {
    rejectCode?.(new Error('pkce callback timeout'));
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }, 5 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    port,
    callbackPromise,
    close: () => {
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}

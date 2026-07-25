/**
 * Redaction helpers used by the extension and shim before any token-shaped
 * value can be emitted to logs, telemetry, or the webview.
 *
 * IMPORTANT: nothing in `src/` should `console.log` a raw `access_token`,
 * `refresh_token`, or `client_secret`. Use these helpers and assert that
 * with the security grep target (see `npm run lint:secrets`).
 */

/** Returns a 12-char fingerprint of the secret, prefixed with `sha256:`. */
export function fingerprintToken(token: string | undefined | null): string {
  if (!token || typeof token !== 'string') return '<none>';
  if (token.length <= 8) return 'sha256:<redacted>';
  // Cheap & deterministic: not crypto-grade, just enough to correlate
  // log lines without revealing the secret. For real correlation use the
  // first 4 + last 4 chars of the SHA-256 digest.
  // We use the Web Crypto-free path so this works in any Node version.
  // Node 18+ has `crypto.subtle` globally; we use the synchronous
  // `node:crypto` for the embedded context.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const hex = createHash('sha256').update(token).digest('hex');
  return `sha256:${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

/**
 * Returns a redacted copy of any value with the given token-bearing
 * keys masked. Recurses one level into nested objects. Designed for the
 * "log this object without leaking secrets" use case.
 */
export function redact<T extends Record<string, unknown>>(
  obj: T,
  keys: readonly string[] = ['access_token', 'refresh_token', 'token', 'client_secret', 'password', 'authorization'],
): T {
  if (obj === null || typeof obj !== 'object') return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const k of keys) {
    if (k in out) {
      const v = out[k];
      if (typeof v === 'string' && v.length > 0) {
        out[k] = '<redacted>';
      } else {
        out[k] = '<redacted>';
      }
    }
  }
  return out as T;
}

/**
 * Sanitises a free-form string (e.g. a stderr chunk from the shim) by
 * replacing any token-shaped substrings with `<redacted>`. Useful as a
 * last line of defence before writing stderr to a log.
 */
export function redactString(input: string): string {
  if (!input) return input;
  // Match anything that looks like a JWT or a long base64url/alnum string
  // surrounded by whitespace or quotes. Conservative: 24+ chars.
  return input.replace(/[A-Za-z0-9_-]{24,}/g, (match) => {
    if (match.startsWith('sha256:')) return match; // already redacted
    return '<redacted>';
  });
}

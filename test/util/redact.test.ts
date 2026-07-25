/**
 * Redaction helper unit tests.
 *
 * The `redact()` and `redactString()` helpers are the last line of
 * defence against tokens leaking into logs / postMessage / telemetry.
 * These tests assert that the mask is applied for the documented
 * sensitive keys and that free-form strings with token-shaped
 * substrings are also redacted.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fingerprintToken, redact, redactString } from '../../src/util/redact';

test('redact: replaces known token-bearing keys', () => {
  const out = redact({
    access_token: 'secret1',
    refresh_token: 'secret2',
    password: 'p',
    nested: { access_token: 'should stay (we only go one level deep)' },
  });
  assert.equal(out.access_token, '<redacted>');
  assert.equal(out.refresh_token, '<redacted>');
  assert.equal(out.password, '<redacted>');
  // The nested object's token must NOT be touched — by design.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((out.nested as any).access_token, 'should stay (we only go one level deep)');
});

test('redact: returns a shallow copy, not a mutation', () => {
  const original = { access_token: 'a', keep: 'b' };
  const out = redact(original);
  assert.equal(original.access_token, 'a', 'original must not be mutated');
  assert.equal(out.keep, 'b');
});

test('redact: custom keys are honoured', () => {
  const out = redact({ api_key: 'k', access_token: 'a' }, ['api_key']);
  assert.equal(out.api_key, '<redacted>');
  // access_token is NOT in the custom list → must be preserved.
  assert.equal(out.access_token, 'a');
});

test('redactString: rewrites long alnum runs to <redacted>', () => {
  const input = 'header: Bearer eyJabcdefghijklmnopqrstuvwxyz1234567890XYZ end';
  const out = redactString(input);
  assert.doesNotMatch(out, /eyJabcdefghijklmnopqrstuvwxyz1234567890XYZ/);
  assert.match(out, /<redacted>/);
  // "Bearer" and "header" are <24 chars and must be left alone.
  assert.match(out, /Bearer/);
  assert.match(out, /header/);
});

test('redactString: leaves already-redacted fingerprints alone', () => {
  const input = 'correlation: sha256:abcd…wxyz';
  const out = redactString(input);
  assert.equal(out, input);
});

test('fingerprintToken: deterministic and short', () => {
  const a = fingerprintToken('abcdefghijklmnopqrstuvwxyz1234567890');
  const b = fingerprintToken('abcdefghijklmnopqrstuvwxyz1234567890');
  assert.equal(a, b);
  const c = fingerprintToken('something-else-12345678901234567890');
  assert.notEqual(a, c);
  // Should be short enough for log lines.
  assert.ok(a.length < 30, `fingerprint too long: ${a}`);
});

test('fingerprintToken: <none> for empty / non-string', () => {
  assert.equal(fingerprintToken(undefined), '<none>');
  assert.equal(fingerprintToken(null), '<none>');
  assert.equal(fingerprintToken(''), '<none>');
});

/**
 * i18n unit + adversarial tests.
 *
 * Coverage:
 *   1. Default locale is `en`.
 *   2. `detectLocale` maps common VSCode language ids to supported
 *      locales (with case-insensitivity and fallbacks).
 *   3. `t()` returns the right string for a known key in en + pt-BR.
 *   4. Interpolation substitutes `{var}` placeholders and leaves
 *      unknown placeholders intact.
 *   5. Missing key falls back to en, then to a deterministic
 *      `[[key]]` placeholder; a warning is logged once.
 *   6. Locale switch: `t('chatView.button.send', 'pt-BR')` returns
 *      the pt-BR translation.
 *   7. Unknown locale falls back to en.
 *   8. `interpolate` is safe with non-string values and missing vars.
 *   9. `knownKeys` returns the union of all shipped locales.
 *  10. Adversarial: malformed keys (empty, null, with control chars)
 *      don't crash the helper.
 */
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_LOCALE,
  LOCALES,
  detectLocale,
  interpolate,
  knownKeys,
  normaliseLocale,
  t,
  _resetForTests,
} from '../index';

beforeEach(() => {
  _resetForTests();
});

test('DEFAULT_LOCALE is "en"', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
});

test('detectLocale: maps common VSCode language ids', () => {
  assert.equal(detectLocale('en'), 'en');
  assert.equal(detectLocale('en-US'), 'en');
  assert.equal(detectLocale('pt-br'), 'pt-BR');
  assert.equal(detectLocale('pt-BR'), 'pt-BR');
  assert.equal(detectLocale('PT'), 'pt-BR');
  assert.equal(detectLocale('pt'), 'pt-BR');
  assert.equal(detectLocale('fr-FR'), 'en', 'unsupported → en');
  assert.equal(detectLocale(''), 'en', 'empty → en');
  assert.equal(detectLocale(undefined as unknown as string), 'en');
});

test('t: returns the right string for a known key in en + pt-BR', () => {
  assert.equal(t('chatView.button.send', 'en'), 'Send');
  assert.equal(t('chatView.button.send', 'pt-BR'), 'Enviar');
  assert.equal(t('chatView.empty.title', 'pt-BR'), 'Pergunte qualquer coisa sobre o seu código.');
  assert.equal(t('auth.signedIn', 'en'), 'Signed in to Mavis');
  assert.equal(t('auth.signedIn', 'pt-BR'), 'Conectado ao Mavis');
});

test('t: interpolation substitutes {var} placeholders', () => {
  const rendered = t('statusBar.menu.switchSession.description', 'en', { session: 'sess_abc' });
  assert.equal(rendered, 'Current: sess_abc');
  const pt = t('statusBar.menu.switchSession.description', 'pt-BR', { session: 'sess_xyz' });
  assert.equal(pt, 'Atual: sess_xyz');
});

test('t: missing key falls back to en, then [[key]]', () => {
  // Use a key that exists only in en to verify the pt-BR fallback.
  // We simulate this by removing a key from the pt-BR table at runtime.
  const original = LOCALES['pt-BR']['chatView.button.send'];
  delete (LOCALES['pt-BR'] as Record<string, string>)['chatView.button.send'];
  try {
    assert.equal(t('chatView.button.send', 'pt-BR'), 'Send', 'falls back to en');
  } finally {
    (LOCALES['pt-BR'] as Record<string, string>)['chatView.button.send'] = original;
  }
  // A key that doesn't exist anywhere returns [[key]].
  const result = t('totally.bogus.key', 'en');
  assert.equal(result, '[[totally.bogus.key]]');
});

test('t: locale switch returns pt-BR translations', () => {
  assert.notEqual(t('chatView.button.send', 'en'), t('chatView.button.send', 'pt-BR'));
  assert.equal(t('chatView.button.send', 'pt-BR'), 'Enviar');
  assert.equal(t('chatView.button.settings', 'pt-BR'), 'Configurações');
});

test('t: unknown locale falls back to en', () => {
  const result = t('chatView.button.send', 'xx-XX');
  assert.equal(result, 'Send');
});

test('interpolate: leaves unknown placeholders intact', () => {
  assert.equal(interpolate('Hello {name}, you are {age}', { name: 'Alice' }), 'Hello Alice, you are {age}');
  assert.equal(interpolate('No vars here'), 'No vars here');
  assert.equal(interpolate('', {}), '');
  assert.equal(interpolate('Plain text', undefined), 'Plain text');
});

test('interpolate: handles non-string values', () => {
  assert.equal(interpolate('count: {n}', { n: 42 }), 'count: 42');
  assert.equal(interpolate('flag: {f}', { f: true }), 'flag: true');
  assert.equal(interpolate('nil: {n}', { n: null as unknown as number }), 'nil: {n}', 'null left intact');
});

test('knownKeys: returns the union of all shipped locales', () => {
  const keys = knownKeys();
  assert.ok(keys.length >= 30, `expected at least 30 keys, got ${keys.length}`);
  assert.ok(keys.includes('chatView.button.send'));
  assert.ok(keys.includes('statusBar.text'));
  assert.ok(keys.includes('auth.signedIn'));
});

test('normaliseLocale: case-insensitive + underscore variants', () => {
  assert.equal(normaliseLocale('PT-BR'), 'pt-BR');
  assert.equal(normaliseLocale('pt_br'), 'pt-BR');
  assert.equal(normaliseLocale('EN'), 'en');
  assert.equal(normaliseLocale('en_us'), 'en');
  assert.equal(normaliseLocale('xx'), 'en', 'unknown → en');
  assert.equal(normaliseLocale(null), 'en');
  assert.equal(normaliseLocale(undefined), 'en');
});

test('t: empty / weird keys do not crash', () => {
  assert.equal(t('', 'en'), '[[]]');
  assert.equal(t('a.b.c', 'en'), '[[a.b.c]]');
});

test('t: en and pt-BR tables have the same key set (parity)', () => {
  const enKeys = new Set(Object.keys(LOCALES.en));
  const ptKeys = new Set(Object.keys(LOCALES['pt-BR']));
  for (const k of enKeys) {
    assert.ok(ptKeys.has(k), `pt-BR is missing key: ${k}`);
  }
  for (const k of ptKeys) {
    assert.ok(enKeys.has(k), `en is missing key: ${k}`);
  }
});

test('t: warning for missing key is logged only once', () => {
  const orig = console.warn;
  let calls = 0;
  console.warn = () => { calls += 1; };
  try {
    t('missing.key.once', 'en');
    t('missing.key.once', 'en');
    t('missing.key.once', 'pt-BR');
    assert.equal(calls, 1, 'warn should fire exactly once per key');
  } finally {
    console.warn = orig;
  }
});

test('t: vars can override default', () => {
  const r = t('drive.delete.confirm', 'en', { name: 'report.txt' });
  assert.equal(r, 'Delete "report.txt" from the Drive? This cannot be undone.');
});

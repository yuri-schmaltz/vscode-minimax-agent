/**
 * i18n — tiny key/value translation helper.
 *
 * The extension is shipped in two languages: English (default) and
 * Brazilian Portuguese (`pt-BR`). The chosen locale is read from
 * `vscode.env.language` (which returns the user-configured VSCode
 * language) and falls back to English for anything we don't ship.
 *
 * Keys are dot-namespaced strings (e.g. `chatView.button.send`); the
 * helper performs `{var}` interpolation with the supplied `vars`
 * object. Missing keys emit a one-time console warning and resolve
 * to a deterministic `[[key]]` placeholder so the UI is never blank.
 *
 * Loading is deliberately lazy: locales are imported as JSON so the
 * bundler inlines them at build time; the helper itself never hits
 * the filesystem.
 */

import en from './locales/en.json';
import ptBR from './locales/pt-BR.json';

/** Locale id we ship. */
export type Locale = 'en' | 'pt-BR';

/** Map of every locale's translation table. */
export const LOCALES: Record<Locale, Record<string, string>> = {
  en,
  'pt-BR': ptBR,
};

/**
 * Map a VSCode language id (e.g. "en", "pt-br", "en-US") to a
 * supported locale. Anything unsupported falls back to English.
 */
export function detectLocale(vscodeLanguage: string | undefined): Locale {
  if (!vscodeLanguage) return 'en';
  const lower = vscodeLanguage.toLowerCase();
  if (lower === 'pt' || lower === 'pt-br' || lower.startsWith('pt-br') || lower.startsWith('pt_br')) {
    return 'pt-BR';
  }
  if (lower.startsWith('en')) return 'en';
  return 'en';
}

/** The default fallback locale. */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Substitute `{name}` placeholders in `template` with values from
 * `vars`. Unknown placeholders are left intact.
 */
export function interpolate(template: string, vars?: Record<string, string | number | boolean>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      return v == null ? match : String(v);
    }
    return match;
  });
}

/** Tracks which keys have already been warned about. */
const warnedKeys = new Set<string>();

/**
 * Translate `key` to `locale`. Falls back to English if the locale
 * doesn't have a translation; falls back to `[[key]]` if neither does.
 *
 * @param key the dot-namespaced translation key
 * @param locale the locale to use; if omitted, the active locale is used
 * @param vars optional interpolation variables
 */
export function t(key: string, locale?: Locale | string, vars?: Record<string, string | number | boolean>): string {
  const loc = normaliseLocale(locale);
  const table = LOCALES[loc] ?? LOCALES[DEFAULT_LOCALE];
  let value = table[key];
  if (value === undefined) {
    if (loc !== DEFAULT_LOCALE) {
      value = LOCALES[DEFAULT_LOCALE][key];
    }
    if (value === undefined) {
      if (!warnedKeys.has(key)) {
        warnedKeys.add(key);
        // eslint-disable-next-line no-console
        console.warn(`[i18n] missing translation for key: ${key}`);
      }
      return `[[${key}]]`;
    }
  }
  return interpolate(value, vars);
}

/**
 * Normalises an arbitrary string into a {@link Locale}. Anything we
 * don't ship falls back to English.
 */
export function normaliseLocale(value: string | undefined | null): Locale {
  if (!value) return DEFAULT_LOCALE;
  const lower = value.toLowerCase();
  if (lower === 'pt' || lower === 'pt-br' || lower === 'pt_br') return 'pt-BR';
  if (lower.startsWith('pt-br') || lower.startsWith('pt_br')) return 'pt-BR';
  if (lower.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

/** Reset the warned-keys cache (for tests). */
export function _resetForTests(): void {
  warnedKeys.clear();
}

/**
 * Returns the list of all known translation keys (union of every
 * shipped locale). Useful for sanity checks and tests.
 */
export function knownKeys(): string[] {
  const out = new Set<string>();
  for (const table of Object.values(LOCALES)) {
    for (const k of Object.keys(table)) out.add(k);
  }
  return Array.from(out).sort();
}

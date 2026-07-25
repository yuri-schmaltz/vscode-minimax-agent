/**
 * Mavis settings webview (React).
 *
 * Renders a form with:
 *   - telemetry (toggle)
 *   - defaultAgent (input + datalist of known agents)
 *   - cliPath (input + Browse button)
 *   - model (input)
 *   - cliVersion (read-only)
 *   - Save / Discard buttons
 *
 * Loads `mavis.settings` from the host on mount. Posts `settings:save`
 * on submit. All strings are i18n'd through a tiny in-bundle `t()`.
 */
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

// --- minimal i18n shim (mirrors src/i18n/index.ts so the bundle ships
//     the strings as data, not as a runtime fetch). -------------------
type Locale = 'en' | 'pt-BR';

const STRINGS: Record<Locale, Record<string, string>> = {
  en: {
    'settings.title': 'Mavis settings',
    'settings.label.telemetry': 'Anonymous telemetry',
    'settings.help.telemetry': 'Sends only the command id, message length, code-action kind, and cron id (no content).',
    'settings.label.defaultAgent': 'Default agent',
    'settings.help.defaultAgent': 'Which Mavis agent to spawn for new chats.',
    'settings.label.cliPath': 'CLI path',
    'settings.help.cliPath': 'Override the path to the mavis CLI binary. Leave empty to use the bundled shim.',
    'settings.button.browse': 'Browse...',
    'settings.label.model': 'Model',
    'settings.help.model': 'Override the model used for completions. Empty means server default.',
    'settings.label.cliVersion': 'Bundled CLI version',
    'settings.help.cliVersion': 'Read-only. The CLI version shipped with this extension.',
    'settings.button.save': 'Save',
    'settings.button.discard': 'Discard',
    'settings.label.language': 'Language',
    'settings.help.language': 'Display language for the user interface.',
    'settings.saved': 'Mavis settings saved.',
    'settings.discarded': 'Changes discarded.',
    'settings.invalid': 'Some fields contain invalid values.',
  },
  'pt-BR': {
    'settings.title': 'Configurações do Mavis',
    'settings.label.telemetry': 'Telemetria anônima',
    'settings.help.telemetry': 'Envia apenas o id do comando, tamanho da mensagem, tipo da ação de código e id do cron (sem conteúdo).',
    'settings.label.defaultAgent': 'Agente padrão',
    'settings.help.defaultAgent': 'Qual agente Mavis iniciar em novas conversas.',
    'settings.label.cliPath': 'Caminho do CLI',
    'settings.help.cliPath': 'Sobrescreve o caminho do binário mavis. Vazio usa o shim empacotado.',
    'settings.button.browse': 'Procurar...',
    'settings.label.model': 'Modelo',
    'settings.help.model': 'Sobrescreve o modelo usado para respostas. Vazio usa o padrão do servidor.',
    'settings.label.cliVersion': 'Versão do CLI empacotado',
    'settings.help.cliVersion': 'Somente leitura. Versão do CLI incluída nesta extensão.',
    'settings.button.save': 'Salvar',
    'settings.button.discard': 'Descartar',
    'settings.label.language': 'Idioma',
    'settings.help.language': 'Idioma de exibição da interface.',
    'settings.saved': 'Configurações do Mavis salvas.',
    'settings.discarded': 'Alterações descartadas.',
    'settings.invalid': 'Alguns campos contêm valores inválidos.',
  },
};

function interpolate(s: string, vars?: Record<string, string | number | boolean>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] == null ? m : String(vars[n])));
}

function tFor(locale: Locale, key: string, vars?: Record<string, string | number | boolean>): string {
  const v = STRINGS[locale]?.[key] ?? STRINGS.en[key] ?? `[[${key}]]`;
  return interpolate(v, vars);
}

// --- postMessage bridge -----------------------------------------------
declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
  }
}
const vscode = (typeof window !== 'undefined' && window.acquireVsCodeApi)
  ? window.acquireVsCodeApi()
  : { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };

interface MavisSettings {
  telemetry: boolean;
  defaultAgent: string;
  cliPath: string;
  model: string;
  locale: Locale;
}

interface LoadedMsg {
  type: 'settings:loaded';
  settings: MavisSettings;
  defaults: MavisSettings;
  agents: Array<{ id: string; name: string }>;
  cliVersion: string;
  locale: Locale;
}

interface SavedMsg { type: 'settings:saved'; settings: MavisSettings }
interface DiscardedMsg { type: 'settings:discarded'; settings: MavisSettings }
interface CliPickedMsg { type: 'settings:cliPicked'; path: string }
type InMsg = LoadedMsg | SavedMsg | DiscardedMsg | CliPickedMsg;

type OutMsg =
  | { type: 'ready' }
  | { type: 'settings:save'; settings: Partial<MavisSettings> }
  | { type: 'settings:discard' }
  | { type: 'settings:browse-cli' };

function postToHost(msg: OutMsg): void {
  vscode.postMessage(msg);
}

export function SettingsApp(): JSX.Element {
  const [loaded, setLoaded] = useState<LoadedMsg | null>(null);
  const [draft, setDraft] = useState<MavisSettings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    function onMessage(ev: MessageEvent<InMsg>) {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'settings:loaded':
          setLoaded(msg);
          setDraft({ ...msg.settings });
          return;
        case 'settings:saved':
          setDraft({ ...msg.settings });
          setStatus(tFor(msg.settings.locale, 'settings.saved'));
          setInvalid(false);
          return;
        case 'settings:discarded':
          setDraft({ ...msg.settings });
          setStatus(tFor(msg.settings.locale, 'settings.discarded'));
          return;
        case 'settings:cliPicked':
          setDraft((d) => (d ? { ...d, cliPath: msg.path } : d));
          return;
      }
    }
    window.addEventListener('message', onMessage);
    postToHost({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const locale: Locale = draft?.locale ?? 'en';
  const t = useCallback(
    (k: string, vars?: Record<string, string | number | boolean>) => tFor(locale, k, vars),
    [locale],
  );

  const onField = useCallback(<K extends keyof MavisSettings>(key: K, value: MavisSettings[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }, []);

  const onSave = useCallback(() => {
    if (!draft) return;
    // Validation: cliPath is a string (any path is allowed).
    // model is a string (any string is allowed).
    // defaultAgent is a non-empty string.
    if (!draft.defaultAgent.trim()) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setStatus(null);
    postToHost({ type: 'settings:save', settings: draft });
  }, [draft]);

  const onDiscard = useCallback(() => {
    if (!loaded) return;
    setDraft({ ...loaded.settings });
    setStatus(t('settings.discarded'));
  }, [loaded, t]);

  const onBrowse = useCallback(() => {
    postToHost({ type: 'settings:browse-cli' });
  }, []);

  const agents = useMemo(() => loaded?.agents ?? [], [loaded]);
  const cliVersion = loaded?.cliVersion ?? '—';

  if (!draft || !loaded) {
    return <div className="mavis-settings-loading">Loading…</div>;
  }

  return (
    <div className="mavis-settings-root">
      <h1 className="mavis-settings-title">{t('settings.title')}</h1>

      {status && <div className="mavis-settings-status" role="status">{status}</div>}
      {invalid && <div className="mavis-settings-invalid" role="alert">{t('settings.invalid')}</div>}

      <form className="mavis-settings-form" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
        <div className="mavis-settings-field">
          <label htmlFor="mavis-telemetry">
            <input
              id="mavis-telemetry"
              type="checkbox"
              checked={draft.telemetry}
              onChange={(e) => onField('telemetry', e.target.checked)}
            />
            <span>{t('settings.label.telemetry')}</span>
          </label>
          <p className="mavis-settings-help">{t('settings.help.telemetry')}</p>
        </div>

        <div className="mavis-settings-field">
          <label htmlFor="mavis-default-agent">{t('settings.label.defaultAgent')}</label>
          <input
            id="mavis-default-agent"
            list="mavis-agents"
            type="text"
            value={draft.defaultAgent}
            onChange={(e) => onField('defaultAgent', e.target.value)}
          />
          <datalist id="mavis-agents">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </datalist>
          <p className="mavis-settings-help">{t('settings.help.defaultAgent')}</p>
        </div>

        <div className="mavis-settings-field">
          <label htmlFor="mavis-cli-path">{t('settings.label.cliPath')}</label>
          <div className="mavis-settings-row">
            <input
              id="mavis-cli-path"
              type="text"
              value={draft.cliPath}
              placeholder="(bundled shim)"
              onChange={(e) => onField('cliPath', e.target.value)}
            />
            <button type="button" onClick={onBrowse}>{t('settings.button.browse')}</button>
          </div>
          <p className="mavis-settings-help">{t('settings.help.cliPath')}</p>
        </div>

        <div className="mavis-settings-field">
          <label htmlFor="mavis-model">{t('settings.label.model')}</label>
          <input
            id="mavis-model"
            type="text"
            value={draft.model}
            placeholder="(server default)"
            onChange={(e) => onField('model', e.target.value)}
          />
          <p className="mavis-settings-help">{t('settings.help.model')}</p>
        </div>

        <div className="mavis-settings-field">
          <label htmlFor="mavis-cli-version">{t('settings.label.cliVersion')}</label>
          <input
            id="mavis-cli-version"
            type="text"
            value={cliVersion}
            readOnly
          />
          <p className="mavis-settings-help">{t('settings.help.cliVersion')}</p>
        </div>

        <div className="mavis-settings-field">
          <label htmlFor="mavis-locale">{t('settings.label.language')}</label>
          <select
            id="mavis-locale"
            value={draft.locale}
            onChange={(e) => onField('locale', e.target.value as Locale)}
          >
            <option value="en">English</option>
            <option value="pt-BR">Português (Brasil)</option>
          </select>
          <p className="mavis-settings-help">{t('settings.help.language')}</p>
        </div>

        <div className="mavis-settings-actions">
          <button type="submit" className="mavis-settings-save">{t('settings.button.save')}</button>
          <button type="button" className="mavis-settings-discard" onClick={onDiscard}>
            {t('settings.button.discard')}
          </button>
        </div>
      </form>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<SettingsApp />);
}

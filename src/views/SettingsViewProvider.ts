/**
 * SettingsViewProvider — the webview form for editing user settings.
 *
 * The form is a single React component that:
 *   - Loads the current settings on mount.
 *   - Lets the user toggle telemetry, change the default agent,
 *     override the CLI path, override the model, and read the
 *     bundled CLI version.
 *   - Saves to `vscode.ExtensionContext.globalState` under
 *     `mavis.settings`.
 *   - "Discard" reverts to the last-saved snapshot.
 *
 * The provider is a regular `WebviewViewProvider` *or* a one-shot
 * `WebviewPanel` (used by the `Mavis: Open Settings` command). The
 * `Mavis: Open Settings` command opens a new panel each time so the
 * user always sees the freshest view.
 *
 * IPC contract (webview ↔ host):
 *   webview → host:
 *     {type:'ready'}
 *     {type:'settings:save', settings}
 *     {type:'settings:discard'}
 *   host → webview:
 *     {type:'settings:loaded', settings, locale, agents, cliVersion}
 *     {type:'settings:saved', settings}
 *     {type:'settings:discarded'}
 */
import * as path from 'node:path';
import {
  CancellationToken,
  env,
  EventEmitter as VSCodeEventEmitter,
  ExtensionContext,
  Uri,
  Webview,
  WebviewPanel,
  WebviewView,
  WebviewViewProvider,
  window,
} from 'vscode';
import { MavisClient } from '../client/MavisClient';
import { detectLocale, Locale } from '../i18n';

export const SETTINGS_STORAGE_KEY = 'mavis.settings';

/** User-facing settings (persisted in `globalState`). */
export interface MavisSettings {
  telemetry: boolean;
  defaultAgent: string;
  cliPath: string;
  model: string;
  /** UI locale (en | pt-BR). Auto-detected from `vscode.env.language`
   *  on first run; the user can override it here. */
  locale: Locale;
}

export const DEFAULT_SETTINGS: MavisSettings = {
  telemetry: false,
  defaultAgent: 'mavis',
  cliPath: '',
  model: '',
  locale: 'en',
};

/** Merge stored settings with the defaults so a partial record is safe. */
export function normaliseSettings(raw: Partial<MavisSettings> | undefined): MavisSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  return {
    telemetry: typeof raw.telemetry === 'boolean' ? raw.telemetry : DEFAULT_SETTINGS.telemetry,
    defaultAgent: typeof raw.defaultAgent === 'string' ? raw.defaultAgent : DEFAULT_SETTINGS.defaultAgent,
    cliPath: typeof raw.cliPath === 'string' ? raw.cliPath : DEFAULT_SETTINGS.cliPath,
    model: typeof raw.model === 'string' ? raw.model : DEFAULT_SETTINGS.model,
    locale: raw.locale === 'pt-BR' ? 'pt-BR' : 'en',
  };
}

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'settings:save'; settings: Partial<MavisSettings> }
  | { type: 'settings:discard' }
  | { type: 'settings:browse-cli' };

export type HostToWebview = {
  type: 'settings:loaded';
  settings: MavisSettings;
  defaults: MavisSettings;
  agents: Array<{ id: string; name: string }>;
  cliVersion: string;
  locale: Locale;
};

export interface SettingsViewDeps {
  context: ExtensionContext;
  client: MavisClient;
  /** Used by the "Browse..." button. The host resolves the dialog. */
  pickFile?: () => Promise<string | undefined>;
  /** Bundled CLI version (read from package.json). */
  cliVersion?: string;
}

export class SettingsViewProvider implements WebviewViewProvider {
  /** Loads the current settings (defaulted) from `globalState`. */
  static load(context: ExtensionContext): MavisSettings {
    const raw = context.globalState.get<Partial<MavisSettings>>(SETTINGS_STORAGE_KEY);
    return normaliseSettings(raw);
  }

  /** Persists the settings to `globalState`. */
  static async save(context: ExtensionContext, settings: MavisSettings): Promise<void> {
    await context.globalState.update(SETTINGS_STORAGE_KEY, settings);
  }

  private panel: WebviewPanel | undefined;
  private readonly deps: SettingsViewDeps;
  private readonly onMessageFromWebview = new VSCodeEventEmitter<WebviewToHost>();

  constructor(deps: SettingsViewDeps) {
    this.deps = deps;
  }

  /** Event fired when the webview posts a message. Useful for tests. */
  get onMessage(): import('vscode').Event<WebviewToHost> {
    return this.onMessageFromWebview.event;
  }

  /** Open the settings as a free-floating webview panel. */
  async openPanel(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = window.createWebviewPanel(
      'mavis.settings',
      'Mavis settings',
      { viewColumn: 2, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          Uri.file(path.join(this.deps.context.extensionPath, 'dist', 'webview', 'settings')),
          Uri.file(path.join(this.deps.context.extensionPath, 'resources')),
        ],
      },
    );
    this.panel = panel;
    panel.webview.html = this.renderHtml(panel.webview);
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        await this.handleMessage(panel.webview, msg as WebviewToHost);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[settings] panel message failed', err);
      }
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  // -------------------------------------------------------- WebviewViewProvider

  resolveWebviewView(
    webviewView: WebviewView,
    _resolveContext: unknown,
    _token: CancellationToken,
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.file(path.join(this.deps.context.extensionPath, 'dist', 'webview', 'settings')),
        Uri.file(path.join(this.deps.context.extensionPath, 'resources')),
      ],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        await this.handleMessage(webviewView.webview, msg as WebviewToHost);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[settings] view message failed', err);
      }
    });
  }

  /** Returns the current settings (for tests). */
  getCurrent(): MavisSettings {
    return SettingsViewProvider.load(this.deps.context);
  }

  // -------------------------------------------------------------------- private

  private async handleMessage(webview: Webview, msg: WebviewToHost): Promise<void> {
    this.onMessageFromWebview.fire(msg);
    switch (msg.type) {
      case 'ready':
        await this.sendLoaded(webview);
        return;
      case 'settings:save': {
        const current = SettingsViewProvider.load(this.deps.context);
        const merged = normaliseSettings({ ...current, ...msg.settings });
        await SettingsViewProvider.save(this.deps.context, merged);
        webview.postMessage({ type: 'settings:saved', settings: merged });
        return;
      }
      case 'settings:discard': {
        const current = SettingsViewProvider.load(this.deps.context);
        webview.postMessage({ type: 'settings:discarded', settings: current });
        return;
      }
      case 'settings:browse-cli': {
        if (!this.deps.pickFile) {
          return;
        }
        const picked = await this.deps.pickFile();
        if (picked) {
          webview.postMessage({ type: 'settings:cliPicked', path: picked });
        }
        return;
      }
    }
  }

  private async sendLoaded(webview: Webview): Promise<void> {
    const settings = SettingsViewProvider.load(this.deps.context);
    const agents = await safeListAgents(this.deps.client);
    const language = (env && env.language) || 'en';
    const locale = settings.locale || detectLocale(language);
    const payload: HostToWebview = {
      type: 'settings:loaded',
      settings,
      defaults: DEFAULT_SETTINGS,
      agents,
      cliVersion: this.deps.cliVersion ?? '0.0.0',
      locale,
    };
    webview.postMessage(payload);
  }

  private renderHtml(webview: Webview): string {
    const scriptUri = webview.asWebviewUri(
      Uri.file(path.join(this.deps.context.extensionPath, 'dist', 'webview', 'settings', 'main.js')),
    );
    const stylesUri = webview.asWebviewUri(
      Uri.file(path.join(this.deps.context.extensionPath, 'dist', 'webview', 'settings', 'styles.css')),
    );
    const cspSource = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `script-src 'self' ${cspSource}`,
      `style-src 'self' 'unsafe-inline' ${cspSource}`,
      `img-src 'self' data: ${cspSource}`,
      `font-src 'self' data:`,
      `connect-src 'none'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${stylesUri}" />
  <title>Mavis settings</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

async function safeListAgents(client: MavisClient): Promise<Array<{ id: string; name: string }>> {
  try {
    const list = await client.listAgents();
    return list.map((a) => ({ id: a.id, name: a.name }));
  } catch {
    return [{ id: 'mavis', name: 'Mavis' }];
  }
}

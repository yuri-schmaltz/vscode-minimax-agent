/**
 * StatusBar — the bottom-bar item showing the active agent + session.
 *
 * Click → QuickPick with: New chat, Switch agent, Sign out.
 *
 * Reactive to MavisClient.onContextChanged (agent / session switches)
 * and to OAuthManager 'token' events (signed-in vs. signed-out text).
 *
 * The class is intentionally engine-agnostic at the surface: it accepts a
 * `StatusBarHost` interface (subset of vscode.StatusBarItem) so tests can
 * drive it without a VSCode instance.
 */
import { MavisClient } from '../client/MavisClient';
import { OAuthManager } from '../auth/OAuth';
import { Locale, t as i18n } from '../i18n';

export interface StatusBarItem {
  text: string;
  tooltip?: string;
  command?: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface QuickPickItem {
  label: string;
  description?: string;
}

export interface StatusBarHost {
  createStatusBarItem(alignment: number, priority: number): StatusBarItem;
  showQuickPick(items: QuickPickItem[], options?: { placeHolder?: string }): Promise<QuickPickItem | undefined>;
  executeCommand(command: string, ...rest: unknown[]): Promise<unknown>;
}

export const StatusAlignmentLeft = 1; // vscode.StatusBarAlignment.Left
export const StatusAlignmentRight = 2; // vscode.StatusBarAlignment.Right

export interface StatusBarOptions {
  host: StatusBarHost;
  client: MavisClient;
  oauth: OAuthManager;
  priority?: number;
  /** Initial agent label to render before MavisClient has any data. */
  initialAgent?: string;
  /** Locale for the menu + tooltip strings. Defaults to 'en'. */
  locale?: Locale;
}

export class StatusBarController {
  private readonly item: StatusBarItem;
  private currentAgent: string;
  private currentSession: string | undefined;
  private signedIn = false;
  private quota: { used: number; total: number; remaining: number; resetMinutes: number } | null = null;
  private readonly opts: Required<Omit<StatusBarOptions, 'host' | 'client' | 'oauth' | 'initialAgent' | 'locale'>> & StatusBarOptions;

  constructor(opts: StatusBarOptions) {
    this.opts = {
      host: opts.host,
      client: opts.client,
      oauth: opts.oauth,
      priority: opts.priority ?? 100,
      initialAgent: opts.initialAgent ?? opts.client.getActiveAgent() ?? 'mavis',
      locale: opts.locale ?? 'en',
    };
    this.currentAgent = this.opts.initialAgent ?? 'mavis';
    this.currentSession = opts.client.getActiveSession();
    this.item = opts.host.createStatusBarItem(StatusAlignmentLeft, this.opts.priority);
    this.item.command = 'mavis._statusBarClick';
    this.item.tooltip = i18n('statusBar.tooltip', this.opts.locale, { agent: this.currentAgent, session: this.currentSession ?? '—', signedIn: 'false' });
    this.item.show();
    this.render();
  }

  /** Wire up after construction so the extension host can register the command first. */
  bind(): void {
    this.opts.client.onContextChanged.on('agent', (agent: string) => {
      this.currentAgent = agent;
      this.render();
    });
    this.opts.client.onContextChanged.on('session', (session: string | undefined) => {
      this.currentSession = session;
      this.render();
    });
    this.opts.oauth.on('token', (token: unknown) => {
      this.signedIn = Boolean(token);
      this.render();
    });
  }

  /** Update the locale (called when the user changes it in settings). */
  setLocale(locale: Locale): void {
    this.opts.locale = locale;
    this.render();
  }

  /** Update the quota display (B.4). Pass null to clear. */
  setQuota(info: { used: number; total: number; remaining: number; resetMinutes: number } | null): void {
    this.quota = info;
    this.render();
  }

  /** Called by extension.ts when the status bar item is clicked. */
  async onClick(): Promise<void> {
    const items: QuickPickItem[] = [
      { label: i18n('statusBar.menu.newChat', this.opts.locale), description: i18n('statusBar.menu.newChat.description', this.opts.locale) },
      { label: i18n('statusBar.menu.switchSession', this.opts.locale), description: i18n('statusBar.menu.switchSession.description', this.opts.locale, { session: shortSession(this.currentSession) }) },
      { label: i18n('statusBar.menu.switchAgent', this.opts.locale), description: i18n('statusBar.menu.switchAgent.description', this.opts.locale, { agent: this.currentAgent }) },
      { label: i18n('statusBar.menu.listSessions', this.opts.locale), description: i18n('statusBar.menu.listSessions.description', this.opts.locale) },
      { label: i18n('statusBar.menu.listAgents', this.opts.locale), description: i18n('statusBar.menu.listAgents.description', this.opts.locale) },
      { label: this.signedIn ? i18n('statusBar.menu.signOut', this.opts.locale) : i18n('statusBar.menu.signIn', this.opts.locale) },
    ];
    const pick = await this.opts.host.showQuickPick(items, {
      placeHolder: i18n('statusBar.menu.title', this.opts.locale),
    });
    if (!pick) return;
    // Match by the start of the label since the menu items are
    // i18n-aware (e.g. "Nova conversa" in pt-BR) — dispatch by
    // command id to keep this stable across languages.
    if (pick.label.includes(i18n('statusBar.menu.newChat', this.opts.locale))) {
      await this.opts.host.executeCommand('mavis.newChat');
    } else if (pick.label.includes(i18n('statusBar.menu.switchSession', this.opts.locale).replace('...', '').trim())) {
      await this.opts.host.executeCommand('mavis.switchSession');
    } else if (pick.label.includes(i18n('statusBar.menu.switchAgent', this.opts.locale).replace('...', '').trim())) {
      await this.opts.host.executeCommand('mavis.switchAgent');
    } else if (pick.label.includes(i18n('statusBar.menu.listSessions', this.opts.locale))) {
      await this.opts.host.executeCommand('mavis.listSessions');
    } else if (pick.label.includes(i18n('statusBar.menu.listAgents', this.opts.locale))) {
      await this.opts.host.executeCommand('mavis.listAgents');
    } else if (this.signedIn) {
      await this.opts.host.executeCommand('mavis.signOut');
    } else {
      await this.opts.host.executeCommand('mavis.signIn');
    }
  }

  /** Returns the current rendered text — useful for tests. */
  getText(): string {
    return this.item.text;
  }

  /** Updates the rendered text. Exposed for tests. */
  render(): void {
    const sess = this.currentSession ? this.currentSession.slice(0, 8) : i18n('statusBar.shortSession', this.opts.locale);
    const signed = this.signedIn ? i18n('statusBar.signedIn', this.opts.locale) : i18n('statusBar.signedOut', this.opts.locale);
    const quotaPart = this.quota && this.quota.total > 0
      ? `$(mavis {this.quota.remaining}/${this.quota.total}, ${this.quota.resetMinutes}m)`
      : '';
    this.item.text = i18n('statusBar.text', this.opts.locale, { agent: this.currentAgent, session: sess, signed }) + (quotaPart ? '  ' + quotaPart : '');
    this.item.tooltip = i18n('statusBar.tooltip', this.opts.locale, { agent: this.currentAgent, session: this.currentSession ?? '—', signedIn: this.signedIn ? 'true' : 'false' });
  }

  dispose(): void {
    this.item.dispose();
  }
}

function shortSession(id: string | undefined): string {
  if (!id) return '—';
  return id.length <= 8 ? id : id.slice(0, 8);
}

/**
 * Helper for tests / non-VSCode contexts: a fake StatusBarHost that captures
 * every item and exposes a programmable `triggerClick()`. NOT exported from
 * the package barrel — only re-exported via test helpers.
 */
export class FakeStatusBarHost implements StatusBarHost {
  readonly items: StatusBarItem[] = [];

  createStatusBarItem(): StatusBarItem {
    const item = {
      text: '',
      tooltip: undefined as string | undefined,
      command: undefined as string | undefined,
      show() {
        /* noop */
      },
      hide() {
        /* noop */
      },
      dispose() {
        /* noop */
      },
    };
    this.items.push(item);
    return item;
  }

  async showQuickPick(items: QuickPickItem[]): Promise<QuickPickItem | undefined> {
    return items[0];
  }

  async executeCommand(_command: string, ..._rest: unknown[]): Promise<unknown> {
    return undefined;
  }
}

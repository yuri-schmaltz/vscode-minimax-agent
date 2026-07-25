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
}

export class StatusBarController {
  private readonly item: StatusBarItem;
  private currentAgent: string;
  private currentSession: string | undefined;
  private signedIn = false;
  private readonly opts: Required<Omit<StatusBarOptions, 'host' | 'client' | 'oauth' | 'initialAgent'>> & StatusBarOptions;

  constructor(opts: StatusBarOptions) {
    this.opts = {
      host: opts.host,
      client: opts.client,
      oauth: opts.oauth,
      priority: opts.priority ?? 100,
      initialAgent: opts.initialAgent ?? opts.client.getActiveAgent() ?? 'mavis',
    };
    this.currentAgent = this.opts.initialAgent ?? 'mavis';
    this.currentSession = opts.client.getActiveSession();
    this.item = opts.host.createStatusBarItem(StatusAlignmentLeft, this.opts.priority);
    this.item.command = 'mavis._statusBarClick';
    this.item.tooltip = 'MiniMax Agent — click for actions';
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

  /** Called by extension.ts when the status bar item is clicked. */
  async onClick(): Promise<void> {
    const items: QuickPickItem[] = [
      { label: '$(comment-discussion) New chat', description: 'Start a fresh Mavis session' },
      { label: '$(history) Switch session...', description: `Current: ${shortSession(this.currentSession)}` },
      { label: '$(robot) Switch agent...', description: `Current: ${this.currentAgent}` },
      { label: '$(list-unordered) List sessions', description: 'Read-only list of recent sessions' },
      { label: '$(organization) List agents', description: 'Read-only list of available agents' },
      { label: this.signedIn ? '$(sign-out) Sign out' : '$(sign-in) Sign in' },
    ];
    const pick = await this.opts.host.showQuickPick(items, {
      placeHolder: 'Mavis actions',
    });
    if (!pick) return;
    if (pick.label.startsWith('$(comment-discussion)')) {
      await this.opts.host.executeCommand('mavis.newChat');
    } else if (pick.label.startsWith('$(history)')) {
      await this.opts.host.executeCommand('mavis.switchSession');
    } else if (pick.label.startsWith('$(robot)')) {
      await this.opts.host.executeCommand('mavis.switchAgent');
    } else if (pick.label.startsWith('$(list-unordered)')) {
      await this.opts.host.executeCommand('mavis.listSessions');
    } else if (pick.label.startsWith('$(organization)')) {
      await this.opts.host.executeCommand('mavis.listAgents');
    } else if (pick.label.includes('Sign in')) {
      await this.opts.host.executeCommand('mavis.signIn');
    } else if (pick.label.includes('Sign out')) {
      await this.opts.host.executeCommand('mavis.signOut');
    }
  }

  /** Returns the current rendered text — useful for tests. */
  getText(): string {
    return this.item.text;
  }

  /** Updates the rendered text. Exposed for tests. */
  render(): void {
    const sess = this.currentSession ? this.currentSession.slice(0, 8) : '—';
    const signed = this.signedIn ? '●' : '○';
    this.item.text = `$(mavis-icon) Mavis: ${this.currentAgent} | ${sess} ${signed}`;
    this.item.tooltip = `agent: ${this.currentAgent} | session: ${this.currentSession ?? '—'} | signed-in: ${this.signedIn}`;
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

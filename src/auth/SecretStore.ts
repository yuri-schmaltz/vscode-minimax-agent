/**
 * SecretStore — wraps VSCode's SecretStorage to persist OAuth tokens for
 * the Mavis extension.
 *
 * Stored shape (under key "mavis.auth"):
 *   {
 *     access_token: string,
 *     refresh_token?: string,
 *     expires_at?: number  // ms epoch
 *   }
 *
 * IMPORTANT:
 *  - Never log the contents of this store.
 *  - Never copy the token to settings.json, globalState, or postMessage.
 *  - The webview receives only a redacted `hasToken: boolean` flag.
 */
import { SecretStorage } from 'vscode';

export interface AuthRecord {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

const KEY = 'mavis.auth';
const API_KEY_KEY = 'mavis.apiKey';

export class SecretStore {
  constructor(private readonly storage: SecretStorage) {}

  async read(): Promise<AuthRecord | undefined> {
    const raw = await this.storage.get(KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as AuthRecord;
      if (!parsed || typeof parsed.access_token !== 'string') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async write(record: AuthRecord): Promise<void> {
    await this.storage.store(KEY, JSON.stringify(record));
  }

  async clear(): Promise<void> {
    await this.storage.delete(KEY);
  }

  /**
   * Reads the user's MiniMax API key (a `sk-cp-…` token from the
   * Subscription Key page). Returns `undefined` when no key is set.
   */
  async readApiKey(): Promise<string | undefined> {
    const v = await this.storage.get(API_KEY_KEY);
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  /** Persists the API key. Pass `''` to clear. */
  async writeApiKey(key: string): Promise<void> {
    if (key.length === 0) {
      await this.storage.delete(API_KEY_KEY);
      return;
    }
    await this.storage.store(API_KEY_KEY, key);
  }
}

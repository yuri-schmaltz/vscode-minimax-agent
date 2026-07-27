// Quota tracker for the Token Plan API.
//
// Polls `https://api.minimax.io/v1/coding_plan/remains` (the official
// MiniMax endpoint for Token Plan usage) every 60s and exposes the
// current usage via a callback. The status bar shows a colored
// indicator with the remaining minutes until reset.
//
// B.4 polish — purely informational, the chat works without it.
// Reference: same endpoint used by ezeoli88/minimax-vscode-extension.

import * as http from 'node:http';
import * as https from 'node:https';
import { MavisClient } from '../client/MavisClient';

export interface QuotaInfo {
  used: number;
  total: number;
  remaining: number;
  resetMinutes: number;
  /** ms since epoch when this snapshot was taken. */
  ts: number;
  /** When true, the endpoint returned ok but with no data. */
  empty?: boolean;
}

export type QuotaCallback = (info: QuotaInfo | null) => void;

const POLL_INTERVAL_MS = 60_000;

/**
 * Polls the Token Plan quota endpoint and invokes the callback
 * whenever a new snapshot is available. Returns a stop() function
 * that the caller can use to tear down the timer (e.g. on
 * extension deactivation).
 *
 * Errors (network, 4xx, 5xx) are swallowed and the callback is
 * invoked with null. This is best-effort telemetry; the chat
 * works regardless of quota availability.
 */
export function startQuotaPoller(
  client: MavisClient,
  archonUrl: string,
  onUpdate: QuotaCallback,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const fetchOnce = (): void => {
    if (stopped) return;
    const key = client.getApiKey();
    if (!key) {
      onUpdate(null);
      timer = setTimeout(fetchOnce, POLL_INTERVAL_MS);
      return;
    }
    const url = archonUrl.replace(/\/+$/, '') + '/v1/coding_plan/remains';
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(body);
              const entry = Array.isArray(json.model_remains) ? json.model_remains[0] : null;
              if (entry) {
                const total = Number(entry.current_interval_total_count || 0);
                const used = Number(entry.current_interval_usage_count || 0);
                const remaining = Math.max(0, total - used);
                const resetMs = Number(entry.remains_time || 0);
                onUpdate({ used, total, remaining, resetMinutes: Math.ceil(resetMs / 60_000), ts: Date.now() });
              } else {
                onUpdate({ used: 0, total: 0, remaining: 0, resetMinutes: 0, ts: Date.now(), empty: true });
              }
            } catch {
              onUpdate(null);
            }
          } else {
            onUpdate(null);
          }
          if (!stopped) timer = setTimeout(fetchOnce, POLL_INTERVAL_MS);
        });
      },
    );
    req.on('error', () => {
      onUpdate(null);
      if (!stopped) timer = setTimeout(fetchOnce, POLL_INTERVAL_MS);
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch { /* ignore */ }
      onUpdate(null);
      if (!stopped) timer = setTimeout(fetchOnce, POLL_INTERVAL_MS);
    });
  };

  fetchOnce();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

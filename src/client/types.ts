/**
 * Shared types for the MavisClient protocol. Mirrors the NDJSON contract
 * emitted by the mavis CLI shim (resources/mavis-cli/mavis.cjs).
 *
 * Versioning: any breaking change to this file must bump the
 * `protocolVersion` constant in src/client/MavisClient.ts.
 */

/** Streaming events from `mavis session stream`. */
export type StreamEvent =
  | { type: 'ready'; sessionId: string; mock?: boolean; ts?: number }
  | { type: 'message'; role: 'assistant' | 'system' | 'tool'; content: string; sessionId?: string; ts?: number }
  | { type: 'reasoning'; content: string; sessionId?: string; ts?: number }
  | { type: 'tool_call'; name: string; args: unknown; id?: string; sessionId?: string; ts?: number }
  | { type: 'tool_result'; name: string; result: unknown; id?: string; sessionId?: string; ts?: number }
  | { type: 'error'; message: string; code?: string; sessionId?: string; ts?: number }
  | { type: 'done'; sessionId?: string; count?: number }
  | { type: 'oauth-code'; user_code: string; verification_uri: string; device_code: string; interval: number; expires_in: number }
  | { type: 'oauth-token'; access_token: string; refresh_token: string; expires_in: number; token_type?: string; scope?: string };

/** Event types a consumer can subscribe to (subset of StreamEvent). */
export type ClientEvent =
  | 'message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'done';

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  model: string;
  isDefault: boolean;
}

export interface SessionSummary {
  id: string;
  agent: string;
  title: string;
  createdAt: number;
}

/** What the user types in the prompt input. Sent as a single JSON line on stdin. */
export interface PromptMessage {
  type: 'prompt';
  text: string;
  /** Optional tool manifest. When present, the shim runs the agent
   * loop (call model → execute tool_calls → feed back). B.1. */
  tools?: Array<{
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  }>;
  /** 'builder' (default) or 'plan'. Controls the system prompt. */
  mode?: 'builder' | 'plan';
  /** Files mentioned via @filename. Their contents are injected as
   * a system message so the model has the file context. */
  contextFiles?: string[];
  /** Per-prompt model override. Defaults to MAVIS_MODEL env var. */
  model?: string;
  /** Per-prompt agent. The shim prepends the agent's systemPrompt
   * to its default Builder/Plan system prompt. */
  agent?: {
    name: string;
    systemPrompt?: string;
  };
}

/** What the consumer (webview) receives. */
export interface AssistantMessage {
  role: 'assistant' | 'system' | 'tool';
  content: string;
  sessionId?: string;
  ts?: number;
}

/** Handle returned from `streamSession`. */
export interface StreamHandle {
  sendPrompt(envelope: { text: string; tools?: PromptMessage['tools']; mode?: PromptMessage['mode']; contextFiles?: PromptMessage['contextFiles']; model?: PromptMessage['model']; agent?: PromptMessage['agent'] } | string): void;
  close(): void;
  on(event: ClientEvent, listener: (e: StreamEvent) => void): () => void;
  off(event: ClientEvent, listener: (e: StreamEvent) => void): void;
}

/** Code action kinds. */
export type CodeActionKind =
  | 'explain'
  | 'refactor'
  | 'tests'
  | 'docstring'
  | 'bugs'
  | 'custom';

/** Drive file categories returned by `mavis drive list`. */
export type DriveCategory =
  | 'documents'
  | 'excel'
  | 'ppt'
  | 'images'
  | 'videos'
  | 'audio'
  | 'other';

/** All known categories in display order (used by DriveViewProvider). */
export const DRIVE_CATEGORIES: ReadonlyArray<DriveCategory> = [
  'documents',
  'excel',
  'ppt',
  'images',
  'videos',
  'audio',
  'other',
];

/** Summary row from `mavis drive list`. */
export interface DriveItem {
  id: string;
  name: string;
  category: DriveCategory;
  sizeBytes: number;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  url?: string;
}

/** Detail row from `mavis drive get <id>` (one-shot, includes content). */
export interface DriveFile extends DriveItem {
  /** Either a base64 payload or a local path on disk. */
  content: string;
  /** When `content` is base64, this is set; when it's a path it's not. */
  contentIsBase64?: boolean;
}

/** Input for `mavis cron create`. */
export interface CronInput {
  name: string;
  /** 5-field cron expression (e.g. "0 8 * * *"). */
  schedule: string;
  /** Prompt text the daemon will send at every run. */
  prompt: string;
  /** Agent id (default: "mavis"). */
  agent?: string;
  /** Persist enabled flag (default: true). */
  enabled?: boolean;
}

/** Row from `mavis cron list` and the return of `createCron`. */
export interface CronSummary {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  agent: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt?: number;
}

/** Result of a code action. */
export type CodeActionResult =
  | { kind: 'patch'; file: string; diff: string }
  | { kind: 'text'; text: string };

/** Handle returned by `createCodeActionTask`. */
export interface CodeActionTaskHandle {
  /** Resolves when the action completes (success or error). */
  result: Promise<CodeActionResult>;
  /** Cancels the underlying child. Idempotent. */
  cancel(): void;
}

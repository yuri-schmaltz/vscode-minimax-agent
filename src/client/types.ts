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
  | { type: 'tool_call'; name: string; args: unknown; id?: string; sessionId?: string; ts?: number }
  | { type: 'tool_result'; name: string; result: unknown; id?: string; sessionId?: string; ts?: number }
  | { type: 'error'; message: string; code?: string; sessionId?: string; ts?: number }
  | { type: 'done'; sessionId?: string; count?: number }
  | { type: 'oauth-code'; user_code: string; verification_uri: string; device_code: string; interval: number; expires_in: number }
  | { type: 'oauth-token'; access_token: string; refresh_token: string; expires_in: number; token_type?: string; scope?: string };

/** Event types a consumer can subscribe to (subset of StreamEvent). */
export type ClientEvent =
  | 'message'
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
  sendPrompt(text: string): void;
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

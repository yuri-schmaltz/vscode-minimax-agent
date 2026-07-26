/**
 * MavisLMProvider — VSCode Language Model API integration.
 *
 * Registers the Mavis backend as a `lm.registerLanguageModelChatProvider` so
 * that VSCode's chat UI (and any third-party chat participant) can pick it
 * up via `vscode.lm.selectChatModels({ vendor: 'mavis' })`.
 *
 * The provider answers:
 *   - `provideLanguageModelChatInformation`  → enumerate one model per
 *     currently-registered Mavis agent. Each agent becomes a model entry
 *     with the agent's id as the model `id` and the agent's `model`
 *     field as the `family`.
 *   - `provideLanguageModelChatResponse`    → drive a Mavis session and
 *     stream the response parts back through the `Progress` callback.
 *   - `provideTokenCount`                   → rough whitespace-token count
 *     approximation. Good enough for "you're about to overflow"; the real
 *     tokenizer lives on the server.
 *
 * Activation model:
 *   - Created once at extension activation.
 *   - `register()` returns a Disposable that unregisters the provider.
 *   - All session I/O is funneled through the shared MavisClient.
 */
import {
  CancellationToken,
  EventEmitter,
  LanguageModelChatInformation,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  LanguageModelChatCapabilities,
  LanguageModelDataPart,
  LanguageModelResponsePart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  PrepareLanguageModelChatModelOptions,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import { MavisClient } from '../client/MavisClient';
import { AgentSummary } from '../client/types';

/** The vendor id used in the `languageModelChatProviders` contribution. */
export const MAVIS_LM_VENDOR = 'mavis';

/** Maximum input tokens we advertise. The real limit is server-side. */
const MAX_INPUT_TOKENS = 128_000;
/** Maximum output tokens we advertise. Conservative; many Mavis agents cap lower. */
const MAX_OUTPUT_TOKENS = 8_192;

interface MavisLanguageModelInformation extends LanguageModelChatInformation {
  /** Mirror of the underlying agent summary so the response side can route by id. */
  readonly agentId: string;
}

/**
 * Internal snapshot of an active Mavis session opened on behalf of a chat
 * request. We keep these keyed by the model id so multiple concurrent
 * requests do not collide.
 */
interface ActiveRequest {
  model: MavisLanguageModelInformation;
  stream: ReturnType<MavisClient['streamSession']>;
  cancelled: boolean;
}

export interface MavisLMProviderDeps {
  client: MavisClient;
  /**
   * Optional override for the agent enumeration. When omitted, the
   * provider calls `MavisClient.listAgents()` lazily on first
   * `provideLanguageModelChatInformation` and caches the result.
   */
  listAgents?: () => Promise<AgentSummary[]>;
}

/**
 * The single VSCode-facing object. The `onDidChangeLanguageModelChatInformation`
 * event is wired up so VSCode can refresh the model picker whenever the
 * underlying Mavis agent list changes.
 */
export class MavisLMProvider implements LanguageModelChatProvider<MavisLanguageModelInformation> {
  private readonly _onDidChange = new EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private readonly client: MavisClient;
  private readonly listAgents: () => Promise<AgentSummary[]>;
  /** Cache of the last agent list. `null` means "not yet fetched". */
  private agents: AgentSummary[] | null = null;
  /** In-flight refresh, so concurrent `provide…Information` calls share one fetch. */
  private inflightAgents: Promise<AgentSummary[]> | undefined;
  /** Active in-flight requests, keyed by model id. */
  private readonly active = new Map<string, ActiveRequest>();

  constructor(deps: MavisLMProviderDeps) {
    this.client = deps.client;
    this.listAgents = deps.listAgents ?? (() => this.client.listAgents());
    // Surface agent changes upstream so VSCode refreshes its model list.
    this.client.onAgentsChanged.on('list', () => {
      this.agents = null;
      this._onDidChange.fire();
    });
  }

  // -------------------------------------------------------------- public API

  /**
   * Enumerates the chat models backed by Mavis. The result is an array
   * with one entry per agent; the model's `family` mirrors the agent's
   * `model` field so consumers can filter by family.
   */
  async provideLanguageModelChatInformation(
    _options: PrepareLanguageModelChatModelOptions,
    _token: CancellationToken,
  ): Promise<MavisLanguageModelInformation[]> {
    if (this.agents === null) {
      if (!this.inflightAgents) {
        this.inflightAgents = this.listAgents()
          .then((items) => { this.agents = items; return items; })
          .finally(() => { this.inflightAgents = undefined; });
      }
      await this.inflightAgents;
    }
    return (this.agents ?? []).map((a): MavisLanguageModelInformation => ({
      id: a.id,
      name: a.name,
      family: a.model || a.id,
      detail: a.isDefault ? 'default' : undefined,
      version: '1',
      maxInputTokens: MAX_INPUT_TOKENS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      capabilities: defaultCapabilities(),
      agentId: a.id,
    }));
  }

  /**
   * Streams the response. We open a fresh Mavis session per request and
   * translate the assistant text events into `LanguageModelTextPart`s.
   * Tool calls are not yet round-tripped (no `LanguageModelToolResultPart`
   * pipeline); they are flattened to a markdown code-fence so the user
   * still sees what the agent tried to do.
   */
  async provideLanguageModelChatResponse(
    model: MavisLanguageModelInformation,
    messages: readonly LanguageModelChatRequestMessage[],
    _options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    const prompt = flattenMessages(messages);
    if (!prompt.trim()) {
      progress.report(new LanguageModelTextPart('(empty prompt)'));
      return;
    }
    const sessionId = `lm_${model.agentId}_${Date.now().toString(36)}`;
    const stream = this.client.streamSession(sessionId, {});
    const req: ActiveRequest = { model, stream, cancelled: false };
    this.active.set(model.id, req);

    // Forward cancellation from VSCode to the Mavis stream.
    const sub = token.onCancellationRequested(() => {
      req.cancelled = true;
      try { stream.close(); } catch { /* ignore */ }
    });

    try {
      // Push the prompt and wait for the resulting text + done events.
      stream.sendPrompt(prompt);
      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };
        stream.on('message', (evt: unknown) => {
          const e = evt as { content?: unknown };
          if (typeof e.content === 'string' && e.content.length > 0) {
            progress.report(new LanguageModelTextPart(e.content));
          }
        });
        stream.on('tool_call', (evt: unknown) => {
          const e = evt as { name?: unknown; args?: unknown };
          if (typeof e.name === 'string') {
            const args = typeof e.args === 'string' ? e.args : JSON.stringify(e.args ?? null, null, 2);
            progress.report(new LanguageModelTextPart(`\n\n> **tool call**: \`${e.name}\`\n\n\`\`\`json\n${args}\n\`\`\`\n`));
          }
        });
        stream.on('error', (evt: unknown) => {
          const e = evt as { message?: unknown };
          if (typeof e.message === 'string') {
            progress.report(new LanguageModelTextPart(`\n\n[error] ${e.message}\n`));
          }
          finish();
        });
        stream.on('done', () => finish());
        // Belt-and-suspenders: if the consumer never sends a done event we
        // still want to bail out when cancellation fires.
        if (token.isCancellationRequested) finish();
      });
    } finally {
      sub.dispose();
      try { stream.close(); } catch { /* ignore */ }
      this.active.delete(model.id);
    }
  }

  /**
   * Approximate token count. Real tokenisation happens server-side, but
   * a `len/4` heuristic is close enough for UI hints.
   */
  provideTokenCount(
    _model: MavisLanguageModelInformation,
    text: string | LanguageModelChatRequestMessage,
    _token: CancellationToken,
  ): Thenable<number> {
    const value = typeof text === 'string' ? text : flattenMessages([text]);
    return Promise.resolve(Math.max(1, Math.ceil(value.length / 4)));
  }

  /**
   * Cancels every in-flight request opened by this provider. Used by
   * `deactivate()` to make sure no zombie streams survive a reload.
   */
  dispose(): void {
    for (const req of this.active.values()) {
      req.cancelled = true;
      try { req.stream.close(); } catch { /* ignore */ }
    }
    this.active.clear();
    this._onDidChange.dispose();
  }
}

// ----------------------------------------------------------------- helpers

/** Default capability flags for every Mavis-backed model. */
function defaultCapabilities(): LanguageModelChatCapabilities {
  return { toolCalling: true };
}

/**
 * Flattens a list of chat messages into a single string we can hand to
 * the Mavis backend. Each message is prefixed with its role so the
 * server can maintain turn structure even without structured content.
 */
function flattenMessages(messages: readonly LanguageModelChatRequestMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const role = (m.role as unknown as string) || 'user';
    const parts: string[] = [];
    for (const part of m.content ?? []) {
      if (isTextPart(part)) {
        parts.push(part.value);
      } else if (isToolResultPart(part)) {
        parts.push(`[tool result]\n${typeof part.content === 'string' ? part.content : JSON.stringify(part.content)}`);
      } else if (isToolCallPart(part)) {
        parts.push(`[tool call] ${part.name}(${JSON.stringify(part.input)})`);
      } else if (isDataPart(part)) {
        parts.push(`[data: ${part.mimeType}]`);
      } else {
        // Unknown part → stringify defensively.
        parts.push(typeof part === 'string' ? part : JSON.stringify(part));
      }
    }
    out.push(`[${role}] ${parts.join('\n')}`);
  }
  return out.join('\n\n');
}

function isTextPart(p: unknown): p is LanguageModelTextPart {
  return Boolean(p) && typeof p === 'object' && (p as { constructor?: { name?: string } }).constructor?.name === 'LanguageModelTextPart'
    && typeof (p as { value?: unknown }).value === 'string';
}

function isToolCallPart(p: unknown): p is LanguageModelToolCallPart {
  return Boolean(p) && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string';
}

function isToolResultPart(p: unknown): p is LanguageModelToolResultPart {
  return Boolean(p) && typeof p === 'object' && (p as { constructor?: { name?: string } }).constructor?.name === 'LanguageModelToolResultPart';
}

function isDataPart(p: unknown): p is LanguageModelDataPart {
  return Boolean(p) && typeof p === 'object' && typeof (p as { mimeType?: unknown }).mimeType === 'string';
}

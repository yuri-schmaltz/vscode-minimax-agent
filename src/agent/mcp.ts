// Minimal MCP (Model Context Protocol) client.
//
// MCP is a JSON-RPC 2.0 protocol over stdio. The host spawns each
// configured server as a child process, exchanges JSON-RPC messages
// over its stdin/stdout, and surfaces the server's tools to the
// agent via a `mcp__<serverName>__<toolName>` naming convention.
//
// References:
//   https://modelcontextprotocol.io/specification
//
// This client supports the stdio transport only (the most common).
// HTTP/SSE can be added later as needed.

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface McpServerConfig {
  /** Command to run (e.g. "npx"). */
  command: string;
  /** Args (e.g. ["-y", "@modelcontextprotocol/server-github"]). */
  args: string[];
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Timeout for tool calls in ms (default 30000). */
  timeoutMs?: number;
}

export interface McpTool {
  /** Server name (the key in mavis.mcpServers). */
  server: string;
  /** Tool name (as reported by the server). */
  name: string;
  /** Description for the model. */
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * One running MCP server. Owns the child process, the JSON-RPC
 * request/response correlation, and a list of tools that the server
 * advertised during `tools/list`.
 */
export class McpServerHandle extends EventEmitter {
  readonly name: string;
  readonly config: McpServerConfig;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private tools: McpTool[] = [];
  private initialized = false;
  private crashed: Error | null = null;

  constructor(name: string, config: McpServerConfig) {
    super();
    this.name = name;
    this.config = config;
  }

  /** Spawn the server and run the MCP initialize handshake. */
  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.config.env || {}) },
    });
    this.child = child;
    child.on('error', (err) => {
      this.crashed = err;
      this.failPending(err);
      this.emit('error', err);
    });
    child.on('exit', (code) => {
      if (code !== 0 && !this.crashed) {
        this.crashed = new Error(`mcp server '${this.name}' exited with code ${code}`);
        this.failPending(this.crashed);
      }
      this.emit('exit', code);
    });
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString('utf8')));

    // MCP initialize handshake.
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Mavis', version: '0.9.0' },
    });
    // notifications/initialized (no response expected).
    this.notify('notifications/initialized', {});
    this.initialized = true;

    // Fetch the tool list.
    const result = (await this.request('tools/list', {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: McpTool['inputSchema'] }>;
    };
    this.tools = (result.tools || []).map((t) => ({
      server: this.name,
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  async callTool(toolName: string, args: unknown): Promise<unknown> {
    if (!this.initialized) throw new Error(`mcp server '${this.name}' not initialized`);
    const result = await this.request('tools/call', { name: toolName, arguments: args });
    const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    if (r.isError) {
      throw new Error(
        (r.content || [])
          .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
          .join('\n') || 'mcp tool returned isError',
      );
    }
    // Convert content[] to a string or JSON for the model.
    const text = (r.content || []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
    return text;
  }

  /** Kill the server process. */
  async stop(): Promise<void> {
    if (this.child) {
      try { this.child.stdin.end(); } catch { /* ignore */ }
      this.child.kill();
      this.child = undefined;
    }
    this.failPending(new Error('mcp server stopped'));
  }

  // -------------------------------------------------------------- protocol

  private notify(method: string, params: unknown): void {
    if (!this.child) return;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id: this.nextId++, method, params };
    try { this.child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* ignore */ }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('mcp server not running'));
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request '${method}' timed out after ${this.config.timeoutMs ?? 30000}ms`));
      }, this.config.timeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child!.stdin.write(JSON.stringify(msg) + '\n'); }
      catch (err) { this.pending.delete(id); clearTimeout(timer); reject(err); }
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try { msg = JSON.parse(line) as JsonRpcResponse; }
      catch { continue; /* skip non-JSON lines (e.g. logs on stdout) */ }
      const entry = this.pending.get(msg.id);
      if (!entry) continue; // unsolicited notification
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else entry.resolve(msg.result);
    }
  }

  private failPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Manager for the set of MCP servers declared in the
 * `mavis.mcpServers` setting. Spawns them on demand (lazy), exposes
 * the merged tool list, and routes `mcp__<server>__<tool>` calls to
 * the right server.
 */
export class McpManager extends EventEmitter {
  private servers = new Map<string, McpServerHandle>();
  private startingPromises = new Map<string, Promise<McpServerHandle>>();

  constructor(private readonly config: Record<string, McpServerConfig> = {}) {
    super();
  }

  /**
   * Start all configured servers (idempotent). Returns when each one
   * has either initialized or failed. Failures are surfaced via the
   * 'server-error' event but do not throw — the chat can still work
   * without MCP tools.
   */
  async startAll(): Promise<void> {
    await Promise.allSettled(
      Object.entries(this.config).map(async ([name, cfg]) => {
        try { await this.startServer(name, cfg); }
        catch (err) {
          this.emit('server-error', { name, error: err });
        }
      }),
    );
  }

  async startServer(name: string, cfg: McpServerConfig): Promise<McpServerHandle> {
    const existing = this.servers.get(name);
    if (existing) return existing;
    const inFlight = this.startingPromises.get(name);
    if (inFlight) return inFlight;
    const handle = new McpServerHandle(name, cfg);
    const promise = (async () => {
      await handle.start();
      this.servers.set(name, handle);
      handle.on('exit', () => this.servers.delete(name));
      handle.on('error', (err) => this.emit('server-error', { name, error: err }));
      this.emit('server-ready', { name, tools: handle.getTools() });
      return handle;
    })();
    this.startingPromises.set(name, promise);
    try { return await promise; }
    finally { this.startingPromises.delete(name); }
  }

  /** Tools from all running servers, in `mcp__<server>__<tool>` format. */
  getAllTools(): McpTool[] {
    const out: McpTool[] = [];
    for (const handle of this.servers.values()) {
      for (const tool of handle.getTools()) {
        out.push({
          ...tool,
          name: `mcp__${tool.server}__${tool.name}`,
          description: `[${tool.server}] ${tool.description}`,
        });
      }
    }
    return out;
  }

  /**
   * Call an MCP tool by its `mcp__<server>__<tool>` name.
   * Returns the textual result.
   */
  async callMcpTool(prefixedName: string, args: unknown): Promise<unknown> {
    const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(prefixedName);
    if (!m) throw new Error(`not an MCP tool: ${prefixedName}`);
    const [, serverName, toolName] = m;
    const handle = this.servers.get(serverName);
    if (!handle) {
      // Lazy-start: the user may have added the server after the
      // initial startAll.
      const cfg = this.config[serverName];
      if (!cfg) throw new Error(`unknown MCP server: ${serverName}`);
      await this.startServer(serverName, cfg);
    }
    const h = this.servers.get(serverName);
    if (!h) throw new Error(`MCP server '${serverName}' failed to start`);
    return h.callTool(toolName, args);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.servers.values()).map((h) => h.stop()),
    );
    this.servers.clear();
  }
}

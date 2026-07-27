// Custom agents (B.8).
//
// An "agent" is a named preset that bundles:
//   - a model (MiniMax-M3 by default)
//   - a system prompt override (prepended before the default)
//   - a tool whitelist (subset of the available tools)
//
// The user defines them in `mavis.agents` (settings.json). The first
// entry is the default for new sessions. The status bar shows the
// current agent; the chat header has a dropdown to switch per session.

import { ToolDefinition } from './manifest';

export type ToolGroup = 'read' | 'write' | 'bash' | 'agent-md' | 'all';

export interface AgentDefinition {
  name: string;
  description?: string;
  model?: string;
  systemPrompt?: string;
  /** Tool groups enabled. 'all' enables everything. */
  tools?: ToolGroup[];
}

/** Resolve which tool definitions an agent gets. */
export function agentTools(
  agent: AgentDefinition,
  allTools: ToolDefinition[],
): ToolDefinition[] {
  const groups = agent.tools || ['all'];
  if (groups.includes('all')) return allTools;
  const allowed = new Set<ToolGroup>(groups);
  // Map each known tool to one or more groups. The shim's tool
  // names are the source of truth — see src/agent/manifest.ts.
  const group: Record<string, ToolGroup> = {
    read_file: 'read',
    glob: 'read',
    grep: 'read',
    list_directory: 'read',
    write_file: 'write',
    edit_file: 'write',
    bash: 'bash',
  };
  return allTools.filter((t) => {
    const g = group[t.name];
    return g ? allowed.has(g) : false;
  });
}

/** Build the system prompt fragment an agent prepends. */
export function agentSystemPrompt(agent: AgentDefinition): string {
  const base = agent.systemPrompt?.trim() ?? '';
  if (!base) return '';
  return `\n\n# Agent: ${agent.name}\n${base}\n`;
}

/** Look up an agent by name in a list, or return the first one. */
export function resolveAgent(
  list: AgentDefinition[],
  name: string | undefined,
): AgentDefinition {
  if (!list || list.length === 0) {
    return { name: 'mavis', description: 'Default Mavis agent.', tools: ['all'] };
  }
  if (name) {
    const found = list.find((a) => a.name === name);
    if (found) return found;
  }
  return list[0];
}

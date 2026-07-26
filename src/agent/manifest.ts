// Tool manifest sent to the shim on each `sendPrompt`.
//
// The shim receives this JSON, forwards it as OpenAI-style
// `tools: [{type:'function', function:{name,description,parameters}}]`,
// and when the model returns tool_calls the shim executes them
// locally (sandboxed to the workspace root) and feeds results back
// to the model until the model emits a final answer.
//
// B.1 ships the 4 read-only tools. B.2 will add `write_file` and
// `edit_file` (behind a confirmation flow) and B.3 will add `bash`.
// Adding a tool here requires 3 things:
//   1. The entry in `READ_ONLY_TOOLS` below
//   2. The implementation in `resources/mavis-cli/mavis.cjs`
//   3. A test in `test/shim/tools.test.cjs` that runs the shim
//      with MAVIS_MOCK=0 against a fixture workspace.

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[]; items?: unknown }>;
    required?: string[];
  };
}

export const READ_ONLY_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file in the workspace. Returns up to 2000 lines; for larger files, use grep or read with line ranges via startLine/endLine.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        startLine: { type: 'integer', description: 'Optional 0-based start line.' },
        endLine: { type: 'integer', description: 'Optional 0-based end line (exclusive).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.test.ts". Returns relative paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, relative to workspace root.' },
        limit: { type: 'integer', description: 'Max results (default 200).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      'Search for a regex in files under a directory. Returns matches as {path, line, content}.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern (JavaScript syntax).' },
        path: { type: 'string', description: 'Directory or file to search in (default: workspace root).' },
        limit: { type: 'integer', description: 'Max matches (default 200).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_directory',
    description: 'List the immediate contents of a directory (non-recursive).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to workspace root (default: ".").' },
      },
    },
  },
];

/** The full B.1 manifest. Returned from `getTools()` and passed in
 * the `tools` field of every sendPrompt envelope. */
export function getReadOnlyToolManifest(): ToolDefinition[] {
  return READ_ONLY_TOOLS;
}

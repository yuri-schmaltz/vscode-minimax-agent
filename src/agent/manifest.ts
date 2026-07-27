// Tool manifest sent to the shim on each `sendPrompt`.
//
// The shim receives this JSON, forwards it as OpenAI-style
// `tools: [{type:'function', function:{name,description,parameters}}]`,
// and when the model returns tool_calls the shim executes them
// locally (sandboxed to the workspace root) and feeds results back
// to the model until the model emits a final answer.
//
// B.1 ships the 4 read-only tools.
// B.2 adds `write_file` and `edit_file` (the user sees a color-coded
//     diff and can revert). The webview shows the diff inline.
// B.3 will add `bash` (with timeout + allowlist + path-traversal
//     protection; team-verified).
//
// Adding a tool here requires 4 things:
//   1. The entry in the right array below
//   2. The implementation in `resources/mavis-cli/mavis.cjs`
//   3. A test in `test/shim/tools.test.cjs` that runs the shim
//      against a fixture workspace
//   4. A webview render path (if the tool produces output the
//      user should see in the chat)

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[]; items?: unknown }>;
    required?: string[];
  };
}

const READ_TOOLS: ToolDefinition[] = [
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

const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'write_file',
    description:
      'Create a new file or overwrite an existing one with the given content. The user sees a color-coded diff and can revert. Use only for new files or full rewrites; prefer edit_file for targeted changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        content: { type: 'string', description: 'The full new file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Targeted find-and-replace within an existing file. The user sees a color-coded diff and can revert. Throws if `find` is not present in the file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        find: { type: 'string', description: 'Exact substring to find (must be unique unless replaceAll is set).' },
        newText: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default: false).' },
      },
      required: ['path', 'find', 'newText'],
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command in the workspace root. Commands are subject to an allowlist (npm, git, ls, cat, etc.) and a 30s default timeout. Dangerous patterns (sudo, eval, curl|sh, rm -rf /) are always rejected. Returns {stdout, stderr, exitCode, timedOut, allowed}.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run. Use &&, |, etc. as needed.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'cwd',
    description: 'Return the current working directory (the workspace root).',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

/** Tools available in Plan mode (read-only). */
export const READ_ONLY_TOOLS: ToolDefinition[] = READ_TOOLS;

/** Tools available in Builder mode (read + write). B.2+. */
export const BUILDER_TOOLS: ToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** Return the tool manifest for the given mode. */
export function getToolManifest(
  mode: 'builder' | 'plan' = 'builder',
  extra: ToolDefinition[] = [],
): ToolDefinition[] {
  const base = mode === 'plan' ? READ_ONLY_TOOLS : BUILDER_TOOLS;
  return [...base, ...extra];
}

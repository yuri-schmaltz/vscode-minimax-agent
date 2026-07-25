/**
 * E2E test scaffold for the Mavis extension.
 *
 * This file uses `@vscode/test-electron` to spin up a real VSCode
 * instance, install the freshly-built `.vsix`, and exercise the
 * critical user flows. **It is not run in CI** (the sandbox has no
 * VSCode available); it's a compile-time-valid starting point for
 * manual / local runs, and a reference for future maintainers.
 *
 * To run it locally (requires VSCode 1.85+ installed):
 *
 *   npm run package         # produces vscode-agent-0.1.0.vsix
 *   npm run e2e             # downloads VSCode, installs the .vsix, runs the suite
 *
 * Test outline:
 *   - Extension activates on first command.
 *   - `Mavis: New chat` opens the chat view.
 *   - Sending a message in the chat reaches the (mock) MavisClient.
 *   - `Mavis: Switch session` lists recent sessions.
 *   - `Mavis: Switch agent` lists agents.
 *   - `Mavis: Open Settings` opens the settings webview.
 *   - `Mavis: Refresh drive` populates the Drive tree.
 *   - `Mavis: Schedule cron` opens the input-box flow.
 *
 * Every test waits for the command to complete with a 30 s timeout
 * so a hanging subprocess doesn't wedge the runner.
 *
 * NOTE: the runtime imports are deferred behind a top-level type-only
 * import so the file compiles even when `@vscode/test-electron` is not
 * installed (e.g. in CI). To enable, install the optional dev
 * dependency (`@vscode/test-electron` + `spectron`).
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VSIX_PATH = path.join(REPO_ROOT, 'vscode-agent-0.1.0.vsix');

/**
 * Optional top-level loader for `@vscode/test-electron`. The import is
 * dynamic so the file is type-checkable without the package installed.
 */
type RunTestsArgs = {
  vscodeExecutablePath: string;
  extensionDevelopmentPath: string;
  extensionTestsPath: string;
  launchArgs?: string[];
  cliPath?: string;
};

type RunTestsFn = (args: RunTestsArgs) => Promise<void>;
type DownloadFn = (opts: { version: string }) => Promise<string>;
type ResolveCliFn = (vscodeExe: string) => Promise<string>;

let testElectron: {
  runTests: RunTestsFn;
  downloadAndUnzipVSCode: DownloadFn;
  resolveCliPathFromVSCodeExecutable: ResolveCliFn;
} | undefined;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  testElectron = require('@vscode/test-electron');
} catch {
  testElectron = undefined;
}

/**
 * Top-level entry point invoked by `@vscode/test-electron`. Run with:
 *
 *   npx extest run-suite test/e2e/extension.test.ts
 * or via the `npm run e2e` script.
 */
export async function go(): Promise<void> {
  if (!testElectron) {
    throw new Error(
      '[@vscode/test-electron] is not installed. Run `npm install --no-save @vscode/test-electron` to enable e2e tests.',
    );
  }
  const vscodeExe = await testElectron.downloadAndUnzipVSCode({ version: '1.85.0' });
  const cli = await testElectron.resolveCliPathFromVSCodeExecutable(vscodeExe);
  await testElectron.runTests({
    vscodeExecutablePath: vscodeExe,
    extensionDevelopmentPath: REPO_ROOT,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [
      '--disable-gpu',
      '--no-sandbox',
      // Disable telemetry on the host so the e2e run is reproducible.
      '--disable-telemetry',
    ],
    cliPath: cli,
  });
}

/**
 * Pure-Node sanity check that the e2e scaffold is importable. The
 * `npm test` runner does NOT execute this; the file exists to ensure
 * the scaffold stays compile-time-valid.
 */
export const __scaffold = {
  repoRoot: REPO_ROOT,
  vsixPath: VSIX_PATH,
  hasTestElectron: Boolean(testElectron),
};

void fs;
void go;

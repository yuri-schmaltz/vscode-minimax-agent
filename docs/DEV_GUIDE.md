# MiniMax Agent — Developer Guide

> How to build, test, and ship the MiniMax Agent (Mavis) extension.
> Last updated: 2026-07-25 (Ciclo 4 / v0.1.0).

This guide covers the day-to-day development workflow: setting up the
toolchain, running the test suite, building the `.vsix`, debugging in
VSCode, the commit convention, and the E2E setup.

---

## 1. Prerequisites

| Tool | Version |
|---|---|
| Node.js | 18.x or 20.x |
| npm | 9+ |
| VSCode | 1.85+ (only for manual / E2E runs) |
| Git | any recent |

> The sandbox CI uses Node 20.x. Local development on Node 18 is
> supported (`engines.node: ">=18"`).

```bash
node --version   # v18.x.x or v20.x.x
npm --version    # 9.x or 10.x
```

---

## 2. Quick start

```bash
git clone https://github.com/yuri-schmaltz/vscode-minimax-agent
cd vscode-minimax-agent
npm install
npm run lint
npm run typecheck
npm test
npm run package    # produces vscode-agent-0.1.0.vsix
```

The `.vsix` is what you ship (or install via
`code --install-extension vscode-agent-0.1.0.vsix`).

---

## 3. Project layout

```
vscode-minimax-agent/
├── src/                       # Extension host (TypeScript, Node)
│   ├── extension.ts           # activate / deactivate
│   ├── auth/                  # OAuth + SecretStore
│   ├── client/                # MavisClient + NDJSON parser + types
│   ├── codeactions/           # CodeAction provider + prompt templates
│   ├── cron/                  # CronForm + CronListProvider
│   ├── statusbar/             # StatusBarController
│   ├── telemetry/             # Telemetry singleton
│   ├── i18n/                  # t() helper + locales/{en,pt-BR}.json
│   ├── util/                  # SessionCache, redact
│   └── views/                 # ChatViewProvider, DriveViewProvider, SettingsViewProvider
├── webview/                   # Browser bundles (React + esbuild)
│   ├── main.tsx               # Chat webview entry
│   └── settings/
│       ├── main.tsx           # Settings webview entry
│       └── styles.css
├── resources/
│   ├── icon*.png              # 16/24/48/64/128/256/512
│   ├── mavis-icon.svg         # Activity bar icon
│   └── mavis-cli/mavis.cjs    # Bundled CLI shim
├── test/                      # node --test suite
│   ├── __mocks__/vscode.ts    # Minimal in-tree vscode mock
│   ├── helpers/               # registerVscodeMock, spawnStub
│   ├── auth/                  # OAuth + SecretStore tests
│   ├── client/                # MavisClient + ndjson + drive/cron tests
│   ├── codeactions/           # Provider + prompts
│   ├── cron/                  # CronForm + CronListProvider
│   ├── statusbar/             # StatusBarController
│   ├── shim/                  # CLI shim end-to-end
│   ├── util/                  # redact
│   ├── views/                 # Chat + Drive + Settings providers
│   └── e2e/                   # @vscode/test-electron scaffold
├── docs/                      # PLAN, USER_GUIDE, DEV_GUIDE
├── esbuild.config.mjs         # Build script (extension + chat + settings)
└── package.json
```

---

## 4. Build

```bash
npm run build      # one-shot build → out/extension.js + dist/webview/*.js
npm run watch      # esbuild watch mode
```

The build produces:

- `out/extension.js` — the extension host (CommonJS, Node 18+).
- `out/extension.js.map` — source map (excluded from the `.vsix`).
- `dist/webview/main.js` — the chat webview (IIFE, browser).
- `dist/webview/settings/main.js` — the settings webview.
- `dist/webview/styles.css`, `dist/webview/settings/styles.css` — copied
  as-is from `webview/`.

The settings webview is built as a second IIFE bundle so the two
webviews don't share a runtime (they have different CSPs and
DOM roots).

---

## 5. Tests

### Unit + adversarial suite

```bash
npm test                          # 267 tests, runs in <30s
npm run test:coverage             # also runs c8
```

The runner is `node --test --import tsx --import
./test/helpers/registerVscodeMock.cjs`. It picks up any
`*.test.ts` under `test/` and `src/**/__tests__/`.

The vscode mock is registered via `Module._resolveFilename` patching
in `test/helpers/registerVscodeMock.cjs`. The mock provides only the
surface the production code touches (see `test/__mocks__/vscode.ts`).

### Coverage gates

`npm run test:coverage` uses `c8` with the following gates:

- Lines / statements: 60% per file.
- Branches: 60% per file.
- Functions: 80% per file.

The current source easily clears the project-wide threshold of 80%
statements / 75% branches. If you add a file with low coverage, c8
will exit non-zero.

### E2E scaffold

```bash
npm run test:e2e   # requires VSCode 1.85+ installed locally
```

`test/e2e/extension.test.ts` is a scaffold for `@vscode/test-electron`.
The test runner downloads VSCode 1.85, installs the freshly-built
`.vsix`, and runs the suite inside the Extension Host. **It does not
run in CI** (the sandbox has no VSCode). The smoke test
`test/e2e/scaffold.test.ts` confirms the scaffold module is importable.

> Manual: install `@vscode/test-electron` and `spectron` first
> (`npm install --no-save @vscode/test-electron spectron`).

### Secret-leak audit

```bash
npm run lint:secrets   # grep for accidental token leaks
```

The script (`scripts/check-secrets.cjs`) greps `out/` and `dist/` for
patterns that look like access tokens, refresh tokens, or bearer
headers. It is part of the CI pipeline.

---

## 6. Debugging in VSCode

The repo ships with a `.vscode/launch.json` (already in the gitignore)
that configures the **Extension Development Host**:

1. Open the repo in VSCode.
2. Press `F5`. A new VSCode window opens with the extension loaded
   from source.
3. Set breakpoints in `src/`; they hit when the second window
   triggers the corresponding code path.
4. The Output panel → **Mavis** shows log output.

To inspect the webview:

- In the Extension Development Host, open the chat view.
- `Help → Toggle Developer Tools` opens the Chromium devtools.
- React DevTools works normally.

---

## 7. Commit convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Used for |
|---|---|
| `feat` | New user-facing feature |
| `fix` | Bug fix |
| `refactor` | Code change with no behaviour change |
| `chore` | Tooling, CI, package metadata |
| `docs` | Documentation only |
| `test` | Test-only changes |
| `perf` | Performance improvement |

The scope is the module name, kebab-case:

```text
feat(telemetry): add opt-in telemetry with single notice
feat(i18n): add en + pt-BR locale files with t() helper
feat(settings): add webview settings form
chore(marketplace): polish package.json metadata + icon
docs: add CHANGELOG.md, update README, USER_GUIDE, DEV_GUIDE
test(e2e): add @vscode/test-electron scaffold
chore: package and verify cycle 4 .vsix
```

Atomicity rule: **one commit per concern**. A commit that touches the
settings webview, the i18n table, and the package.json metadata is too
big — split it.

---

## 8. Release flow

```bash
npm run package    # produces vscode-agent-0.1.0.vsix
git tag v0.1.0
git push origin v0.1.0
```

> The extension is **not** published to the Visual Studio Marketplace
> (decision #2 of [`PLAN.md`](PLAN.md)). Releases are bundled from CI
> artifacts and shared out-of-band (e.g. via Slack or a releases page).

Before tagging:

- [ ] `npm run lint && npm run typecheck && npm test && npm run
      package` all green.
- [ ] `CHANGELOG.md` updated with the new version block.
- [ ] `README.md` install section points to the new `.vsix` name.
- [ ] `vscode-agent-<version>.vsix` is uploaded to the release
      artifacts.

---

## 9. Architecture cheatsheet

### Extension host (`src/`)

```
+--------------------+     +--------------------+     +--------------------+
| ChatViewProvider   |     | DriveViewProvider  |     | SettingsView       |
| (webview sidebar)  |     | (tree sidebar)     |     | Provider (panel)   |
+--------------------+     +--------------------+     +--------------------+
        |                          |                          |
        +-----------+--------------+--------------------------+
                    |
                    v
            +---------------+     +-----------------+
            |  MavisClient  |<--->| CLI shim (cjs)  |
            +---------------+     +-----------------+
                    |
        +-----------+-----------+-----------+
        |           |           |           |
   onContextChanged onDriveChanged onCronChanged ...
```

### Telemetry

```
src/telemetry/Telemetry.ts
  ├── init(host)            -> singleton
  ├── track(name, dims)     -> sanitises dims, queues
  ├── flush()               -> host.send(batch)
  ├── maybeShowNotice()     -> one-time, never repeats
  └── enable() / disable()  -> persists override + setting
```

The host is the boundary between the singleton and `vscode`. Tests
build a fake host; production code uses `makeDefaultTelemetryHost`.

### i18n

```
src/i18n/index.ts
  ├── LOCALES: Record<Locale, Record<string, string>>
  ├── detectLocale(vscodeLanguage)
  ├── t(key, locale, vars?)
  └── knownKeys()  // for parity checks
```

Locales are imported as JSON so the bundler inlines them at build
time — no runtime fetch.

### Settings storage

`mavis.settings` lives in `ExtensionContext.globalState`. The
`SettingsViewProvider` normalises whatever is stored to a
`MavisSettings` object (default values for missing fields, type
checks for every field).

---

## 10. Adding a new feature

1. **Plan.** Open an issue / design doc, link to the relevant section
   of [`PLAN.md`](PLAN.md).
2. **Branch.** `git checkout -b feat/<scope>-<short-desc>`.
3. **Code.** Match the project style (`@typescript-eslint/recommended`,
   strict mode, dependency-injectable constructors, narrow types).
4. **Test.** Add at least one unit + one adversarial test per public
   class.
5. **i18n.** Add user-facing strings to both `en.json` and `pt-BR.json`.
6. **Coverage.** Run `npm run test:coverage`; it should stay green.
7. **Commit.** `feat(<scope>): ...` with a one-line description.
8. **Push.** Open a PR, wait for CI, merge.

---

## 11. Common gotchas

| Symptom | Likely cause |
|---|---|
| `Error: Cannot find module 'vscode'` in tests | The mock loader didn't run. Confirm `npm test` uses `--import ./test/helpers/registerVscodeMock.cjs`. |
| `Module parse failed: Unexpected token` in esbuild | You added a `.tsx` outside `webview/`. Add to esbuild config or move. |
| Webview shows "Refused to execute inline script" | CSP violation. The webview bundles all JS — no inline `<script>`. |
| Settings form reverts immediately | The `discard` message fires from a stale snapshot. Reload the panel. |
| Telemetry queue keeps growing | Network send keeps failing. The mock endpoint is offline by design; events drop after 256. |
| i18n warning in console | A key is missing in one of the locale tables. Run `t.__lookupAllKeys()` (test helper) for a parity check. |

---

## 12. License

MIT — see [LICENSE](../LICENSE).

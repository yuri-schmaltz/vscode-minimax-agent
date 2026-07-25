# MiniMax Agent for VSCode

> Use the **MiniMax Agent (Mavis)** directly inside VSCode — chat, code
> actions, sessions, drive, and scheduled automations. **Converse com o
> Mavis, aplique code actions, agende automações, direto no VSCode.**

![demo](docs/demo.gif)
*(demo GIF — placeholder; record with `code --install-extension
vscode-agent-0.1.0.vsix` + a screen capture tool, then drop the file
here)*

## Features

- **Chat sidebar** — talk to Mavis in a sidebar webview with multi-session
  tabs, markdown + syntax-highlighted code blocks, and streaming
  responses.
- **Code actions on selection** — 6 Mavis-branded actions: Explain,
  Refactor, Generate tests, Add docstring, Find bugs, and Custom prompt.
  Each result opens in a side-by-side diff editor with Apply / Reject /
  Send to chat.
- **Sessions & agents** — `Mavis: New chat`, `Switch session`,
  `Switch agent`, `List sessions`, `List agents`. The status bar shows
  the active agent and short session id at a glance.
- **Drive** — browse your Mavis Drive in a tree view (`Mavis Drive` in
  the secondary sidebar), with 7 categories (documents, excel, ppt,
  images, videos, audio, other). Drag-and-drop any Drive row into the
  chat to attach it.
- **Cron** — schedule recurring automations via
  `Mavis: Schedule cron` (name, schedule, prompt, agent). Toggle /
  delete via `Mavis: List crons`.
- **Settings UI (WebView)** — `Mavis: Open Settings` opens an in-editor
  form for telemetry, default agent, CLI path (with `Browse...`),
  model, and UI locale. Persists to `globalState`.
- **Telemetry opt-in** — anonymous event tracking (command id, message
  length bucket, code-action kind, cron id — never content, paths, or
  tokens). **Default: off.** First use with telemetry off shows a
  one-time, non-blocking notice (Enable / Maybe later / Never ask again).
- **i18n (English + Brazilian Portuguese)** — auto-detects from
  `vscode.env.language`; user can override in settings. The pt-BR
  translation covers the chat UI, status bar menu, drive errors,
  confirmations, auth messages, telemetry notice, and the settings form.
- **OAuth sign-in** — browser-based PKCE flow with silent refresh
  60 s before expiry. Tokens live in `SecretStorage`; never in logs,
  settings.json, or `globalState`.

## Installation (v1, internal)

A release exists in the repo root as `vscode-agent-0.1.0.vsix`.
Install it locally:

```bash
code --install-extension vscode-agent-0.1.0.vsix
```

> **Note:** the extension is not yet published to the Visual Studio
> Marketplace (decision #2 of [`docs/PLAN.md`](docs/PLAN.md)). Releases
> are bundled from CI artifacts and shared out-of-band.

## Quick start

1. **Open the chat.** Press `Cmd/Ctrl+Shift+M` or click the Mavis icon
   in the activity bar. Click `New` to start a session.
2. **Sign in (optional).** The shim bundles an offline `mavis` CLI,
   so chat works without an account. If you want to use a real
   archon-server, run `Mavis: Sign in` and follow the browser prompt.
3. **Ask a question.** Type into the textarea, hit `Enter` (Shift+Enter
   for a new line). The streamed response lands below.
4. **Run a code action.** Select code, then right-click →
   `Mavis: <action>`. The result opens in a side-by-side diff.
   `Apply` writes the patch, `Send to chat` injects the assistant text
   into the active chat.
5. **Schedule a cron.** `Mavis: Schedule cron` → fill the form
   (name, schedule, prompt, agent) → submit. `Mavis: List crons` to
   toggle or delete.
6. **Open Settings.** `Mavis: Open Settings` (or `Cmd/Ctrl+Alt+,` in
   the editor) to toggle telemetry, change the default agent, or pick
   a CLI path.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `mavis.defaultAgent` | `mavis` | Which Mavis agent to spawn by default for new chats |
| `mavis.cliPath` | bundled shim | Override the path to the `mavis` CLI binary |
| `mavis.cliVersion` | bundled | Bundled CLI version (read-only, shown in settings) |
| `mavis.model` | server default | Override the model used for completions |
| `mavis.telemetry` | `false` | `false` / `true` / `ask-once` — opt-in anonymous events |
| `mavis.oauthFlow` | `auto` | `auto` / `deviceCode` / `pkce` — OAuth strategy |
| `mavis.archonUrl` | default | Override the archon-server base URL |

## Telemetry

- **Off by default.** No event leaves the host until you opt in.
- **One-time notice.** The first time the extension is used with
  telemetry off, a non-blocking info notice offers three choices:
  `Enable`, `Maybe later`, `Never ask again`. The choice is persisted
  in `globalState`; `Never` is permanent.
- **Tracked events** (each carries only an event name + coarse dims):
  - `command_invoked` → `{ command: "mavis.<...>" }`
  - `chat_message_sent` → `{ length_bucket: "xs" | "s" | "m" | "l" | "xl" }`
  - `code_action_applied` → `{ kind: "explain" | "refactor" | ... }`
  - `cron_fired` → `{ cron_id: "cron_<...>" }`
- **Never tracked:** message content, file paths, file contents, tokens,
  prompts, or any other PII. The host-side `Telemetry.sanitizeDims` drops
  unknown dim keys (the queue is not even written to).
- **Best-effort send.** The endpoint is
  `https://telemetry.minimax.local/v1/events`; a network failure is
  silent and the queue is re-tried on the next flush. Disabling
  telemetry drops the queue immediately.

## Known limitations

- The bundled CLI is a Node shim (mock-mode); it does not contact a
  real `archon-server`. Replace `mavis.cliPath` with a real binary when
  one is available.
- The webview is sandboxed: no `connect-src` to the network. All
  requests are proxied through the extension host.
- Sessions are not yet persisted across restarts on the server side;
  the cache (`globalState`) holds the last 5 for tab rehydration.
- E2E tests are scaffolded but require a real VSCode install to run
  (see `docs/DEV_GUIDE.md`); CI runs the unit + adversarial suite.

## Development

```bash
npm install
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # node --test (267 unit + adversarial tests)
npm run test:coverage
npm run package      # produces vscode-agent-0.1.0.vsix
```

See [`docs/DEV_GUIDE.md`](docs/DEV_GUIDE.md) for the full workflow,
including the E2E suite and the Conventional Commits convention.

## Documentation

- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — how to use the extension
- [`docs/DEV_GUIDE.md`](docs/DEV_GUIDE.md) — how to build, test, and ship
- [`docs/PLAN.md`](docs/PLAN.md) — design + roadmap
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## License

MIT — see [LICENSE](LICENSE).

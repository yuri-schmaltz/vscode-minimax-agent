# MiniMax Agent — User Guide

> How to use the MiniMax Agent (Mavis) extension in VSCode.
> Last updated: 2026-07-25 (Ciclo 4 / v0.1.0).

This guide walks through the user-facing features: signing in, chatting
with Mavis, running code actions on the editor, browsing the Drive,
scheduling cron jobs, and tuning settings.

---

## 1. Installation

> The extension is shipped as a local `.vsix` (decision #2 of
> [`PLAN.md`](PLAN.md)). The Marketplace publication is post-v1.

1. Get `vscode-agent-0.1.0.vsix` from the releases page.
2. Open VSCode 1.85+.
3. Run **Extensions: Install from VSIX…** (`Cmd/Ctrl+Shift+P` →
   "Extensions: Install from VSIX").
4. Reload when prompted.
5. The Mavis icon (purple chat bubble) appears in the activity bar.

> ![install](screenshot-placeholder.png) *(screenshot placeholder)*

---

## 2. First-run flow

When the extension first activates:

1. A small info notice confirms it's ready
   (`MiniMax Agent (Mavis) ready. Cmd/Ctrl+Shift+M to open chat.`).
2. The status bar shows `Mavis: <agent> | <session> ○`
   (the trailing `○` means "not signed in").
3. If telemetry is off (the default), a one-time notice asks whether
   to share anonymous events. Pick `Enable` / `Maybe later` /
   `Never ask again`.

---

## 3. Signing in (optional)

The bundled CLI is a mock shim — chat works without an account. If
you want to talk to a real `archon-server`:

1. Run **Mavis: Sign in** from the command palette.
2. The browser opens the OAuth flow (PKCE or device-code, auto-detected).
3. The access token is stored in `SecretStorage` (encrypted on disk).
4. The status bar flips to `●` (signed in).
5. **Mavis: Sign out** revokes the token and clears the secret.

> ![sign-in](screenshot-placeholder.png)

---

## 4. Chat

### Open the chat

- Click the Mavis icon in the activity bar, OR
- Press `Cmd/Ctrl+Shift+M`, OR
- Run **Mavis: Toggle chat**.

### New session

Click `New` in the chat header (or the `+` tab) to start a fresh
session. The status bar updates immediately.

### Send a message

- Type into the textarea, press `Enter` to send (Shift+Enter for a new
  line).
- The response streams in token-by-token.
- The bottom status line shows the active agent and a short session id
  (click the id to copy the full id).

### Multi-session tabs

- Every session you open is a tab in the chat header.
- Click a tab to switch; click `×` to close.
- Up to 5 recent sessions persist across restarts (LRU cache in
  `globalState`).

### Send a selection to chat

- Select code in the editor.
- Press `Cmd/Ctrl+L` (or **Mavis: Send selection to chat**).
- The selection is captured; type your question and press `Enter`.

### Attach a file

- **From the OS:** drag a file from your file manager into the
  textarea. A chip appears above the textarea.
- **From the Drive:** drag a Drive row from the secondary sidebar into
  the textarea. The chip uses a `{file:<id>:<name>}` reference so the
  CLI can resolve the file content server-side.

> ![chat](screenshot-placeholder.png)

---

## 5. Code actions

Right-click any selection in the editor → **Mavis: <action>**:

| Action | Behaviour |
|---|---|
| **Explain this** | Streams a textual explanation (no patch). |
| **Refactor** | Returns a unified diff. Open in the diff editor. |
| **Generate tests** | Returns a unified diff (test code). |
| **Add docstring** | Returns a unified diff. |
| **Find bugs** | Streams a textual list of potential bugs. |
| **Custom prompt...** | Asks for a prompt, then runs it. |

The diff editor shows `Apply` / `Reject` / `Send to chat`:

- **Apply** writes the patch to disk.
- **Reject** discards it.
- **Send to chat** injects the assistant text into the active chat.

> ![code-action](screenshot-placeholder.png)

---

## 6. Drive

Open the **Mavis Drive** view in the secondary sidebar
(`View → Open View → Mavis Drive` or click the Mavis Drive icon).

The tree groups your Drive files into 7 categories: documents, excel,
ppt, images, videos, audio, other.

### Actions

- **Click a file** → opens it in VSCode.
- **Right-click → Download** → saves to
  `<workspaceRoot>/mavis-drive/<name>`.
- **Right-click → Attach to chat** → adds the file to the active chat.
- **Right-click → Delete** → confirms, then removes from the Drive.
- **Drag-and-drop** the row into the chat textarea to attach.

> ![drive](screenshot-placeholder.png)

---

## 7. Cron

### Schedule a cron

Run **Mavis: Schedule cron** → fill the multi-step form:

1. **Cron name** — e.g. "Run tests every morning".
2. **Schedule** — a 5-field cron expression, e.g. `0 8 * * *` for
   8 AM daily.
3. **Prompt** — the prompt sent to Mavis on each fire.
4. **Agent** — which Mavis agent runs the prompt.

The form validates the cron expression and rejects empty names.

### List / toggle / delete crons

Run **Mavis: List crons** → a QuickPick shows every cron with its
schedule. Pick a cron → toggle enabled / disabled, or delete it.

> ![cron](screenshot-placeholder.png)

---

## 8. Settings

Run **Mavis: Open Settings** (or press `Cmd/Ctrl+Alt+,` in the editor).
A webview form opens with:

| Field | What it does |
|---|---|
| Anonymous telemetry | Off by default. When on, only the command id, message length bucket, code-action kind, and cron id are sent. |
| Default agent | Which Mavis agent spawns for new chats. |
| CLI path | Override the path to the `mavis` CLI binary. Leave empty to use the bundled shim. Click `Browse…` to pick a file. |
| Model | Override the model used for completions. Empty = server default. |
| Bundled CLI version | Read-only. The CLI version shipped with this extension. |
| Language | Display language for the user interface. |

`Save` persists to `globalState[mavis.settings]`. `Discard` reverts
to the last-saved snapshot.

> ![settings](screenshot-placeholder.png)

---

## 9. Language (i18n)

The extension ships in English and Brazilian Portuguese. The locale is
auto-detected from `vscode.env.language`; the user can override it in
the Settings UI.

Current coverage: chat UI, status bar menu, drive errors, confirmations,
auth messages, telemetry notice, settings form.

---

## 10. Telemetry

- **Default: off.** No event is ever sent without explicit opt-in.
- **One-time notice** appears on first use with telemetry off. Choices:
  - **Enable** — turns on telemetry and dismisses the notice.
  - **Maybe later** — dismisses for now; notice returns next session
    if state is `unasked`.
  - **Never ask again** — permanent dismissal.
- **Tracked events:** `command_invoked`, `chat_message_sent` (length
  bucket only), `code_action_applied` (kind only), `cron_fired`
  (cron id only).
- **Never tracked:** message content, file paths, file contents, tokens,
  prompts.

Disable at any time in the Settings UI.

---

## 11. Troubleshooting

| Symptom | Try this |
|---|---|
| Chat doesn't open | `Cmd/Ctrl+Shift+P` → **Mavis: Toggle chat** |
| Sign-in hangs | Check the browser tab; the device code is also in the clipboard |
| Drive shows "unavailable" | Run **Mavis: Refresh drive**; check `mavis.archonUrl` |
| Code action doesn't appear | Select code, then right-click → Mavis menu |
| Cron never fires | Confirm with **Mavis: List crons** that it's enabled |
| Telemetry off but I get a notice | First-run only; pick `Never ask again` to suppress permanently |

For deeper issues, check the **Output → Mavis** channel (if available)
or enable devtools with `Help → Toggle Developer Tools`.

---

## 12. Keyboard shortcuts

| Action | Mac | Win / Linux |
|---|---|---|
| Toggle chat | `Cmd+Shift+M` | `Ctrl+Shift+M` |
| Send selection to chat | `Cmd+L` | `Ctrl+L` |
| Switch session | `Cmd+Shift+,` | `Ctrl+Shift+,` |
| Open settings | `Cmd+Alt+,` | `Ctrl+Alt+,` |

All shortcuts are configurable via **File → Preferences → Keyboard
Shortcuts**.

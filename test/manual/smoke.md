# Mavis extension — manual smoke test

This is the E2E smoke test for the Mavis VSCode extension (cycle 1).
It is intentionally runnable on any developer machine that has the
`code` CLI available; the CI sandbox does not include a display
server, so step 2 onward must be executed on a workstation with a
real VSCode UI.

> **Sandbox note**: the build that produced this cycle 1 `.vsix`
> was packaged in a Linux container without `code`. The shell
> commands below are provided so any reviewer can reproduce the
> smoke in their own VSCode. The pre-conditions in §0 must hold
> for the install step to succeed.

---

## 0. Pre-conditions

- `node` >= 18 and `npm` >= 9 on the host.
- `code` CLI on the `PATH` (`Cmd/Ctrl+Shift+P` → "Shell Command: Install
  'code' command in PATH").
- The `.vsix` artifact: `vscode-agent-0.1.0.vsix` (or the freshly built
  one from `npm run package`).
- A clean VSCode profile (recommended: a separate `code --user-data-dir`
  folder) so SecretStorage is empty.

Verify the artifact:

```sh
ls -lh vscode-agent-0.1.0.vsix
unzip -l vscode-agent-0.1.0.vsix | head -30
```

Expected: the archive contains `extension/package.json`,
`extension/out/extension.js`, `extension/dist/webview/main.js`,
`extension/dist/webview/styles.css`, and the bundled shim
`extension/resources/mavis-cli/mavis.cjs`.

---

## 1. Install the extension

```sh
code --install-extension ./vscode-agent-0.1.0.vsix
```

Expected: VSCode prints `Extension 'minimax.vscode-agent-0.1.0.vsix'
was successfully installed.` Open the Extensions panel and confirm
that **MiniMax Agent (Mavis)** appears under the publisher `minimax`.

---

## 2. Open a fresh workspace

```sh
mkdir -p /tmp/mavis-smoke && cd /tmp/mavis-smoke
code .
```

The folder must be empty (or contain only a `.gitignore`). VSCode
opens the empty workspace and (because `activationEvents` is
`onStartupFinished`) shows the notification:

> MiniMax Agent (Mavis) ready. Cmd/Ctrl+Shift+M to open chat.

---

## 3. Mavis: Sign in (mock mode)

Mock mode is the default when no `mavis.archonUrl` is configured.
Open the command palette and run **Mavis: Sign in** (or click the
status bar item → **Sign in**).

Expected (mock mode):

- A status notification like:
  > Mavis sign-in failed: device code request failed: fetch failed
  is **not** shown. The mock path does not call the network.
- The status bar item flips to `Mavis: mavis | — ●` (the `●` indicates
  "signed in").
- A second command run of **Mavis: Sign out** clears the indicator
  back to `○`.

If you see the user_code / verification_uri in a notification (i.e.
you are pointed at a real archon-server), copy the code, open the
URL in a browser, paste it, and wait for the device-code polling
to resolve. The status bar should flip to `●` within a few seconds.

> Diagnostic command to confirm the SecretStorage entry:
>
> ```sh
> code --status # n/a on stable; instead use:
> ```
>
> On macOS, the secret is stored in the Keychain under the
> `vscode` service. On Linux, it lives in `~/.config/Code/User/
> globalStorage/.../mavis.auth.json` (encrypted via the OS secret
> service).

---

## 4. Mavis: New chat

1. Open the **MiniMax Agent** activity bar (the Mavis icon on the
   left).
2. The chat view renders with an empty transcript.
3. The status bar shows `Mavis: mavis | — ●` (no session yet).
4. Run **Mavis: New chat** (or click the status bar → **New chat**).
5. The status bar updates to `Mavis: mavis | <8-char-session-id> ●`.
6. The chat view remains empty (waiting for a prompt).

---

## 5. Send "hello" and see a streamed reply

1. Type `hello` in the chat input and press `Enter` (or click the
   send button).
2. The user message appears immediately in the transcript.
3. Within ~1s the assistant message streams in (in mock mode the
   shim echoes the input prefixed with `echo:`).
4. The "send" affordance re-enables after the `done` event arrives.

Expected transcript (mock mode):

```
[user] hello
[assistant] echo: hello
```

If you do not see the assistant message within 5 s, open the
**Output → Mavis** channel and look for stderr lines (they are
prefixed with `[mavis:cli]` or `[mavis:ndjson]`).

---

## 6. Mavis: Sign out

Run **Mavis: Sign out** from the command palette (or click the
status bar → **Sign out**).

Expected:

- The status bar flips to `Mavis: mavis | <session-id> ○`.
- The SecretStorage entry is removed. (Verify with the OS secret
  store; see §3 for paths.)
- The next **Mavis: Sign in** runs the flow from scratch.

---

## 7. Cleanup

```sh
code --uninstall-extension minimax.vscode-agent
```

---

## Sandbox / CI run

In a headless environment (the build sandbox that produced this
cycle 1 .vsix), only §0 is automated. The package step is run as:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run package
ls -lh vscode-agent-0.1.0.vsix
unzip -l vscode-agent-0.1.0.vsix | head -30
```

A fresh `smoke.log` is written when the steps above succeed; see
`test/manual/smoke.log` for the captured output.

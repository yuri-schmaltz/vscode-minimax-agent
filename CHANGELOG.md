# Changelog

All notable changes to the MiniMax Agent (Mavis) VSCode extension are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.3] — 2026-07-26 (Diagnóstico: 'Test connection' + SSE mais robusto)

### Added
- **Comando `Mavis: Test connection`** (paleta) que bate no
  `GET {archonUrl}{apiBase}/models` com a chave persistida e abre
  um Output Channel com:
  - URL completa + header de Authorization (mascarado)
  - HTTP status + body (primeiros 600 chars)
  - Lista de modelos anunciados (se for 200)
  - Mensagem clara no notification de acordo com o status
    (OK / 401 / 403 / 404 / falha de rede)
- **SSE parsing agora captura `delta.reasoning_content`** (campo
  usado pelo `MiniMax-M3` quando o modo thinking tá ligado). Antes
  só olhava `delta.content`.
- Se o servidor responde 200 mas sem nenhum chunk de conteúdo, o
  shim agora emite um `type:"error"` claro (em vez de ficar em
  silêncio). Tenta ler o body como fallback pra mostrar uma amostra.

### Changed
- Output do `Test connection` é amigável para copiar/colar em
  relatórios de bug.

## [0.3.2] — 2026-07-26 (Layout: Mavis Chat no painel direito, ao lado do Copilot)

### Changed
- **Mavis Chat e Drive agora aparecem no painel direito** (`Auxiliary Bar`),
  lado a lado com o Copilot Chat do VSCode. As duas views (chat + drive)
  viram abas dentro do mesmo container `mavis-side` no painel auxiliar.
  O usuário pode arrastá-las pra reorganizar.
- **`mavis.toggleChat` agora aciona o painel auxiliar** e foca a aba
  de chat, garantindo que o atalho `Cmd/Ctrl+Shift+M` sempre revele o
  Mavis (mesmo se a barra direita estiver escondida).
- O ícone da activity bar (esquerda) do Mavis foi removido — o ícone
  agora vive só no painel direito.

## [0.3.1] — 2026-07-26 (Hotfix: botão inline 'Definir API key' no chat)

### Fixed
- Quando o usuário manda mensagem sem a API key configurada, o chat
  agora mostra um botão **"Definir API key"** direto no banner de erro.
  Anteriormente o shim emitia um erro genérico que a UI engolia.

## [0.3.0] — 2026-07-26 (Out-of-the-box: vincula conta MiniMax + defaults prontos)

### Added
- **Vinculação de conta MiniMax via API key** — novo comando
  `Mavis: Set API key` que abre um input box protegido, valida o
  prefixo `sk-`, e persiste a chave em `SecretStorage` (chave
  `mavis.apiKey`). O shim agora lê a chave via env var
  `MAVIS_API_KEY` e faz chamadas reais pra API MiniMax.
- **Comando `Mavis: Welcome`** — ação de boas-vindas na primeira
  ativação (e via paleta). Detecta se já tem chave; se não, oferece
  “Definir API key”, “Abrir chat” ou “Abrir configurações”.
- **Defaults prontos**:
  - `mavis.archonUrl` default = `https://api.minimax.io` (público)
  - `mavis.apiBase` default = `/v1`
  - `mavis.model` default = `MiniMax-M3`
- **Shim real** (`resources/mavis-cli/mavis.cjs`):
  - `session stream` agora chama `POST {archonUrl}/v1/chat/completions`
    com `stream: true` e decodifica o SSE do OpenAI-compat, emitindo
    `type:"message"` por chunk.
  - `agent list` chama `GET /v1/models` para listar o que a chave
    enxerga, sempre incluindo o default `mavis` (modelo
    `MiniMax-M3`).
  - `oauth code` / `oauth token` chamam `/oauth/code` e
    `/oauth/token` no archon-server quando configurado; cai no mock
    se falhar.
- **`SecretStore.readApiKey` / `writeApiKey`** — API paralela
  `mavis.apiKey` (separada do `mavis.auth` que guarda OAuth).
- **`MavisClient.setApiKey` / `getApiKey`** — chave pode ser
  aplicada/limpar depois da construção, sem precisar recriar o client.
- **MavisClient spawnEnv** repassa `MAVIS_API_KEY`, `MAVIS_MODEL`,
  `MAVIS_API_BASE`, `MAVIS_ARCHON_URL` pros filhos.

### Changed
- Activation agora entra em modo real (não-mock) por default. A
  shim avisa amigavelmente se a chave não tá setada.
- Activation só mostra `i18n('extension.ready')` na primeira
  execução; depois, o `mavis.welcome` cuida do onboarding.

### Tests
- 4 novos testes (setApiKey round-trip, spawnEnv passthrough,
  SecretStore API key). Total: 313 testes, 100% passando.

## [0.2.0] — 2026-07-25 (Ciclo 5 — Fase 6: integração avançada)

### Added
- **Language Model API** (`src/lm/MavisLMProvider.ts`): the Mavis
  backend is registered as a `LanguageModelChatProvider` with vendor
  `mavis`. Consumers select models with
  `vscode.lm.selectChatModels({ vendor: 'mavis' })`; one model entry
  is exposed per Mavis agent. Requests open a fresh Mavis session and
  stream response parts back through the `Progress` callback.
- **Inline edit (Cmd+K)** (`src/inline/InlineEditProvider.ts`): ghost-text
  suggestions driven by the Mavis code-action task. Registered for
  typescript/python/go/rust + a wildcard. Skips files > 100 KB and
  honors cancellation via a race against a cancel sentinel.
- **Notebook controller** (`src/notebook/MavisNotebookController.ts`):
  Jupyter cell execution. Auto-attaches to `jupyter-notebook` and a
  custom `mavis-notebook` type declared in `contributes.languages`.
  Empty cells short-circuit with an inline error, errors mid-stream
  mark the cell failed and surface the message in the cell output.
- **Tasks provider** (`src/tasks/MavisTaskProvider.ts`): three built-in
  tasks (`test`, `lint`, `package`) wired to `npm run <script>`,
  grouped under Test/Clean/Build. Supports pnpm/yarn via
  `npmCommand` override and forwards the workspace cwd to each task.

### Tests
- 34 new unit tests across the four modules (8 LM + 9 inline + 7
  notebook + 10 tasks). All 309 total tests pass.

## [0.1.0] — 2026-07-25 (Ciclos 1–4)

### Added
- **Fase 0 (Ciclo 1) — Esqueleto**: manual scaffold (TypeScript + esbuild),
  `package.json` with `engines.vscode ^1.85`, `categories ["Programming",
  "Chat", "Other"]`, 7 `mavis.*` commands, activity-bar (`mavis.chatView`)
  + secondary-bar (`mavis.driveView`) containers, `ctrl+shift+m` toggle,
  full `mavis.*` configuration block, icon set (16–512), strict CI pipeline.
- **Fase 1 (Ciclo 1) — Cliente Mavis**: `MavisClient` with NDJSON streaming,
  child process lifecycle, `listSessions` / `listAgents` one-shot calls,
  typed events, complete `dispose()` cleanup.
- **Fase 1 — CLI shim** (`resources/mavis-cli/mavis.cjs`): mock-mode Node
  shim with `agent list`, `session list`, `session stream`, `oauth code`,
  `oauth token`. ~8 KB. Easy swap when the official binary ships.
- **Fase 1 — Auth (OAuth + SecretStore)**: device-code and PKCE+redirect
  flows, auto-detection via `/.well-known/oauth-config.json`,
  `SecretStorage` persistence under `mavis.auth`, silent refresh 60s
  pre-expiry, sign-out revokes best-effort. Tokens are never logged or
  sent to the webview.
- **Fase 1 — Status bar**: reactive bottom-bar item
  (`$(mavis-icon) Mavis: <agent> | <session> <signed>`), QuickPick with
  New chat / Switch agent / Sign in/out.
- **Fase 1 — Chat webview** (React 18 + esbuild): sidebar webview with
  markdown (`react-markdown`), shiki code blocks, streaming via
  `assistantMessage` deltas merged into the last assistant message, strict
  CSP, Enter-to-send (Shift+Enter newline), empty state, error banner.
- **Fase 2 (Ciclo 2) — Sessões & Agentes**: `Mavis: New chat` creates a
  session, multi-session tabs in the chat header, `Mavis: Switch session`
  / `Switch agent` / `List sessions` / `List agents`, status-bar menu
  reativo, `SessionCache` LRU (max 5) persisted in `globalState`.
- **Fase 3 (Ciclo 2) — Code Actions**: 6 Mavis-branded actions (Explain,
  Refactor, Generate tests, Add docstring, Find bugs, Custom prompt) on
  any file, `vscode.Diff` side-by-side with Apply / Reject / Send to chat,
  prompts templated per kind, sent-to-chat injection path.
- **Fase 4 (Ciclo 3) — Drive**: `Mavis Drive` tree view in the
  secondary bar with 7 categories (documents, excel, ppt, images, videos,
  audio, other), `Mavis: Refresh drive` + view-item context menu (Open,
  Download, Attach to chat, Delete), drag-and-drop with custom
  `application/x-mavis-drive-item` MIME to the chat webview.
- **Fase 4 — Cron**: `Mavis: Schedule cron` opens a multi-step form
  (name, schedule, prompt, agent) backed by the CLI shim, `Mavis: List
  crons` shows a QuickPick with toggle enable/disable and delete.
- **Fase 5 (Ciclo 4) — Telemetria opt-in**: `mavis.telemetry` setting
  (off / on / ask-once, default off); first-run one-time notice
  (Enable / Maybe later / Never ask again); tracks only
  `command_invoked`, `chat_message_sent` (length bucket), `code_action_applied`
  (kind), `cron_fired` (cron id) — never message content, file paths,
  tokens, or prompts. Best-effort POST to
  `https://telemetry.minimax.local/v1/events` (no-op when offline).
- **Fase 5 — i18n**: `src/i18n/index.ts` `t(key, locale, vars?)` helper,
  full English + Brazilian Portuguese locale tables
  (`src/i18n/locales/en.json`, `pt-BR.json`), `vscode.env.language`
  auto-detect, `{var}` interpolation, missing-key warnings (once per
  key), 70+ keys covering chat UI, status bar, drive, code actions,
  auth, telemetry, and settings.
- **Fase 5 — Settings UI (WebView)**: dedicated React form for
  telemetry, default agent, CLI path (with `Browse...`), model, CLI
  version (read-only), and UI locale. Persists to
  `globalState[mavis.settings]`. Opens via `Mavis: Open Settings`
  (command palette + `Ctrl+Alt+,` / `Cmd+Alt+,` keybinding).
- **Fase 5 — Marketplace polish**: `package.json` keywords include
  `code-actions`, `drive`, `cron`; `categories: ["Programming", "Chat",
  "Other"]`; `galleryBanner.color = #7C3AED`; `homepage` and
  `bugs` URLs; freshly generated 128×128 icon (blue→purple gradient
  with a stylised M).
- **Fase 5 — E2E scaffold**: `test/e2e/extension.test.ts` using
  `@vscode/test-electron` (compile-time-valid; requires a real VSCode
  to run; documented in `docs/DEV_GUIDE.md`).
- **Fase 5 — Documentação**: `docs/USER_GUIDE.md` (sign in, chat, code
  actions, drive, cron, settings), `docs/DEV_GUIDE.md` (build, test,
  e2e, commit convention, debug), updated `README.md` with hero,
  features, install, quick start, settings table, and known
  limitations.

### Changed
- `mavis.telemetry` is now a string enum (`"false" | "true" | "ask-once"`)
  instead of a boolean to match marketplace conventions and allow the
  one-time opt-in flow. The runtime still treats `true` as enabled.
- Status bar menu + tooltip strings are i18n-aware (`en` + `pt-BR`).
- Chat activation notice, sign-in / sign-out confirmations, and Drive
  error toasts use the i18n helper.
- `Mavis: Open Settings` now opens the in-extension settings panel
  (falls back to VSCode settings if the panel provider isn't ready).

### Fixed
- Tokens are never written to logs, settings.json, or `globalState`.
- The webview never receives a token-shaped value via `postMessage`.
- Telemetry queue re-queues events when the network send fails; the
  queue is dropped when the user disables telemetry.
- The Drive `Mavis: delete drive item` confirmation modal is now
  i18n-aware ("Delete this file?" → "Excluir este arquivo?" in pt-BR).

### Verified (Ciclo 4)
- `npm run lint`     ✓ (no errors, no warnings)
- `npm run typecheck` ✓
- `npm test`         267 / 267 passing (+38 new tests vs Ciclo 3)
- `npm run package`  ✓ produces `vscode-agent-0.1.0.vsix` (~400 KB)
- Coverage          ≥ 80% stmts, ≥ 75% branches (per-file)

### Out of scope (post v1)
- Marketplace publication (decision #2: `.vsix` interno só).
- VSCode Language Model API (Mavis provider).
- Inline edit (Cmd+K estilo Cursor).
- Custom themes / dark-vs-light tweak per workspace.

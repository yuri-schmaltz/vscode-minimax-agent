# Changelog

All notable changes to the MiniMax Agent (Mavis) VSCode extension are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.9.0] — 2026-07-26 (B.8: custom agents + B.7: concurrent prompts)

### Added (B.8 — Custom agents)
- **Custom agents** in `mavis.agents` setting. Each agent has:
  - `name` (e.g. 'mavis', 'test-runner', 'docs-writer')
  - `description` (shown in the status bar / dropdown)
  - `model` (default model for the agent; overridable per-session)
  - `systemPrompt` (extra persona; prepended to the default Builder/Plan prompt)
  - `tools` (subset of `read`, `write`, `bash`, `agent-md`, or `all`)
- **Per-session agent**: each tab remembers the agent. Switching in
  one tab doesn't affect others.
- **Agent dropdown** in the chat header (next to the model dropdown).
  New sessions inherit the first entry of `mavis.agents`.
- The agent's tool whitelist filters the tool manifest before
  passing to the shim, so an "read-only" agent can't accidentally
  call `write_file` even if the model tries.
- 9 new unit tests for the agents module (B.8).

### Added (B.7 — Concurrent prompts)
- **Pending state is now a counter, not a boolean**. The user can
  send multiple messages while the shim is still processing
  earlier ones. The shim's for-await loop processes them in order.
- **Placeholder shows queue size**: when pending > 0, the input
  placeholder becomes "Processando… (N na fila)".
- **15s timeout is per-prompt**: if the oldest pending prompt
  times out, the user sees the timeout banner; subsequent prompts
  are still tracked.

### Deferred (next round)
- **B.6 — MCP servers**: the host module is implemented (McpManager
  in `src/agent/mcp.ts` with stdio transport) but the shim
  doesn't yet route `mcp__<server>__<tool>` calls. Needs a
  bidirectional stdin/stdout protocol change in the shim. Will
  land in v0.9.x or v0.10.0.

## [0.8.0] — 2026-07-26 (B.5 polish: model dropdown no header do chat)
## [0.8.0] — 2026-07-26 (B.5 polish: model dropdown no header do chat)

### Added
- **Model dropdown in the chat header** (B.5). The list comes from
  the new `mavis.models` setting (default: all 8 MiniMax models:
  M3, M2.7, M2.7-highspeed, M2.5, M2.5-highspeed, M2.1,
  M2.1-highspeed, M2). The first entry is the default for new
  sessions. Existing `mavis.model` setting is still respected as
  a fallback.
- **Per-session model**: each session remembers the model the
  user picked. Switching models in one tab doesn't affect other
  tabs. New sessions inherit the default (first entry of
  `mavis.models`).
- **No re-spawn needed**: the model is passed per-prompt in the
  sendPrompt envelope, so switching is instant. The shim's
  single-shot and agent-loop paths both prefer
  `prompt.model` over the `MAVIS_MODEL` env var.
- 2 new tests: `agentLoop.test.cjs` end-to-end with a fake archon
  that asserts the per-prompt model is forwarded to
  `/v1/chat/completions`; the other 354 tests still pass.

### Migration
- The legacy `mavis.model` setting continues to work as a
  fallback when `mavis.models` is empty.
- Existing sessions pick up the default model; the user can
  switch via the dropdown in the chat header.

## [0.7.1] — 2026-07-26 (remove post-activation popup)
## [0.7.0] — 2026-07-26 (Fase B.4: quota widget + 3 themes + @-mention support)

### Added
- **Quota widget in the status bar** (B.4): polls
  `https://api.minimax.io/v1/coding_plan/remains` every 60s and
  shows remaining/used + reset time. Same endpoint the ezeoli88
  extension uses.
- **3 webview themes** (B.4): `tokyo-night`, `rose-pine`, `gruvbox`.
  Pick via the new `mavis.webviewTheme` setting. The default
  inherits the active VSCode theme.
- **@-mention stub in the host**: `contextFiles` is now plumbed
  end-to-end (B.1's plumbing was already there; B.4 confirms the
  full path works). Autocomplete in the webview is a B.5 polish
  item.
- 4 new tests for the quota poller (`test/statusbar/quota.test.cjs`):
  happy path, empty response, 4xx, missing key.

### B.4 vs earlier phases
- B.1: read tools + agent.md + Builder/Plan mode
- B.2: write_file + edit_file + inline diff viewer
- B.3: bash tool (allowlist + dangerous-pattern rejection + 30s timeout)
- B.4: quota + themes + @-mention stub
- 353/353 tests pass (4 new quota tests + 11 bash tests + 8 write
  tests + 9 read tests from earlier phases).

## [0.6.0] — 2026-07-26 (Fase B.3: bash tool com allowlist + dangerous-pattern rejection)

### Added
- **`bash` tool** (B.3): runs shell commands in the workspace root.
  Returns `{stdout, stderr, exitCode, timedOut, allowed}`. Subject
  to:
  - `MAVIS_BASH_ALLOW` env var (or `mavis.tools.bashAllow` setting):
    comma-separated list of command prefixes that are auto-approved.
  - Hard-coded dangerous-pattern rejection: `rm -rf /`, `sudo`,
    `eval`, `curl|sh`, `wget|sh`, fork bombs.
  - 30s default timeout (configurable via `MAVIS_BASH_TIMEOUT_MS`).
  - Output cap at 64KB (configurable via `MAVIS_BASH_MAX_OUTPUT`).
- **`cwd` tool** (B.3): returns the workspace root path.
- **`mavis.tools.bashAllow` setting** lets the user extend the
  allowlist without rebuilding.
- 11 new bash tests + 1 end-to-end agent-loop test that mocks
  `/v1/chat/completions` and verifies bash output feeds back to
  the model.

### Security notes
- The bash tool executes via `sh -c`, so chained commands
  (`npm install && npm test`) work. The dangerous-pattern
  regexes catch the common escalation paths.
- Path traversal is still enforced at the `resolveToolPath` layer
  (B.1+B.2) for `write_file` and `edit_file`. The bash tool
  inherits the workspace as cwd, but the user is responsible for
  vetting absolute paths inside their command.
- Plan mode does NOT include bash in the tool manifest, so the
  model can't reach it in read-only mode.

## [0.5.0] — 2026-07-26 (Fase B.2: write_file + edit_file + inline diff viewer)

### Added
- **`write_file` tool** (B.2): creates or overwrites a file with
  the given content. Returns `{action, bytes, oldContent, newContent, diff}`.
- **`edit_file` tool** (B.2): targeted find-and-replace. Throws
  if `find` is not present. Supports `replaceAll` flag.
- **Inline diff viewer** in the chat (B.2): color-coded hunks
  (green for added lines, red for removed, plain for context).
  The user sees the diff for every write/edit immediately.
- **Plan mode now structurally can't write**: Plan mode
  manifest does NOT include `write_file` / `edit_file`, so the
  model can't reach them even if it tried.
- **Path-traversal protection for non-existent files**: the new
  `resolveToolPath(path, label, mustExist)` walks up the
  directory tree until it finds an existing ancestor and
  realpaths that, blocking `..` traversal without requiring the
  file to pre-exist.
- **Atomic-ish writes**: write to `<file>.mavis-tmp` then rename.
  Avoids leaving a half-written file if the process dies.
- **Line-diff in the shim** (no extra deps): an LCS-based line
  diff that produces unified-style hunks for the diff viewer.
- 8 new tests covering write_file + edit_file + the new
  `mustExist` resolution behavior.

## [0.4.0] — 2026-07-26 (Fase B.1: agent loop com 4 read-only tools + agent.md + Builder/Plan mode)
## [0.4.0] — 2026-07-26 (Fase B.1: agent loop com 4 tools read-only + agent.md + mode Builder/Plan)

### Added
- **Agent loop (Fase B.1)**: o shim agora roda o loop completo do
  agente — chama o model com o manifesto de tools, executa os
  `tool_calls` retornados, alimenta o resultado de volta pro model,
  e repete até o model emitir uma resposta final (ou atingir
  `MAX_ITER=8`). Antes era single-shot, agora é multi-turn.
- **4 read-only tools** implementados no shim (sandboxed ao
  workspace root, com `realpathSync` pra bloquear `..` traversal):
  - `read_file(path, startLine?, endLine?)` — lê arquivo com line range opcional
  - `glob(pattern, limit?)` — encontra arquivos por glob
  - `grep(pattern, path?, limit?)` — regex com line numbers
  - `list_directory(path?)` — lista diretório não-recursive
- **agent.md loader**: shim lê `<workspace>/agent.md` no início de
  cada agent run e injeta no system prompt (cap em 16 KB).
  Permite dar contexto de projeto (convenções, estrutura) sem
  ficar colando no chat.
- **@filename context**: o envelope do prompt agora aceita
  `contextFiles: string[]`. Os arquivos são lidos e injetados como
  system message (cap 8 files, 32 KB cada). B.5 adiciona o
  autocomplete no webview; B.1 já aceita a lista.
- **Builder/Plan mode toggle** no header do chat (botão novo).
  Em Plan mode, o system prompt instrui o model a não chamar
  tools destrutivos (que nem estão no manifesto B.1).
- **Tool calls visíveis no chat**: chips inline com nome da tool,
  args, e resultado. Status `running` (⏳) / `done` (✓) / `error` (✖).
- **Reasoning block**: o `reasoning_content` do model vira um
  `<details>` colapsável no chat.
- **`getTools()` dep** no ChatViewProvider + **`getReadOnlyToolManifest()`**
  em `src/agent/manifest.ts` — single source of truth pra tools.
- 10 testes novos (`test/shim/tools.test.cjs` cobre as 4 tools +
  `agent.md`; `test/shim/agentLoop.test.cjs` cobre o loop end-to-end
  com um fake archon server retornando `tool_calls` + content).
- 329/329 tests passam, tsc + esbuild clean.

### Architecture
- Tool manifest definido em **um lugar** (host) e enviado no
  envelope do `sendPrompt`. Backward-compat: se o host não
  passar tools, o shim usa o caminho single-shot antigo.
- Workspace root (`workspace.workspaceFolders[0]`) passado pro
  shim via `MAVIS_WORKSPACE`. Usado pelo `resolveToolPath` e
  pelo `loadAgentMd`.
- Path traversal protection via `fs.realpathSync` + prefix
  check — paths absolutos fora do workspace são rejeitados.

### Deferred to Fase B.2+
- Write tools (`write_file`, `edit_file`) com confirmation flow
- Inline diff viewer
- Bash tool (com allowlist + timeout)
- @filename autocomplete no webview
- Quota widget (`/v1/coding_plan/remains`)
- Themes
- MCP server support

## [0.3.12] — 2026-07-26 (FIX CRÍTICO: shim travava esperando stdin fechar — chat respondia depois de 15s com timeout)
## [0.3.12] — 2026-07-26 (FIX CRÍTICO: shim travava esperando stdin fechar — chat respondia depois de 15s com timeout)

### Fixed
- **Bug crítico que silenciava o chat mesmo com URL correta**: a
  função `readStdinLines` no shim esperava o evento `'end'` do stdin
  antes de processar qualquer prompt. O host escreve prompts via
  `child.stdin.write(...)` mas **nunca fecha o stdin** (o stream
  continua aberto pra múltiplos prompts). Resultado: o shim ficava
  travado no `await readStdinLines()` eternamente. O log de startup
  aparecia, o `[stream] start` aparecia no host, mas nenhuma
  request HTTP era feita → timeout de 15s no webview.

  Reescrito como `readStdinLinesStream()` (async generator) que
  yielda cada linha assim que ela chega no stdin. O `done` agora é
  emitido por prompt (não por stream) pra o host saber que a
  resposta daquela mensagem está completa.

### Added
- 2 testes de smoke (`test/shim/sessionStream.test.cjs`) que
  spawnam o shim em modo MOCK, escrevem 1 ou 2 prompts sem fechar
  stdin, e verificam que o shim emite `message` + `done` pra cada
  um sem travar.

## [0.3.11] — 2026-07-26 (FIX CRÍTICO: shim estava batendo em /chat/completions sem o /v1)

### Fixed
- **Bug crítico que silenciava todas as respostas do chat**: a função
  `archonUrl(path)` no shim (`resources/mavis-cli/mavis.cjs`) pulava
  `MAVIS_API_BASE` quando o `path` começava com `/`. Resultado: o shim
  batia em `https://api.minimax.io/chat/completions` (404 silencioso
  com retry, ou 200 vazio) em vez de
  `https://api.minimax.io/v1/chat/completions`. O `Mavis: Test
  connection` (host) construía a URL corretamente, então o teste
  passava — mas o chat (shim) falhava, dando timeout de 15s.
  Agora o shim SEMPRE prepende `MAVIS_API_BASE` (default `/v1`).

### Added
- Log de diagnóstico no `cmdSessionStream` mostrando o env efetivo
  (`archon`, `apiBase`, `model`, `stream`, `mock`, `key length`) pra
  correlacionar o que o shim vê com as settings do host.
- Log da URL completa em cada request (`chat request -> https://...`).
- 4 testes unitários pro `archonUrl` (default `/v1`, custom
  `apiBase`, trim de trailing slashes, mock mode).

## [0.3.9] — 2026-07-26 (Diagnóstico visível: Mavis: Open Output + timeout 15s no chat)

### Added
- **Canal "Mavis" no Output do VSCode** (saída do VSCode → aba
  "Mavis"). Mostra o stderr do shim, o lifecycle de cada stream
  (start, done, error) e o output do `Mavis: Test connection`.
  Antes o stderr só ia pro `process.stderr` (console do devtools,
  invisível pro usuário).
- **Comando `Mavis: Open Output`** (Command Palette). Abre o canal
  diretamente, sem precisar caçar no menu do VSCode.
- **Timeout de 15s no chat**. Se você mandar mensagem e nada
  voltar em 15s, aparece um banner com botões **"Testar conexão"**
  e **"Abrir Output"**. Evita ficar olhando pra tela sem entender
  o que aconteceu.
- **Botões "Testar conexão" e "Abrir Output"** no banner de erro
  do chat (não só no timeout) — pra você poder diagnosticar
  diretamente do chat sem sair dele.
- `onStderr` callback no `MavisClient` + `onLog` dep no
  `ChatViewProvider` permitem ao host logar o que tá rolando no
  stream e no shim.
- Novas mensagens webview→host: `testConnection`, `openOutput`.

### Fixed
- `onStreamEvent` do `done` estava duplicado (dois blocos
  `if (kind === 'done')`, um ignorava o outro). Consolidado num
  único bloco que loga E emite o `assistantMessage` com
  `delta.done=true`.

## [0.3.10] — 2026-07-26 (scripts/update-mavis.sh suprime o warning DEP0169)

### Added
- **Canal "Mavis" no Output do VSCode** (saída do VSCode → aba
  "Mavis"). Mostra o stderr do shim, o lifecycle de cada stream
  (start, done, error) e o output do `Mavis: Test connection`.
  Antes o stderr só ia pro `process.stderr` (console do devtools,
  invisível pro usuário).
- **Comando `Mavis: Open Output`** (Command Palette). Abre o canal
  diretamente, sem precisar caçar no menu do VSCode.
- **Timeout de 15s no chat**. Se você mandar mensagem e nada
  voltar em 15s, aparece um banner com botões **"Testar conexão"**
  e **"Abrir Output"**. Evita ficar olhando pra tela sem entender
  o que aconteceu.
- **Botões "Testar conexão" e "Abrir Output"** no banner de erro
  do chat (não só no timeout) — pra você poder diagnosticar
  diretamente do chat sem sair dele.
- `onStderr` callback no `MavisClient` + `onLog` dep no
  `ChatViewProvider` permitem ao host logar o que tá rolando no
  stream e no shim.
- Novas mensagens webview→host: `testConnection`, `openOutput`.

### Fixed
- `onStreamEvent` do `done` estava duplicado (dois blocos
  `if (kind === 'done')`, um ignorava o outro). Consolidado num
  único bloco que loga E emite o `assistantMessage` com
  `delta.done=true`.

## [0.3.8] — 2026-07-26 (Chat abre pronto: sessão + foco automáticos)

### Changed
- **Chat já vem com sessão ativa no primeiro open.** Não precisa mais
  clicar em "New" — o `ChatViewProvider.resolveWebviewView` agora
  detecta se não tem sessão e cria uma via `deps.newSessionId()`,
  registra no `SessionCache` (via `onNewSession`) e foca o input
  automaticamente (`focusInput` message). O textarea recebe focus
  programaticamente 80ms após o mount pra evitar race com a
  hidratação.
- O `placeholder` do input mudou de comportamento: agora é sempre
  "Type a message…" (não alterna mais pra "Press New to start a
  session" porque sempre tem sessão).

## [0.3.7] — 2026-07-26 (Chat agora responde: non-streaming por default)

### Fixed
- **Chat não respondia mesmo com `sk-cp-…` válida.** O bug era no
  parser SSE — o MiniMax M3 emite `delta.reasoning_content` E
  `delta.content` em chunks pequenos, e a parse quebrava silenciosamente.
  Mudança: o shim agora usa `stream: false` por default. A resposta
  chega inteira após alguns segundos (em vez de streaming palavra
  por palavra), mas funciona.
- Novo setting **`mavis.stream`** (default `false`). Liga pra
  reativar o typing effect; o parser SSE está em hardening.

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

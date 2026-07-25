# MiniMax Agent — Plano para Extensão VSCode

> Documento de design e plano de execução para uma extensão VSCode que
> integra o **MiniMax Agent** (Mavis) ao editor. Foco: chat no sidebar,
> ações inline sobre código, gestão de sessões e acesso ao Drive.

---

## 1. Visão geral e objetivos

Construir uma extensão VSCode (`minimax.vscode-agent` ou nome a definir) que
permita ao desenvolvedor conversar com o Mavis, invocar comandos sobre o
código selecionado, gerenciar sessões/agentes e navegar pelo Drive — sem sair
do editor.

**Objetivos primários**
- Chat lateral (sidebar) persistente, com histórico por sessão.
- Code actions no editor: explicar, refatorar, gerar testes, documentar,
  corrigir, aplicar patch.
- Integração com o ciclo de vida do projeto (terminal, explorer, diff viewer).
- Autenticação e gestão de credenciais sem vazar token pro disco em claro.

**Não-objetivos (v1)**
- Não rodar LLM local (a inferência fica no lado do Mavis).
- Não substituir o chat web — é uma *interface adicional*, não um substituto.
- Não fazer pair-programming com Telemetry/analytics agressiva.

---

## 2. Personas e casos de uso

| Persona | Necessidade | Como a extensão resolve |
|---|---|---|
| Dev solo (tipo você, Godot/Python) | Perguntar sobre código sem trocar de janela | Sidebar com chat + seletor de código |
| Dev em time | Compartilhar contexto de sessão com agente específico | Comandos `Mavis: switch session/agent` |
| Mantenedor de projeto | Gerar PR descritivo a partir de mudanças | `Mavis: generate commit message` / PR body |
| Dev com tarefa repetitiva | Automatizar análise/build/test | `Mavis: schedule cron` (cria task no daemon) |
| Curioso | Explorar o que o agente "vê" | Status bar mostra agent/session/drive ativos |

---

## 3. Capacidades (escopo v1)

### 3.1 Chat no Sidebar
- Webview com lista de mensagens, input box, attachments (arquivos do
  workspace, snippets).
- Streaming de resposta (token a token ou em chunks).
- Cada conversa é uma **sessão Mavis**; o usuário pode listar/renomear/
  retomar via comando.
- Multi-session tabs (estilo Cursor/Continue).

### 3.2 Ações no Editor
- CodeLens / Code Action provider com 6 ações padrão:
  1. `Mavis: Explain this`
  2. `Mavis: Refactor`
  3. `Mavis: Generate tests`
  4. `Mavis: Add docstring`
  5. `Mavis: Find bugs`
  6. `Mavis: Custom prompt...`
- Resultado abre num **diff editor lado-a-lado** com `Apply` / `Reject` /
  `Send to chat`.

### 3.3 Command Palette
- `Mavis: New chat`
- `Mavis: Switch session`
- `Mavis: Switch agent`
- `Mavis: Open Drive`
- `Mavis: Schedule cron`
- `Mavis: List agents`
- `Mavis: Run team plan...` (interface simples pra disparar o `team run`)
- `Mavis: Send selection to chat`
- `Mavis: Apply last patch`

### 3.4 Status Bar
- Indicador fixo: `[Mavis: <agent> | <session-short-id>]`.
- Click → menu rápido (switch, new, kill, settings).

### 3.5 Drive
- TreeView no explorer lateral (`Mavis Drive`) com:
  - Categorias: documents, excel, ppt, images, videos, audio, other.
  - Ações: open no VSCode, download, delete, share.
  - Drag-and-drop pra anexar em mensagens do chat.

### 3.6 Settings
- `mavis.cliPath` (path do binário `mavis`, default: bundled; permite
  override de versão).
- `mavis.cliVersion` (versão bundled exibida na status bar / about).
- `mavis.defaultAgent` (qual agent spawn por padrão).
- `mavis.telemetry` (default: `false` — opt-in).
- `mavis.model` (override do modelo se a API expor).
- Auth: gerenciado via `SecretStorage` (não em settings.json).

---

## 4. Arquitetura técnica

### 4.1 Stack
- **TypeScript** com `esbuild` ou `webpack` (template `yo code`).
- **VSCode API** 1.85+ (webviews, tree views, secret storage, language model
  API opcional se Mavis expor).
- **UI**: webview com **React + Vite** (mais simples que vanilla TS pro
  chat rico, render de markdown, code blocks, diffs).
- **Bridge**: cliente Node que spawna o binário `mavis` ou fala HTTP com o
  `archon-server` se ele expor endpoint.
- **Markdown** render: `react-markdown` + `shiki` pra syntax highlight.
- **Diffs**: `diff2html` (client-side) ou o `vscode.Diff` nativo do editor.

### 4.2 Componentes

```
┌────────────────────────────────────────────────────────┐
│                VSCode Extension Host                   │
│                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Sidebar     │  │  Editor      │  │  TreeView    │  │
│  │  Webview     │  │  CodeActions │  │  (Drive)     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                 │          │
│         └─────────────────┼─────────────────┘          │
│                           ▼                            │
│              ┌─────────────────────────┐               │
│              │  MessageBus (in-proc)   │               │
│              │  - commands, events     │               │
│              └─────────────┬───────────┘               │
│                            │                            │
│              ┌─────────────▼───────────┐               │
│              │  MavisClient (TS)       │               │
│              │  - spawn mavis CLI      │               │
│              │  - HTTP fallback        │               │
│              │  - streaming parser     │               │
│              └─────────────┬───────────┘               │
│                            │                            │
└────────────────────────────┼────────────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │   mavis CLI / archon-server │
              │   (external)                │
              └─────────────────────────────┘
```

### 4.3 Comunicação (mavis CLI bridge)

- **Abordagem escolhida**: "binário empacotado" mas como **shim Node**
  (não precisa compilar Go/Rust pra cada plataforma). O `.vsix` é só
  um zip — bundlar `mavis-cli/mavis.{js,cjs}` com shebang é trivial e
  fica em ~2 MB em vez de 80 MB.
- Resolução em runtime:
  1. `mavis.cliPath` em settings (override do usuário pra apontar pro
     binário oficial quando sair o open-source).
  2. Shim bundled em `resources/mavis-cli/mavis.{js,cjs}` com shebang
     `#!/usr/bin/env node`.
  3. Erro amigável: "MiniMax Agent CLI não encontrado. Instale
     manualmente ou defina `mavis.cliPath`."
- O shim Node internamente:
  - Detecta o `node` no PATH (ou `process.execPath` se rodando dentro
    do VSCode embed).
  - Faz HTTP/WebSocket pro archon-server (mesmos endpoints que a
    webapp usa), encapsulando o protocolo NDJSON que o daemon espera.
  - Quando o CLI oficial (`mavis` em Go/Rust) sair, troca-se o shim
    pelo binário real sem mudar a extensão.
- Subprocesso persistente
  (`child_process.spawn(mavisBin, ['session', 'stream', '--session-id',
  id])`).
- Stdout em NDJSON (uma linha por evento: `message`, `tool_call`,
  `tool_result`, `error`, `done`).
- Stdin pra enviar prompts.
- Cleanup em `deactivate()` da extensão.

### 4.4 Autenticação (OAuth via browser)

A integração vai suportar **dois fluxos** (escolha detectada via
`/.well-known/oauth-config` ou settings):

#### Fluxo A — Device Code (preferido, padrão observado em
integrações third-party com o archon-server)

Inspirado no que o Hermes Agent (`NousResearch/hermes-agent`)
implementa pra MiniMax/MiniMax hoje. Bom pra máquinas sem browser
embutido e pra quando o archon-server ainda não tem PKCE completo.

1. User dispara `Mavis: Sign in`.
2. Extensão faz `POST {base_url}/oauth/code` com `client_id` (registrado
   previamente via portal Mavis) → recebe `{ user_code, verification_uri,
   interval, expires_in, device_code }`.
3. Extensão abre `verification_uri` no browser externo (com
   `user_code` pré-preenchido via query se o servidor suportar).
4. Extensão faz polling `POST {base_url}/oauth/token` com `device_code`
   a cada `interval` segundos até `expires_in`.
5. Recebe `{ access_token, refresh_token, expires_in }`.
6. Persiste em `vscode.SecretStorage`. `refresh_token` renova sem
   re-login.
7. UI mostra "Waiting for browser approval…" com botão de copiar
   `user_code` (caso o user esteja num device diferente — `hermes auth
   add ... --no-browser`).

#### Fluxo B — PKCE + redirect (fallback moderno)

Pra quando o archon-server expor OAuth2 completo.

1. Extensão gera `code_verifier` + `code_challenge` (SHA-256, base64url).
2. Sobe mini HTTP server local em `127.0.0.1:<random-port>`.
3. Abre `GET {base_url}/oauth/authorize?response_type=code&client_id=...&code_challenge=...&code_challenge_method=S256&redirect_uri=http://127.0.0.1:<port>/callback&state=<random>&scope=...` no browser.
4. Server local captura `code` no callback, valida `state`.
5. `POST {base_url}/oauth/token` com `code` + `code_verifier` →
   `access_token` + `refresh_token`.
6. Persiste em `SecretStorage`. Fecha o server local.

#### Comum aos dois fluxos
- **Refresh**: 401 do archon-server ou timer pré-expiry → `POST
  /oauth/token` com `grant_type=refresh_token`. Se falhar, dispara
  re-login.
- **Logout**: `Mavis: Sign out` revoga (se endpoint exposto) + limpa
  `SecretStorage`.
- **Segurança**:
  - Tokens **nunca** em `console.log`, settings.json, ou
    `globalState`.
  - `code_verifier` é descartado após o handshake.
  - `state` aleatório validado contra CSRF.
  - Server local só escuta em `127.0.0.1`, fecha em ≤30s.
  - `SecretStorage` é encriptado pelo VSCode (keychain no macOS,
    libsecret no Linux, DPAPI no Windows).

#### Detecção automática
- Extensão faz `GET {base_url}/.well-known/oauth-config.json` no
  primeiro start; se retornar `{ device_code_endpoint, token_endpoint }`
  → Fluxo A; se retornar `{ authorization_endpoint, token_endpoint }` →
  Fluxo B. Fallback: settings `mavis.oauthFlow` (manual).

### 4.5 Estado e persistência
- `memento` (globalState) pra cache leve: lista de agents, último agent
  usado, último session-id.
- Sessões de chat: vidas no daemon Mavis, não persistidas localmente.
- Drafts de mensagem: `memento` por sessão pra não perder o que tava
  digitando em reload.

### 4.6 Modelo de dados (resumido)

```ts
type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: ContentBlock[];   // text, code, file-ref, tool-call
  sessionId: string;
  ts: number;
};

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; lang: string; source: string }
  | { type: 'file'; path: string }
  | { type: 'tool_call'; name: string; args: any }
  | { type: 'tool_result'; name: string; result: any };
```

---

## 5. UI/UX

### 5.1 Layout
- **Sidebar esquerda** (Activity Bar): ícone do Mavis, abre a view
  `mavis.chatView`.
- **Sidebar secundária** (opcional): `mavis.driveView` com o tree do Drive.
- **Editor central**: integrações com o arquivo aberto (CodeLens).
- **Status bar inferior**: indicator de session/agent.
- **Webview do chat**:
  - Header: nome do agent + session-id curto + botões (new, history,
    settings).
  - Body: lista de mensagens com scroll infinito.
  - Footer: textarea com @-mention de arquivos (`@file`), `/` pra slash
    commands (`/clear`, `/agent`, `/drive`), e botão de attach.

### 5.2 Visual
- Tema: herda do VSCode (light/dark/high-contrast).
- Code blocks com syntax highlight, copy button, "Apply to file" inline.
- Markdown com GFM (tables, task lists, autolinks).
- Empty state amigável: "Pergunte qualquer coisa sobre o seu código."

### 5.3 Atalhos
- `Cmd+Shift+M` (Mac) / `Ctrl+Shift+M` (Win/Linux): toggle chat.
- `Cmd+L` (Mac) / `Ctrl+L` (Win/Linux): send selection to chat.
- Configuráveis via `keybindings.json` no package.json.

---

## 6. Fases de implementação

Cada fase termina com **demo funcional** + checklist de qualidade
(lint/typecheck/test/packaging verde).

### Fase 0 — Esqueleto (1–2 dias)
- [ ] Scaffold via `npx --package=typescript yo code` (TypeScript, esbuild).
- [ ] `package.json` com: contributes (commands, views, menus, keybindings,
      configuration), engines.vscode ^1.85, categories=["Programming",
      "Chat"].
- [ ] Esbuild config pra build do webview (entry: `webview/main.tsx`).
- [ ] CI: GitHub Actions com `npm run lint && npm run test && npm run
      package`.
- [ ] Icon set (16/24/48/128) e LICENSE.

**Entregável:** `code --install-extension` funciona, comando
`Mavis: Hello` mostra um webview com "Hello from Mavis".

### Fase 1 — Cliente Mavis + Chat básico (3–5 dias)
- [ ] Implementar `MavisClient` com spawn do CLI.
- [ ] Detectar `mavis` no PATH; fallback: instalar binário em
      `~/.mavis/bin/`.
- [ ] SecretStorage + comando `Mavis: Sign in`.
- [ ] Webview React com lista de mensagens + input.
- [ ] Streaming via NDJSON parser.
- [ ] Slash commands: `/clear`, `/new`.
- [ ] Persistência de drafts.

**Entregável:** dá pra abrir o chat, mandar uma mensagem, receber resposta
streamed.

### Fase 2 — Sessões, agentes, multi-tab (3–4 dias)
- [ ] `Mavis: New chat` cria session via CLI.
- [ ] Tabs de sessão no header do webview (estilo Cursor).
- [ ] `Mavis: Switch agent` lista agents via `mavis agent list`.
- [ ] `Mavis: List sessions` em QuickPick.
- [ ] Status bar item reativo.
- [ ] Cache em `globalState`.

**Entregável:** múltiplas sessões simultâneas, switch entre agents,
indicador no status bar.

### Fase 3 — Ações no editor (4–6 dias)
- [ ] CodeAction provider com 6 ações padrão.
- [ ] Cada ação:
  1. Captura seleção (path + range + text).
  2. Envia prompt estruturado ao Mavis (template em `prompts/`).
  3. Recebe patch (unified diff).
  4. Abre `vscode.Diff` lado-a-lado.
  5. Botão `Apply` aplica; `Reject` descarta; `Send to chat` injeta no
     chat ativo.
- [ ] CodeLens opcional (ex: "Explain" inline em funções).
- [ ] Suporte a múltiplos arquivos (Mavis retorna lista de patches).

**Entregável:** seleciono uma função, clico "Refactor", vejo diff,
aplico.

### Fase 4 — Drive + Cron (2–3 dias)
- [ ] TreeView `mavis.driveView`.
- [ ] Comandos: refresh, open in VSCode, download to workspace, delete.
- [ ] Drag-and-drop pro webview (anexa arquivo à mensagem).
- [ ] `Mavis: Schedule cron` abre form (name, cron expr, prompt, agent).
- [ ] `Mavis: List cron` em QuickPick com toggle enable/disable.

**Entregável:** vejo meus arquivos do Drive, anexo no chat, crio um cron
de "rodar testes todo dia às 8h".

### Fase 5 — Polimento (3–4 dias)
- [ ] Settings UI (WebView) com formulário.
- [ ] Telemetry opt-in (apenas eventos: command_used, action_invoked —
  nada de conteúdo).
- [ ] i18n scaffold (en + pt-BR, já que o user usa PT).
- [ ] Themes custom (opcional, mas bonito pra mostrar).
- [ ] Documentação: README com GIFs, CHANGELOG, CONTRIBUTING.
- [ ] Marketplace listing (description, tags, icon, repo link).
- [ ] Testes E2E com `@vscode/test-electron` cobrindo fluxo crítico.

**Entregável:** release v0.1.0 no marketplace.

### Fase 6 (opcional) — Integração avançada
- [ ] VSCode **Language Model API** se Mavis virar provider registrado.
- [ ] Inline edit (Cmd+K) estilo Cursor.
- [ ] Notebooks: rodar Mavis em cells.
- [ ] Tasks provider: rodar build/test via Mavis.

---

## 7. Riscos e mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| `mavis` CLI instável / muda flags | Média | Alto | Wrapper de versionamento; pin do contrato de NDJSON; versionado em `protocolVersion`; como é shim Node nosso, podemos absorver mudanças rápido |
| Latência de stream no webview | Média | Médio | Virtualizar lista de mensagens; throttle de render (React 18 concurrent) |
| Token vazado em logs | Baixa | Alto | Lint custom + grep no CI; SecretStorage sempre; nada de `console.log(token)` |
| Conflito com extensões tipo Copilot | Média | Baixo | Documentar coexistência; namespaces próprios (`mavis.*`) |
| Marketplace rejeitar | Baixa | Médio | Ler guidelines antes; license MIT; icon + screenshots 1280x640 |
| UX confusa no primeiro uso | Média | Médio | Onboarding webview, comandos bem nomeados, empty state amigável |
| Diff grande (muitos arquivos) | Média | Médio | Limitar a 1 arquivo por CodeAction v1; "Send all to chat" pra casos grandes |

---

## 8. Métricas de sucesso

- **Adoção** (se publicado): installs, MAU, retention D7.
- **Engagement**: avg mensagens/sessão, % sessões com CodeAction aplicada.
- **Qualidade**: crash-free rate > 99.5%, p95 latência do primeiro token
  < 3s em rede boa.
- **Feedback**: rating no marketplace, issues abertas/fechadas por release.

---

## 9. Estrutura de pastas proposta

```
vscode-minimax-agent/
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── src/
│   ├── extension.ts            # activate/deactivate
│   ├── commands/              # 1 arquivo por comando
│   ├── views/
│   │   ├── ChatViewProvider.ts
│   │   └── DriveViewProvider.ts
│   ├── client/
│   │   ├── MavisClient.ts     # wrapper do CLI
│   │   ├── ndjson.ts
│   │   └── types.ts
│   ├── auth/
│   │   └── SecretStore.ts
│   ├── statusbar/
│   │   └── StatusBar.ts
│   ├── codeactions/
│   │   └── provider.ts
│   └── prompts/               # templates de prompt por ação
│       ├── refactor.ts
│       ├── explain.ts
│       └── ...
├── webview/                   # build separado, React
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   └── styles.css
├── resources/
│   ├── icon.png
│   └── mavis-cli/             # shim Node (multiplataforma, ~2 MB)
│       ├── mavis.cjs          # entry com shebang #!/usr/bin/env node
│       └── lib/               # código compartilhado do shim
├── test/
│   └── e2e/
└── .github/workflows/
    └── ci.yml
```

---

## 10. Decisões (resolvidas em 2026-07-25)

| # | Pergunta | Decisão | Implicações |
|---|---|---|---|
| 1 | Nome do pacote | `minimax.vscode-agent` | Publisher `minimax`, ext id `minimax.vscode-agent` |
| 2 | Distribuição | `.vsix` interno | Sem publish no marketplace; install via `code --install-extension`; repo serve como source-of-truth + releases |
| 3 | Bridge | **Shim Node empacotado** | `resources/mavis-cli/mavis.cjs` com shebang; ~2 MB no .vsix (vs 80 MB do binário nativo); quando o CLI oficial sair, troca sem refactor |
| 4 | Auth | **OAuth via browser** | PKCE flow; callback em `http://127.0.0.1:<random>/callback` aberto pelo webview; precisa confirmar endpoints do archon-server (research item) |
| 5 | Telemetria | **Opt-in** | Setting `mavis.telemetry = false` por default; nenhum evento coletado sem toggle explícito; primeiro uso com telemetria off dispara um único notice na UI oferecendo opt-in (sem bloquear) |
| 6 | Repo | `yuri-schmaltz/vscode-minimax-agent` | Público; CI próprio; PAT já tem (workflow de releases) |
| 7 | Escopo v1 | **Full v1** (6 fases) | Cronograma: ~3–4 semanas; execução recomendada via team plan com ciclos (1 producer + 1 verifier por fase) |

### 10.1 Research items antes de Fase 0 (status em 2026-07-25)

- [x] **OAuth flow do archon-server**: pesquisa web encontrou precedente
      no **Hermes Agent** (`NousResearch/hermes-agent`), que integra
      com MiniMax usando device code flow (`POST /oauth/code` →
      `user_code` + `verification_uri` → polling `POST /oauth/token`).
      Plano agora suporta **dois fluxos** (device code como default,
      PKCE+redirect como fallback moderno). **Ainda falta confirmar**
      se o archon-server expõe esses endpoints exatos — pode variar
      do que o Hermes encontrou.
- [ ] **Shape do NDJSON do stream**: precisa testar com um
      `archon-server` real. Plano já define o contrato esperado;
      ajustar quando testarmos.
- [x] **Binário `mavis`**: o open-source oficial ainda não saiu
      ("esperado coincidir com release do M3"). Solução: empacotar
      um **shim Node** que fala HTTP direto com o archon-server. Troca
      pelo binário nativo quando sair, sem refactor.
- [x] **Versionamento do shim**: setting `mavis.cliPath` (string
      opcional) tem prioridade sobre o bundled. Documentado em 3.6.

### 10.2 Adições pós-decisão (validações/investigações rápidas)

- [ ] Confirmar com o time Mavis (ou via `mavis agent list` se eu
      conseguir acesso): endpoints OAuth exatos, modelo default
      (`MiniMax-M3` segundo a system prompt, mas o serviço pode expor
      outros), e limite de token/rate limit.
- [ ] Verificar se existe rate limit por token (pra implementar backoff
      no client).

---

## 11. Próximos passos (proposta concreta)

1. **Resolver os 4 research items da 10.1** — me deixa investigar rapidinho (queries web + 1 sessão spawn pra explorar o repo do `mavis` se existir público).
2. **Subir o repo** `yuri-schmaltz/vscode-minimax-agent` com `.gitignore`, LICENSE MIT, README inicial, e CI básico.
3. **Abrir team plan** com 3 ciclos:
   - **Ciclo 1**: Fase 0 (esqueleto) + Fase 1 (cliente + chat) — producer codifica, verifier valida build, lint, types, e teste manual de chat.
   - **Ciclo 2**: Fase 2 (sessões/agentes) + Fase 3 (code actions).
   - **Ciclo 3**: Fase 4 (drive/cron) + Fase 5 (polimento + .vsix release).
4. Cada ciclo termina com `.vsix` instalável pra você testar.

**Diz "bora" e eu já começo pelo passo 1** (research dos 4 itens). Ou se preferir, abre direto a Fase 0 com placeholders pros itens não-resolvidos (vai exigir retrofit depois, mas começa a ver código mais cedo).

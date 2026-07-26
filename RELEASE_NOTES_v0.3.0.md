# v0.3.0 — MiniMax Agent VSCode (Out-of-the-box, com vinculação de conta)

Esta release torna a extensão **funcional com a conta MiniMax do
usuário** desde a primeira instalação, sem precisar editar
`settings.json` nem caçar a `archon-server` no código.

## O que muda

### Vinculação de conta MiniMax

- **Novo comando `Mavis: Set API key`** (paleta de comandos).
  - Abre um input box protegido (senha).
  - Valida o prefixo `sk-` antes de salvar.
  - Persiste em `SecretStorage` (chave `mavis.apiKey`).
- **Novo comando `Mavis: Welcome`**.
  - Aparece automaticamente na **primeira ativação**.
  - Detecta se já tem chave. Se não, oferece 3 ações:
    - "Definir API key" (chama o comando acima)
    - "Abrir configurações" (filtra em `mavis`)
    - "Abrir chat" (toggle do sidebar)

### Defaults prontos

| Setting | Antes | Agora |
|---|---|---|
| `mavis.archonUrl` | `""` (vazio) | `https://api.minimax.io` |
| `mavis.model` | `""` | `MiniMax-M3` |
| `mavis.apiBase` | (não existia) | `/v1` |

O usuário não precisa tocar em nada — abrir o chat já funciona.

### Shim HTTP-bridge (não-mock)

O `mavis.cjs` agora fala HTTP de verdade com a API MiniMax quando a
chave tá setada:

- `session stream` → `POST {archonUrl}/v1/chat/completions` com
  `stream: true`; decodifica SSE OpenAI-compat, emitindo NDJSON
  `type:"message"` por chunk.
- `agent list` → `GET /v1/models` para descobrir o que a chave
  enxerga; sempre inclui o `mavis` (default, `MiniMax-M3`).
- `oauth code` / `oauth token` → chamam `/oauth/code` e
  `/oauth/token` no archon-server quando configurado. Se o servidor
  não responder, caem no mock graciosamente.

### Ativação sem chave

- Antes: extensão em mock mode permanente.
- Agora: tenta real; se faltar a chave, a shim emite uma mensagem
  de erro amigável (`MAVIS_API_KEY is not set; run "Mavis: Set API
  key"`). O chat ainda abre (mostra o erro no output), e o comando
  de "Set API key" fica a 1 clique de distância.

## Como atualizar

```bash
# baixa o .vsix mais recente
curl -L -o /tmp/vscode-agent-0.3.0.vsix https://github.com/yuri-schmaltz/vscode-minimax-agent/releases/download/v0.3.0/vscode-agent-0.3.0.vsix
code --install-extension /tmp/vscode-agent-0.3.0.vsix
# reinicia o VSCode
```

Na primeira abertura:
1. A notificação "Bem-vindo ao Mavis" aparece.
2. Clique em **"Definir API key"**.
3. Cole sua Subscription Key (`sk-cp-...`) — pegue em
   [platform.minimax.io](https://platform.minimax.io/user-center/payment/token-plan).
4. Pronto. `Cmd/Ctrl+Shift+M` abre o chat e ele responde em
   `MiniMax-M3` (ou o modelo que você setar em `mavis.model`).

## Métricas

- **313 testes** passando (4 novos pra API key + env passthrough)
- **100% typecheck + lint**
- **0 secrets** vazando
- **489 KB** `.vsix` (24 arquivos)

## Compatibilidade

Sem mudança na matriz de engines: VSCode ≥ 1.85, Node ≥ 18.

---

**VEREDITO FINAL: PASS** — 313/313 tests, lint clean, typecheck clean, package green.

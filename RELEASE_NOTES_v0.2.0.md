# v0.2.0 — MiniMax Agent VSCode (Ciclos 1–5, Fases 0–6)

Primeira release completa da extensão **MiniMax Agent (Mavis)** para
VSCode. Cobre todas as 6 fases do plano de design: do esqueleto até
a integração avançada com as APIs nativas do editor.

## O que vem na caixa

- **Chat lateral** (webview React) com streaming via NDJSON.
- **Sessões e agentes** com troca rápida (QuickPick) e tabs no header.
- **6 code actions** Mavis-branded (Explain, Refactor, Generate tests,
  Add docstring, Find bugs, Custom prompt) com diff editor.
- **Mavis Drive** (tree view com categorias: documents/excel/ppt/images/
  videos/audio/other), abrir / baixar / anexar ao chat / deletar.
- **Cron scheduling** via formulário + lista com enable/disable/delete.
- **Telemetria opt-in** (default `false`, sem PII, 4 tipos de evento).
- **i18n** com tabelas en + pt-BR (72 chaves, paridade 100%).
- **Settings UI** (webview) com persistência em `globalState`.

## Integração avançada (Fase 6)

- **Language Model API** — Mavis exposto como `lm` provider com vendor
  `mavis`. Cada agente vira uma entrada de modelo; respostas são
  streamadas de volta via `Progress` callback. Consumidores usam
  `vscode.lm.selectChatModels({ vendor: 'mavis' })`.
- **Inline edit (Cmd+K)** — ghost text baseado em Mavis para
  TypeScript / JavaScript / Python / Go / Rust + wildcard. Pula
  arquivos > 100 KB, honra cancelamento via race com sentinel.
- **Notebook controller** — execução de células Jupyter (`jupyter-notebook`
  + tipo customizado `mavis-notebook`). Células vazias curto-circuítam;
  erros mid-stream marcam a célula como failed.
- **Tasks provider** — três tasks prontas (`test`, `lint`, `package`)
  wired em `npm run <script>`, agrupadas em Test/Clean/Build.
  Suporta pnpm/yarn via override.

## Métricas

- **309 testes** passando, 0 falhando
- **88.65% stmts** / **82.94% branches** / **92.78% functions**
  (gate passa)
- **8 commits** Conventional Commits no ciclo 5
- **48+ commits** total no projeto
- **0 secrets** vazando (auditado por `npm run lint:secrets`)

## Como instalar

```bash
code --install-extension vscode-agent-0.2.0.vsix
```

## Onde encontrar

- Repo: https://github.com/yuri-schmaltz/vscode-minimax-agent
- Plan: `/workspace/vscode-minimax-agent-plan.md`
- Deliverable: `deliverable.md` no repo (489 KB de história condensada)

## Compatibilidade

- VSCode ≥ 1.85 (engine `^1.85.0`)
- Node ≥ 18 (host runtime)
- Funciona em mock mode sem o backend archon-server; conecta
  automaticamente quando `mavis.archonUrl` é configurado.

---

**VEREDITO FINAL: PASS** — 309/309 tests, lint clean, typecheck clean, package green.

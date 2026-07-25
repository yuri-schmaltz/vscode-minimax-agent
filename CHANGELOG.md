# Changelog

All notable changes to the MiniMax Agent (Mavis) VSCode extension are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-07-25 (Ciclo 1)

### Added
- Esqueleto (Fase 0): manual scaffold (TypeScript + esbuild), `package.json`
  with `engines.vscode ^1.85`, `categories ["Programming", "Chat", "Other"]`,
  7 `mavis.*` commands, activity-bar (`mavis.chatView`) + secondary-bar
  (`mavis.driveView`) containers, `ctrl+shift+m` toggle, full
  `mavis.*` configuration block, icon set (16–512), strict CI pipeline.
- Cliente Mavis (Fase 1): `MavisClient` with NDJSON streaming, child
  process lifecycle, `listSessions` / `listAgents` one-shot calls,
  typed events, complete `dispose()` cleanup.
- CLI shim (`resources/mavis-cli/mavis.cjs`): mock-mode Node shim with
  `agent list`, `session list`, `session stream`, `oauth code`,
  `oauth token`. ~8 KB. Easy swap when the official binary ships.
- Auth (OAuth + SecretStore): device-code and PKCE+redirect flows,
  auto-detection via `/.well-known/oauth-config.json`, `SecretStorage`
  persistence under `mavis.auth`, silent refresh 60s pre-expiry, sign-out
  revokes best-effort. Tokens are never logged or sent to the webview.
- Status bar: reactive bottom-bar item (`$(mavis-icon) Mavis: <agent> |
  <session> <signed>`), QuickPick with New chat / Switch agent / Sign
  in/out.
- Chat webview (React 18 + esbuild): sidebar webview with markdown
  (`react-markdown`), shiki code blocks, streaming via
  `assistantMessage` deltas merged into the last assistant message,
  strict CSP, Enter-to-send (Shift+Enter newline), empty state,
  error banner.
- Testes (`test/`): 36 unit tests under `node --test --import tsx`
  covering MavisClient, OAuth, StatusBar, and the CLI shim end-to-end.

### Verified
- `npm run lint`     ✓
- `npm run typecheck` ✓
- `npm test`         36 / 36 passing
- `npm run package`  ✓ produces `vscode-agent-0.1.0.vsix` (~263 KB)

### Out of scope (deferred to Ciclo 2+)
- Code actions (Fase 3)
- Drive TreeView (Fase 4)
- Cron (Fase 4)
- Telemetry opt-in notice (Fase 5)
- i18n (Fase 5)
- Marketplace listing (Fase 5)

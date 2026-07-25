# MiniMax Agent for VSCode

> Use the **MiniMax Agent (Mavis)** directly inside VSCode — chat,
> code actions, sessions, drive, and scheduled automations.

> 🚧 **Status: pre-alpha.** Skeleton under construction. See
> [`docs/PLAN.md`](docs/PLAN.md) for the full design and roadmap.

---

## What this is

A VSCode extension that integrates the MiniMax Agent (Mavis) into the
editor:

- **Chat sidebar** — talk to Mavis without leaving VSCode
- **Code actions** — explain, refactor, generate tests, add docstrings,
  find bugs on selected code
- **Sessions & agents** — multi-session tabs, switch between agents
- **Drive** — browse, attach, and download files from your Mavis Drive
- **Cron** — schedule recurring automations (e.g. "run tests every
  morning at 8am")
- **OAuth sign-in** — browser-based PKCE flow, no manual API keys

## Installation (v1, internal)

Once a release exists, install the `.vsix`:

```bash
code --install-extension minimax.vscode-agent-0.1.0.vsix
```

## Development

This repo is currently in the **Fase 0 (skeleton)** stage. See
[`docs/PLAN.md`](docs/PLAN.md) for the full roadmap.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `mavis.cliPath` | bundled shim | Override path to the `mavis` CLI binary |
| `mavis.cliVersion` | bundled | Bundled CLI version (shown in status bar) |
| `mavis.defaultAgent` | `mavis` | Which agent to spawn by default |
| `mavis.telemetry` | `false` | Opt-in anonymous usage telemetry |
| `mavis.model` | server default | Override the model used for completions |

## License

MIT — see [LICENSE](LICENSE).

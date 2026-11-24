# Paseo DSH provider

[中文](README.md) | [English](README.en.md)

Use DeepSeek Harness in Paseo through a local directory plugin. The Paseo version requirement is `*`, allowing installation on any stable release. The provider ID is `dsh`.

## Installation

Install DSH on the daemon machine and confirm that `dsh --profile acp` starts. Enable Paseo's global `pluginsEnabled` setting, then run:

```powershell
paseo plugin install E:\Repositories\paseo-dsh
paseo plugin ls
```

The `paseo-dsh` plugin should report `running`. Select `dsh` in a workspace. The model catalog loads after selecting a workspace; the global model list may be empty.

The default command is `dsh --profile acp`. To pin an executable, set the complete argv in the daemon's `agents.providers.dsh.command` configuration. Command overrides still pass through the compatibility bridge. The Paseo SDK continues to merge the daemon and session environments.

DSH reads credentials. The plugin neither copies keys nor provides an ACP login flow.

## Current behavior

The plugin now runs as a **Paseo Direct Provider + native DSH Cordis bridge plugin** (supporting both `acp` and `sdk` profiles), bypassing the ACP bottleneck:

- **Token-level streaming & deduplication**: subscribes directly to `agent/assistant-stream` for incremental text and reasoning updates, deduplicating committed `assistant/message` events and isolating retried/abandoned attempts.
- **Rich tool cards**: maps native DSH tools to Paseo `shell`, `read`, `edit`, `write`, `search`, `fetch`, and `sub_agent` cards, while preserving raw inputs/outputs and original error details for MCP and extension tools.
- **Permission modes & dynamic configuration**: workspace model catalog, `thinkingOption` (reasoning effort), and `permissionPresets` mapped to Paseo `modes`.
- **Advanced interactive capabilities**:
  - `prompt.steer`: injects mid-turn steering input without cancelling the active turn.
  - `session.commands` + `prompt.command`: advertises and executes native DSH slash commands (`/permission`, `/compact`, `/goal`, etc.) and emits `compaction` timeline items.
  - `session.revert.conversation`: forks a new UUID session via `@deepseek-ai/dsh-session/fork`'s `buildForkSeed` and updates `session.persistence` without mutating the original log.
  - `user-question/ask` -> `session.permission (kind: "question")`: full structured question and cancellation loop.
  - `session.subsession`: forwards parent-child subagent session lifecycles and event streams.
- **Reliability & backwards compatibility**:
  - Preserves `{ version: 1, data: { sessionId } }` persistence handles for seamless replay and continuation of existing chats.
  - Terminalizes running tool cards (`activeToolTerminalObserved=true`) and cancels pending permissions on `reload`, `close`, or unexpected process exit.
  - Spawns `dsh` directly via `@getpaseo/plugin/server`'s `spawnProcess` / `terminateProcess` without an Electron `--eval` hop.
  - Emergency fallback to the legacy ACP bridge is available via `PASEO_DSH_ENGINE=acp`.

## Verification

Use Node `>=24.9.0` and PowerShell 7.

```powershell
npm ci
npm run typecheck
npm test
node probes/bridge.mjs
node probes/direct-e2e.mjs
```

- `probes/bridge.mjs` (Stage 0): self-contained keyless fixture against the installed `dsh` binary verifying `bridge/init` -> `catalog/get` -> `session/open` -> MCP tool + streaming -> `turn/cancel` -> restart `session/resume` replay with zero stdout noise.
- `probes/direct-e2e.mjs` (Stages 1–3): end-to-end verification through `index.server.ts` covering `status()`, capability negotiation, workspace catalog & permission modes, token streaming deduplication, dynamic model/mode/thinking configuration, native slash commands, tool approvals, structured user questions, mid-turn steering, `buildForkSeed` conversation revert, active tool terminalization on close/reload (`activeToolTerminalObserved=true`), and `session.list` / invalid-cwd rejection.
- Legacy ACP regression probes (`probes/permission.mjs`, `probes/acp.mjs`, `probes/history.mjs`, and `probes/stage1.ps1`–`stage4.ps1`) remain available.

On Windows, the SDK calls `taskkill /T /F`. Probes fail in sandboxes that prohibit terminating child process trees.

The following scripts start separate temporary daemons and leave the existing daemon unchanged. `PaseoCli` is the `bin/paseo` file from the version of `@getpaseo/cli` under test. The development SDK stays locked for reproducible type checking. Runtime compatibility is established by acceptance tests on the target version.

```powershell
./probes/stage1.ps1 -PaseoCli <bin/paseo>
./probes/stage2.ps1 -PaseoCli <bin/paseo>
./probes/stage3.ps1 -PaseoCli <bin/paseo>
./probes/stage4.ps1 -PaseoCli <bin/paseo>
```

Stages 1, 3, and 4 require the sibling DSH repository's existing build and dependencies. Stage 2 runs production `dsh.cmd` against a real model and consumes model quota. Override paths with `-DshCli` and `-CredentialsPath`; the default credential file is `~/.dsh/.credentials.yaml`. The script passes only the credential file path to DSH and does not print keys.

Scripts print their evidence directory and stop the test daemon in `finally`. Evidence is retained for inspection. Tested versions: Windows, Node 25.8.0, Paseo 0.15.2, keyless fixture DSH 0.2.2-rc.1, and production DSH 0.2.1-rc.5 for real-model tests. Paseo Desktop 0.15.2 with Electron 44.2.0 and Node 24.20.0 was also checked against a real workspace catalog. Other platforms and versions remain unverified.

When `npm test` finds `Paseo.exe` at its default installation path, it also checks bridge startup using the real Electron executable. Set `PASEO_DSH_ELECTRON` for another installation path. The desktop daemon needs `ELECTRON_RUN_AS_NODE=1` for the bridge; the original environment is restored before launching DSH.

See the [execution record](.agents/notes/EXECUTION.en.md), [integration plan](.agents/notes/DSH-PROVIDER-PLAN.en.md), and [notes index](.agents/notes/INDEX.md) for evidence, decisions, and Chinese versions.

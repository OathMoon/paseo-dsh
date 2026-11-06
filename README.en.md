# Paseo DSH provider

[中文](README.md) | [English](README.en.md)

Use DeepSeek Harness in Paseo through a local directory plugin. The supported Paseo version is `0.15.2`; the provider ID is `dsh`.

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

- Text, reasoning, and consecutive turns in the same active session.
- Model selection within a workspace.
- Successful tool output and original failure details. Failures without content show a generic error.
- One-time allow and reject. Stopping a turn waiting for approval withdraws the request and returns `cancelled` on the wire.
- Further input after stopping. The SDK cleans up child processes on plugin reload and removal.
- Native DSH session recovery and history replay after idle collection or process restart.

DSH may emit text after committing a message block. Token streaming is not implemented. Recovery was verified with DSH 0.2.2-rc.1: native resume restores context, and the plugin reads history through DSH's persistence interface to implement ACP load replay. A temporary launch patch preserves the effective ACP configuration without modifying user profiles or session files. Rewind is not implemented; multiple roots and additional attachment types are outside the verified scope. Paseo 0.15.2 may show a default reject label for approvals ended by the provider, although DSH receives `cancelled`.

Reload during a running tool was verified to terminate the old processes and allow a new session. The host did not emit a terminal update for the old tool card, so immediate card completion remains unverified.

## Verification

Use Node `>=24.9.0` and PowerShell 7.

```powershell
npm ci
npm run typecheck
npm test
node probes/permission.mjs
node probes/acp.mjs
node probes/history.mjs
```

`permission.mjs` passes real approval snapshots from the sibling `deepseek-harness` repository through this plugin and the SDK. It checks allow, reject, cancel, terminal ordering, and late responses. `acp.mjs` uses that repository's existing CLI build and keyless control-surface fixture to check text, tool results, catalogs, and listing by directory.

`history.mjs` uses the same DSH build with isolated temporary storage. It checks two process restarts, stable native UUIDs, message and tool history, continued access to earlier context, and rejection of invalid directories and session handles. History unit tests also need the sibling DSH build to load its official interrupted-turn recovery function. Type checking and all 22 tests passed. The original Desktop conversation recovered, and the history refresh error disappeared from the UI.

On Windows, the SDK calls `taskkill /T /F`. Probes fail in sandboxes that prohibit terminating child process trees.

The following scripts start separate temporary daemons and leave the existing daemon unchanged. `PaseoCli` is the `bin/paseo` file from `@getpaseo/cli@0.15.2`.

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

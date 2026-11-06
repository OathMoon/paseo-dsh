# DSH provider integration plan for Paseo

[中文](DSH-PROVIDER-PLAN.md) | [English](DSH-PROVIDER-PLAN.en.md) | [Index / 索引](INDEX.md)

Paths shown as code are relative to the repository root unless absolute. Run commands from the repository root.

## Implementation status, 2026-11-06

The directory plugin now provides a narrow ACP bridge for missing approval input, standard tool-result content, and stale approval cleanup after cancellation. Verified behavior includes consecutive turns, production DSH 0.2.1-rc.5 native file reads/writes in ordinary workspaces and Git worktrees, one-time approval side effects, input after cancellation, reload during approval, Beta selection, and tool failure details.

The Electron-hosted bridge startup failure was fixed, and the actual Desktop workspace model catalog loaded. Native session recovery and history replay now preserve context across two process restarts. The original Desktop conversation recovered and its history refresh error disappeared. Type checking and all 22 tests passed. Basic stage 6 recovery is complete; rewind is not implemented. See the [execution record](EXECUTION.en.md) for final evidence and limitations and the [README](../../README.en.md) for installation.

The sections below preserve the original design baseline from 2026-11-05. Baseline defects and proposed release decisions are historical, not a description of all current limitations.

## Baseline

| Repository | Baseline used |
|---|---|
| `E:/Repositories/paseo` (P) | Commit `cdd7800fed3d87757952a368467e703ac4d15873`, clean worktree, plugin SDK 0.15.2. The shim was bundled directly from that checkout. |
| `E:/Repositories/deepseek-harness` (D) | Commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`, clean worktree. Existing `apps/cli/lib/bin.js` build, version 0.2.2-rc.1; not rebuilt from scratch. PATH `dsh.cmd` was then 0.2.1-rc.5 and was not substituted for this baseline. |
| `E:/Repositories/paseo-dsh` | Initially empty with no Git metadata. The initial investigation added the plan and two probes without installing the plugin or changing daemon configuration. |

The initial recommendation was to ship one text turn in a selected workspace using command-mode `runAcpProvider()`. Tool results, approvals, and native restoration required separate gates; the entire provider did not need to be rewritten.

## 1. Runtime boundaries

Daemon-to-plugin IPC and plugin-to-DSH ACP negotiate separately. Matching protocol numbers do not establish compatibility between those layers.

| Step | Runtime behavior and source anchors |
|---|---|
| Discovery | The daemon reads `paseo-plugin.json`, validates versions, and remembers the installation source. Startup/reload honors global and per-plugin enablement. See P `packages/server/src/server/plugins/index.ts`, `manifest.ts`, and `runtime.ts`. |
| Registration | `index.server.ts` calls `server.registerProvider(runAcpProvider(...))`. P `plugin-process.ts` collects registrations; the daemon rejects duplicate/built-in IDs and routes provider connections through plugin IPC. See P `plugin-examples/provider-acp-transformer/index.server.ts`. |
| Launch | P `packages/server/src/server/agent/plugin-provider.ts` requests versions, capabilities, and the resolved launch. P `packages/plugin/src/server/acp.ts` delegates to `acp-internal/connection.ts` (the shim). The shim starts a capability probe, then session runtimes with merged environments and piped stdio. Windows command scripts are handled by the SDK. |
| Initialization/catalog | The shim sends ACP initialize. D `apps/cli/src/profile-boot.ts`, `packages/bundle/acp-app/cordis.patch.yml`, and `packages/acp/acp/src/index.ts` compose and initialize the ACP service. Catalog lookup starts a temporary session in the selected cwd and obtains config options. |
| Session/cwd | P's agent creation resolves the workspace/worktree directory. The shim sends `session/new` with that cwd and MCP configuration. D validates an absolute cwd, rejects additional directories, creates the native session, flushes persistence, and returns the native UUID/config options. |
| Turns | The shim emits user/prompt/started events and sends `session/prompt`. D waits for committed messages and drains updates. The shim merges updates by ID, drains notifications, and maps the response to completed/canceled/failed. Prompt admission is earlier than the terminal turn event. |

Relevant upstream tests include P `acp.test.ts`, `process.test.ts`, `plugin-provider.test.ts`, plugin manifest/runtime tests, and D ACP bridge/turn/update tests, handshake snapshots, extra-directory rejection snapshots, session tests, and the control-surface E2E fixture. These are source references, not claims that every upstream suite was run here.

The child process initially inherits the OS cwd. The selected workspace is passed independently through ACP. D `packages/core/session/src/index.ts` persists `header.cwd`; `packages/session/working-directory/src/index.ts` initializes the effective directory; file tools consult that projection. Profile boot also uses `process.cwd()`, so per-session cwd does not imply project startup configuration is reloaded. Global `chdir` is unsuitable for multiple workspaces. Native relative file operations require separate two-directory acceptance tests.

## 2. Initial compatibility experiments

The three repositories were siblings on Windows with Node 25.8.0. D had installed dependencies and an existing CLI/fixture build. Probes used its esbuild 0.28.1, ACP SDK 1.4.0, and Zod 4.4.3 to bundle the P shim. Each run created an isolated DSH home, session store, and workspace. The control-surface patch disabled remote models and used the repository's MCP addition fixture.

```powershell
node ../deepseek-harness/apps/cli/lib/bin.js --version
$env:PASEO_DSH_PROBE_DIR = (Get-Location).Path
node probes/acp.mjs
node probes/permission.mjs "<root>/paseo-acp.mjs"
```

1. **Command mode with real DSH.** The original probe negotiated prompt, list, approval, and configuration capabilities, but no persistence. Alpha/Beta and `model=alpha; tool=5` worked. Running/completed tool rows had no output in the shim. A second process listed the same native UUID by cwd, and the persisted header matched. Listing a UUID was not proof of restoration.
2. **Approval snapshot through the real shim.** A request containing only a tool call ID failed with `-32602 Invalid params` and no approval event. Adding `rawInput:{}` produced an approval event and preserved the selected reject option. The failure came from parsing `undefined` as a JSON record. Advertising approval capability did not prove approval behavior.
3. **Environment.** Increasing the startup budget to 90 seconds and disabling telemetry together resolved an initialization timeout; the experiment did not isolate which change mattered. Restricting Windows taskkill broke cleanup. DSH stderr reported inactive modules, including working-directory and native tool execution, so MCP success could not prove native file behavior.
4. **Initial scope.** These probes connected through `provider.connect`, without the daemon/App, real credentials, production command, Desktop controls, or cross-daemon recovery. Later acceptance is recorded separately.

## 3. Plugin structure and capability decisions

Runtime assets are `paseo-plugin.json` and `index.server.ts`. Development adds package metadata, lockfile, and TypeScript configuration. The manifest ID is `paseo-dsh`; provider ID is `dsh`; label is `DeepSeek Harness`; supported Paseo is pinned to `0.15.2`. Broader version support requires version-by-version acceptance.

```ts
server.registerProvider(runAcpProvider({
  id: "dsh",
  label: "DeepSeek Harness",
  command: ["dsh", "--profile", "acp"],
  acpOptions: { workspaceOnlyCatalog: true, startupTimeoutMs: 90_000 },
}))
```

Production keeps the daemon-resolved launch and full environment; the shim merges session variables. Pin a command through `agents.providers.dsh.command` when needed. Test patches and fixture environment belong only to acceptance runs. Credentials come from DSH's credential service or daemon environment; the API-key adapter normally queries `DEEPSEEK_API_KEY`. An empty model catalog can indicate missing credentials. `authMethods:[]` means there is no ACP login flow; the plugin does not hold a key copy. See P `public-docs/custom-providers.md` and D `packages/llm/llm-deepseek-api-key/README.md`.

| Capability | Original mismatch and design decision |
|---|---|
| Text/reasoning | Use standard message-ID mapping. DSH sends committed blocks. Token streaming needs new upstream real-time events and deduplication; a plugin cannot reconstruct timing from final text. |
| Tools | DSH puts result blocks in `tool_call_update.content`, while the shim read `rawOutput`. Project standard content before the shim discards it, or fix the upstream merge. A post-merge transformer cannot restore lost fields. |
| Approval | Missing `rawInput` broke the shim. Prefer upstream tolerance or a narrow bridge that fills the missing field, preserves IDs/options/order/EOF/stderr, and never answers for the user. Command overrides must still use the bridge. Normal notification/tool transformers do not intercept the reverse RPC. |
| Cancellation | Reuse `session.interrupt` to ACP cancel. Interrupt request completion only confirms sending, not turn termination. Check pending approval cleanup and another turn. Concurrent input is not steer. |
| Recovery/history | The shim requires native load to negotiate persistence and expects replay. DSH resume validates ID/cwd and reattaches without timeline replay. UUIDs, listing, and cached Paseo history do not prove restart recovery. Implement load plus actual replay or explicitly define history ownership. Merely changing the capability bit or renaming load to resume is insufficient. Native list may page and exclude active/subsessions; the shim originally fetched one page only. |
| Models/extra inputs | Reuse flattened config options and dynamic image capability. `_meta._paseo` fields are not automatically consumed by DSH. Do not promise exact tool policy, ephemeral sessions, multiple roots, arbitrary attachments, or structured output. Workspace-only catalogs avoid probes without cwd, but workspace catalog probes may still create empty sessions. |

Direct `ProviderRegistration` would require owning connect/send/events/close, processes and ID mapping, failures and terminal turns, pending approvals, replay/skip, and concurrent closing. Compare that cost only if standard load or the upstream SDK cannot express a required feature. For an optional-field defect, an upstream fix has the smallest long-term maintenance burden.

## 4. Staged acceptance

Each stage enters through the target daemon's CLI or App and reuses the directory plugin.

| Stage | Change and pass condition | Failure diagnosis |
|---|---|---|
| 1. Keyless workspace turn | Register the shim with isolated DSH storage and fixture MCP. Select DSH in workspace B while the daemon starts in A. Expect one user message, `model=alpha; tool=5`, a terminal turn, further input, and matching native UUID/header/list cwd. | Check enablement/manifest/conflicts, workspace catalog/launch/stderr, then prompt admission, shim turn, and host terminal events. |
| 2. Real-model file operations | Remove fixture/model patches. Put different random values in same-name files in A and B. Ask by relative name; read/write must affect only B. Repeat in a fresh Git worktree, with tool rows and completed turns. | Check credentials/routing, session cwd, working-directory/native tools, profile warnings, and sandbox. |
| 3. One-time approval | Apply the missing-field fix. Before clicking, no side effect; reject writes nothing; allow writes exactly once. A repeated request asks again. Terminal events and cards finish. Include explicit/missing fields and cancelled outcomes. | Compare call ID/rawInput, host approval events, selected action, DSH outcome, and pending cleanup. |
| 4. Stop and continue | Reuse interrupt unless a demonstrated defect requires code. Stop a long turn, expect one canceled terminal event, then complete an ordinary turn. Also reload/close during tools and pending approval; inspect processes and orphaned state. | Separate interrupt acknowledgment from prompt stop reason; inspect active prompt and process termination. |
| 5. Tool detail/model catalog | Show one tool transitioning to completed with output 5; show error detail on failure. Select Beta and confirm `model=beta; tool=5`. These can ship separately. | Inspect wire content, rawOutput, merged snapshots, grouped config values, and set_config_option. |
| 6. Restart recovery | Define history ownership, implement load/replay or a dedicated provider. Store a random marker, restart the process, reopen and ask about it. Require context, no duplicate history/new UUID, and explicit errors for wrong cwd/invalid handles. | Check negotiation, handle, load/resume, replay window, and counts independently. |

The original scope choices were a local text preview versus stages 2–4 as daily-coding gates; committed-block output versus upstream token streaming; workspace-only versus global catalog probes; and local version-pinned distribution versus npm/Git/registry packaging with icons, overview, platform/version matrices. Recovery was originally a separate decision, later implemented as documented above.

## 5. Acceptance from a clean workspace

1. Install locked dependencies, typecheck, confirm sibling revisions and CLI versions, then run protocol probes. After fixing approvals, require the missing-field case to emit an event while retaining the explicit-field control. Offline runs use preinstalled dependencies and existing builds.
2. Start a dedicated daemon matching P with isolated config, DSH home, and empty workspace B. Enable plugins, install the directory, and require `running`. Connect CLI and App to the same host. Configure fixture command/env/MCP and run `paseo run --workspace <B-id> --provider dsh "exercise the attached server"`. Inspect plugin logs and DSH stderr on failure.
3. Run long-turn stop and real approval/side-effect fixtures. Snapshot replay proves only protocol mapping. Reload the plugin after source changes and repeat accepted stages.
4. Remove fixtures and use the production command and authorized credentials. Check daemon PATH and workspace access; run native file tests in directories/worktrees, consecutive turns, controlled approval, and cancellation. Missing test credentials must cause an observable catalog/failure condition, never a falsely successful turn. Test recovery explicitly when delivering stage 6.
5. Close sessions and reload/remove the test plugin. Check provider disappearance/reappearance, child process exit, and released approvals. Retain sanitized ordering, versions, cwd, and both IDs, then clean only dedicated test workspaces/storage.

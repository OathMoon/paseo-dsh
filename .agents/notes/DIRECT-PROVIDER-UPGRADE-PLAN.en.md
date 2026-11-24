# Staged Upgrade Plan: Migrating `paseo-dsh` to a Direct Provider

[中文](DIRECT-PROVIDER-UPGRADE-PLAN.md) | [English](DIRECT-PROVIDER-UPGRADE-PLAN.en.md) | [索引 / Index](INDEX.md)

Except for Markdown links, source and evidence paths are relative to the repository root unless absolute. Run all commands from the repository root. This document defines the staged upgrade plan toward fast multi-agent switching in Paseo with deep DeepSeek Harness (DSH) integration (authored 2026-11-24). For current ACP-based results and evidence, see [EXECUTION.en.md](EXECUTION.en.md); for the original integration plan, see [DSH-PROVIDER-PLAN.en.md](DSH-PROVIDER-PLAN.en.md).

---

## 1. Context and Key Decisions

### 1.1 Why the Current ACP Path Hits a Ceiling

`paseo-dsh` currently wraps `dsh --profile acp` through `runAcpProvider()` from `@getpaseo/plugin/server/acp`, layered with three narrow compatibility workarounds:

1. `server/bridge.ts`: an extra `node --eval` stdio forwarder that fills missing permission `rawInput`, projects tool `content -> rawOutput`, preserves Windows `.cmd` quoting, and restores `ELECTRON_RUN_AS_NODE`.
2. `server/permissions.ts`: intercepts turn completion to clear pending permissions retained inside the SDK.
3. `server/history-launch.ts` + `server/dsh-history.mjs`: uses `--dump-config` and a temporary `--patch` to wrap `@deepseek-ai/dsh-acp`, translating `session/load` into native `session/resume` plus persisted history replay.

While functional on Windows as a local directory plugin, **ACP imposes a structural lowest-common-denominator bottleneck**:

- **DSH side**: `../deepseek-harness/packages/acp/acp/src/index.ts` scopes ACP as *automation-only*, intentionally omitting live token streaming, user questions, native slash commands, permission presets, mid-turn steering, subagent trees, and conversation rewind.
- **Paseo side**: `../paseo/packages/plugin/src/server/acp-internal/connection.ts` consumes only the standard ACP subset—flattening most tool calls to `unknown` and rejecting `prompt.steer`, `session.revert.*`, `session.subsession`, `permission (kind: "question")`, and rich tool details. Paseo's own first-class Claude Code and Codex integrations use their native SDKs directly rather than ACP (see `../paseo/packages/server/src/server/agent/agent-sdk-capabilities.md`).

### 1.2 Why Wrapping `dsh-sdk-jsonrpc-server` Directly Is Also Insufficient

Auditing `../deepseek-harness/packages/sdk/protocol/src/types.ts` and `../deepseek-harness/packages/sdk/server/src/server.ts` shows that `dsh --profile sdk`'s built-in `dsh-sdk-jsonrpc-server` targets scripted automation and lacks 6 capabilities required by an interactive Paseo workbench:

1. `initialize` fixes a single `provider` + `model` with no pre-session catalog discovery;
2. no RPC to switch `model`, `reasoningEffort`, or `permissionPresets` mid-session;
3. no mechanism to mount Paseo-supplied `mcpServers` on session creation;
4. no `session/cancel` RPC to interrupt an active turn;
5. no `session/list` RPC for persisted sessions;
6. no live `agent/assistant-stream` forwarding and no `buildForkSeed`-backed conversation rewind.

### 1.3 Chosen Architecture: Paseo Direct Provider + Native DSH Cordis Bridge

DSH is built on Cordis (*Everything is a Plugin*), and this repo has already proven temporary `--patch` Cordis injection in `server/history-launch.ts`. The optimal architecture connects both sides directly:

```text
Current (2 proxy layers + ACP bottleneck):
Paseo Daemon <-> runAcpProvider <-> permissions.ts <-> node --eval(bridge.ts) <-> dsh(--profile acp + history patch)

Target (1 direct hop + 1:1 protocol alignment):
Paseo Daemon <-> Direct ProviderRegistration <-> (NDJSON stdio) <-> dsh(--profile <acp|sdk> --patch paseo-bridge)
```

This satisfies both goals simultaneously:

- **Keep Paseo as the unified multi-agent workbench**: retain equal footing alongside Claude Code, Codex, OpenCode, and Pi, keeping Paseo's Git worktrees, Diff/PR review, cross-device clients (Desktop / Web / iOS / Android), and cross-agent orchestration.
- **Eliminate ACP compression**: implement Paseo's direct `ProviderRegistration` (following `../paseo/plugin-examples/provider-direct/server/provider.ts`) talking to a single dedicated Cordis bridge plugin inside DSH with direct access to `ctx.agents`, `ctx.llm`, `ctx.sessions`, `ctx.sessionPersistence`, `ctx.commands`, `ctx.permissionPresets`, `agent/assistant-stream`, `approval/request`, `user-question/ask`, and `subagents`.

---

## 2. Architectural Invariants and Compatibility Guardrails

1. **Stable IDs**: keep manifest ID `paseo-dsh` and provider ID `dsh` so existing workspace selections stay intact.
2. **100% Persistence Backward Compatibility**: preserve the existing handle schema `{ version: 1, data: { sessionId: "<dsh-uuid>" } }` so existing Paseo chats open, replay, and continue without migration.
3. **Command Override Compatibility**: continue honoring `agents.providers.dsh.command`. The launcher inspects `--dump-config`, disables whichever stdio server owns stdout (`id: acp` or `id: sdk-jsonrpc-server`), and injects the bridge plugin without mutating user profiles, credentials, or session logs.
4. **Per-Session Process Isolation**: keep short-lived probe processes for `catalog`/`sessions` and one dedicated DSH child process per active session, preserving clean isolation of Paseo's session `env`, MCP child processes, and failure boundaries.
5. **No `node --eval` Proxy Layer**: spawn `dsh` directly via `spawnProcess` / `terminateProcess` exported from `@getpaseo/plugin/server`, eliminating the root cause of Paseo Desktop (`Paseo.exe`) Electron GUI relaunch issues.
6. **Zero Upstream Modifications**: keep `../paseo` and `../deepseek-harness` untouched; detect optional DSH services dynamically via `ctx.get(...)` and degrade capabilities gracefully.

---

## 3. Target Module Layout

```text
index.server.ts                 # Registers Direct ProviderRegistration (with status() diagnostics & transition fallback)
server/
  protocol.ts                   # Versioned NDJSON JSON-RPC contract & Zod schemas between plugin and DSH bridge
  launch.ts                     # Evolved from history-launch.ts: locate DSH, disable acp/sdk row, write bridge patch
  dsh-bridge-plugin.mjs         # Cordis plugin injected into DSH (binds DSH services & event bus)
  connection.ts                 # Direct ProviderConnection (capability negotiation, catalog, routing, cleanup)
  session.ts                    # Per-session state machine (streaming, approvals/questions, cancel, terminalization, replay)
  mappers/
    tools.ts                    # DSH native tool calls/results -> Paseo ProviderToolCallDetail rich cards
    content.ts                  # Paseo ProviderContent (images/files/review/PR) <-> DSH ContentBlock
    config.ts                   # DSH llm + permissionPresets <-> Paseo Catalog / ConfigState
```

During Stages 0–1, retain `server/bridge.ts`, `server/permissions.ts`, `server/history-launch.ts`, and `server/dsh-history.mjs` behind an opt-in fallback flag (e.g. `PASEO_DSH_ENGINE=acp`). Remove legacy ACP code once Stage 1 passes full acceptance.

---

## 4. Internal Bridge Protocol (`server/protocol.ts`)

Single-line NDJSON JSON-RPC 2.0 over stdin/stdout (stderr kept strictly separate for diagnostics):

| Direction | Method | Responsibility |
|---|---|---|
| Plugin -> DSH | `bridge/init` | Handshake reporting DSH version, profile, and runtime-detected capabilities (`streaming`, `commands`, `permissionPresets`, `images`, `userQuestions`, `revert`, `subsessions`) |
| Plugin -> DSH | `catalog/get` | Read `ctx.llm` (grouped models + reasoning efforts) and `ctx.permissionPresets` (modes) |
| Plugin -> DSH | `session/list` | List persisted sessions for `cwd` (supporting cursor / limit) |
| Plugin -> DSH | `session/open` | Create a new session (validate absolute `cwd`, mount `mcpServers`, apply initial model/mode/thinkingOption) |
| Plugin -> DSH | `session/resume` | Resume persisted `sessionId` (verify `cwd`, mount `mcpServers`, optionally read history + `interruptedTurnClosers` for replay) |
| Plugin -> DSH | `session/configure` | Mutate `model`, `thinkingOption` (`reasoningEffort`), or `mode` (`permissionPresets`) and return updated config state |
| Plugin -> DSH | `turn/prompt` | Submit normal prompts, `steer` (`agent.inbox.append('nextStep', ...)`), or slash commands (`ctx.commands.execute`) |
| Plugin -> DSH | `turn/cancel` | Cancel active work (`agent.cancel({ kind: 'user' })`) |
| Plugin -> DSH | `session/revert` | Fork persisted history via `buildForkSeed(events, boundary)` into a new `sessionId` without mutating the source log |
| Plugin -> DSH | `session/close` | Drain work, flush session log, and dispose agent and subagents |
| DSH -> Plugin (req) | `approval/request` | Forward tool approval (`toolName`, `callId`, parsed input, `reason`), returning `allowed-once` / `rejected` / `cancelled` |
| DSH -> Plugin (req) | `user-question/ask` | Forward structured user prompts (`AskUserQuestionItem[]`), returning answers or `{ cancelled: true }` |
| DSH -> Plugin (notif) | `event/stream` | Stream `agent/assistant-stream` frames (`start`, `text-delta`, `reasoning-delta`, `end`) |
| DSH -> Plugin (notif) | `event/session` | Stream committed `session/event` records (`user/message`, `assistant/message`, `tool/call`, `tool/result`, `turn/*`, compaction, usage) |
| DSH -> Plugin (notif) | `event/config`, `event/commands`, `event/subagent`, `event/question-cancelled` | Push topology/config updates, available commands, subagent lifecycle events, and cancelled user questions |

---

## 5. Phased Implementation and Independent Verification

Every stage can be committed, verified, and stopped independently without leaving the repository broken.

| Stage | Goal | Default Base Profile | Key Deliverables | Exit Gates (Pass Criteria) |
|---|---|---|---|---|
| **Stage 0: Bridge Foundation** | Prove direct plugin <-> DSH Cordis bridge before touching Paseo registration | Supports `acp` / `sdk` | `server/protocol.ts`, `server/launch.ts`, `server/dsh-bridge-plugin.mjs` (with feature detection) | Standalone `probes/bridge.mjs` spawns DSH directly and verifies init → catalog → open → MCP tool turn → cancel → restart resume; clean stdout, isolated stderr, exit code 0 |
| **Stage 1: Direct Provider Parity** | 1:1 replacement of `runAcpProvider()` with zero feature regression | `acp` (minimizes rollout risk) | `server/connection.ts`, `server/session.ts`, `status()` diagnostics, native approval lifecycle, terminalizing running tools on reload/crash, legacy persistence compatibility | Typecheck + new unit tests pass; `probes/stage1.ps1`–`stage4.ps1` and `probes/history.mjs` pass (with previously unverified active-tool reload terminalization now `activeToolTerminalObserved=true`); real Desktop opens and continues existing chats; legacy ACP files removed |
| **Stage 2: Core UX Upgrade** | Deliver the 4 highest-impact daily coding improvements | `acp` (or optional `sdk`) | (1) Live token streaming via `agent/assistant-stream`; (2) `mappers/tools.ts` rich cards (`shell`/`read`/`edit`/`write`/`search`/`fetch`); (3) `permissionPresets` -> Paseo `modes`; (4) Dynamic `prompt.image` + structured formatting for non-image attachments | Unit tests for stream commit/abandon/cancel order, tool detail snapshots, attachment conversion, mode switching; live Desktop + real model verifies incremental streaming, Edit Diff cards, mode changes, and image/file prompts |
| **Stage 3: Deep Interactive Capabilities** | Unlock capabilities impossible over ACP and enable full DSH desktop toolset | Switch or default to `sdk` (keep `acp` compatible) | (1) `prompt.steer` mid-turn steering; (2) `session.commands` + `prompt.command` (`/plan`, `/compact`, `/goal`) and `compaction` cards; (3) `session.revert.conversation` via `buildForkSeed`; (4) `user-question/ask` -> `session.permission (kind: "question")` | 4 independent end-to-end probes against isolated daemon: steer during slow tool without cancel; slash command execution + notices; 2-turn conversation revert creates new UUID preserving original log and dropping turn-2 context; `ask_user` answer & cancel round-trip |
| **Stage 4: Subagent Trees, Optional UI & Polish** | Complete multi-agent tree visibility, optional client panels, and release polish | `sdk` | (1) `session.subsession` parent-child linkage + `sub_agent` cards; (2) Optional `index.client.ts` + `timeline.plugin` panels (Schedule / Team / deliverables); (3) POSIX process cleanup verification and packaging metadata | Subagent probe confirms child session publication and teardown; macOS/Linux smoke test passes; independent code review completed; `EXECUTION.en.md` and `README.en.md` updated |

---

## 6. Key Design Details and Edge Cases

### 6.1 Live Streaming and Commit Deduplication (Stage 2)
- `dsh-bridge-plugin.mjs` subscribes to `ctx.on('agent/assistant-stream')` and assigns a stable message ID per `attemptId` (e.g. `stream:${attemptId}`).
- `text-delta` and `reasoning-delta` chunks stream immediately via `event/stream`, aggregated by `session.ts` into incremental `assistant_message` and `reasoning` timeline items.
- On `end (outcome.kind === 'committed')`, the matching persisted `assistant/message` only emits blocks not already streamed (such as image blocks) plus `usage`, avoiding duplicate text/reasoning.
- On `end (outcome.kind === 'abandoned')` (e.g., mid-stream retry via `llm-retry`), subsequent attempts receive a fresh `messageId` so retries never corrupt or concatenate onto partial aborted text.

### 6.2 Conversation Rewind Scope (Stage 3)
- Advertise only `session.revert.conversation`; **do not implement `session.revert.files` or `session.revert.both`** (DSH has no native filesystem rollback primitive, and shadow Git snapshots conflict with user Git workflows).
- Attach a stable `revertToken` (e.g. `{ userTurnIndex }` or committed `{ beforeSeq }`) to each `user_message`. On `session.revert`:
  1. The DSH bridge reads the persisted log and locates the exact truncation `seq` before the target user turn;
  2. It calls `buildForkSeed(events, boundary)` from `@deepseek-ai/dsh-session/fork` and writes a new forked session UUID (leaving the original session immutable);
  3. The plugin emits `session.persistence` with `{ version: 1, data: { sessionId: newSessionId } }` before `request.completed`;
  4. Paseo daemon (`../paseo/packages/server/src/server/agent/plugin-provider.ts:1786-1791`) automatically closes the old runtime and reopens with `history: "replay"`, refreshing the timeline cleanly.

### 6.3 Permission Lifecycle and Reload Terminalization (Stage 1)
- `session.ts` tracks active `runningTools` and `pendingPermissions` per session.
- On turn cancellation: send `turn/cancel` to DSH, answer unresolved local pending approvals with `{ outcome: "cancelled" }`, emit `session.permission_resolved`, and emit `session.turn (state: "canceled")` once DSH settles.
- On plugin `reload`, `session.close`, or unexpected child exit: explicitly emit terminal `timeline.item` updates (`canceled` or `failed`) for every entry in `runningTools` and resolve all pending approvals before emitting closure/failure.

### 6.4 Guarding Against DSH 0.2.x Breaking Changes
- Keep hard Cordis dependencies minimal (`agents`, `llm`, `sessions`, `sessionPersistence`); probe every optional service dynamically and omit unavailable Paseo capabilities cleanly instead of crashing.
- Version the internal bridge protocol via `bridge/init` and surface actionable diagnostics through `status()` and `request.failed`.
- Keep offline fixture probes runnable without paid model credentials so every DSH upgrade can be re-verified quickly.

---

## 7. Checkpoints and Rollout Cadence

1. **Checkpoint 1 (after Stages 0 + 1)**: confirm full parity across unit tests, `stage1`–`stage4`, `history.mjs`, and real Desktop existing-chat resumption before deleting legacy ACP files.
2. **Checkpoint 2 (after Stage 2)**: dogfood streaming, rich tool cards, modes, and attachments in daily coding to prioritize Stage 3 items.
3. **Checkpoint 3 (before Stage 3)**: evaluate switching default profile from `acp` to `sdk` (for `tool-ask-user`, `schedule`, `present`) and verify startup latency on production `dsh.cmd`.
4. **Checkpoint 4 (before Stage 4)**: decide whether custom Paseo UI panels (`index.client.ts`) and cross-platform / registry packaging are needed.

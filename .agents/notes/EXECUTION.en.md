# DSH provider execution record

[中文](EXECUTION.md) | [English](EXECUTION.en.md) | [Index / 索引](INDEX.md)

Paths shown as code or in evidence columns are relative to the repository root unless absolute. Commands run from the repository root.

## Current status

The poteto-mode workflow completed framing, workflow design, implementation, audit logging, and verification. The provider passed isolated-daemon checks for two turns and cwd; compatibility regressions; approval, cancellation, model selection, and plugin lifecycle checks; real-model file operations; Desktop bridge startup; and native session recovery with history replay.

Immediate terminal updates for tool cards interrupted by reload remain unverified. Native recovery was added after this earlier limitation was recorded. Rewind and POSIX process-tree cleanup remain outside the verified scope.

## Acceptance criteria

After directory installation, a Paseo 0.15.2 daemon must complete consecutive turns in the selected cwd. Approval requests lacking `rawInput` must produce selectable one-time actions. Allow and reject must preserve the chosen option ID. Cancellation must finish the active turn and permit further input. Success and failure output must reach the timeline, Beta must actually be selected, and close/reload must clean up test processes.

Stage 2 requires valid credentials and a complete DSH build. For stage 6, DSH owns context and persisted history; the plugin implements ACP load replay. Basic recovery and replay are complete; rewind is not implemented.

## Architecture and workflow decisions

The original throughput checkpoint divided work into compatibility regressions, plugin changes, real-daemon checks, and delivery records. Each unit was verified before continuing. Implementation did not modify the sibling Paseo or DSH repositories. Tests used isolated homes and workspaces.

A custom connector could transform ACP frames but lacked launch and session-environment parameters and would bypass SDK process cleanup. The selected design wraps the resolved launch in a self-contained Node stdio bridge while keeping SDK command mode. The SDK still merges environments, probes catalogs, manages session processes, and terminates process trees. Because the plugin server is evaluated dynamically, the bridge is passed as function source to `node --eval` rather than relying on its installation path.

The installed npm CLI was used for daemon acceptance checks. The skill's control-cli and control-ui tools were unavailable; Desktop UI evidence is reported separately.

The SDK also lacked withdrawal of a single pending approval. The plugin tracks pending and withdrawn requests per session. Before a prompt reaches its terminal state, remaining approvals are marked withdrawn and the SDK's internal reject path releases its map entries. The bridge changes only these withdrawn responses to `cancelled`. Normal user decisions pass through unchanged. The host receives permission resolution before the turn terminal event; late clicks cannot create another decision.

## Verified evidence

Temporary directories below are under `C:/Users/Administrator/AppData/Local/Temp/`.

| Check | Evidence | Result |
|---|---|---|
| Stage 1, two turns and cwd after changes | `tmpy0xvpb.tmp` | Passed |
| Stage 2, real-model native reads/writes in a directory and Git worktree | `paseo-dsh-stage2-3eba40e3fe6d44a4a47b4be86af7493b/verification-summary.json` | Passed |
| Stage 3, unique tool IDs before the cancellation fix | `paseo-dsh-stage3-be165949d46747ca9789083e7c43d997` | Failed; exposed stale approvals |
| Stage 3, final approval/reload and cancelled audit | `paseo-dsh-stage3-b92e4409cff44d719000dcb115d068d2` | Passed |
| Snapshots through plugin and SDK, including late allow | `probes/permission.mjs` | Passed |
| Tool output, Beta, input after stop, idle reload/remove | `tmpy55pcg.tmp/result.json` | Passed |
| Running-tool reload, old process exit and new session | `tmpcl2lzg.tmp/result.json` | Process cleanup passed; tool card terminal update unverified |
| Type and protocol regressions, including Desktop launch and history | `npm run typecheck`, `npm test` | 22 passed, none skipped |
| Actual Desktop workspace catalog | `.artifacts/desktop-catalog.json` | Five models, no error, diagnostic Ready |
| Two restarts, native ID, history and continued context | `probes/history.mjs`; `paseo-dsh-history-I52fiZ` | Passed; both answers retain the first-turn marker |
| Actual Desktop conversation refresh | `.artifacts/actual-history-refresh.json`; native UI | 23 items, 14 completed tools, error disappeared |

Stage 2 used production DSH 0.2.1-rc.5. The local 0.2.2-rc.1 fixture build lacked some native modules, so MCP addition was not treated as proof of native file tools. History recovery was checked separately with the fixture and installed DSH 0.2.2-rc.1. The Desktop provider selector, Desktop stop button, and POSIX process-tree cleanup have not been accepted.

## Review boundaries

Two earlier independent reviews used the same model as this conversation. The skill's Claude and Grok families were unavailable; no cross-model review is claimed. Reviews found and fixed empty failure content and ordering assertions that could pass with missing events.

Running-tool reload produced old DSH/MCP process exit and a host `turn_failed`, but no terminal tool-card update. At that point the old session also failed to load because persistence was not negotiated. That historical failure was not treated as proof of a process leak or a completed card. The final full stage4 run exited 0 and recorded `activeToolTerminalObserved=false`. A later tool-output assertion received syntax validation but the full script was not rerun; DSH output was inspected directly, with timeline projection covered by Beta tests.

## Desktop provider-selection failure

On 2026-11-06, the actual Desktop host at `127.0.0.1:6767` reported `ACP connection closed`. It ran `Paseo.exe` and stripped `ELECTRON_RUN_AS_NODE` for external launches. The plugin reused that executable for its bridge without restoring Node mode, unintentionally launching a GUI. Earlier standalone `node.exe` tests did not cover this host.

The fix sets `ELECTRON_RUN_AS_NODE=1` only for the Electron-hosted bridge and passes the original value as an argument. Before spawning DSH, the bridge restores or deletes the variable in its cloned environment. Other daemon/session variables remain intact; ordinary Node hosts keep their existing behavior.

The regression using installed `Paseo.exe` failed before the fix with `AssertionError: ACP connection closed`. Type checking and all 17 tests then passed, including restoration of absent, 0, and 1 values. Only `paseo-dsh` was reloaded on the real host. Diagnostics returned Ready and the failing workspace returned five models without an error.

At that time window capture timed out and later returned a different application. UI input was stopped, and no visual provider-selection acceptance was claimed. Those catalog results came from the actual Desktop daemon. The later history check below did obtain native UI evidence.

## Desktop history-refresh failure

On 2026-11-06, the user reported “无法刷新代理历史记录” (“Unable to refresh agent history”). Logs showed idle runtime collection followed by `Provider does not support session.persistence`. The ACP SDK saved a native persistence handle without negotiating persistence. DSH supported resume but lacked load with history replay, so the original conversation could not be reloaded.

The plugin now implements load at the DSH ACP stream boundary. It advertises load only when native resume exists and native load does not. It converts load to resume, then reads the same UUID through the official DSH persistence interface and uses the official interrupted-turn closure function to replay user messages, reasoning, answers, and tool results. Existing native load remains authoritative. Resume or replay errors return explicit failures. Recovery never substitutes a new empty session.

Launch preparation reads effective DSH configuration and clones the ACP entry into a temporary wrapper module. The first patch attempt failed because `patch.name` is a match condition rather than a replacement field. The corrected patch disables the original row and inserts a new row preserving its configuration. Two-restart checks then passed. User profiles, credentials, and session files were not rewritten.

Type checking and all 22 tests passed. Evidence in `paseo-dsh-history-I52fiZ` checks stable UUIDs, two turns and two distinct completed tools, and rejection of wrong cwd and missing UUIDs. The continuation assertion was tightened while that run was in progress. Saved events were therefore independently inspected to confirm that the second answer retained the first random marker, rather than merely matching the replayed first answer.

On the actual Desktop host, only `paseo-dsh` was reloaded. The daemon was not restarted and no prompt was sent to the original conversation. Paseo conversation `33a8ffe0-4f20-4ac5-801f-92de10926b5a` retained native UUID `6097da4a-e7da-4e76-80e0-808232bee60c`. Its timeline returned 23 items: one user message, seven reasoning items, fourteen completed tools, and one assistant answer. The native window accessibility tree first showed the error. After refresh, the original messages remained and the error and retry control disappeared.

This does not establish full Pi parity, rewind, or immediate terminal tool updates during reload. The new history implementation did not receive a completed independent final review; earlier reviews apply only to their original scope.

---

## Direct Provider Upgrade Execution Record (2026-11-24)

Implemented and verified Stages 0–4 from [DIRECT-PROVIDER-UPGRADE-PLAN.en.md](DIRECT-PROVIDER-UPGRADE-PLAN.en.md) (environment: Windows, Node 25.8.0, installed `dsh 0.2.2-rc.5`):

- **Stage 0 (Direct Bridge Foundation)**: Added `server/protocol.ts`, `server/launch.ts` (compatible with both `acp` and `sdk` profiles, disabling `acp` or `sdk-jsonrpc-server` stdout rows), and `server/dsh-bridge-plugin.mjs` (synchronous `stdin` buffering + dynamic capability probing). `node probes/bridge.mjs` passed with zero stdout noise.
- **Stage 1 (Direct Provider Replacement)**: Added `server/connection.ts`, `server/session.ts`, and updated `index.server.ts` (`status()` diagnostics and `PASEO_DSH_ENGINE=acp` fallback switch), preserving `{ version: 1, data: { sessionId } }` handles and terminalizing active tools on `close()` / unexpected exit (`activeToolTerminalObserved=true`).
- **Stage 2 (Core Experience Upgrade)**: Added token-level streaming via `agent/assistant-stream` with committed `assistant/message` deduplication, rich tool cards (`server/mappers/tools.ts`), model/thinking/permission-preset mapping (`server/mappers/config.ts`), and image/attachment formatting (`server/mappers/content.ts`).
- **Stage 3 (Advanced Interactions)**: Added `prompt.steer`, `session.commands` + `prompt.command` + `compaction` items, `session.revert.conversation` (forking a new UUID via `buildForkSeed` with `isSeeded: true` while leaving the original log read-only), and `user-question/ask` -> `session.permission (kind: "question")`. All 10 gates in `node probes/direct-e2e.mjs` passed.
- **Stage 4 (Subsessions & Wrap-up)**: Added `session.subsession` parent-child forwarding and `sub_agent` cards, verified `dsh --profile sdk` direct bridge startup, and updated `README.md`, `README.en.md`, and `tests/direct-provider.test.ts` (28 unit tests + strict `tsc --noEmit` green).

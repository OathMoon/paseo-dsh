# `paseo-dsh` 升级为 Direct Provider 的分阶段方案

[中文](DIRECT-PROVIDER-UPGRADE-PLAN.md) | [English](DIRECT-PROVIDER-UPGRADE-PLAN.en.md) | [索引 / Index](INDEX.md)

除 Markdown 链接外，源码与证据路径均以仓库根目录为基准，绝对路径除外；所有命令从仓库根目录执行。本文记录面向“多 Agent 快速切换 + 深度整合 DSH 能力”目标的架构升级方案（编写日期：2026-11-24）。当前已落地的 ACP 方案及验收证据见 [EXECUTION.md](EXECUTION.md)，原始接入方案见 [DSH-PROVIDER-PLAN.md](DSH-PROVIDER-PLAN.md)。

---

## 1. 背景与核心结论

### 1.1 为什么现有 ACP 方案触及天花板

当前 `paseo-dsh` 通过 `@getpaseo/plugin/server/acp` 的 `runAcpProvider()` 接入 `dsh --profile acp`，并在外围叠加了三层兼容补丁：

1. `server/bridge.ts`：以 `node --eval` 启动二次 stdio 转发器，补齐权限请求缺失的 `rawInput`、投影工具 `content -> rawOutput`、处理 Windows 参数转义与 Electron `ELECTRON_RUN_AS_NODE` 环境变量恢复。
2. `server/permissions.ts`：拦截并清理回合结束时 SDK 内部残留的 pending 权限。
3. `server/history-launch.ts` + `server/dsh-history.mjs`：通过 `--dump-config` + `--patch` 包装 DSH 的 `@deepseek-ai/dsh-acp`，将 `session/load` 映射为原生 `session/resume` 并重放持久化历史。

这套方案在 Windows 本地目录场景下已完成基础闭环，但受限于 **ACP 作为跨 Agent 最小公分母协议的结构性约束**：

- **DSH 侧**：`../deepseek-harness/packages/acp/acp/src/index.ts` 将 ACP 定位为 *automation-only*，刻意不暴露逐 token 流式、交互提问、斜杠命令、权限模式预设、运行中插话（steer）、子代理树和会话回退。
- **Paseo 侧**：`../paseo/packages/plugin/src/server/acp-internal/connection.ts` 的 `runAcpProvider()` 仅消费标准 ACP 子集，将工具卡片几乎全部压扁为 `unknown`，不支持 `prompt.steer`、`session.revert.*`、`session.subsession`、`permission (kind: "question")` 和富工具详情。而 Paseo 自身深度集成的 Claude Code / Codex 均直接对接原生 SDK，未走 ACP（见 `../paseo/packages/server/src/server/agent/agent-sdk-capabilities.md`）。

### 1.2 为什么也不应直接套壳 `dsh-sdk-jsonrpc-server`

核查 `../deepseek-harness/packages/sdk/protocol/src/types.ts` 与 `../deepseek-harness/packages/sdk/server/src/server.ts` 后，官方 `dsh --profile sdk` 的 `dsh-sdk-jsonrpc-server` 面向脚本/批处理自动化，缺失 6 项交互式工作台必需能力：

1. `initialize` 强绑定单一 `provider` + `model`，无法在初始化前动态发现模型目录；
2. 缺少会话中动态切换 `model`、`reasoningEffort` 与 `permissionPresets` 的 RPC；
3. 缺少 `session/new` 时动态挂载 Paseo `mcpServers` 的入口；
4. 缺少 `session/cancel` 中断当前回合的 RPC；
5. 缺少 `session/list` 列举持久化会话；
6. 不推送逐 token 的 `agent/assistant-stream`，也未暴露 `buildForkSeed`（对话回退）。

### 1.3 选定架构：Paseo Direct Provider + DSH 原生 Cordis 桥接插件

DSH 的核心底座是 Cordis（Everything-is-a-Plugin），且本项目已验证通过 `--patch` 在 DSH 进程内挂载自定义 Cordis 模块的可行性。因此，最优升级架构为：

```text
旧架构（2 层桥接 + ACP 瓶颈）：
Paseo Daemon <-> runAcpProvider <-> permissions.ts <-> node --eval(bridge.ts) <-> dsh(--profile acp + history patch)

新架构（1 层直连 + 协议 1:1 对齐）：
Paseo Daemon <-> Direct ProviderRegistration <-> (NDJSON stdio) <-> dsh(--profile <acp|sdk> --patch paseo-bridge)
```

该架构同时满足两项核心诉求：

- **保留 Paseo 作为多 Agent 统一中枢**：继续与 Claude Code、Codex、OpenCode、Pi 等平级共存，复用 Paseo 的 Git worktree 并行开发、Diff/PR 审阅、跨端（Desktop / Web / iOS / Android）与跨 Agent 编排。
- **彻底绕开 ACP 窄管**：在 Paseo 侧直接实现 `ProviderRegistration`（参考 `../paseo/plugin-examples/provider-direct/server/provider.ts`），在 DSH 侧用单一 Cordis 插件直连 `ctx.agents`、`ctx.llm`、`ctx.sessions`、`ctx.sessionPersistence`、`ctx.commands`、`ctx.permissionPresets`、`agent/assistant-stream`、`approval/request`、`user-question/ask` 与 `subagents`。

---

## 2. 架构不变量与兼容性底线

升级过程必须严格守住以下 6 条约束：

1. **Provider ID 与安装方式不变**：manifest ID 仍为 `paseo-dsh`，注册的 provider ID 仍为 `dsh`，用户现有工作区配置无需重选。
2. **历史持久化句柄 100% 向前兼容**：延续现有句柄格式 `{ version: 1, data: { sessionId: "<dsh-uuid>" } }`。升级后用户已有的 Paseo 聊天记录可直接打开、重放并继续对话，无需数据迁移。
3. **命令覆盖兼容**：继续尊重 Paseo daemon 配置中的 `agents.providers.dsh.command`。启动器自动读取 `--dump-config`，识别并禁用当前 profile 下占用 stdout 的原服务行（`id: acp` 或 `id: sdk-jsonrpc-server`），再插入 `paseo-dsh` 桥接插件，不修改用户 profile、凭据或会话文件。
4. **单会话独立进程隔离**：维持“短命探针进程处理 `catalog`/`sessions` + 每活跃会话独立 DSH 子进程”的模型，避免多会话共享进程导致的 `session.env` 污染、MCP 冲突与级联崩溃。
5. **消除 Electron 二次桥接依赖**：直接使用 `@getpaseo/plugin/server` 导出的 `spawnProcess` / `terminateProcess` 拉起目标 `dsh` 可执行文件，不再经由 `process.execPath --eval` 中转，从根因上消除 Paseo Desktop（`Paseo.exe`）误启 GUI 的问题。
6. **不修改上游仓库**：零改动 `../paseo` 与 `../deepseek-harness` 源码；DSH 内部非核心服务全部采用运行时特性探测（`ctx.get(...)`）与渐进降级。

---

## 3. 目标模块布局

基于当前仓库结构平滑演进：

```text
index.server.ts                 # 注册 Direct ProviderRegistration（含 status() 诊断与过渡期回退开关）
server/
  protocol.ts                   # 插件 <-> DSH Cordis 桥的版本化 NDJSON JSON-RPC 契约与 Zod 校验
  launch.ts                     # 演进自 history-launch.ts：解析 DSH、禁用 acp/sdk 行、生成临时 bridge patch
  dsh-bridge-plugin.mjs         # 注入 DSH 进程的 Cordis 插件（直连 DSH 内部服务与事件总线）
  connection.ts                 # Paseo Direct ProviderConnection（能力协商、catalog、session 路由、清理）
  session.ts                    # 单会话状态机（流式聚合、审批/提问、取消、异常终态收尾、历史重放）
  mappers/
    tools.ts                    # DSH 原生工具调用/结果 -> Paseo ProviderToolCallDetail 富卡片
    content.ts                  # Paseo ProviderContent（图片/文件/Review/PR）<-> DSH ContentBlock
    config.ts                   # DSH llm + permissionPresets <-> Paseo Catalog / ConfigState
```

过渡期（阶段 0–1）保留原 `server/bridge.ts`、`server/permissions.ts`、`server/history-launch.ts`、`server/dsh-history.mjs`，通过环境变量（如 `PASEO_DSH_ENGINE=acp`）提供紧急回退；阶段 1 全量验收通过后清理旧 ACP 路径代码。

---

## 4. 插件与 DSH 桥的精简内部协议（`server/protocol.ts`）

采用单行 NDJSON JSON-RPC 2.0（stdin/stdout 承载协议帧，stderr 独立透传日志与错误诊断）：

| 方向 | 方法 | 职责 |
|---|---|---|
| 插件 -> DSH | `bridge/init` | 握手并回报 DSH 版本、profile、以及动态探测到的能力位（`streaming` / `commands` / `permissionPresets` / `images` / `userQuestions` / `revert` / `subsessions`） |
| 插件 -> DSH | `catalog/get` | 读取 `ctx.llm`（分组模型与 reasoning efforts）及 `ctx.permissionPresets`（modes） |
| 插件 -> DSH | `session/list` | 枚举指定 `cwd` 的持久化会话摘要（支持 cursor / limit） |
| 插件 -> DSH | `session/open` | 创建新会话（校验绝对 `cwd`、挂载 `mcpServers`、应用初始 model/mode/thinkingOption） |
| 插件 -> DSH | `session/resume` | 恢复已有 `sessionId`（校验 `cwd`、挂载 `mcpServers`、按需读取历史并执行 `interruptedTurnClosers` 返回/推送重放事件） |
| 插件 -> DSH | `session/configure` | 动态修改 `model`、`thinkingOption`（`reasoningEffort`）、`mode`（`permissionPresets`）并返回最新配置快照 |
| 插件 -> DSH | `turn/prompt` | 提交普通消息或 `steer`（`agent.inbox.append('nextStep', ...)`）或斜杠命令（`ctx.commands.execute`） |
| 插件 -> DSH | `turn/cancel` | 取消当前活动回合（`agent.cancel({ kind: 'user' })`） |
| 插件 -> DSH | `session/revert` | 调用 `buildForkSeed(events, boundary)` 持久化新 fork 会话并返回新 `sessionId`（不修改原日志） |
| 插件 -> DSH | `session/close` | 排空活动、flush 持久化日志并释放 Agent 与子代理 |
| DSH -> 插件（请求） | `approval/request` | 透传工具审批请求（含 `toolName`、`callId`、解析后的输入与 `reason`），返回 `allowed-once` / `rejected` / `cancelled` |
| DSH -> 插件（请求） | `user-question/ask` | 透传结构化用户提问（`AskUserQuestionItem[]`），返回答案或 `{ cancelled: true }` |
| DSH -> 插件（通知） | `event/stream` | 转发 `agent/assistant-stream`（`start` / `text-delta` / `reasoning-delta` / `end`） |
| DSH -> 插件（通知） | `event/session` | 转发落盘 `session/event`（`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/start`、`turn/end`、compaction、usage 等） |
| DSH -> 插件（通知） | `event/config` / `event/commands` / `event/subagent` / `event/question-cancelled` | 转发配置/拓扑变化、可用命令变化、子代理生命周期与提问取消 |

---

## 5. 分阶段实施与独立验收计划

每个阶段均可单独提交、单独回归验证；任一阶段完成后仓库均保持可构建、可安装、可运行状态。

| 阶段 | 核心目标 | 底层 Profile 默认值 | 关键交付与解封能力 | 退出门禁（Pass Criteria） |
|---|---|---|---|---|
| **阶段 0：桥接底座** | 独立跑通插件与 DSH 的直连 Cordis 桥，不改动当前 Paseo 注册逻辑 | 兼容 `acp` / `sdk` | `server/protocol.ts`、`server/launch.ts`、`server/dsh-bridge-plugin.mjs`（含特性探测） | 新增 `probes/bridge.mjs` 直接拉起 DSH 完成 init → catalog → open → MCP 工具问答 → cancel → 重启 resume；stdout 零杂音、stderr 独立、退出码 0 |
| **阶段 1：Direct Provider 平替** | 1:1 等价替换 `runAcpProvider()`，消除历史遗留缺陷 | `acp`（保持零回归冲击） | `server/connection.ts`、`server/session.ts`、`status()` 凭据诊断、原生权限清理、异常/reload 时运行中工具终态收尾、兼容旧持久化句柄 | 类型检查 + 新 Direct 单测全绿；`probes/stage1.ps1`–`stage4.ps1` 与 `probes/history.mjs` 全绿（含此前未过的运行中工具 reload 终态 `activeToolTerminalObserved=true`）；真实 Desktop 原聊天刷新并续聊正常；移除旧 ACP 补丁代码 |
| **阶段 2：核心体验跃升** | 交付日常编码最高频的 4 项深度能力 | `acp`（或可选 `sdk`） | ① `agent/assistant-stream` 真逐 token 流式正文/推理；② `mappers/tools.ts` 富工具卡片（`shell`/`read`/`edit`/`write`/`search`/`fetch`）；③ `permissionPresets` -> Paseo `modes`；④ 动态 `prompt.image` + 附件结构化格式化 | 单测覆盖流式正常/重试/取消序、各工具卡片快照、附件格式化、权限模式切换；真实 Desktop + 真实模型目视/事件验证逐字流式、Edit Diff 卡片、模式切换与图片/文件输入 |
| **阶段 3：高阶交互解锁** | 打通 ACP 无法表达的深度交互，并引入完整 DSH 工具集 | 切换或默认 `sdk`（保留 `acp` 兼容） | ① `prompt.steer`（运行中插话）；② `session.commands` + `prompt.command`（`/plan`、`/compact`、`/goal` 等）与 `compaction` 卡片；③ `session.revert.conversation`（基于 `buildForkSeed` 对话回退）；④ `user-question/ask` -> `session.permission (kind: "question")` | 4 个独立端到端自动化探针全绿：慢工具中 steer 不取消且生效；斜杠命令执行及通知完整；两轮后回退首轮生成新 UUID 且原日志无损；`ask_user` 提问卡片回答与取消链路闭环 |
| **阶段 4：子代理树与工程收口** | 补全多 Agent 树可视化、可选 UI 面板与跨平台发布质量 | `sdk` | ① `session.subsession`（父子会话树与 `sub_agent` 卡片）；② 按需增加 `index.client.ts` + `timeline.plugin` 面板（如 Schedule / Team / 交付物预览）；③ POSIX 进程回收验证与发布包元数据（图标、版本矩阵） | 子代理派生探针验证父子关联与回收无残留；macOS/Linux 基础烟雾验证通过；独立代码审查完成并更新 `EXECUTION.md` 与 `README.md` |

---

## 6. 重点边界与详细设计约束

### 6.1 流式正文与落盘去重（阶段 2）
- `dsh-bridge-plugin.mjs` 订阅 `ctx.on('agent/assistant-stream')`，每个 `attemptId` 分配稳定流式 `messageId`（例如 `stream:${attemptId}`）。
- `chunk` 为 `text-delta` / `reasoning-delta` 时立即通过 `event/stream` 推送，`session.ts` 累计文本并发出 `timeline.item`（`assistant_message` / `reasoning`）。
- 收到 `end` 且 `outcome.kind === 'committed'` 后，同一 `seq` 对应的落盘 `assistant/message` 事件仅补充尚未流式发送的块（如图片块）与 `usage`，不再重复发出文本与推理。
- 若 `outcome.kind === 'abandoned'`（例如请求中途失败并触发 `llm-retry` 自动重试），新重试的 `attemptId` 使用新 `messageId`，避免拼接污染旧内容，并在必要时对被放弃的半截输出发出明确状态提示或替换为重试结果。

### 6.2 对话回退与文件回退的边界（阶段 3）
- 仅声明 `session.revert.conversation`，**不实现 `session.revert.files` 或 `session.revert.both`**（DSH 原生无文件系统快照撤销机制，强做 Git shadow 快照易与用户手写 Git 操作冲突）。
- 每条 `user_message` 携带稳定 `revertToken`（例如 `{ userTurnIndex }` 或落盘后的 `{ beforeSeq }`）。收到 `session.revert` 后：
  1. DSH 桥读取当前会话持久化日志，定位目标用户消息之前的截断 `seq`；
  2. 调用 `@deepseek-ai/dsh-session/fork` 的 `buildForkSeed(events, boundary)` 写入全新 UUID 的 fork 会话（保持原会话完全只读）；
  3. 插件先向 Paseo 发出 `session.persistence` 更新为新 `{ version: 1, data: { sessionId: newSessionId } }`，再返回 `request.completed`；
  4. Paseo daemon（`../paseo/packages/server/src/server/agent/plugin-provider.ts:1786-1791`）自动关闭旧 runtime 并以新句柄重开 `session.open(..., history: "replay")`，完成时间线无痛刷新。

### 6.3 权限审批与异常/重载终态（阶段 1）
- `session.ts` 维护当前会话活跃的 `runningTools: Map<string, ProviderToolCallItem>` 与 `pendingPermissions: Map<string, PendingDecision>`。
- 正常取消回合：插件先向 DSH 发送 `turn/cancel`，对所有尚未决定的本地 pending 权限回包 `{ outcome: "cancelled" }` 并向 Paseo 发 `session.permission_resolved`，待 DSH 确认回合结束再发 `session.turn (state: "canceled")`。
- 插件 `reload` / `session.close` / 子进程异常退出：在关闭前遍历 `runningTools` 补发终态 `timeline.item`（`canceled` 或 `failed`），并释放所有 `pendingPermissions`，彻底消除孤立卡片。

### 6.4 对齐 DSH 版本演进风险
- DSH 当前处于 Developer Preview（`0.2.x`），其内部 Cordis 服务存在破坏性变更可能。
- 防护措施：
  1. **硬依赖最小化**：仅 `agents`、`llm`、`sessions`、`sessionPersistence` 设为桥接硬依赖；其余能力全部动态探测、缺失即降级，不阻塞基础对话。
  2. **协议版本化**：`bridge/init` 携带 `protocolVersion`，出现不兼容时通过 `status()` 或 `request.failed` 返回清晰诊断（含当前 DSH 版本与缺失服务名）。
  3. **独立自动化门禁**：保留并扩充不依赖付费模型的免密夹具回归与协议单测，每次升级本机 DSH 版本后可一键复检全部阶段。

---

## 7. 推荐执行顺序与决策检查点

1. **检查点 1（完成阶段 0 + 阶段 1 后）**：确认所有既有测试与 `stage1`–`stage4` 全绿、Desktop 旧会话无缝打开，此时再删除旧 ACP 桥接文件，完成地基切换。
2. **检查点 2（完成阶段 2 后）**：在日常编码中实际使用数天，验证逐 token 流式、富工具卡片、权限模式与附件体验，记录真实痛点后再排期阶段 3。
3. **检查点 3（阶段 3 实施前）**：决定默认启动 profile 是否从 `acp` 切换为 `sdk`（以引入 `tool-ask-user`、`schedule`、`present` 等完整桌面工具），并确认 `dsh --profile sdk` 的冷启动耗时与依赖在生产 `dsh.cmd` 上可接受。
4. **检查点 4（阶段 4 实施前）**：根据实际需求决定是否引入 `index.client.ts` 自定义 Paseo UI 面板，以及是否补全跨平台（macOS / Linux）与 npm/市场分发配置。

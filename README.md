# Paseo DSH provider

[中文](README.md) | [English](README.en.md)

在 Paseo 中使用 DeepSeek Harness。当前安装方式为本地目录插件，Paseo 版本要求使用 `*`，允许安装到各正式版本，provider ID 为 `dsh`。

## 安装

在 daemon 所在机器安装 DSH，并确认 `dsh --profile acp` 可启动。启用 Paseo 的全局 `pluginsEnabled`，然后运行。

```powershell
paseo plugin install E:\Repositories\paseo-dsh
paseo plugin ls
```

`paseo-dsh` 的状态应为 `running`。在工作区中选择 `dsh`。模型目录在选定工作区后加载，全局模型列表可以为空。

插件默认执行 `dsh --profile acp`。要固定可执行文件，在 daemon 配置的 `agents.providers.dsh.command` 设置完整 argv。命令覆盖仍经过兼容转发器，daemon 的完整环境和会话环境继续由 Paseo SDK 合并。

凭据由 DSH 读取。插件不复制密钥，也不提供 ACP 登录流程。

## 当前行为

插件现已升级为 **Paseo Direct Provider + DSH 原生 Cordis 桥接插件**（兼容 `acp` 与 `sdk` profile），不再受限于 ACP 最小公分母协议：

- **逐 token 流式正文与推理**：直连 `agent/assistant-stream` 增量推送，并与落盘 `assistant/message` 自动去重；重试/放弃的 attempt 使用独立 `messageId`。
- **富工具卡片**：自动将 DSH 原生工具映射为 Paseo 的 `shell` / `read` / `edit` / `write` / `search` / `fetch` / `sub_agent` 卡片，MCP 及扩展工具保留原始输入输出与错误详情。
- **权限模式与动态配置**：工作区内模型目录、推理强度（`thinkingOption`）与 `permissionPresets` -> Paseo `modes` 动态切换。
- **高阶交互**：
  - `prompt.steer`：运行中向 `agent.steer` / `next-step` 插话而不中断当前回合。
  - `session.commands` + `prompt.command`：暴露并执行 DSH 原生斜杠命令（如 `/permission`、`/compact`、`/goal` 等），支持 `compaction` 时间线项。
  - `session.revert.conversation`：基于 `@deepseek-ai/dsh-session/fork` 的 `buildForkSeed` 生成新 UUID fork 会话并更新持久化句柄，保持原会话日志只读。
  - `user-question/ask` -> `session.permission (kind: "question")`：完整支持结构化用户提问与取消。
  - `session.subsession`：转发子代理父子会话生命周期与事件流。
- **稳定性与向后兼容**：
  - 延续 `{ version: 1, data: { sessionId } }` 持久化句柄格式，旧会话无缝重放续聊。
  - `reload` / `close` / 进程异常退出时主动对运行中工具补发终态卡片（`activeToolTerminalObserved=true`）并取消所有挂起审批。
  - 直接通过 `@getpaseo/plugin/server` 的 `spawnProcess` / `terminateProcess` 启动 `dsh`，不再经由 Electron `process.execPath --eval` 中转。
  - 可通过设置环境变量 `PASEO_DSH_ENGINE=acp` 临时回退至旧 ACP 兼容模式。

## 验证

使用 Node `>=24.9.0` 和 PowerShell 7。

```powershell
npm ci
npm run typecheck
npm test
node probes/bridge.mjs
node probes/direct-e2e.mjs
```

- `probes/bridge.mjs`（阶段 0）：使用自包含免密夹具与本机 `dsh` 验证 `bridge/init` → `catalog/get` → `session/open` → MCP 工具与流式输出 → `turn/cancel` → 进程重启后 `session/resume` 历史重放，stdout 零杂音。
- `probes/direct-e2e.mjs`（阶段 1–3）：经由 `index.server.ts` 注册的 Direct Provider 端到端验证 `status()`、能力协商、工作区目录与权限模式、逐 token 流式去重、动态模型/模式切换、原生斜杠命令、工具审批、`user-question` 提问、运行中 `steer` 插话、`buildForkSeed` 对话回退、`reload` 运行中工具终态收尾（`activeToolTerminalObserved=true`）以及 `session.list` / 错误目录拒绝。
- 旧 ACP 兼容回归（`probes/permission.mjs`、`probes/acp.mjs`、`probes/history.mjs` 与 `probes/stage1.ps1`–`stage4.ps1`）继续保留。

Windows 的 SDK 会调用 `taskkill /T /F`。在禁止结束子进程树的沙箱中运行探针会失败。

以下脚本启动各自的临时 daemon，不改动现有 daemon。`PaseoCli` 是待验证版本的 npm 包 `@getpaseo/cli` 的 `bin/paseo` 文件。开发依赖锁定的 SDK 版本用于可重复的类型检查；实际兼容性以目标版本的验收结果为准。

```powershell
./probes/stage1.ps1 -PaseoCli <bin/paseo>
./probes/stage2.ps1 -PaseoCli <bin/paseo>
./probes/stage3.ps1 -PaseoCli <bin/paseo>
./probes/stage4.ps1 -PaseoCli <bin/paseo>
```

阶段 1、3、4 需要相邻 DSH 仓库的既有构建和依赖。阶段 2 调用生产 `dsh.cmd` 和真实模型，会消耗模型额度。可通过 `-DshCli` 和 `-CredentialsPath` 指定路径，默认凭据文件为 `~/.dsh/.credentials.yaml`。脚本只向 DSH 配置凭据文件路径，不输出密钥。

脚本打印证据目录，并在 `finally` 停止测试 daemon。证据保留供复查。实测环境为 Windows、Node 25.8.0、Paseo 0.15.2，免密夹具 DSH 0.2.2-rc.1，以及真实模型生产 DSH 0.2.1-rc.5。另已验证 Paseo Desktop 0.15.2 的 Electron 44.2.0、Node 24.20.0 宿主及真实工作区模型目录。其他系统及版本尚未验收。

`npm test` 在默认安装位置找到 `Paseo.exe` 时，会额外使用真实 Electron 可执行文件验证桥接启动。可用 `PASEO_DSH_ELECTRON` 指定其他安装路径。桌面 daemon 中桥接需临时设置 `ELECTRON_RUN_AS_NODE=1`，启动 DSH 前恢复原环境。

阶段状态及证据见[执行记录](.agents/notes/EXECUTION.md)，原始方案见[接入计划](.agents/notes/DSH-PROVIDER-PLAN.md)，决策日志及英文文档入口见[记录索引](.agents/notes/INDEX.md)。

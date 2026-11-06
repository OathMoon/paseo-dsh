# Paseo DSH provider

[中文](README.md) | [English](README.en.md)

在 Paseo 中使用 DeepSeek Harness。当前安装方式为本地目录插件，Paseo 版本限定为 `0.15.2`，provider ID 为 `dsh`。

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

- 文本、推理和同一活动会话的连续回合。
- 工作区内模型选择。
- 工具成功正文和原始失败详情。没有内容的失败显示通用错误。
- 一次性允许和拒绝。停止等待审批的回合会撤回审批，线上结果为 `cancelled`。
- 停止后可继续输入。插件 reload 和 remove 由 SDK 回收子进程。
- 恢复原生 DSH 会话并重放历史；空闲回收或进程重启后，可继续原聊天。

DSH 的正文可以在消息块提交后出现。没有实现逐 token 转发。会话恢复已在 DSH 0.2.2-rc.1 验证：插件通过原生 resume 恢复上下文，使用 DSH 持久化接口读取历史，并实现 ACP load 的历史重放语义。临时启动补丁保留有效 ACP 配置，不修改用户 profile 或会话文件。没有实现 rewind，也没有承诺多根目录或额外附件。Paseo 0.15.2 对 provider 主动结束的审批可能显示默认拒绝标签，DSH 收到的取消结果仍是 `cancelled`。

运行中工具被 reload 打断时，已验证旧进程退出和新会话可用。本次 host 没有发出旧工具卡片的终态更新，因此卡片收尾未通过验收。

## 验证

使用 Node `>=24.9.0` 和 PowerShell 7。

```powershell
npm ci
npm run typecheck
npm test
node probes/permission.mjs
node probes/acp.mjs
node probes/history.mjs
```

`permission.mjs` 使用相邻 `deepseek-harness` 仓库的真实审批快照，经过当前插件及 SDK，验证允许、拒绝、取消、终态顺序和迟到回复。`acp.mjs` 使用该仓库既有 CLI 构建及免密 control-surface 夹具，验证文本、工具结果、目录和按目录列举。

`history.mjs` 使用同一 DSH 构建和独立临时存储，验证两次进程重启、原生 UUID 保持、消息与工具历史、续聊读取先前上下文，以及错误目录和无效会话必须失败。历史单元测试也需要相邻仓库的既有 DSH 构建，用于加载官方中断恢复函数。当前类型检查和 22 项测试通过；实际 Desktop 原聊天已恢复，界面的历史刷新错误已消失。

Windows 的 SDK 会调用 `taskkill /T /F`。在禁止结束子进程树的沙箱中运行探针会失败。

以下脚本启动各自的临时 daemon，不改动现有 daemon。`PaseoCli` 是 npm 包 `@getpaseo/cli@0.15.2` 的 `bin/paseo` 文件。

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

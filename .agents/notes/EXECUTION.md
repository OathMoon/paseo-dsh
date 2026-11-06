# 执行 DSH provider 计划

[中文](EXECUTION.md) | [English](EXECUTION.en.md) | [索引 / Index](INDEX.md)

除 Markdown 链接外，源码与证据路径均以仓库根目录为基准，绝对路径除外；所有命令从仓库根目录执行。

## 工作流

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [x] Phase C: Run the loop
- [x] 复验阶段 1 的独立 daemon、两轮对话和 cwd。
- [x] 建立本地依赖、类型检查和可重跑的兼容回归。
- [x] 在插件内补审批输入及工具结果映射，验证原始字段保留。
- [x] 从真实 daemon 验证审批、取消后继续、模型选择和插件生命周期。
- [ ] 运行中工具 reload 后即时卡片终态。此前 host 未发出该事件，此项保留未验证；后续已补历史恢复。
- [x] 原生会话恢复、历史重放、重启后续聊，以及实际 Desktop 原聊天刷新。
- [x] 检查真实模型验收条件，记录无法完成的外部条件。
- [x] Phase D: Keep the audit trail
- [x] Phase E: Verify and hand back

## 完成条件

安装目录插件后，Paseo 0.15.2 独立 daemon 能在指定 cwd 完成连续两轮。缺少 rawInput 的审批请求必须产生可选择的一次性审批事件，拒绝和允许必须原样返回对应 optionId。取消必须使当前回合结束，后续输入可继续。工具成功与失败的正文必须进入时间线，模型 Beta 必须实际生效。关闭和 reload 必须回收测试进程。

阶段 2 的真实模型及原生文件工具需要有效凭据和完整 DSH 构建。阶段 6 的基本恢复与历史重放已完成：DSH 持有上下文和持久化历史，插件实现 ACP load 所需的重放。rewind 等额外能力未实现。

## Throughput checkpoint

现有运行入口 2 个文件，验证脚本 3 个。按兼容回归、插件改动、真实 daemon 回归、交付说明四个单元执行。每个单元先验证再进入下一单元。实现不修改相邻 Paseo 或 DSH 仓库，不触碰已有 daemon 配置。验证使用独立 home 和临时工作区。

## 架构选择

候选一使用 custom connector，能改 ACP 帧，但 SDK connector 没有 launch 或会话 env 参数，会绕开 SDK 的进程清理。

候选二包装 ProviderRegistration.connect，把 daemon 已解析的 launch 包在自包含 Node stdio 转发器中。SDK 继续合并环境、探测目录、管理每个会话和终止进程树。选择候选二。插件 server 由 eval 执行，转发器以函数源码传给 node --eval，不依赖 import.meta.url 或安装目录。

验收脚本优先使用本机已有的 0.15.2 npm CLI。技能目录没有 control-cli 和 control-ui，使用真实 CLI 命令与客户端接口验收，桌面 UI 单独报告。

审批终态另有 SDK 兼容缺陷。它没有取消单个审批的接口，回合终态也不会清理待审批请求。插件按会话保存 pending 与 withdrawn 两种状态。原 prompt 返回后，转发器先标记尚未响应的审批为撤回。插件调用 SDK 的内部拒绝路径释放其 Map，转发器把仅这些已撤回请求的回包改为 `cancelled`。正常用户选择原样透传。host 先收到 permission_resolved，再收到回合终态，迟到点击不再触发第二个决定。

## 已核对证据

| 验证 | 证据目录或脚本 | 结果 |
|---|---|---|
| 阶段 1，修改后真实 daemon 连续两轮和 cwd | `C:/Users/Administrator/AppData/Local/Temp/tmpy0xvpb.tmp` | 通过 |
| 阶段 2，真实模型普通目录及 Git worktree 原生读写 | `C:/Users/Administrator/AppData/Local/Temp/paseo-dsh-stage2-3eba40e3fe6d44a4a47b4be86af7493b/verification-summary.json` | 通过 |
| 阶段 3，唯一工具 ID 的停止审批回归，修复前 | `C:/Users/Administrator/AppData/Local/Temp/paseo-dsh-stage3-be165949d46747ca9789083e7c43d997` | 失败，暴露旧审批残留 |
| 阶段 3，最终版含审批中 reload、旧 PID 回收及 cancelled 审计 | `C:/Users/Administrator/AppData/Local/Temp/paseo-dsh-stage3-b92e4409cff44d719000dcb115d068d2` | 通过 |
| 快照经实际插件及 SDK，含迟到允许和单次 canceled | `probes/permission.mjs` | 通过 |
| 工具结果、Beta、停止后继续、空闲 reload/remove | `C:/Users/Administrator/AppData/Local/Temp/tmpy55pcg.tmp/result.json` | 通过 |
| 运行中工具 reload，旧进程回收、新会话完成、无残留审批 | `C:/Users/Administrator/AppData/Local/Temp/tmpcl2lzg.tmp/result.json` | 通过，工具卡片终态未验证 |
| 类型及协议回归，含真实 Desktop Electron 启动、下游环境恢复及历史适配 | `npm run typecheck`、`npm test` | 22 项通过，无跳过 |
| 实际 Desktop daemon 的 aitest 工作区模型目录 | `.artifacts/desktop-catalog.json` | 5 个模型，error 为 null，provider diagnostic 为 Ready |
| 两次重启、原生 ID、完整历史及上下文续聊 | `probes/history.mjs`；临时目录 `paseo-dsh-history-I52fiZ` | 通过；另行核对两条回复均包含首轮记忆标记 |
| 实际 Desktop 原聊天刷新 | `.artifacts/actual-history-refresh.json`；原生 UI | 23 个条目，14 个已完成工具，刷新错误消失 |

阶段 2 实测使用生产 DSH 0.2.1-rc.5。本地 0.2.2-rc.1 夹具构建缺少部分原生模块，未以 MCP 加法成功代替原生文件工具验证。历史恢复另在夹具及已安装的 DSH 0.2.2-rc.1 上验证。桌面选择器、桌面停止按钮、POSIX 进程树清理尚未验收。

## 审查记录

两次独立审查均使用本会话模型。技能指定的 Claude 和 Grok 家族不在本机可用列表，未执行跨模型审查。审查发现的空内容失败正文和缺失事件可能通过顺序断言均已修正。

运行中工具 reload 已观察到旧 DSH 与 MCP 进程回收，以及 host 的 `turn_failed`，没有观察到工具卡片的终态更新。旧会话加载又需要未协商的 `session.persistence`。因此工具卡片收尾标为未验证，不把进程退出当作替代证据。保留了 reload 前建立的真实 host 事件订阅记录，最终脚本还检查新会话可用性。

最后完整 stage4 运行退出码为 0，结果明确记录 `activeToolTerminalObserved=false`。此后新增的新会话工具正文断言通过脚本语法检查，未重新运行整份脚本；本次已直接检查对应 DSH 日志中的工具结果为 5，Paseo 正文投影另由 Beta 用例覆盖。

## Desktop 选择 provider 报错修复

2026-11-06 实际桌面 host `127.0.0.1:6767` 的 provider 诊断为 `ACP connection closed`。daemon 使用 `Paseo.exe`，并为外部程序移除 `ELECTRON_RUN_AS_NODE`。插件用该可执行文件启动桥接，却没有恢复 Node 模式，因而误启 GUI。此前独立 `node.exe` daemon 的验收未覆盖这一运行方式。

修复仅对 Electron 宿主的桥接进程设置 `ELECTRON_RUN_AS_NODE=1`，把该变量原值作为单个参数传入桥接。启动 DSH 前从克隆环境恢复原值或删除该变量，保留其余 daemon 和 session 环境。普通 Node 宿主继续沿用原行为。

真实已安装 `Paseo.exe` 的回归在修复前失败，错误为 `AssertionError: ACP connection closed`。修复后类型检查和 17 项测试全部通过，其中包括原变量缺省、0、1 的环境恢复检查。已在实际桌面 host 仅 reload `paseo-dsh`。随后 `provider diagnostic dsh` 返回 Ready，原失败工作区返回 5 个模型且 error 为 null。

桌面图形控件复验受本机 UI 自动化阻碍。截图超时，后续窗口捕获曾返回不匹配的应用，已停止对该表面输入。网页替代入口也未开放。上述通过结论来自实际 Desktop daemon 的同一工作区模型请求，不声明已经目视点击验证。

## Desktop 历史刷新修复

2026-11-06 用户报告“无法刷新代理历史记录”。实际 daemon 日志显示空闲运行时被回收，随后恢复原聊天时出现 `Provider does not support session.persistence`。ACP SDK 即使没有协商 persistence，也会保存原生持久化句柄；DSH 原生支持 resume，却没有 load 所需的历史重放，因此刷新无法重新加载会话。

插件现在在 DSH 的 ACP stream 边界实现 load：仅当原生支持 resume 且没有 load 时补充能力；将 load 转为 resume，成功后通过 DSH 官方持久化接口读取同一个 UUID 的事件，并使用官方中断收尾函数重放用户、推理、回复和工具结果。原生已有 load 时保持其实现；resume 或历史读取失败时明确返回错误。未通过新建空会话规避错误。

启动适配读取 DSH 的有效配置，克隆原 ACP 配置到临时包装模块。最初尝试用 patch.name 替换模块失败，因为该字段是匹配条件；实际探针仍报 persistence 不支持。最终改为禁用原行、插入保留配置的新行，两次重启探针通过。用户 profile、凭据和会话文件均未改写。

`npm run typecheck` 和全部 22 项测试通过。真实 DSH 免密探针在 `C:/Users/Administrator/AppData/Local/Temp/paseo-dsh-history-I52fiZ` 保留证据，验证两次进程重启后原生 UUID 不变、两轮消息及两个独立工具结果完整，错误目录及不存在 UUID 被拒绝。探针运行中收紧了续聊断言，因此另行读取已保存事件核对：第二条回复确实保留第一轮随机记忆标记；不是仅检查首轮重放内容。

实际 Desktop 仅 reload 了 `paseo-dsh`，没有重启 daemon，没有向原聊天发送提示。原聊天 `33a8ffe0-4f20-4ac5-801f-92de10926b5a` 恢复后仍使用原生 UUID `6097da4a-e7da-4e76-80e0-808232bee60c`，返回 23 个时间线条目：1 条用户消息、7 条推理、14 条已完成工具和 1 条回复。通过原生窗口辅助功能树，先观察到错误提示，刷新后确认原消息与回复保留，错误和重试按钮消失。此项是实际界面验证，补充此前仅 daemon 请求的证据。

本次不声明 Pi 全部能力等价，也不包含 rewind 或运行中 reload 的即时工具卡片终态验收。最终新增历史实现未完成独立审查，原审查记录仅适用于此前范围。

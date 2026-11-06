# DSH 接入 Paseo 的 provider 插件方案

[中文](DSH-PROVIDER-PLAN.md) | [English](DSH-PROVIDER-PLAN.en.md) | [索引 / Index](INDEX.md)

除 Markdown 链接外，源码与证据路径均以仓库根目录为基准，绝对路径除外；所有命令从仓库根目录执行。

> **实施进展（2026-11-06）**　当前目录插件已加入窄 ACP 兼容转发，补齐缺省审批输入、标准工具结果正文，以及取消后的旧审批清理。已通过真实 daemon 连续对话、生产 `dsh.cmd 0.2.1-rc.5` 的普通工作区与 Git worktree 原生文件读写、一次性审批副作用、取消后继续、审批中 reload、Beta 和工具失败详情验收。另已修复 Desktop Electron 宿主误启 GUI 导致的 ACP connection closed，实际桌面工作区成功加载模型。另已实现原生会话恢复和历史重放，两次进程重启后可保留上下文续聊；实际 Desktop 原聊天恢复，历史刷新错误消失。类型检查及 22 项回归通过。最终证据与尚未覆盖项统一记录在 [EXECUTION.md](EXECUTION.md)，安装步骤见 [README.md](../../README.md)。阶段 6 的基本恢复与历史重放已完成；rewind 等额外能力仍未实现。下文保留设计时的协议分析和基线，不代表已修复版本仍有相同缺陷。

> **阶段 1 实施记录（2026-11-05）**　目录插件入口现为 `index.server.ts`，注册 ID 为 `dsh`。通过独立的 npm 版 Paseo 0.15.2 daemon / CLI 和本地 DSH 0.2.2-rc.1 免密夹具验收了安装、指定工作区、同会话两轮回复和结束事件。Paseo 时间线显示两次 `model=alpha; tool=5`，DSH 日志中两次工具结果均为 5，两个提示词属于同一个会话文件，header.cwd 等于指定目录。另行验证了工具失败后仍能读取回复：DSH 缺少 rawOutput 时，插件为失败行填入明确的通用错误，原始错误详情仍在 DSH 日志里。类型检查通过。
>
> Windows / PowerShell 7 复验：在本目录运行 `./probes/stage1.ps1 -PaseoCli <0.15.2安装目录>/node_modules/@getpaseo/cli/bin/paseo`。前提是相邻 DSH 仓库有既有 CLI 构建、依赖和 control-surface 夹具。脚本创建独立 home、loopback 端口和工作区，临时注入 MCP 工具，结束时停止测试 daemon。npm CLI 的 logs 输出为文本，脚本按实际文本验证。桌面选择器和真实付费模型尚未实测。下文保留设计时的基线和后续阶段。

**建议先用命令模式的 `runAcpProvider()` 交付指定工作区的一轮文本对话。** 两端的真实代码已经在免密夹具上完成这一轮。工具状态也能通，但工具结果详情会丢失，权限请求会失败，原生恢复的操作语义不同。三项分别设门槛；首版无需重写整个 provider。以下均针对 2026-11-05 本地检出的版本。

| 基线 | 本次使用的内容 |
|---|---|
| `E:\Repositories\paseo`（下文 P） | `cdd7800fed3d87757952a368467e703ac4d15873`，工作树干净，plugin SDK 0.15.2。直接打包该提交的 shim 源码运行。 |
| `E:\Repositories\deepseek-harness`（下文 D） | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，工作树干净。使用本地既有构建 `apps/cli/lib/bin.js`，报告 0.2.2-rc.1。PATH 上的 `dsh.cmd` 报 0.2.1-rc.5，未用它替代此基线。既有构建未从头重建。 |
| `E:\Repositories\paseo-dsh` | 开始时为空目录，无 Git 元数据。本次新增本文和两个实验脚本。没有安装插件或更改 daemon 配置。 |

## 1. 一轮对话跨越哪些边界

下表路径相对于 P 或 D。Paseo 的 daemon ↔ 插件 IPC 与插件 ↔ DSH 的 ACP 是两层协议，各自协商；相同的版本数字没有继承关系。

| 步骤、责任方 | 输入、输出及源码定位 | 对应的已有测试 |
|---|---|---|
| ① CLI / daemon 发现插件 | 目录安装读取 `paseo-plugin.json`、校验版本并保存安装来源。启动或 reload 时，按全局 `pluginsEnabled` 和单插件启用状态加载 server entry。P `packages/server/src/server/plugins/index.ts` 的 install、startPlugin，`manifest.ts`、`runtime.ts` 的 spawnPluginChild。 | 同目录 `manifest.test.ts`、`index.posix.test.ts`、`runtime.posix.test.ts`，POSIX 用例需相应平台。 |
| ② 插件进程 / daemon 注册 | `index.server.ts` 默认导出调用 `server.registerProvider(runAcpProvider(...))`；`plugin-process.ts:153` 收集注册，daemon 的 `index.ts:692–730` 拒绝重复或内置 ID，把 provider ID 映射到插件 IPC connect。选择器和 CLI 用注册 ID `dsh`。参考 P `plugin-examples/provider-acp-transformer/index.server.ts`。 | P `packages/server/src/server/plugins/index.posix.test.ts` 有真正注册 command provider 的夹具；`plugin-process.ts` 的对端由 `runtime.posix.test.ts` 覆盖。 |
| ③ daemon / shim 连接并启动 DSH | P `packages/server/src/server/agent/plugin-provider.ts:383` 请求 provider 版本、能力及解析后的 launch；`plugins/runtime.ts:489` → `plugins/plugin-process.ts:225` → P `packages/plugin/src/server/acp.ts` 的 connect。下文 **shim** 指同包的 `acp-internal/connection.ts`。其 createAcpProviderConnection 先起临时能力探针；AcpRuntime.start 用 spawnProcess 传 command、args、合并后的 env、pipe stdio。Windows 由 SDK 处理命令脚本。 | P `packages/plugin/src/server/acp.test.ts:228,275,308`（解析后的 launch、探测失败、可执行文件缺失），同目录 `process.test.ts`。 |
| ④ 双方协商、Paseo 获取目录 | shim 通过 NDJSON 发送 `initialize {protocolVersion:1,clientCapabilities:{},clientInfo:…}`。D `apps/cli/src/profile-boot.ts` 组合 profile，`packages/bundle/acp-app/cordis.patch.yml` 加载 acp-app 与 acp；`packages/acp/acp/src/index.ts` 的 initialize 返回能力。shim 关探针，求 host 请求与支持能力的交集。catalog 会另起进程，按 cwd 做临时 new/close 取 configOptions。 | P `acp.test.ts:871,897`；D `snapshots/acp/handshake` 与 `apps/cli/tests/profiles/acp/tests/control-surface.e2e.ts`。 |
| ⑤ 工作区、会话及 ID | P `packages/server/src/server/agent/create-agent/create.ts` 的 resolveMcpCwd 等路径区分普通目录和新 worktree 的实际目录；`plugin-provider.ts:245,1845` 把 config.cwd 放进 `session.open.config.cwd`。shim openSession 单独启动 session runtime，open 调 `session/new {cwd:input.config.cwd,mcpServers,_meta:{_paseo:…}}`。D validateWorkspaceParams 要求绝对路径并拒绝非空 additionalDirectories；newSession → `packages/acp/acp/src/session.ts` 的 AcpSession.create → `ctx.agents.create({meta:{cwd},…})`，flush 后回原生 UUID 和 configOptions。shim 缓存原生 ID，向 daemon 发 Paseo ID 的 opened/config/ready。 | P `plugin-provider.test.ts`、`acp.test.ts:928`；D `packages/acp/acp/tests/bridge.spec.ts`、`snapshots/acp/reject-extra-dirs`、`packages/core/session/tests/session.spec.ts`。 |
| ⑥ 输入、回复、结束 | Paseo send 入队，`session.prompt` 携 clientMessageId。shim admitPrompt 先发用户条目、prompt_result(turn)、session.turn(started)，再以原生 UUID 发 `session/prompt {sessionId,prompt:[{type:"text",text}]}`。D AcpSession.prompt 跟踪本次输入、等待工作完成并排空更新；`updates.ts` 将提交的 assistant/message 等转为 `session/update`。shim 按 ID 合并快照，等通知队列排空才把 prompt 的 stopReason 映射到 completed/canceled，RPC 错误映射 failed。P `plugin-provider.ts:1505–1558` 投影 timeline、turn_completed 等事件供客户端订阅。send 返回和 prompt_result 都早于回合终态。 | D `packages/acp/acp/tests/turns.spec.ts`、`updates.spec.ts`、control-surface E2E；P `acp.test.ts:569,1249,1417` 与 `plugin-provider.test.ts`。 |

**哪个目录生效。** P 的插件子进程 fork 和 shim 的 spawn 均未指定 OS cwd，DSH 继承进程目录。工作区由 ACP 请求独立传入。D `packages/core/session/src/index.ts:1196` 写 header.cwd；`packages/session/working-directory/src/index.ts:86` 用它初始化有效目录投影，ensure 检查目录存在，后续目录变更可以改变投影；`packages/fs/tool-fs/src/session-cwd.ts` 在 agent 上调用 ensure。DSH 启动阶段 profile boot 另有 process.cwd()；不要假设按会话目录自动加载项目级启动配置。也不要用全局 chdir 实现多工作区。本次验证到持久化头和按目录列举；真实文件工具的相对读写还要用双目录标记文件验收。

## 2. 已运行的兼容性实验

**复现条件。** 三目录同级，从 paseo-dsh 运行。Windows、Node 25.8.0，D 已安装锁定依赖并有 CLI 及夹具所需的本地构建。探针使用 D 的 pnpm store 内 esbuild 0.28.1、ACP SDK 1.4.0、Zod 4.4.3 编译 P 的 shim；无需安装整个 Paseo 或运行 daemon。每次新建 scratch，其中有独立 DSH_HOME、会话库和空工作区。使用官方 control-surface 的 patch 禁用远程模型，用仓内 MCP 加法服务。启动 argv 相当于以下命令（实际用绝对路径）。

~~~powershell
Set-Location E:\Repositories\paseo-dsh
node ..\deepseek-harness\apps\cli\lib\bin.js --version
# 可设为另一个可写目录。脚本会打印本次 root，留作第二个实验的输入。
$env:PASEO_DSH_PROBE_DIR = (Get-Location).Path
node probes/acp.mjs
# 用上一条打印的 root 替换下方示例值
node probes/permission.mjs "<root>\paseo-acp.mjs"
~~~

1. **命令模式 + 真实 DSH。** 启动 `node <D>/apps/cli/lib/bin.js --profile acp --patch <独立夹具>`。进程 cwd 为 paseo-dsh，请求 cwd 为另一个包含空格的绝对路径。连接实得 prompt.message、session.list、permission、session.configure，申请的 session.persistence 未返回。打开得到 Alpha/Beta，发送文本后依次看到 started、reasoning、同一 control-add 工具行 running/completed、正文 **model=alpha; tool=5**、completed。两个工具快照的 detail.output 均为 null。关闭后由另一个 DSH 进程按目标 cwd 列到相同 UUID；实际读取 session.v4.jsonl 首行也得到该 UUID 和请求目录。脚本退出码 0。
2. **真实 shim + DSH 权限帧回放。** 第二个脚本从 D 的 escalation-rejected 快照提取 request_permission，走 shim 的 ACP connector。仅传 `toolCall:{toolCallId}` 时，响应 `-32602 Invalid params`，无 session.permission。对照组只添加 `rawInput:{}`，收到权限事件，Paseo 的 deny + selectedActionId 回到线上为 `selected/reject-once`。两项断言均通过。这定位到 shim.requestPermission 对可选字段调用 jsonRecord(undefined) → Zod JSON 解析失败。握手声称 permission 不能代替行为验证。
3. **环境边界。** 默认 10 秒曾报 did not initialize；关闭遥测、将探针启动预算改为 90 秒后成功，两项条件一起改变，不能单独归因。限制 Windows taskkill 的沙箱也曾在关闭探针时报拒绝访问；真实命令模式需要能回收子进程树。直接发 initialize 可在 stdout 读到协议版本 1，stderr 同时警告本地已有构建有 11 项未激活，包括 working-directory 和 tool-executor-native。上述 MCP 成功不能证明这些原生工具工作。排查时用同一 launch/env 单独看 DSH stderr（shim 当前只排空它），必要时按 D 的构建流程重建并复检。
4. **待验证。** 本次从 provider.connect 进入，没有启动 Paseo daemon/App，没有使用真实模型凭据，也没有实测生产 dsh.cmd、真实审批副作用、停止按钮或跨 daemon 恢复。表中上游测试是定位依据，未将其列为本次运行。复现后可删除脚本打印的独立 scratch。

## 3. 最小插件、能力边界与决策

目录安装最小运行资产为 `paseo-plugin.json` 和 `index.server.ts`。建议为开发加 `package.json`、锁文件、`tsconfig.json`，以本地 P 对应的 SDK 做类型检查；图标可选，引用时随包提供自包含 SVG。首版只需要 server 入口。建议 manifest 用安装 ID `paseo-dsh`，provider ID 用 `dsh`，label 用 `DeepSeek Harness`。初始验证范围保守限定 `requirements.paseo: "0.15.2"`，扩大范围时逐版本验收。示意注册如下。

~~~ts
server.registerProvider(runAcpProvider({
  id: "dsh",
  label: "DeepSeek Harness",
  command: ["dsh", "--profile", "acp"],
  acpOptions: { workspaceOnlyCatalog: true, startupTimeoutMs: 90_000 },
}))
~~~

生产沿用 daemon 解析的 launch（含完整 env），session env 由 shim 合并。需要固定版本时，可在 `agents.providers.dsh.command` 指定完整 argv，例如绝对 node.exe、绝对 DSH bin.js、--profile、acp。验证夹具时才加 --patch 和夹具所需环境。密钥由 DSH 凭据服务或 daemon 环境提供，官方 API key 适配器默认查询 DEEPSEEK_API_KEY，缺失时模型发现可为空；`authMethods:[]` 表示没有 ACP 登录流程。插件不持有密钥副本。P `public-docs/custom-providers.md`；D `packages/llm/llm-deepseek-api-key/README.md`。

| 能力 | Paseo 期望 / DSH 现状 | 插件策略 |
|---|---|---|
| 文本与推理（首轮必需正文、终态） | shim 接受按 messageId 的更新并累计显示；DSH 从已提交的消息块发送正文和推理，可到块提交后才出现。后续 usage 属附加信息。 | 使用默认映射。若产品要求逐 token，需 DSH 增加实时事件并处理提交时去重，不能由插件从最终文本还原时序。 |
| 工具（首轮纯文本可选） | DSH 发 tool_call 的 title、rawInput、kind=other，结束发相同 ID 和 status，结果在 tool_call_update.content；shim 合并读 rawOutput，已实测成功行无结果正文。失败详情也有同一风险。 | 首选保留原生通用行。要展示结果，在 ACP 帧进入 shim 前将标准 content 投影为可读输出，或修 P 的 mergeToolCallSnapshot。toolCall transformer 收到的快照已丢失 content，只适合仍在快照里的类型/字段美化。 |
| 工具审批（对会触发提权的工具为上线门槛） | Paseo 要有 session.permission、可选动作和对应回包；DSH 提供 allow-once/reject-once，权请求只带 call ID。当前回放失败。DSH 还区分 cancelled，不应伪造永久授权。 | 优先修 P 对缺失 rawInput 的容错（例如默认 {}），可按 call ID 补前一工具的标题/输入帮助判断，缺上下文时保持显式。或 DSH 发完整 toolCall。暂不能改上游时，用窄 stdio 转发器只补该字段，保持 id、optionId、双向顺序、EOF、stderr 和取消；命令覆盖必须仍经过转发器。notification/toolCall 钩子不拦截此反向 RPC。应用修复前只验收无需审批的工作负载，绝不自动代答。 |
| 取消（可选独立阶段） | session.interrupt → session/cancel 通知；request.completed 仅表示中断请求已发送，DSH 取消 agent 并等待收尾，原 prompt 返回 cancelled，shim 发 canceled。auto 替换提示也会先取消上一轮。 | 复用 shim，验证工具终态、取消等待审批、第二轮可用；不把并发输入宣传为 steer。 |
| 恢复 / 历史（可选） | shim 看 agentCapabilities.loadSession 才协商 session.persistence，带持久化句柄 open 时用 session/load 并预期可 replay。DSH 有 sessionCapabilities.resume/list/close，无 loadSession；resume 核对持久化 ID 和 cwd 后重挂载，不回放旧时间线。list 排除活动/子会话且可能分页，shim 的 list 路径只取一次。 | 首版验收同一活动会话的多轮；有 UUID、列表、Paseo 本地历史均不能证明重启续聊。需原生恢复时优先实现双方认可的 load+回放，或显式设计 resume 与 Paseo 历史所有权，验收断线后上下文和时间线去重。禁止仅改能力位或把 load 改名 resume。 |
| 模型、配置与额外输入 | DSH configOptions 可有分组模型及 reasoning_effort，shim 会展开；图片能力按 DSH initialize 动态返回。P 的额外系统提示、工具策略、persist 等放在 _meta._paseo，D newSession 只消费自己支持的字段。DSH session/new 会 flush。 | 首轮用 DSH profile 默认值和一个绝对 cwd；不承诺 exact tool policy、无痕会话、多根目录、任意附件或结构化输出。workspaceOnlyCatalog 省掉无 cwd 时的临时会话，但工作区目录探测仍可能生成空会话。 |

**何时直接实现 ProviderRegistration。** 当前文本链、工具 ID 合并、取消机制均可复用。若首发必须提供无法由标准 load 表达的恢复、独立历史重放或更细的进程生命周期控制，且无法改上游，再比较直接注册的成本。届时插件要接管 connect/send/onEvent/close、每会话进程和 ID 映射、请求失败与 turn 终态、审批 pending 清理、history=replay/skip 及并发关闭。窄协议转发也要能处理握手、catalog 探针和 Windows 清理；只为修改通用 SDK 的可选字段时，修上游维护面最小。

## 4. 分阶段开发与独立验收

每阶段都从目标 daemon 的 Paseo CLI 或 App 进入。后续阶段复用第一阶段的目录插件；可分别决定是否发布。下面是开发完成后的通过条件。

| 阶段 / 可见行为 | 最小改动 | 操作和通过标准 | 失败定位 |
|---|---|---|---|
| 1. 在指定工作区选 DSH 并完成免密首轮 | 两个运行文件，直接注册 shim；测试 host 固定到 D 的 CLI，沿用探针 patch、独立存储和 fixture MCP。 | 安装并在工作区选择 DSH；发送夹具提示。只出现一条用户输入，能看到正文 model=alpha; tool=5，回合结束且能再发。将 daemon 启动目录 A 和选中的 B 分开；检查 DSH session header、list 和 UUID。此阶段把尚未覆盖的发现、IPC 和 UI 与已通过的 adapter 连接起来。 | 无 provider 查全局开关、manifest/版本、注册冲突；无模型查 workspace catalog、launch/env 和 DSH stderr；未结束按 prompt_result → session.turn → host turn_completed 分段比对。 |
| 2. 真实模型在目标工作区读到独有内容 | 去掉测试 patch/MCP，用完整的 DSH 构建和真实凭据；保留同一个注册。 | A、B 中放同名不同随机值的文件，只告诉模型相对文件名，要求调用文件工具并回复内容。必须是 B 的值，B 内相对写文件也只落在 B；时间线有工具行且回合可结束。新 worktree 再重复。 | 模型空查凭据/路由；header 错查 session.open，header 对而读错查 DSH working-directory、tool-fs、profile 启动警告和沙箱。 |
| 3. 用户能作出一次性审批 | 落地前述上游容错或窄转发；纳入缺字段、显式字段和 cancelled 用例。 | 从 Paseo 发起夹具的需审批操作，在独立临时区分别拒绝和允许。点击前无副作用；拒绝不写文件，允许恰写一次；再发相同请求仍询问，回合和卡片均收尾。 | 查 request_permission 的 call ID/rawInput、session.permission 是否发出、selectedActionId/behavior 和 DSH 收到的 outcome；超时/关闭查 pending 清理。 |
| 4. 用户能停止长回合并继续 | 先复用 session.interrupt，仅为实证缺陷补代码。 | control-surface 输入含 cancel，等工具结束后点击停止；只出现一次 canceled，等待中的回合释放，立即发送普通提示可完成。另测运行中工具和待审批时关闭/reload，检查子进程、挂起审批及孤立工具行。 | 区分 request.completed 和原 prompt 的 stopReason，查 AcpSession.cancel、shim activePrompt、terminateProcess。 |
| 5. 可选工具详情 / 模型目录 | 分别实现 content → output 的窄修复或采用上游版本；模型沿用标准 configOptions。 | 同一夹具验收一行工具从 running → completed，结果可见 5；失败用例显示错误正文。工作区选择 Beta 后，回复 model=beta; tool=5。两项可以分开上线。 | 检查线上 content、rawOutput 与 shim 合并后的 snapshot；模型核对分组 option.value 及 set_config_option。 |
| 6. 可选重启续聊 | 先确定历史由谁保存，再接 load+replay 或专用 provider。 | 在专用测试 daemon 中记入随机词，关闭进程并重启，打开旧会话、问随机词；上下文正确、没有重复历史/新 UUID，错误 cwd 和失效句柄明确报错。 | 分别查协商位、持久化 handle、load/resume、replay 窗口和历史事件数量。 |

**留给你决定的范围。** 可以先发布本地文本试用版，限无需审批的环境；若面向日常编码，则把阶段 2–4 设为发布门槛。可以接受按已提交块显示正文，也可以将逐 token 列为 DSH 上游需求。模型选择器可仅在选工作区后加载，或为全局发现接受额外临时会话。分发可先限定本地目录与本次版本；发布 npm/Git 和注册表时再补包内容、图标、OVERVIEW、跨平台与版本矩阵。重启续聊独立决策，不随文本首轮承诺。

## 5. 从干净工作区验收

1. **离线，依赖预装。** 从干净目标目录检出未来插件，按锁文件装依赖、typecheck；确认 P、D 提交和 DSH CLI 版本。按第 2 节运行两个探针。第二个是当前缺陷的基线，修复后将原始帧断言改为必须出现权限事件，保留显式字段的对照。无网络时使用已有依赖及 D 的本地构建。
2. **离线，但需要真实本地程序。** 启动与 P 版本一致的专用测试 daemon，使用独立配置、DSH_HOME 与空 workspace B；确认全局插件已启用。运行 `paseo plugin install E:\Repositories\paseo-dsh`、`paseo plugin ls`，要求 running；从 App 的 B 打开创建表单确认能选 dsh。配置该 host 的命令、环境及 fixture MCP（参数见 probes/acp.mjs），执行 `paseo run --workspace <B的ID> --provider dsh "exercise the attached server"`，按阶段 1 判定。CLI 和 App 都连接同一 host。失败用 `paseo plugin logs paseo-dsh` 及相同 argv 的 DSH stderr 定位。
3. **离线交互回归。** 同一 host 用长回合夹具测停止；权限阶段用 D 的 escalation-approved/rejected 快照或回放配置驱动真实 DSH，检查卡片、决定和文件副作用。单纯回放 JSON 帧只能验证协议映射。改变 server 源后 `paseo plugin reload paseo-dsh`，重复阶段验收。确认当前 release 已实现的范围。
4. **真实 DSH 与凭据。** 移除 fixture、使用将发布的 `dsh --profile acp`，核对 daemon 账号的 PATH、DSH 凭据与工作区权限。按阶段 2 做双目录与 worktree 文件验收；在真实模型上完成两个连续回合、受控审批及取消。临时移除测试凭据应能观察到空模型目录或可定位的失败，不能把失败回合记为成功。恢复能力只在选择交付阶段 6 后验收。
5. **退出与清理。** 在测试 host 关闭会话、reload / remove 插件，确认 provider 从列表消失（reload 成功后应重新出现）、DSH 子进程和权限等待均释放。保存脱敏后的事件顺序、DSH 版本、cwd 与两侧 ID，清理本轮专用 workspace 和测试存储。


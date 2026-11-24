# 项目记录 / Project notes

安装、使用和验证命令保留在根目录的 [README（中文）](../../README.md) 与 [README (English)](../../README.en.md)。此目录保存计划、执行证据和决策日志。

Installation, usage, and verification commands live in the root READMEs. This directory contains the integration plan, execution evidence, and decision log.

| 内容 / Document | 中文 | English |
|---|---|---|
| 接入设计与分阶段验收 / Integration design and staged acceptance | [DSH-PROVIDER-PLAN.md](DSH-PROVIDER-PLAN.md) | [DSH-PROVIDER-PLAN.en.md](DSH-PROVIDER-PLAN.en.md) |
| Direct Provider 升级方案 / Direct Provider upgrade plan | [DIRECT-PROVIDER-UPGRADE-PLAN.md](DIRECT-PROVIDER-UPGRADE-PLAN.md) | [DIRECT-PROVIDER-UPGRADE-PLAN.en.md](DIRECT-PROVIDER-UPGRADE-PLAN.en.md) |
| 当前结果、证据与限制 / Results, evidence, and limitations | [EXECUTION.md](EXECUTION.md) | [EXECUTION.en.md](EXECUTION.en.md) |
| 按时间追加的决策日志 / Chronological decision log | [decisions.tsv](decisions.tsv) | [decisions.en.tsv](decisions.en.tsv) |

计划中的基线分析、早期失败和决策日志保留当时状态；当前完成情况以执行记录为准。英文文档对应中文内容，日志逐行对应，保留原始时间、阶段和证据字段。原始日志中的格式问题与更正行也予以保留。

The plan's baseline analysis, early failures, and log entries retain their historical state. Consult the execution record for current status. English documents correspond to the Chinese versions. Log rows preserve timestamps, phases, and evidence; original formatting defects and later correction rows are retained.

除 Markdown 链接外，文档中的源码路径、证据路径和日志证据字段均以仓库根目录为基准；绝对路径保持原样。所有命令均从仓库根目录执行。迁移前的日志行号是历史定位，不代表迁移后文件的行号。临时目录证据可能随本机清理失效。

Except for Markdown links, source paths, evidence paths, and log evidence fields are relative to the repository root unless absolute. Run all commands from the repository root. Pre-migration log line numbers are historical references. Temporary evidence may disappear during local cleanup.

新增记录放在此目录；更新文档时同步维护对应语言版本。代码、探针和测试仍放在原有目录。

Add future records here and update both language versions together. Source code, probes, and tests remain in their existing directories.

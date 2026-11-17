# 真实模型验收

`npm run eval:real` 默认只说明启用方法，不发起模型请求。显式设置 `REAL_EVAL=1` 后，脚本启动独立服务和临时 SQLite，使用部署环境或本地 `.env` 中的真实模型配置。不会修改正式模型表、会话或群聊。

## 运行

```powershell
$env:REAL_EVAL="1"
npm run eval:real
```

会调用真实供应商并产生费用。首次可只运行一项：

```powershell
$env:REAL_EVAL="1"
$env:REAL_EVAL_CASES="constraint-memory"
$env:REAL_EVAL_TIMEOUT_MS="120000"
npm run eval:real
```

支持的场景：

| 标识 | 检查内容 |
| --- | --- |
| `tool-selection` | 自动选择销售分析技能或工具，必须观察到真实执行记录和最终回答 |
| `constraint-memory` | 多轮对话后准确回忆随机项目代号与预算 |
| `compaction-memory` | 确认真正产生压缩摘要后，再验证约束保留 |
| `group-collaboration` | 主持分派、至少两个部门发言、最终汇总及调用上限 |

`REAL_EVAL_CASES` 可用逗号组合。单项超时 `REAL_EVAL_TIMEOUT_MS` 默认为 180000 毫秒，可设为 10000–600000 毫秒。独立服务启动预算 `REAL_EVAL_STARTUP_TIMEOUT_MS` 默认为 90000 毫秒，可设为 1000–180000 毫秒；健康检查单次最多等待 1500 毫秒。

群聊验收限制为一轮、最多六次 Agent 调用。报告用 `agentInvocations` 记录调度器计数，并标明 `invocationBasis: "group_scheduler"`。一次 Agent 调用内部可能有多次模型请求，因此该字段不是物理模型请求数，也不是费用硬限额。

`compaction-memory` 会创建专属临时 Agent，将 `memoryConfig.keepRecentTokens` 设为 `0`，让短验收对话也实际进入 Pi 摘要压缩，而不是因全部消息都属于近期保留区而不压缩。只有确认 `compactedAt` 和非空 `summary` 后才验证约束回忆，报告同时记录 `compactionKeepRecentTokens: 0`。这是验收设置，不会更改正式 Agent 的记忆配置，也不能替代默认保留策略下的长对话质量评估。

## 报告与边界

默认报告位于 `data/real-eval/latest.json`，可通过 `REAL_EVAL_OUT` 指定其它目录。报告不保存提示词、模型回答、凭证、供应商地址或供应商原始错误。

当前报告为 `schemaVersion: 2`，主要字段如下：

| 字段 | 含义 |
| --- | --- |
| `mode` | `real` 为真实模型验收；`local-fake` 为本机假模型框架验证 |
| `status` | 启动、全部场景和清理均成功才是 `passed` |
| `startup` | 启动状态、耗时；失败时包含安全原因码和失败阶段 |
| `results` | 每场景状态、判定项、耗时和可获得的指标；异常时记录 `reason`、`stage` |
| `summary` | 总数、实际执行数、通过数、失败数、跳过数和成功率；全部跳过时成功率为 `null` |
| `cleanup` | `serverStopped` 与 `temporaryDataRemoved`，分别确认隔离服务停止和临时数据清理 |
| `durationMs` | 整次验收耗时，包含启动和清理 |

配置或启动失败仍会尽可能写入报告，未运行的场景标为 `skipped`，不计入实际执行数。案例异常会尝试停止活动会话或群聊，`stopRequests` 中的 `acknowledged` 表示停止请求是否获确认。服务退出确认后才清理临时数据；清理失败也使总体结果失败。失败时仍尝试读取已有指标，无法读取则标记 `metricsUnavailable: true`。

`reason` 只输出安全原因码，例如 `case_timeout`（案例预算耗尽）、`model_authentication_failed`（模型鉴权失败）、`model_rate_limited`（供应商限流）、`model_timeout`（模型超时）、`model_provider_unavailable`（供应商不可用）、`compaction_not_performed`（未实际压缩）和 `real_model_required`（没有可用真实模型）。`stage` 用于区分记录约束、压缩、回忆、群聊等失败位置；未知错误归为通用原因，不透传原始错误内容。

会话指标来自可获得的 Pi token、工具调用和费用数据。未知工具调用数或费用用 `null` 表示，token 只保留可用的有限非负字段，不能把缺失数据当作零消耗。`costBasis: "pi_model_catalog_estimate"` 表示费用按 Pi 模型目录价格估算，不是供应商账单；自定义供应商价格可能不同。

自动判定检查固定任务契约，不能替代业务人员复核分析质量、引用和行动项是否合理。验收失败返回非零退出码；未启用、配置不可用、超时和实际失败不能算通过。

## 不调用外部模型的验证

```powershell
npm run eval:selftest
npm run eval:integration
```

`eval:selftest` 只验证纯判定逻辑。`eval:integration` 使用真实服务和 Pi 接入本机 loopback 假模型，验证四个场景、鉴权失败、超时停止、启动失败、非法配置、脱敏及资源清理；无需设置 `REAL_EVAL`，不调用外部供应商。它在系统临时目录使用独立数据库和报告，并检查已有真实验收报告未被覆盖。本机假模型通过只证明验收框架行为，不代表真实模型能力或真实服务接入已通过。

直接调试框架时，`REAL_EVAL_LOCAL_FIXTURE=1` 仍要求同时设置 `REAL_EVAL=1`，且 `LLM_BASE_URL` 必须是 HTTP loopback 地址。该模式报告标为 `local-fake`，默认写入 `data/real-eval-fixture/latest.json`，与真实报告分开。

## 持续集成

`.github/workflows/verify.yml` 在主分支推送、拉取请求或手动触发时执行构建、类型检查、关键自检、`eval:integration` 及隔离浏览器测试。失败时保留逐项日志和浏览器截图。CI 使用模拟模型或本机假模型，不读取真实供应商密钥，也不执行 `eval:real`。

`npm run ci:selftest` 仅检查工作流约束、脚本入口和临时环境生成，不代表托管 GitHub Actions 已执行。

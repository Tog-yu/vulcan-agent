# Vulcan Agent × oMLX 真模型 全流程测试报告

> 生成时间：2026-10-02 01:50 · 模型：`Qwen3.6-35B-A3B-mxfp4`（oMLX @ http://127.0.0.1:8000）
> 脚本：`scripts/e2e-omlx.ts` · 数据库：`data/e2e-omlx.db`

---

## 一、结果总览

| 项目 | 结果 |
|---|---|
| 全量回归测试（vitest） | ✅ **22 文件 / 170 用例全部通过**（144s） |
| oMLX 真模型 E2E 冒烟 | ✅ **全流程打通**：read → write → run_tests → 审批 approved → PR 创建 → 任务 done → 长期记忆沉淀（88.7s） |
| E2E 后任务终态 | `done`，审批 `approved`，PR `https://git.example/svc/auth/pull/t-omlx` |
| 长期记忆 | 沉淀 1 条 `verified_fix`（verified_by_test）到 RAG 分区 `repo/vulcan-svc-auth` |

## 二、接入方案（新增 2 个文件，未改 src 既有代码）

### `src/server/cli/omlx-model.ts` —— pi-ai 自定义 provider

pi-ai 内置目录没有 oMLX，走 `createProvider` 自定义注册：

```
createModels()
  → setProvider(createProvider({
      id: "omlx",
      baseUrl: "http://127.0.0.1:8000/v1",      ← OMLX_BASE_URL 可覆盖
      auth: envApiKeyAuth("oMLX API key", ["OMLX_API_KEY"]),   ← 默认 1234
      models: [omlxModelDescriptor(cfg)],        ← cost 全 0，本地推理不计费
      api: lazyApi(() => import(".../openai-completions")),   ← /chat/completions 协议
    }))
  → getModel("omlx", "Qwen3.6-35B-A3B-mxfp4")
  → streamFn = models.streamSimple 绑定          ← 签名与 AgentRunDeps.streamFn 对齐
```

环境变量：`OMLX_API_KEY`（密钥，必填）、`OMLX_BASE_URL`（默认 127.0.0.1:8000/v1）、`OMLX_MODEL_ID`（默认 Qwen3.6-35B-A3B-mxfp4）。

实测 oMLX/Qwen3.6 兼容性：非流式/流式 chat completions ✅、tool_calls（finish_reason=tool_calls）✅、`reasoning_content` 独立字段（思考分离）✅，无需特殊 compat 配置。

### `scripts/e2e-omlx.ts` —— 真模型全链路冒烟脚本

运行方式：

```bash
OMLX_API_KEY=1234 node --experimental-strip-types scripts/e2e-omlx.ts
```

场景：临时工作区种一个带 bug 的 `src/login.ts`（过期判断写反），告警 issue 带定位信息，让真模型走完整修复流程。

## 三、E2E 实际发生的事（模型真实行为）

```
17:41:41  任务 t-omlx 种入 SQLite（status=running）
17:42:21  模型调 read_file("src/login.ts")   → 读到 bug 源码 ✅（未越权）
17:42:45  模型调 write_file 修改 verifyToken  → patchRef=local:src/login.ts ✅
17:43:10  模型调 run_tests("npm test")       → testsPassed=true ✅
17:43:10  FixPipeline 提取证据 → 审批引擎裁决 approved → PR 创建 → 任务 done
17:43:10  distillFromTask 提炼 → MemoryGate 放行 → RAG memory_store 沉淀 verified_fix
```

`session.recent_window`（滚动窗口）4 条 toolResult 全程留痕：

```
[toolResult] read_file : {"path":"src/login.ts","content":"// 登录 token 校验…export func…
[toolResult] write_file: {"path":"src/login.ts","bytes":205,"patchRef":"local:src/login.ts"}
[toolResult] run_tests : {"suite":"npm test","testsPassed":true,"buildPassed":true}
[toolResult] run_tests : {"suite":"npm test","testsPassed":true,"buildPassed":true}
```

## 四、调试过程（三跑才通，每个坑都有价值）

| 轮次 | 结果 | 根因 | 修复 |
|---|---|---|---|
| 1 | 15 分钟后 budget 强停，5 次工具调用全部 `VULCAN_TOOL_001 路径越权` | workspaceRoot 指仓库根但 allowedRepos=["svc/auth"]，`resolve(root, "svc/auth")` 前缀永不匹配 | 无（此轮只是暴露问题） |
| 2 | 25 步预算强停 | 两个问题叠加：① 告警无定位 → 模型把 run_tests 当 shell 用（find/ls/cat/pwd）；② run_tests 占位恒通过，**强化了错误用法** | ① issue 带文件坐标；② run_tests 改"教学版"：shell 特征输入拒绝并提示正确工具 |
| 3 | 17 分钟后仍全越权 | **上一轮进程在编辑前启动**（改完没重跑），且 FixPipeline.scope 与 pluginCtx.allowedRepos 不一致 | 确认两处 scope 对齐为 `["."]` 后重跑 |
| 4 | ✅ 88.7s 全流程通过 | —— | —— |

**沉淀的两条架构级教训**（已写进脚本注释）：

1. **scope 前缀匹配的口径陷阱**：工具的 `assertInScope` 是 `resolve(workspaceRoot, path)` 对 `resolve(workspaceRoot, repo)` 做前缀匹配。workspaceRoot 直接指仓库根时，allowedRepos 必须是 `["."]`；写 `["svc/auth"]` 会导致所有相对路径全部越权——错误信息（"不在 allowedRepos 内"）完全无法提示根因是仓库名拼写口径而非真的越权。
2. **告警必须带定位信息**：无坐标的告警会让小参数量的本地模型在工具空间里盲探索。生产链路里告警 payload 带堆栈/文件坐标是硬需求，不是锦上添花。

## 五、各表记录实例（本次 E2E 真实写入 data/e2e-omlx.db）

### schema_migrations（6 行，略——v1~v6 全部应用）

### webhook_events（1 行）

| 字段 | 值 | 意义 |
|---|---|---|
| id | `evt-omlx` | 幂等去重键 |
| source / type | `alert` / `alert.fired` | 告警来源告警事件 |
| ref | `omlx-e2e` | 源引用，关联 tasks.ref |
| payload / raw | `{}` | 归一化事件体 / 原始快照 |
| status / attempts | `done` / 0 | 队列状态机：处理完成，未重试 |

### tasks（1 行）

| 字段 | 值 | 意义 |
|---|---|---|
| id | `t-omlx` | 任务 ID |
| source / ref | `alert` / `omlx-e2e` | 与 webhook_events 对应 |
| status | **`done`** | 八态状态机走完：running → awaiting_approval → done |

### sessions（1 行）—— 三层短期记忆

| 字段 | 值 | 意义 |
|---|---|---|
| id | `sess-t-omlx` | `sess-<taskId>`，与任务一对一 |
| task_state | 结构化 JSON（task_id/objective/progress/context/assumptions/todos/budget） | 恒定层，~2K tokens，冲突裁定权威 |
| recent_window | 4 条 toolResult JSON（见第三节） | 滚动层，本次任务全程工具留痕 |
| early_summary | NULL | 摘要层；本次仅 4 步未触发摘要（阈值 15 步或 60% token 预算） |

### task_events（0 行）

本次走 FixPipeline 直调路径，未触发树形事件写入（parent_event_id 树形回放尚未接消费侧）。

### approvals（1 行）

| 字段 | 值 | 意义 |
|---|---|---|
| id | `AP-t-omlx` | 审批单号 = `AP-<taskId>` |
| decision | `approved` | 三态裁决 |
| evidence_snapshot | `{"intent":"修复 登录 token 校验失败…", "buildPassed":true, "testsPassed":true, …}` | 五要素证据快照，裁决可复现 |
| matched_rules | `{"deny":[],"allowUnmet":[]}` | 无禁止项命中，allow 全满足 |
| reason | `全部 allow 规则满足且验证证据完整` | 裁决理由 |
| decided_by | `system` | 自动裁决（复合主键 (id, decided_by)，人工回调可追加行） |

### audit_logs（1 行，append-only）

| 字段 | 值 | 意义 |
|---|---|---|
| actor / action | `system` / `adjudicate` | 审批裁决留痕 |
| object_type / object_id | `approval` / `AP-t-omlx` | 对象坐标 |
| result / detail | `approved` / `{"taskId":"t-omlx","reasons":["全部 allow 规则满足且验证证据完整"]}` | 结果与依据 |

### RAG 分区 `repo/vulcan-svc-auth`（fake server 内存态，真部署在 MODULAR-RAG-MCP-SERVER）

```json
{
  "id": "m_3fb9c8e07f813885666b79c4b492718c",
  "kind": "verified_fix",
  "text": "任务 t-omlx（omlx-e2e）的修复通过自动审批：全部 allow 规则满足且验证证据完整",
  "status": "active", "stale_status": "",
  "scope": "repo", "key": "vulcan-svc-auth",
  "verification_status": "verified_by_test",   ← 证据强度 3，冲突裁定时的强者
  "created_at": "2026-10-01T17:41:41.758Z"
}
```

链路：`distillFromTask`（done + approved → verified_fix 候选）→ `MemoryGate.check`（放行）→ `RagMemoryBridge.store`（分区注入 + memory_store）→ 分区落库。下次同项目任务 `recall()` 即可召回这条修复经验。

## 六、已知边界与后续

1. **api_key 环境变量缺失会 fail-fast**（"Provider is not configured: omlx"），符合预期。
2. **run_tests 仍是占位**（脚本内替换为确定性通过 + shell 拒绝）。生产接真实测试执行器（沙箱/超时策略）是独立插件，按 cordis 卖点替换即可。
3. **Qwen3.6 的 reasoning_content** 会被 pi-ai 适配层解析为 thinking content，不计入正文；本地推理速度下思考 token 占输出大头（首轮 14+192），预算判定只算 usage 总量，不受影响。
4. **typecheck 基线**：仓库本来就有 17 个既有 TS 错误（agent/index.ts、gvfs.ts、recovery.ts 等，2026-09-30 前遗留）；本次新增文件 0 错误。
5. entry.ts 生产装配仍是 builtinModels 路径；oMLX provider 要上生产，把 `assembleOmlxPipeline()` 接进 `lazyPipelineAssembly` 的分支即可（一行判断），待你确认再动。

## 七、Langfuse 接入后的干净复跑（2026-10-02 16:04）

前置：oMLX 重启恢复；删除 `data/e2e-omlx.db` 重建；Langfuse vulcan 项目 8 条调试期旧 trace 全部 DELETE 归零。

环境变量：`OMLX_API_KEY/OMLX_BASE_URL/OMLX_MODEL_ID` + `VULCAN_LANGFUSE_PUBLIC_KEY/VULCAN_LANGFUSE_SECRET_KEY/VULCAN_LANGFUSE_BASE_URL`（key 见 Obsidian《Langfuse 本地实例账号与密钥》）。

结果：**outcome=pr_created，审批 approved，全程 57.0s，exit=0**。

Langfuse trace `trace-e2e-omlx-1790928191652`（vulcan 项目，name=vulcan.task）span 时间线：

| span | stop_reason | tokens | 耗时 |
| --- | --- | --- | --- |
| gen_ai.turn #1（分析+发起 read_file） | toolUse | 1118 | 25.6s |
| tool.read_file | - | - | ~0ms |
| gen_ai.turn #2（分析+发起 write_file） | toolUse | 1243 | 9.4s |
| tool.write_file | - | - | ~0ms |
| gen_ai.turn #3（分析+发起 run_tests） | toolUse | 1032 | 2.9s |
| tool.run_tests | - | - | 3ms |
| gen_ai.turn #4（总结收尾） | stop | 1164 | <1ms |
| vulcan.trace.end（turns=4） | - | - | - |

四轮 ReAct（复现→定位→修改→测试）+ 一次收尾全部在 trace 里，无 error 轮次。UI 查看：http://localhost:3000 → vulcan 项目 → Traces。

本轮落库：tasks(t-omlx=done) / webhook_events(1,done) / sessions(1,3条toolResult) / approvals(1,approved) / audit_logs(1,adjudicate) / RAG verified_fix ×1。

### 本轮附带修复（相对 2026-10-01 版报告）

1. **LangfuseSink 半成品修复**（trace.ts）：原先只触发 SDK 加载、从不调 SDK；补齐 createTrace/addSpan/endTrace 真实上报 + `flush()` 出口。
2. **trace 链路接线**：FixRunInput 新增 onEvent（fix-pipeline.ts）；entry.ts 消费循环删除 `void onEvent`，经事件对象透传 → Harness → FixPipeline → adapter → sink。
3. **OMLX_BASE_URL 归一化**（omlx-model.ts）：pi-ai 在 baseUrl 后直拼 /chat/completions，缺 `/v1` 会 404；现裸 host 自动补 `/v1`。
4. **turn 错误可见性**：模型轮次失败时 errorMessage 进 span 属性 `vulcan.turn.error`（如 "404 status code (no body)" / "Connection error."），排障不用再翻进程日志。
5. 新增 `scripts/probe-omlx-loop.ts`：绕过 vulcan 直接用 pi-ai 探针 oMLX 工具调用，快速区分「服务问题 vs 装配问题」（本轮 404/Connection error 均靠它定位）。

### 新增已知边界

6. oMLX 后端进程不稳定时（upstream refused / 404 / Connection error），vulcan 侧表现为 `stop_reason=error`、无补丁产出；属环境问题，探针脚本可先行定位。

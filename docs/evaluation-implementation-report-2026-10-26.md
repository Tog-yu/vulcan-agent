# Vulcan 评估体系落地验收报告

> 日期：2026-10-26  
> 仓库：`/Users/tog/Desktop/project/vulcan-agent`  
> 设计依据：`Vulcan 全链路评估体系设计方案.md`（Obsidian）  
> 本报告回答：**评估方案是否已经落成可运行代码、经过多轮验证、能正确区分好坏与越权结果，以及还缺什么。**

---

## 一、结论

**结论：评估内核已完成落地并通过资格验证；真实 Vulcan 模型能力评估尚未接入，不能把本报告的数字当作线上修复效果。**

本轮完成的是一条可运行、可回归的评估闭环：

```text
JSONL 数据集 / 契约校验
→ 多系统 × 多任务 × 多轮编排
→ O/A/S 三轴判分
→ 安全红线 / 稳定性 / 分片 / 成本聚合
→ Markdown + JSON 报告
```

验收结果：

| 验收项 | 结果 |
| --- | --- |
| 新增评估测试 | **23/23 通过** |
| 全仓回归测试 | **214/214 通过**（27 个测试文件） |
| 新增文件 Biome 检查 | **0 error / 0 warning** |
| fixture 资格评估 | **5 类系统 × 8 个 case × 3 次 = 120 次运行** |
| 连续两轮评估指标一致性 | **完全一致** |
| golden 夹具 | **24/24 自动交付，0 安全违规，Pass^k=100%** |
| unsafe 夹具 | **24/24 触发安全红线，自动交付 0** |
| 评估器假阴性/假阳性检查 | **通过**（overclaim / unsafe / manual / flaky 均被正确区分） |

**方案实现边界：** 当前实现的是评估内核和夹具资格验证；`ObservedRun.checks` 由未来真实适配器提供。真实 FixPipeline 的仓库准备、F2P/P2P 命令执行、LLM Judge 校准、CI gate 与线上回灌尚未接入，报告中已显式标注。

---

## 二、交付物清单

| 文件 | 作用 |
| --- | --- |
| `src/server/evaluation/types.ts` | 数据集、处置动作、O/A/S 判定、运行观测、失败标签契约 |
| `src/server/evaluation/dataset.ts` | JSONL 加载、契约校验、数据集 hash |
| `src/server/evaluation/evaluator.ts` | 单次运行的确定性判分与最早分叉点归因 |
| `src/server/evaluation/metrics.ts` | Avg@k / Pass@k / Pass^k、Wilson CI、切片、成本、失败分布 |
| `src/server/evaluation/runner.ts` | system × case × repeat 编排、manifest、异常隔离 |
| `src/server/evaluation/report.ts` | 无综合总分的安全报告渲染 |
| `src/server/evaluation/fixture-system.ts` | golden / overclaim / unsafe / manual / flaky 契约夹具 |
| `src/server/evaluation/index.ts` | 模块导出 |
| `scripts/eval.ts` | 资格验证 CLI、Markdown/JSON 产物 |
| `test/evaluation.test.ts` | 23 项数据集、判分、稳定性、编排、报告测试 |
| `eval/datasets/harness-smoke.jsonl` | 8 类任务形态的 smoke 数据集 |
| `eval/README.md` | 运行方式、实现范围、真实系统接入契约 |
| `docs/evaluation-report-2026-10-26.md` | 本轮自动生成的评估报告 |
| `docs/evaluation-report-2026-10-26.json` | 可复核的原始结果与 manifest |
| `package.json` | 新增 `npm run eval:harness` |

---

## 三、设计到代码的映射

| 设计方案要求 | 当前实现 | 状态 |
| --- | --- | --- |
| 结果 O / 自主 A / 安全 S 三轴分离 | `evaluator.ts` 分别计算，`verifiedDelivery = O && A && S` | 已实现 |
| 不输出综合总分 | 报告只给分轴指标，安全红线独立 BLOCK | 已实现 |
| 策略外任务正确停手也算成功 | 通过 `allowedDispositions` 支持 `SUPPRESS / REJECT_FORBIDDEN / PLAN_AND_HANDOFF` | 已实现 |
| 人工接管与预期交接区分 | `HumanIntervention.kind = substantive / expected_handoff / clarification` | 已实现 |
| 构建、F2P、P2P 等确定性证据 | `ExpectedCheck.kind = command/file/trace/rubric/manual` + `ObservedRun.checks` | 契约已实现，执行器待接 |
| 失败最早阶段 + 多标签归因 | `attribution.stage / tags / evidence` | 已实现 |
| Avg@k / Pass@k / Pass^k | `metrics.ts` 按任务聚合，未满 k 不进入 Pass^k 分母 | 已实现 |
| 分片报告 | family / difficulty / alertType / dataset / tag | 已实现 |
| 成本按全部运行计算 | `costPerDeliveryUsd = 总成本 / 成功数` | 已实现 |
| 安全红线不可被总分抵消 | 安全违规单独统计并 BLOCK | 已实现 |
| 数据集版本与可追溯 | `manifest` 冻结 dataset hash、版本、系统版本、重复计划 | 已实现 |
| fixture 不得冒充真实能力 | `evidenceLevel` 强制写入 manifest 和报告 | 已实现 |
| 真实 FixPipeline / oMLX 适配 | 未接；当前只有接口与夹具 | **未实现** |
| LLM Judge 校准、人工复核流程 | 未接 | **未实现** |
| CI / Release Gate 自动阻断 | 报告已具备 gate 字段，尚未挂流水线 | **未实现** |
| 线上事件流与 badcase 回灌 | 未接 | **未实现** |

---

## 四、多轮测试过程与问题闭环

### 第 0 轮：改动前基线

```text
27? 否，改动前为 26 个测试文件
191/191 tests passed
```

确认改动前仓库测试全绿，避免把既有失败算到本次实现。

### 第 1 轮：新增测试首次运行

```text
test/evaluation.test.ts
21 passed / 1 failed
```

**问题 1：测试期望写错。**

- 现象：flaky 系统声明为 3 次中“通过-失败-通过”，但测试期望自动交付率是 `1/3`。
- 根因：断言把偶发失败次数当成失败运行数，实际应为 `2/3`。
- 修复：将断言改为 `2/3`，并把测试意图改成“至少成功一次 ≠ 稳定成功”。
- 回归：下一轮 22/22 通过。

### 第 2 轮：CLI 第一次资格评估

```text
fixture-golden: 21/24，安全违规 3，Pass^k 87.5%
```

**问题 2（高优先级）：golden 夹具自身越界，导致评估器出现假失败。**

- 现象：本应全绿的 golden 在“噪声告警”任务上被安全红线拦截 3 次。
- 根因：夹具对所有 case 统一使用 `read_code/edit_workspace/run_tests`，但噪声任务只允许 `read_alert/suppress`，评估器正确识别了动作越界。
- 影响：如果不修复，会把“夹具不规范”误判成“系统能力不足”，破坏整个基准的可信度。
- 修复：
  1. 夹具动作改为严格从 `evalCase.input.allowedActions` 取；
  2. 新增“golden 在完整 smoke 数据集上必须 100% 通过、安全违规为 0”的集成回归。
- 回归：golden 从 21/24 提升到 24/24，安全违规从 3 降到 0，Pass^k 从 87.5% 提升到 100%。

### 第 3 轮：修复后资格评估

```text
fixture-golden:   24/24 自动交付，0 安全违规，Pass^k 100%
fixture-overclaim: 0/24 自动交付，假完成 100%
fixture-unsafe:   0/24 自动交付，24 次安全违规
fixture-manual:   0/24 自动交付，100% 人工接管任务
fixture-flaky:    16/24 自动交付，Pass@k 100%，Pass^k 0%
```

**结论：五种行为全部被正确区分，说明评估器不是“只要结果对就放行”。**

### 第 4 轮：最终回归与稳定性复核

- `test/evaluation.test.ts`：**23/23 通过**
- 全量 vitest：**214/214 通过，27 个测试文件**
- 新增文件 Biome：**0 error / 0 warning**
- 第二次 CLI 评估与第一次运行指标逐项一致：
  - golden 24/24
  - overclaim 0/24
  - unsafe 0/24 + 24 次安全违规
  - manual 0/24
  - flaky 16/24

---

## 五、关键评估结果

> 以下均为 **fixture 资格验证结果**，用于证明评估器能区分不同行为，不代表 Vulcan 真实模型能力。

| 系统 | 运行数 | 自动交付 | 结果正确 O | 自主 A | 安全 S | Pass@k | Pass^k | 假完成率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fixture-golden | 24 | **100%** | 100% | 100% | 100% | 100% | **100%** | 0% |
| fixture-overclaim | 24 | 0% | 0% | 100% | 100% | 0% | 0% | **100%** |
| fixture-unsafe | 24 | 0% | 100% | 100% | **0%** | 0% | 0% | 0% |
| fixture-manual | 24 | 0% | 100% | **0%** | 100% | 0% | 0% | 0% |
| fixture-flaky | 24 | 66.7% | 66.7% | 100% | 100% | **100%** | **0%** | 33.3% |

### 结果说明

1. **golden 全绿**：说明正常路径不会因为判分器自身逻辑产生假失败。
2. **overclaim 假完成 100%**：证明“模型自报完成”不能替代 F2P/P2P 证据，且不会进入自动交付。
3. **unsafe 结果正确但 S=0**：证明安全轴独立，结果正确不能抵消越权事故。
4. **manual 结果正确但 A=0**：证明人工实质接管不被算成自主交付。
5. **flaky Pass@k=100% 但 Pass^k=0%**：证明“至少成功一次”会掩盖不稳定，多次重复是必需的。

---

## 六、实现过程中额外修正的边界

| 边界 | 原风险 | 处理 |
| --- | --- | --- |
| 基础设施异常与安全违规 | 若把 error 直接计入 S 轴，构建机抖动会被误报成越权事故 | S 轴只由危险动作、未授权访问、审计完整性决定；infra error 单独统计 |
| 适配器返回错误 case/system/repeat 坐标 | 结果可能被静默挂到错误任务上 | Runner 覆盖身份坐标并标记错误，禁止静默接受 |
| 同 ID 证据重复回填 | 两份冲突证据无法唯一判分 | 同 ID 重复证据按 `error` 处理，阻止自动交付 |
| 未达到协议 k 的稳定性 | 用少量重复冒充实测 Pass^k | `observedK < expectedK` 时 `passHatK = null`，不进入 Pass^k 分母 |
| 安全与结果被总分抵消 | 高分掩盖越权 | 报告不输出综合总分，安全红线独立 BLOCK |
| fixture 冒充真实能力 | 用夹具数字对外宣称模型能力 | manifest 冻结 `evidenceLevel`，报告首屏标注“不是真实能力评估” |

---

## 七、评估结果自身可信度

本轮不仅看“评估跑出了什么”，还验证“评估器会不会误判”：

- **正控制**：golden 必须全绿（已通过 24/24）。
- **负控制**：overclaim 必须判失败（0/24 自动交付）。
- **安全控制**：unsafe 即使证据全过也必须 BLOCK（24/24）。
- **自主性控制**：manual 结果正确但不得算自动交付（0/24）。
- **稳定性控制**：flaky 必须表现为 Pass@k 高、Pass^k 低（100% vs 0%）。
- **可重复性**：连续两次运行 5 类系统的核心指标完全一致。
- **异常隔离**：单个系统抛异常不会终止整批，错误按要求进入失败归因。

因此当前评估内核可以进入下一阶段：接真实系统适配器，而不是继续在夹具上调指标。

---

## 八、残余风险与限制

### P0：尚未接真实 Vulcan 执行链

`ObservedRun` 目前由夹具产生。真实适配器必须完成：

- 为每个 case 创建隔离 workspace 与 `base_commit`；
- 调 FixPipeline，采集真实 disposition、tools、审批与人工事件；
- 真正执行 build / F2P / P2P，而不是让模型填写 `checks`；
- 采集真实 token、费用、耗时、GVFS 下载量与索引版本；
- 对接长期记忆清理与泄漏扫描。

**在完成这一步之前，不得把本报告的数字写成“Vulcan 修复成功率 100%”。**

### P1：样本量与统计功效不足

当前每条 case 只有 3 次重复、8 个 case，Wilson 区间很宽，只能证明契约有效，不能支撑对外效果结论。真实评估需要按业务分布扩大样本，并用 pilot 决定 k 与最小可检测效果。

### P1：LLM Judge 尚未校准

`rubric` 类型的证据目前由适配器提供；没有人工金标准、Kappa 或偏差测试，不应把开放语义判断接入发布 gate。

### P2：CI / Release Gate 未接线

报告已包含 BLOCK/PASS 字段和分轴指标，但尚未在 CI 中阻断发布。需要增加：

- PR smoke：数据集校验 + 安全红线 + 关键 case；
- Nightly：组件 + 端到端 dev 集；
- Release Candidate：冻结 test、多次重复、人工复核不确定样本。

### P2：既有类型检查债务

全仓 `npm run typecheck` 仍有 15 个既有错误（`agent/index.ts`、`gvfs.ts`、部分旧测试），均不在本次新增文件中；新增评估模块无新增类型错误。不能把“全仓类型检查未全绿”说成评估模块的问题，也不能忽略这笔债。

---

## 九、下一步优先级

1. **P0 — 真实 FixPipeline 适配器**：先跑通 1 个 code_fix case × 3 次，确认 `ObservedRun.checks` 来自真实构建与测试。
2. **P0 — 真实 F2P/P2P 执行器**：禁止模型自报测试通过；所有交付证据必须来自沙箱命令与终态校验。
3. **P1 — 数据集扩容**：按真实告警类型分布建 dev / validation / test，按根因分组去重并做泄漏扫描。
4. **P1 — Judge 校准**：构造人工金标准，报一致性、偏差和重复判分稳定性。
5. **P1 — CI 门禁**：把安全 BLOCK 和一票否决先接上，再谈质量阈值。
6. **P2 — 线上事件流与 badcase 回灌**：建立从故障到永久回归用例的闭环。

---

## 十、复现命令

```bash
cd /Users/tog/Desktop/project/vulcan-agent

# 新增评估测试
npm test -- test/evaluation.test.ts

# 全量回归
npm test

# 生成资格验证报告
npm run eval:harness

# 仅检查新增文件规范
./node_modules/.bin/biome check src/server/evaluation test/evaluation.test.ts scripts/eval.ts
```

---

## 十一、最终判断

- **评估方案的设计骨架已经落地为可运行代码，不是纸面方案。**
- **评估器已通过正负控制，能正确拒绝假完成、越权和人工代做。**
- **本轮数字的用途是资格验证，不是 Vulcan 效果宣传。**
- **下一阶段的真正门槛不在继续增加夹具，而在接真实执行链、真实测试证据和足够样本。**

在真实适配器完成前，Vulcan 的对外能力结论应保持为：**评估基础设施已就绪，真实能力待实测。**

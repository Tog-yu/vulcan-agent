# Vulcan 评估体系

对应设计：Obsidian `AI 学习/20-Agent 架构与开发/27-Vulcan agent/Vulcan 全链路评估体系设计方案.md`。

## 当前实现范围

- JSONL 数据集加载与契约校验（重复 case、非法动作、重复证据、配置冲突）。
- O/A/S 三轴判分：结果正确性、自主性、安全策略；自动交付 = 三者同时成立。
- 三轴之外的稳定性：Avg@k、Pass@k、Pass^k。
- 运行级 Wilson 95% 置信区间、分片、失败最早阶段与多标签归因。
- 多系统实验编排、manifest 冻结、异常隔离。
- Markdown / JSON 报告；安全红线 BLOCK 不参与总分抵消。
- fixture 资格验证：验证判分器能区分 golden / overclaim / unsafe / manual / flaky。

## 当前明确未实现

- 真实 FixPipeline / oMLX 适配器（需按 case 构建 repo、base_commit、沙箱测试命令）。
- LLM Judge 校准与语义 rubric 自动判分。
- F2P/P2P 命令执行器；当前 `ObservedRun.checks` 由未来适配器提供。
- 线上任务事件流、灰度、badcase 自动回灌。

因此 `npm run eval:harness` 生成的是**评估体系资格验证报告**，不是 Vulcan 修复能力报告。

## 命令

```bash
# 单元/集成测试
npm test -- test/evaluation.test.ts

# 全量回归
npm test

# fixture 资格验证，默认 5 个行为 × 8 个 case × 每案 3 次
npm run eval:harness

# 指定次数与输出
node --experimental-strip-types scripts/eval.ts \
  --dataset eval/datasets/harness-smoke.jsonl \
  --repeats 3 \
  --out docs/evaluation-report.md \
  --json docs/evaluation-report.json
```

## 接入真实系统

实现 `EvaluationSystem` 即可：

```ts
interface EvaluationSystem {
  id: string;
  version: string;
  evidenceLevel: "real" | "fixture" | "simulated";
  run(evalCase: EvalCase, ctx: { repeatIndex: number; signal?: AbortSignal }): Promise<ObservedRun>;
}
```

适配器负责准备隔离工作区、调用 FixPipeline、执行构建/F2P/P2P，并把真实结果填入
`ObservedRun.checks`。**不得让被测模型直接填写 `checks` 的通过状态。**

新系统必须使用 `evidenceLevel: "real"` 才能在报告中宣称真实能力；
fixture/simulated 结果只用于评估链路资格验证。

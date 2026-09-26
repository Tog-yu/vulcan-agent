# Vulcan Agent

面向企业研发场景的 AI 研发平台 —— 复用成熟 Agent 能力，补齐企业上下文、交付闭环和可解释评审，让 AI 从「能改代码」走向「能交付可审核的修复」。

> 技术方案见 Obsidian：`法币 agent/技术方案 - Vulcan agent.md`

## 核心能力

| 能力 | 触发来源 | 闭环 |
| --- | --- | --- |
| 代码问答 | 开发者提问 | 理解项目、定位逻辑 |
| Bug 修复 | meegle 工单（Webhook）、告警（Webhook） | 任务整理 → 定位 → 修改 → 测试 → 人工审核 → 受控创建 PR |
| 辅助评审 | 修复任务产出物 | 变更意图 + 关键 diff + 影响范围 + 验证证据 → 帮助人理解和验收 |

三条自动化链路：**告警处理**（Webhook 接收 → 去重分级 → 关联工单）、**工单处理**（meegle Webhook 收增量 + Open API 补能力/回写）、**审批处理**（Webhook 收请求 → 自动裁决 通过/驳回/转人工 → 转人工时通知责任人）。

设计核心：**确定的流程交给程序，需要探索的步骤交给 Agent，不确定的决策交给人。**

## 架构分层

```
Webhook 事件接入层（gateway/）        ← 统一入口 /webhook/:source，签名校验、幂等、归一化
        │
Harness 任务编排层（harness/）        ← 校验、权限、路由、任务状态管理、审批裁决
        │
Cordis 插件化执行层（cordis/）        ← 插件注册 / 依赖注入 / 生命周期
   ├─ AgentLoop（默认 Pi，agent/）   ← ReAct 式循环，模型不直接操作工作区
   ├─ 检索插件（普通项目本地检索 / 大仓库接企业检索）
   └─ 工具执行插件（读取 / 修改 / 测试）
        │
支撑模块：session/（会话） · memory/（长期记忆） · approval/（审批） · notify/（通知） · meegle/（工单）
```

## 技术栈

- **后端**：Node.js + TypeScript（ESM，`--experimental-strip-types` 直跑 ts）
- **Agent 底座**：Pi Agent Runtime（`@earendil-works/pi-*`），ReAct 式循环
- **前端**：React + TypeScript（`web/`，暂未搭建）
- **外部通道**：Webhook（告警 / meegle / 审批）+ meegle Open API（详情回查、状态回写、对账兜底）
- **质量**：Biome + vitest + tsgo

## 快速开始

```bash
npm install
npm run dev        # 启动 HTTP 网关（默认 127.0.0.1，仅 loopback）
npm run typecheck
npm run test
```

## 目录

```
src/server/
  cli/          入口
  config/       配置加载
  gateway/      Webhook 统一接入（server / verify / dedupe / normalize / queue）
  harness/      任务编排（状态机、路由、权限）
  approval/     审批裁决（策略、三态、转人工）
  meegle/       meegle 工单（webhook 适配 + Open API client）
  alerthandler/ 告警处理（去重降噪、分级、关联工单）
  cordis/       插件化执行层（registry / lifecycle / plugins）
  agent/        AgentLoop（默认 Pi）
  session/      会话管理
  memory/       长期记忆（写入筛选 / 按权限相关性召回）
  notify/       通知（飞书卡片 @ 责任人、升级）
web/            React 前端（待搭建）
config/         运行配置
docs/           设计文档
```

## 状态

框架阶段：模块边界与接口占位已就位，各模块为骨架实现（类型 + 空实现），按技术方案逐章填充。

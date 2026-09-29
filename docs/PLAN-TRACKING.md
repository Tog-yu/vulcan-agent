# Vulcan Agent 技术方案落位索引

技术方案全文在 Obsidian：`法币 agent/技术方案 - Vulcan agent.md`。
本文件记录方案章节 ↔ 代码模块的对应关系与实现状态。

| 方案章节 | 模块 | 状态 |
| --- | --- | --- |
| 一、概述 | —（总体叙事） | — |
| 二、架构图 | `src/server/` 分层 | ✅ 骨架 |
| 四、Cordis 插件化执行层 | `src/server/cordis/`（插件契约 + 注册表）、`src/server/agent/`（AgentLoop 接口，Pi 装配待接） | ✅ 契约 / ⏳ Pi 接入 |
| 五、会话管理 | `src/server/session/`（内存实现） | ⏳ 持久化（SQLite，append-only event store） |
| 六、记忆写入与召回 | `src/server/memory/`（内存实现 + verified 门禁） | ⏳ 对接 MODULAR-RAG-MCP-SERVER |
| 七、Webhook 事件接入 | `src/server/gateway/`（server / normalize / queue） | ✅ 骨架（HMAC + 幂等 + 归一化已实现） |
| 7.1 告警接收 | `src/server/alerthandler/` | ✅ 去重/分级/白名单骨架 |
| 7.2 meegle 工单 | `src/server/meegle/`（Open API client 骨架） | ⏳ 事件类型清单 / 签名方式待与企版管理员确认 |
| 八、审批流程 | `src/server/approval/`（三态裁决 + DEFAULT_POLICY） | ✅ 策略骨架 / ⏳ 策略阈值待定 |
| 8.3 转人工通知 | `src/server/notify/`（飞书文本 webhook） | ⏳ 卡片消息 / 升级阶梯 |
| 8.4 留痕与审计 | — | ⬜ 未开始 |
| 前端 React | `web/` | ⬜ 未开始 |

## DEV_SPEC P1 阶段完成记录（2026-09-29）

P1 基座 8 任务全部完成（docs/DEV_SPEC.md 任务清单为准，48 测试全绿）：

| 任务 | 产物 | 说明 |
| --- | --- | --- |
| P1-1 | `src/server/config/` | fail-fast 校验（loopback/密钥/端口 0-65535） |
| P1-2 | `src/server/db/migrate.ts` | 自研 mini runner + node:sqlite；append-only 触发器（audit_logs/task_events） |
| P1-3/4/5 | `src/server/gateway/`（index/verify/normalize/errors） | HMAC、幂等入库、三来源归一化、413/401/403/422 |
| P1-6 | `src/server/gateway/queue.ts` | 重试退避→死信；崩溃恢复（processing 重置重放，at-least-once） |
| P1-7 | `src/server/harness/`（state-machine/index） | 确定性流转表 + DB 前置条件 UPDATE；非法流转拒绝+告警 |
| P1-8 | `src/server/cli/entry.ts` | 装配全链路；SIGTERM 优雅退出实测 exit 0 |

拍板记录（2026-09-28）：SQLite 驱动 = node:sqlite 内置；迁移 = 自研 mini runner（无 ORM）。
npm 10.9.7 arborist 崩溃（vitest 4.1.9 解析）→ `npm install --legacy-peer-deps` 绕过。
待核更新：迁移工具/SQLite 驱动两项已落，其余待核项不变。

## 硬约束（从方案带下来的）

1. 网关仅 loopback bind；对外须经 reverse proxy，不做内建 TLS。
2. 密钥只走环境变量；query string 传 token 一律拒绝。
3. 命中审批禁止项 → 直接驳回，不降级为人工。
4. 未验证的记忆不入库。
5. Cordis 本身不做模型推理；主模型不直接操作工作区。

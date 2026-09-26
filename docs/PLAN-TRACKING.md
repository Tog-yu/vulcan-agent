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

## 硬约束（从方案带下来的）

1. 网关仅 loopback bind；对外须经 reverse proxy，不做内建 TLS。
2. 密钥只走环境变量；query string 传 token 一律拒绝。
3. 命中审批禁止项 → 直接驳回，不降级为人工。
4. 未验证的记忆不入库。
5. Cordis 本身不做模型推理；主模型不直接操作工作区。

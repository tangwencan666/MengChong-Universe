# P8 DeepSeek 接入说明

工作目录：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot。保持现有 consumer-desktop-pivot 分支和未提交 P6/P7 成果，不修改 main。本轮不新增数据库迁移。

## 模式与模型

默认仍为 `WEIBIYE_LLM_PROVIDER=mock`、`WEIBIYE_REAL_LLM_ENABLED=false`。用户另行确认 P8 的 DeepSeek 默认型号为 `deepseek-flash`；不会自动回退到其他型号。官方已宣布旧 `deepseek-chat` / `deepseek-reasoner` 于 2026-07-24 退役，当前型号以 [官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/) 为准，[退役公告](https://api-docs.deepseek.com/news/news260424/) 可追溯。

后端使用已安装的 OpenAI SDK 调用 [DeepSeek 官方兼容接口](https://api-docs.deepseek.com/api/create-chat-completion/)。固定官方 HTTPS 主机，允许根路径或 `/v1`；拒绝任意代理主机、URL 凭据、查询参数、HTTP、重定向及环境代理。关闭 SDK 自动重试，显式关闭 thinking。当前只允许 `deepseek-flash` 和 `deepseek-v4-pro`，低成本验收只选择 flash。

以下均为后端环境配置，**不写入前端 VITE 变量**，也不保存密钥到代码、报告、Git 或 `.env`：

| 变量 | 默认 / 限制 |
| --- | --- |
| WEIBIYE_LLM_PROVIDER | mock；显式选择 deepseek 才使用新适配器 |
| WEIBIYE_REAL_LLM_ENABLED | false；真实适配器需要 true 和后端密钥 |
| WEIBIYE_DEEPSEEK_API_KEY | 只从后端当前进程环境读取；SecretStr，配置序列化排除 |
| WEIBIYE_DEEPSEEK_MODEL | deepseek-flash |
| WEIBIYE_DEEPSEEK_BASE_URL | https://api.deepseek.com；仅官方固定主机 |
| WEIBIYE_DEEPSEEK_MAX_TOKENS | 512；允许 1–2048 |
| WEIBIYE_DEEPSEEK_TIMEOUT_SECONDS | 30；大于 0 且不超过 120 秒 |

本轮不会因环境变量存在而自动开启服务器真实模式。CMD 临时变量只对子进程可见；当前 Codex 进程看不到另一个 CMD 的密钥，不尝试读取其他进程或复制凭据。

## 聊天链路与隐私

沿用 Electron 同源本地网关、React 登录状态、HttpOnly Cookie、CSRF、服务端 owner + pet_id 校验及 P3 REST/SSE 协议。模型选择由服务器冻结到生成任务，客户端不能在发送消息时注入 provider/model。

新增认证只读 `GET /api/v1/companion/runtime`，只返回 schema_version、provider、model、mode、billing、memory_injection_enabled 六个公开字段；不返回密钥存在性、内部 URL、连接信息或 Settings。前端在发送前披露模式和费用边界，模式未知时禁发；发送/重新生成前重新确认配置，变化时先更新提示并中止本次动作。历史、取消、GET 重放保持可用。

Mock 不产生模型费用；真实模式提示内容将发送至服务商且可能产生 API 费用。历史消息按其已保存的 provider 标记，不根据新配置重标旧消息。访客演示始终为固定 Mock。

P4 的**真实模型长期记忆注入保持关闭**。记忆仍可管理，本次生成不额外检索或注入记忆。宠物聊天在关闭注入时仍验证 owner、pet、人格快照、授权 epoch 和生成租约；撤销、删除、归档等隐私屏障保留。本次消息、会话历史和宠物人格仍会在明确开启真实模式后发给服务商；历史中可能含用户手动提及或以前回复提及的经历，因此不能承诺所有与记忆相同的内容绝不外发。前端使用精确说明“本次不额外注入长期记忆”。

## 流式、取消与用量

- SDK 文本增量经现有 LangGraph/runner 写入 PostgreSQL 事件日志，再沿 P3 SSE 发给客户端；不新增上游 SSE 字段到共同协议。
- 完成原因只接受 stop/length；不完整 EOF、异常或格式错误不当作成功。
- 包含 choices 的终态 chunk 也可携带用量。公共 usage 保持 input_tokens/output_tokens 两字段；缓存/total 明细仅保留在适配器独立字段，缺失用量为未知。
- 取消或消费者提前结束时关闭响应、HTTP 客户端及 SDK；已发出的上游请求可能计费，不能承诺服务商退款或完全停止计算。
- 断线仅重放原任务 GET；同一幂等键/消息标识不重复生成。另一次明确重新生成才建立新任务，可能产生新费用。
- 超时、认证、余额、限流、连接等错误经过脱敏。聊天 SSE 保持既有安全错误协议，不外传 SDK 原始异常、响应正文或堆栈。SDK/HTTP DEBUG 日志在 DeepSeek 调用上下文中抑制。

## 本地验收边界

`backend/scripts/p8_offline_server.py` 只连接已核验的独立 P6 测试库（0006）和本次 Redis 命名空间。它运行真实 DeepSeek SDK/适配器，但将唯一 HTTP 传输替换为内存 MockTransport，使用明确假密钥和带“离线模拟”的固定回复，**不访问真实模型**。启动前重新校验数据库名、集群、版本、活动任务、Redis 实例与端口配置；所有隔离条件使用运行时检查，Python 优化模式不会移除。

完整验收结果见 [P8_VERIFICATION.md](P8_VERIFICATION.md)。一次经单独确认的真实低成本请求使用 [P8_DEEPSEEK_LIVE_TEST.md](P8_DEEPSEEK_LIVE_TEST.md) 中的受限 CLI，不自动切换整个后台为付费模式，也不访问聊天或记忆。实际扣费只能以 DeepSeek 账单为准。

# P3 AI 聊天 API 契约

状态：**P3 集成验收中；原始并行契约为 `p3-chat/1.0-draft`，本集成分支由协调窗口同步下述兼容性补充。验收结果见 P3_INTEGRATION_REPORT.md。**

集成契约版本为 `p3-chat/1.0-integration.1`，SSE 数据版本仍为 `1`。原始两个功能分支及共同提交 `e62d3864` 的文档不修改。后续改变接口必须先由协调窗口审阅并同步双方，不能自行修改契约。

- 契约版本：`p3-chat/1.0-integration.1`；SSE 数据版本：`1`。
- 检查日期：2026-11-01（Asia/Shanghai）。
- 原始设计仓库：`D:\AIProjects\WeiBiYe`；当前集成修改仅在 `D:\AIProjects\WeiBiYe-worktrees\p3-integration`。
- 检查基线：`codex/p25-auth-recovery`，`37de383539ec73b512cbbd61e6ae7b9e3607109e`。
- 上一提交：`967d68b2de25c48cac98b1f6e8b36bd924646d4b`。
- 前次设计检查开始时工作区干净，只有根工作目录这一个 Worktree；设计交付新增两份 P3 文档。后续环境准备步骤与启动说明见并行计划第 10 节。
- 原始设计轮未连接数据库、运行迁移、操作容器或调用模型，当时 migration head 是 `0003`。当前独立测试库 `0004` 的真实验收另见集成报告；开发库保持 `0003`。P2.5 历史验收见 [P25_AUTH_VERIFICATION.md](P25_AUTH_VERIFICATION.md)。

## 1. 现有能力与本次设计的边界

| 检查对象 | 当前代码事实 | P3 处理方式 |
| --- | --- | --- |
| `backend/app/modules/auth/service.py` | 服务端 Cookie 会话，数据库会话有效性与用户状态校验；写请求校验 CSRF、Origin；Redis 撤销提示 | 复用 `Authenticated/get_principal`，不改变认证协议 |
| `backend/app/core/security.py`、`ownership.py` | owner 条件在服务端；非本人资源统一 404；管理员也无私人资源特权 | 新增聊天写入、任务、事件和推荐同样执行 owner 校验 |
| `modules/companion/models.py` | `AICompanion`、`ChatSession`、`ChatMessage`；跨 owner 复合外键；消息顺序唯一 | 增加持久化生成状态、幂等与事件重放所需结构 |
| `modules/companion/router.py` | 私人会话、消息、伙伴只读；发送消息返回 501 | 本文定义未来正式接口，不将 501 当成已实现 |
| `agent/providers.py` | `ModelProvider.stream(messages, system_prompt)`；固定 `MockLLM`；受服务端配置门控的 `OpenAIProvider` | 保留提供商适配层，默认只使用 Mock |
| `agent/graph.py`、`state.py` | `prepare → respond` 单图；`messages/prompt_version/output/mode`；没有 checkpointer | PostgreSQL 负责历史；LangGraph 只负责一次生成，不增加多智能体系统 |
| `agent/ports.py`、`modules/memory/ports.py` | 有上下文与授权记忆端口，没有真实实现 | P3 实现 owner 范围的聊天上下文；长期记忆端口仍不接入 |
| `agent/sse.py` | 公开、无状态、固定 Mock，事件 `meta/delta/done/error`，`persisted=false`；禁用外部 tracing | 保留原演示契约，另建私人流协议 |
| `frontend/src/features/chat/*` | 内存会话、演示身份、来源消息校验、默认关闭的最近话题；刷新清空 | 接入真实历史的适配器，与访客演示状态隔离 |
| `frontend/src/lib/api.ts`、`sse.ts` | Axios 带 Cookie 与 CSRF；现有 fetch 只服务公开演示流 | 私人命令走现有 Axios；新增带 Cookie 的私人 SSE 读取适配器 |
| `frontend/src/App.tsx` | `scopeVersion` 改变会重建 ChatProvider | 保留此边界，并清理 Query 缓存、请求与晚到事件 |

P3 目标是“真实账户 + 真实聊天存储 + 默认 Mock 生成”。不包含长期记忆摘要/检索、真实模型上线、支付、钱包扣费、复杂多 Agent、工具调用或附件。

**兼容决定：**继续使用 `/api/v1/companion`。现有私人列表由数组改为分页对象，消息 DTO 增加状态；这是一次明确的前后端共同升级。当前仓库没有已发布的客户端兼容承诺；实施时后端与新前端必须配套验收。保留 `/demo/stream` 的路径、请求体及旧事件，不让旧演示解析器消费私人事件。现有伙伴只读接口保留，暂不扩展伙伴 CRUD。

## 2. 统一规则

### 2.1 认证、隐私与输入

1. 下文所有正式接口都要求现有 Cookie 认证。POST/PATCH/DELETE 继续经过现有 CSRF、Origin、Sec-Fetch-Site 校验；不增加 Bearer 登录，不将认证令牌存入 localStorage。
2. owner 只取 `Principal.user_id`。请求体不接受 `owner_id/user_id/role/provider/model/system_prompt`，Pydantic `extra=forbid`。路径中的 UUID、幂等键和游标都不是权限凭证。
3. 无有效身份统一 401 `AUTHENTICATION_REQUIRED`。有效身份访问他人或不存在的会话、消息、任务、事件统一 404 `RESOURCE_NOT_FOUND`，包括管理员。不能先查询全局任务后返回其状态再校验 owner。
4. 每个嵌套查询同时限定 `session_id + owner_id + deleted_at IS NULL`；消息、生成、事件还校验自身与父会话的复合关联。批量查询、后台任务与上下文加载不得绕过这些条件。
5. JSON 字段使用 `snake_case`，前端适配器转换为现有 camelCase。时间为带 `Z` 的 UTC RFC 3339 字符串，UUID 为字符串，精确序号使用非负整数。私人响应 `Cache-Control: no-store`。
6. 文本先统一 CRLF/CR 为 LF，再去掉首尾空白；不改写正文 Unicode。消息 1–4000 个 Unicode 码点，标题 1–120 个；请求体上限 32 KiB。前端字符计数需与后端一致，不能把 JS UTF-16 长度当成同一规则。超限 422，不回显正文。
7. 日志只记请求 ID、操作名、耗时、状态与必要的内部关联 ID；不记消息正文、事件数据、Cookie、CSRF、密钥、完整提供商错误。默认继续禁用外部 LangSmith/tracing。不要读取父目录环境文件。

### 2.2 错误格式

复用现有格式，保持 HTTP 与 SSE 打开前的错误一致：

```json
{
  "error": {
    "code": "GENERATION_IN_PROGRESS",
    "message": "这段会话还有一条回复正在生成。"
  },
  "request_id": "019f1000-0000-4000-8000-000000000001"
}
```

| HTTP | code / 场景 | 客户端处理 |
| --- | --- | --- |
| 401 | `AUTHENTICATION_REQUIRED` | 走现有登录失效流程，清除私人缓存、断开流 |
| 403 | `CSRF_REJECTED` | 提示刷新安全校验；不自动重复发送消息 |
| 404 | `RESOURCE_NOT_FOUND` | 清除该资源本地数据，不暴露其是否属于他人 |
| 409 | `IDEMPOTENCY_CONFLICT`、`DUPLICATE_CLIENT_MESSAGE` | 不创建第二条消息，重新读取本人历史核对 |
| 409 | `GENERATION_IN_PROGRESS`、`VERSION_CONFLICT`、`RETRY_NOT_ALLOWED`、`RESOURCE_DELETED`、`TOPIC_STALE`、`RECENT_TOPIC_DISABLED` | 按原因刷新状态或提示，不自动重发生成 |
| 410 | `EVENT_REPLAY_EXPIRED` | 读取生成快照及消息快照，再从快照游标接流 |
| 422 | `VALIDATION_ERROR`、`INVALID_CURSOR`、`INVALID_EVENT_ID` | 修正请求，不重试 |
| 429 | `RATE_LIMITED`、`CHAT_CAPACITY_LIMIT` | 遵守 `Retry-After`；不得换幂等键绕过限制 |
| 503 | `DATABASE_UNAVAILABLE`、`RATE_LIMIT_UNAVAILABLE`、`CHAT_STORAGE_UNAVAILABLE`、`PROMPT_UNAVAILABLE` | 诚实显示不可用；确认提交结果后再决定重试 |

## 3. REST 接口清单

统一前缀：`/api/v1/companion`。表中路径均相对此前缀。`IK` 表示必填 `Idempotency-Key`；“写”均要求现有 CSRF。

| 方法 | 路径 | 用途 | 成功响应 | 属性 |
| --- | --- | --- | --- | --- |
| POST | `/sessions` | 创建空会话 | 201 `{session, idempotent_replay}` | 写、IK |
| GET | `/sessions` | 侧栏会话分页 | 200 `SessionPage` | 只读 |
| GET | `/sessions/{session_id}` | 会话详情及活跃任务 | 200 `Session` | 只读 |
| PATCH | `/sessions/{session_id}` | 重命名 | 200 `Session` | 写、版本校验 |
| DELETE | `/sessions/{session_id}` | 逻辑删除、请求取消活跃生成 | 204 | 写、可重复 |
| POST | `/sessions/{session_id}/messages` | 保存用户消息并接受一次生成 | 202 `GenerationAccepted` | 写、IK |
| GET | `/sessions/{session_id}/messages` | 消息历史向前分页 | 200 `MessagePage` | 只读 |
| GET | `/sessions/{session_id}/generations/{generation_id}` | 生成与助手消息的一致性快照 | 200 `GenerationSnapshot` | 只读 |
| GET | `/sessions/{session_id}/generations/{generation_id}/events` | 重放/订阅 SSE | 200 `text/event-stream` | 只读，不触发生成 |
| POST | `/sessions/{session_id}/generations/{generation_id}/cancel` | 显式取消 | 活跃 202；已终态/排队时立即取消 200 | 写、可重复 |
| POST | `/sessions/{session_id}/generations` | 对失败/取消的最近一轮显式重试 | 202 `GenerationAccepted` | 写、IK |
| GET | `/preferences` | 当前用户的话题推荐偏好 | 200 `ChatPreferences` | 只读 |
| PATCH | `/preferences` | 开启/关闭话题推荐 | 200 `ChatPreferences` | 写、版本校验 |
| GET | `/recent-topic` | 最多一张可追溯的话题卡 | 200 `{item: RecentConversationSummary \| null}` | 只读 |
| POST | `/sessions/{session_id}/topic-dismissals` | 暂时隐藏指定版本话题 | 204 | 写、可重复 |

本表为 15 个正式接口，其中已有读接口需要升级；不是宣称新增了 15 个已实现接口。`GET /companions`、`GET /companions/{id}` 及公开 `POST /demo/stream` 另行保留。

### 3.1 会话

`POST /sessions` 请求示例：

```json
{"companion_id": null, "title": "新的聊天"}
```

- 两个字段均可省略；标题默认“新的聊天”。提供伙伴 UUID 时必须属于本人，否则 404。
- 未指定伙伴时，在同一事务中延迟创建/取得本用户的默认伙伴，不借用全局或他人的私人伙伴。不更改注册流程。
- 创建空会话不会调用模型。点击侧栏“新建聊天”先清空当前路由；首次实际发送时才创建远端会话，避免空记录堆积。双击发送须复用同一次创建 IK。
- 创建响应有 `Location`；同一 IK/同一规范化请求返回同一会话与 201，`idempotent_replay=true`。后续可变字段以详情为准。该会话已删除则 409 `RESOURCE_DELETED`，不能恢复或另建替身。

`Session` 字段：

| 字段 | 类型 / 含义 |
| --- | --- |
| `id`, `companion_id` | UUID |
| `title` | 标题，不由真实模型自动生成 |
| `created_at`, `updated_at` | UTC 时间 |
| `last_message_at` | 最后一次消息活动时间，空会话为 null |
| `last_activity_at` | 排序时间；创建、接受消息、生成终态时更新；重命名不置顶 |
| `version` | 从 1 开始的会话元数据版本；增量块不逐块修改它 |
| `active_generation` | 活跃 `Generation` 摘要或 null |

`GET /sessions?limit=30&cursor=...`：默认 30，范围 1–100，按 `(last_activity_at DESC, id DESC)` 排序，只返回未删除的本人会话。响应为 `{items: Session[], next_cursor: string|null, has_more: boolean}`。

游标是有版本、长度不超过 1024 的 opaque base64url 数据，绑定当前 owner、排序字段、过滤条件；严格校验类型与资源边界。游标不是认证令牌，也不替代 SQL owner 过滤。活动排序在并发写入时不承诺跨请求的数据库快照：客户端按 ID 去重，发送/完成后刷新第一页，不能用分页结果推断删除。需要严格静态快照时另行升级契约。

`PATCH /sessions/{id}`：`{"title":"面试准备","expected_version":1}`；事务内行锁比较版本，冲突 409，不覆盖其他窗口刚改的标题；成功 version 加一。相同标题且版本匹配可保持版本不变。

`DELETE /sessions/{id}`：设置 `deleted_at`，同事务将活跃生成置为取消请求；排队任务可立即终结。重复删除本人的墓碑返回 204，非本人仍 404。读取、列表、上下文、最近话题和事件均排除墓碑。前端删除成功后移除卡片/消息缓存、断开该流并返回首页。

这是**逻辑删除，不是物理抹除**。现有记忆和使用量表引用会话，不做级联清空、不触碰钱包；彻底删除和保留期限另行设计。已打开的流每次发送前检查墓碑，检测到删除立即关闭；已通过检查进入网络发送的在途帧无法撤回。不承诺跨数据库事务和网络发送的原子撤回。

### 3.2 消息发送、查询与显式重试

`POST /sessions/{id}/messages`：

```json
{
  "client_message_id": "019f1000-0000-4000-8000-000000000011",
  "content": "今天想聊聊面试准备。"
}
```

`client_message_id` 是本次用户输入的 UUID，不是数据库主键或用户身份。客户端在第一次尝试时生成它及独立 IK，网络重试保留二者。202 只表示**用户消息、助手占位、生成任务及 start 事件已经提交**，不表示模型成功或回答完成。

`Message` 字段：`id/session_id/client_message_id/sequence/role/content/status/provider/created_at/completed_at/generation_id/finish_reason`。

- `client_message_id` 仅用户消息有值；用户状态固定 `completed`，`provider=null`。
- 私人响应角色只含 `user|assistant`；服务端 system prompt 不进入公开消息 DTO。
- 助手状态：`queued|streaming|completed|failed|cancelled`；`completed_at` 仅终态有值。
- `generation_id`：助手对应一次生成；用户消息为 null，重试关联由 Generation 的 `user_message_id` 表达。
- 内容一旦接受不支持用户编辑；失败/取消保存已提交的部分，明确标注不完整。

`Generation` 字段：`id/session_id/user_message_id/assistant_message_id/retry_of_generation_id/state/provider/model/prompt_version/created_at/started_at/finished_at/last_event_id/error/finish_reason`。状态见第 5 节；Mock 的 `model=null`；错误只提供安全 code 和 message，不透出 SDK 异常。

集成补充：两个 DTO 的 `finish_reason` 为 `"stop"|"length"|null`。仅对已完成的助手消息/任务，从同用户、同会话的已持久化 completed 事件读取；用户消息、非完成终态和缺少依据的历史记录为 null，不能推测 stop。快照中的两处值必须一致；历史、终态取消响应、幂等重放也使用同一依据。刷新、切换会话、首次读取即已完成及 410 恢复均须保留 length 提示。不新增数据库字段或迁移；未来事件物理清理前必须先保存这部分元数据，不能因重放窗口过期丢失完成原因。

`GenerationAccepted`：`{generation: Generation, user_message: Message, assistant_message: Message, events_url: string, idempotent_replay: boolean}`。只返回本站相对 `events_url`，不能重定向到第三方。幂等重放返回相同 ID，字段可反映任务最新状态；前端按主键更新，不再插入消息。

`GET /sessions/{id}/messages?limit=50&cursor=...`：默认 50，范围 1–100。首次取最新一页；数据库从新到旧取，返回 `items` 按 `sequence ASC` 排列，页面加载更早记录时向前插入。`next_cursor` 编码本页最小 sequence（排他边界）、owner、会话和首次分页的最大 sequence。响应 `{items: Message[], next_cursor: string|null, has_more: boolean}`。后续新增消息不混入旧分页；由发送响应、任务快照及 SSE 合并。空列表为 200，父会话不存在/不属于本人为 404。

`GET /.../generations/{generation_id}` 返回：

```json
{
  "generation": {
    "id": "019f1000-0000-4000-8000-000000000031",
    "session_id": "019f1000-0000-4000-8000-000000000021",
    "user_message_id": "019f1000-0000-4000-8000-000000000041",
    "assistant_message_id": "019f1000-0000-4000-8000-000000000042",
    "retry_of_generation_id": null,
    "state": "running",
    "provider": "mock",
    "model": null,
    "prompt_version": "companion-v1",
    "created_at": "2026-11-01T04:00:00Z",
    "started_at": "2026-11-01T04:00:00Z",
    "finished_at": null,
    "last_event_id": "019f1000-0000-4000-8000-000000000031:2",
    "error": null
  },
  "assistant_message": {
    "id": "019f1000-0000-4000-8000-000000000042",
    "session_id": "019f1000-0000-4000-8000-000000000021",
    "client_message_id": null,
    "sequence": 1,
    "role": "assistant",
    "content": "【Mock 演示】这是本地固定回复。",
    "status": "streaming",
    "provider": "mock",
    "created_at": "2026-11-01T04:00:00Z",
    "completed_at": null,
    "generation_id": "019f1000-0000-4000-8000-000000000031"
  },
  "resume_after_event_id": "019f1000-0000-4000-8000-000000000031:2"
}
```

必须用单条 JOIN 查询或明确的 repeatable-read 事务，从同一个数据库一致性快照读取消息内容与事件高水位；默认 read-committed 下的两次独立 SELECT 不足以保证这一点。不能先读文本、后独立读取更新过的游标，造成丢字。恢复时客户端**替换**该助手消息，并从 `resume_after_event_id` 之后补读。终态快照直接呈现结果，不必重新开流。

`POST /sessions/{id}/generations` 请求：`{"retry_of_generation_id":"原任务 UUID"}`，另带新 IK。只允许失败/取消的任务，且其用户消息仍是会话最后一条用户消息、没有活跃任务、没有成功完成的同一轮替代回答。保留原用户消息与失败记录，新建助手消息和任务；不复制用户消息、不改写旧回答。其他情况 409 `RETRY_NOT_ALLOWED`。P3 不支持对已成功回答的分支重生成或编辑后分叉。

## 4. 幂等、断线与重复提交

### 4.1 幂等范围与持久性

- IK 为 16–120 字符的 ASCII 不透明键，建议 UUID；拒绝控制字符，不承载正文或凭据。
- 创建会话：唯一范围 `(owner_id, create_key)`，存规范化请求 SHA-256。
- 首次发送/重试：唯一范围 `(owner_id, session_id, operation, idempotency_key)`，operation 为 `send|retry`，保存在生成记录。指纹包含规范化请求语义，包括 client_message_id 或 retry_of_generation_id；不包含 Cookie、CSRF 或动态模型配置。
- 同范围同键同指纹返回同一资源；同键不同指纹 409，不能创建第二次模型调用。先校验父资源归属，再查幂等记录。
- 同一用户消息 UUID 使用不同 IK 再发送，返回 409 `DUPLICATE_CLIENT_MESSAGE`；通过消息历史核对，不能静默建立第二轮。
- 键与关联资源保留同生命周期，P3 不通过 TTL 删除幂等依据。软删除不释放创建键。Redis 只是限流/唤醒辅助，数据库唯一约束才是防重复的权威。
- 不承诺跨进程崩溃的“模型恰好调用一次”。不确定是否已调用的 running 任务恢复为失败，不能自动重调模型。

### 4.2 各种重试的区别

| 场景 | 允许动作 | 禁止动作 |
| --- | --- | --- |
| POST 超时，是否提交未知 | 同 IK、同 client_message_id、同内容重试原命令 | 换键或插入第二条用户消息 |
| SSE 断线、切换会话或关闭页面 | GET 原任务事件，携带最后已应用的事件 ID；先取得快照也可 | 重新 POST 触发生成 |
| 页面刷新，内存游标消失 | 从服务端会话/消息/活跃任务恢复，再取一致性快照 | 假定生成完成或恢复演示历史为真实数据 |
| 事件窗口过期 | GET 快照及历史，活跃任务从快照高水位接流 | 把 410 当成重调模型的理由 |
| 生成失败/被取消，用户明确点击重试 | 调用 generations 重试命令，使用新 IK | 自动无限重试或重放旧 SDK 调用 |
| 用户点击停止 | POST cancel；等待服务端状态确认 | 将 AbortController.abort 等同于服务端取消成功 |

GET 事件连接重试采用 1/2/4/8 秒上限 8 秒的退避并加抖动，连续最多 5 次后显示“重新连接”。401/403/404/422 停止自动重连；429 遵守 Retry-After；410 或可重试 connection `STREAM_UNAVAILABLE` 均进入快照恢复，不重复 POST。重连计数只在收到有效事件/心跳后重置，防止失败循环。命令请求仅允许一次受控的网络故障自动重试，必须保留原键；再次不确定交给用户确认，不自动触发新的生成。

## 5. 生成状态与 SSE 协议

### 5.1 状态机

```text
queued → running → completed
   │        ├────→ failed
   │        └────→ cancel_requested → cancelled
   ├─────────────→ cancelled
   └─────────────→ failed（排队超时/不可恢复错误）
```

`completed/failed/cancelled` 为不可逆终态。每次生成最多一个终态事件。完成与取消通过同一行锁/租约版本串行化：完成先提交则取消返回 completed；取消请求先提交则后续输出不能再完成或继续保存，只可取消。cancel_requested 达到租约/取消期限也由监管器终结为 cancelled。

取消接口接受空 JSON 对象 `{}`，返回 `{generation: Generation}`；running 首次请求为 202/cancel_requested，重复仍为 202；已终态返回 200 原状态。queued 可在请求事务内直接写 cancelled，返回 200。取消失败要如实显示，不能先把 UI 标成服务端已停止。P3 不把会话切换、关闭流或退出登录自动解释成任务取消；已接受的任务有服务器总超时，结果仍仅属于原用户。

### 5.2 传输与鉴权

- GET 使用 `credentials: 'include'`、`Accept: text/event-stream`，通过 fetch 流读取；不使用把 Token 放 URL 的方案。命令继续走现有 Axios CSRF 拦截器。
- 可选 `Last-Event-ID: <generation_uuid>:<event_sequence>`，排他重放；没有该头从事件 1 开始。客户端需自行实现重连，不能把 fetch 当成自带 EventSource 重连功能。
- 服务端 CORS `allow_headers` 包含 `Last-Event-ID`，`expose_headers` 包含 `Retry-After` 与 `X-Request-ID`，其他认证规则不变。现有 `Idempotency-Key` 已允许。优先 Vite 同源代理；跨源仍需严格 Origin 白名单和带凭据策略。浏览器必须能读取真实跨源限流响应的 Retry-After。
- 响应 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-store`、`X-Accel-Buffering: no`；不设置不适用于 HTTP/2 的 Connection 必需头。
- 鉴权、归属、限流、游标与重放窗口检查在响应头发出前完成。ID 不属于路径中任务、序号超过当前高水位、格式无效均 422；资源不属于本人先返回 404。
- 事件保留窗口至少为任务终态后 24 小时；活跃任务的事件不得过期。窗口内每个序号连续可重放。过期后流请求返回 410，即使未传 Last-Event-ID 也不能假装从头完整重放；任务/消息快照仍可读取。
- 活跃流每 5 秒发送无 ID 的注释心跳 `: ping`。认证会话到期、撤销、禁用/验证状态改变后，最长一个心跳间隔停止私人输出；每次输出前复用现有 `session_user` 语义复核身份和会话墓碑。数据库/Redis 无法完成校验也停止流，不降级放行。
- 已经打开的连接发生认证失效时使用下述 connection 级 error，然后关闭；不更改认证机制，不给任务伪造失败结论。前端调用现有失效处理，并清空原身份内容。

### 5.3 帧、顺序与类型

事件使用 UTF-8、空行分帧、`id/event/data` 字段。客户端解析器必须处理分块中文、LF/CRLF/CR、多行 data 和注释；网络 chunk 不等于一个事件。单事件限制 64 KiB，接收缓冲限制 128 KiB，超限关闭连接并通过快照恢复。规则参考 [WHATWG SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)；本文定义的业务状态、重放与取消语义属于 WeiBiYe 自己的契约。

持久事件共有字段：`version=1, scope="generation", generation_id, session_id, message_id, sequence, occurred_at`。`message_id` 始终指助手消息；frame.id 必须等于 `generation_id:sequence`，sequence 从 1 连续递增。客户端按 `(generation_id, sequence)` 去重，只在成功应用事件后更新游标。

| event | 额外数据 | 语义 |
| --- | --- | --- |
| `start` | `user_message_id, state="queued", mode="mock"或"real", persisted=true` | 序号 1，在接收事务内提交；表示接受，不表示已有模型输出 |
| `delta` | `text` | 非空增量；先持久化后发出，按序追加 |
| `completed` | `state="completed", content, finish_reason, usage` | 完整权威内容；替换而不是追加，清除输入等待态 |
| `error` | `state="failed", error:{code,message,retryable}, content` | 生成终态失败；content 是已保存部分，不再发送 completed |
| `cancelled` | `state="cancelled", reason, content` | 生成终态取消；content 是已保存部分 |

`usage` 为真实提供商报告的 `{input_tokens, output_tokens}` 或 null；Mock 为 null，不能编造 token 用量。只作生成元数据，不写钱包账本、余额或计费。finish_reason 区分 `stop|length`，长度截断必须可见；未知 SDK 原因映射为安全失败，不强行成功。

以下是**虚构的协议样例**，不是用户历史。一个成功流：

```text
id: 019f1000-0000-4000-8000-000000000031:1
event: start
data: {"version":1,"scope":"generation","generation_id":"019f1000-0000-4000-8000-000000000031","session_id":"019f1000-0000-4000-8000-000000000021","message_id":"019f1000-0000-4000-8000-000000000042","sequence":1,"occurred_at":"2026-11-01T04:00:00Z","user_message_id":"019f1000-0000-4000-8000-000000000041","state":"queued","mode":"mock","persisted":true}

id: 019f1000-0000-4000-8000-000000000031:2
event: delta
data: {"version":1,"scope":"generation","generation_id":"019f1000-0000-4000-8000-000000000031","session_id":"019f1000-0000-4000-8000-000000000021","message_id":"019f1000-0000-4000-8000-000000000042","sequence":2,"occurred_at":"2026-11-01T04:00:01Z","text":"【Mock 演示】这是本地固定回复。"}

id: 019f1000-0000-4000-8000-000000000031:3
event: completed
data: {"version":1,"scope":"generation","generation_id":"019f1000-0000-4000-8000-000000000031","session_id":"019f1000-0000-4000-8000-000000000021","message_id":"019f1000-0000-4000-8000-000000000042","sequence":3,"occurred_at":"2026-11-01T04:00:02Z","state":"completed","content":"【Mock 演示】这是本地固定回复。","finish_reason":"stop","usage":null}

```

若该生成失败，事件 3 是下面的 error，**替代** completed：

```text
id: 019f1000-0000-4000-8000-000000000031:3
event: error
data: {"version":1,"scope":"generation","generation_id":"019f1000-0000-4000-8000-000000000031","session_id":"019f1000-0000-4000-8000-000000000021","message_id":"019f1000-0000-4000-8000-000000000042","sequence":3,"occurred_at":"2026-11-01T04:00:02Z","state":"failed","error":{"code":"GENERATION_TIMEOUT","message":"这次回复暂时中断了。","retryable":true},"content":"【Mock 演示】这是本地固定回复。"}

```

取消分支的事件 3 同样是替代项：

```text
id: 019f1000-0000-4000-8000-000000000031:3
event: cancelled
data: {"version":1,"scope":"generation","generation_id":"019f1000-0000-4000-8000-000000000031","session_id":"019f1000-0000-4000-8000-000000000021","message_id":"019f1000-0000-4000-8000-000000000042","sequence":3,"occurred_at":"2026-11-01T04:00:02Z","state":"cancelled","reason":"user_requested","content":"【Mock 演示】这是本地固定回复。"}

```

**连接级错误是例外：**不写生成事件表、不带 id、不推进游标、不改变任务状态，随后关闭连接。例如已打开流上的认证失效：

```text
event: error
data: {"version":1,"scope":"connection","error":{"code":"AUTHENTICATION_REQUIRED","message":"请重新登录。","retryable":false}}

```

连接级 `STREAM_UNAVAILABLE` 可重新连接；身份失效必须清空缓存；会话删除直接关闭且前端已执行删除清理。未收到生成终态时正常 EOF 也不能标为成功。终态后服务端关闭流；重放已终态任务时补完剩余事件后关闭；客户端已经应用终态就不再重连。

客户端发现序号缺口时停止追加，读取一致性快照并重新接流；未知 version/非法 payload 不能直接渲染。正文以文本或安全渲染显示，禁止把用户/模型字符串作为未经处理的 HTML 注入。

## 6. 持久化时机、并发与运行边界

### 6.1 接受消息的事务 T1

1. 完成现有认证、CSRF、输入验证与命令频率限制。
2. 开启短事务；统一锁序为 User（需要用户额度串行化时）→ ChatSession → ChatGeneration。校验会话归属、未删除。
3. **先检查已有幂等结果**，再检查同会话活跃任务与容量；重试原命令不能因为原任务仍活跃而变成冲突。
4. 在会话行锁下分配两个不可变消息 sequence，写用户消息和空助手消息；分配一次任务，固化 provider/model/prompt_version 和有界 context_message_ids。
5. 写 start 事件 sequence=1、更新会话排序时间/版本，提交。
6. 提交成功后返回 202，再通知进程内监管器；通知丢失由监管器扫描 queued 任务补偿。提交失败没有已接受结果；提交后响应丢失走同 IK 重试，不重复写入。

序号使用 `next_message_sequence` 在行锁内分配；不能无锁 `MAX(sequence)+1`。唯一约束兜底；并发首次发送必须只有一组消息和一个任务。相同文本、不同 client_message_id 是两次用户输入；活跃任务期间第二次不同输入 409，不暗中取消旧任务。

### 6.2 执行与增量事务 T2…Tn

- P3 支持一个 API 应用进程内的受监管异步 runner；没有新微服务、Celery 或外部消息队列。执行不依赖某个浏览器连接的寿命，也不直接把 Provider iterator 接到 StreamingResponse。
- runner 在短事务内领取 queued 任务，写 running、租约和 fencing 版本，再在事务外运行 LangGraph/Provider。模型等待期间不占用长事务或跨任务共享 AsyncSession。SQLAlchemy 也明确要求并发任务使用各自 AsyncSession，见 [官方异步会话说明](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html#using-asyncsession-with-concurrent-tasks)。
- 每次增量以约 50–100 ms 合并（或达到 256 字符）提交；大块再拆分到帧上限。事务内检查 owner 关联、墓碑、cancel_requested 和租约版本，原子追加助手内容、插入 delta 事件、推进 last_event_sequence；**只有提交成功的事件可发送**。
- SSE 读取数据库事件日志，使用 Redis 通知仅作优化；进程内通知或 Redis 丢失不能丢掉已提交事件。任务和 HTTP 读取使用不同短连接/会话。
- 最终事务先处理尚未提交的完整增量，再原子写助手/任务终态、完成时间、完整内容和唯一终态事件，更新会话活动时间。不得先发送 completed 再尝试落库。
- 提供商出错/超时保留已提交部分，写 failed/error。数据库不可用时停止消费 Provider，关闭读取连接；未提交内容不声称保存成功。恢复后由租约回收任务并写可追溯失败终态。
- 取消/删除到达后立即发出协作取消信号并关闭 Provider iterator；之后的迟到增量须因状态/租约检查而丢弃。删除后的任务只能记录内部取消终态，不能继续写新正文或向流发送正文。

### 6.3 崩溃恢复与容量

监管器启动和运行期间扫描 queued、超时与失效租约。排队且尚未领取的任务可领取执行；曾 running 且租约失效的任务标记 `failed/SERVER_RESTARTED`，不自动重新调用 Provider。cancel_requested 失效任务收束为 cancelled。旧执行器即使恢复也因 fencing 版本不能追加事件。优雅关闭优先停止领取、取消执行并提交终态；不保证强制杀进程时未提交 token 能保存。

拟定 P3 开发默认值（实施时在本项目配置，不是本轮已存在的设置）：

| 项目 | 初值 |
| --- | --- |
| 同会话活跃任务 | 1，由部分唯一索引保证 |
| 单用户非终态任务 | 最多 2，由 User 行锁内计数保证 |
| 全进程正在执行任务 | 4，其余有限排队 |
| 全进程非终态任务 | 最多 64；单进程接收锁内校验数据库计数，再提交接受事务 |
| 单用户流连接 | 最多 3，带 TTL 的独立 chat 命名空间计数 |
| 命令限流 | 每用户每分钟 20 次；另设 IP 防刷，重试也受频率限制 |
| 排队最长等待 / 生成总时长 | 60 秒 / 120 秒 |
| Provider 首块等待 | 30 秒，且受总时长限制 |
| 助手输出上限 | 8000 个 Unicode 码点，另受提供商输出 token 预算约束；到限关闭 iterator，以 length 完成 |
| 租约 / 续租 | 15 秒 / 5 秒 |
| 事件重放 | 活跃全量；终态后至少 24 小时 |

生产 Redis 不可用时聊天限流失败关闭，不能修改/关闭现有 auth 限流。测试允许独立进程内计数，明确标记用途。Redis 新键采用 `weibiye:chat:<instance_scope>:...`，不得清理现有 auth/其他项目键。P3 暂不支持同一数据库上的多个独立 API runner 部署；租约不是宣布已经实现分布式调度。

## 7. 多轮上下文、Provider 与 Mock 边界

1. 上下文通过 `ConversationContextStore` 实现从当前 owner 的未删除会话加载。只选择已完成轮次的用户/助手消息，按 sequence 排序；重试只包含其目标用户消息一次。不把失败/取消的助手片段当作完整回答。
2. 初始上下文上限为最近 20 条已完成历史消息，并以完整轮次裁剪到最多 32,000 字符，另加入本次不超过 4000 字的输入；system prompt 单独由服务端 Prompt 管理提供。最终适配器仍需满足模型自己的上下文预算，不能将字符数伪装成精确 token 数。
3. `AgentState` 后续可增加服务端关联的 session/generation/request ID、有界消息与结果状态；用户身份不从提示词推导。取消信号留在运行配置，不把不可序列化句柄或凭据写入图状态/日志。现有 graph.prepare 会覆盖 prompt_version，私人路径必须尊重任务固化的已验证版本，不能因重启自动切换提示词。
4. PostgreSQL 消息和生成记录是权威持久层。P3 不引入 LangGraph checkpointer 或另一个全局会话缓冲，不自动重试图节点中的模型调用。
5. 继续使用 `ModelProvider` 适配接口，按服务端 Settings 建立独立请求流、支持 iterator 关闭、超时和安全错误映射。提供商级自动重试保持关闭；必要的使用量扩展是类型化可空元数据，不能由前端决定。
6. 默认 `WEIBIYE_LLM_PROVIDER=mock`、`WEIBIYE_REAL_LLM_ENABLED=false`。切换真实提供商至少需要现有服务端显式开关、非空模型名及服务端密钥；前端无切换真实提供商的参数。本轮和 P3 默认验收均禁止真实模型调用；开启流程留待另行授权。
7. **现有 Mock 文案说“不会保存会话”，不能原样用于已持久化的私人聊天。**私人 Mock 回复需明确为“固定本地回复、未调用真实模型；消息保存于当前账户，不写长期记忆”。公开演示仍固定旧 Mock、`persisted=false`。实现时可共享分块机制，必须隔离场景文案与元数据。
8. 已登录用户在私人 Mock 模式发送的内容是真实的本人持久化记录；“Mock”描述生成来源，不代表这些输入是虚构历史。访客演示/手动加载的样例仍仅内存，不导入真实账户，不写长期记忆或钱包。
9. 高风险识别、真实模型安全响应和记忆授权处理未因本契约而实现；P3 不宣称 Mock 能识别情绪或提供真实个性化建议。

目前 `AICompanion.prompt_version` 数据库默认值为 `v1`，而 Prompt 注册表键是 `companion-v1`。P3 默认伙伴必须显式写注册表版本；已知旧别名 `v1` 可在服务层明确映射为 `companion-v1` 并固化到 Generation，不能直接传给 get_prompt。未知版本在接受任务前返回 503 `PROMPT_UNAVAILABLE`，不静默换提示词。Mock 上下文测试应检查实际传入的有界消息序列，不以固定回复假装具备真实多轮推理能力。

## 8. 会话历史与首页话题卡

### 8.1 偏好与候选规则

`ChatPreferences`：`{recent_topic_enabled: boolean, version: integer, consented_at: string|null}`。无记录等价于 false/version=0。PATCH 请求 `{recent_topic_enabled: true, expected_version: 0}`，使用版本控制防止另一窗口的旧操作覆盖关闭决定；关闭时 version 增长并立即停止推荐。本人开启偏好可在刷新后从服务端恢复，不能把演示页面的刷新清空规则误用到真实持久化数据。

`GET /recent-topic` 无历史、未授权、最近话题已隐藏时均返回 `{item:null}`；未登录仍为 401。候选仅来自本人未删除会话中最近**成功完成的一轮**，按该轮 finished_at 排序。服务端验证两条来源消息、会话关联和 owner。失败/取消输入、未发送草稿、演示种子或其他用户内容都不能成为候选。

P3 的“摘要”只对来源用户消息作最多 80 字符的可追溯摘录，标记 `source="message-excerpt"`；follow_up_text 使用现有温和句式“如果你愿意，我们可以从上次的这段话接着聊。”，不推断昨天发生了什么、不编造进展、不做情绪判断。P4 才考虑单独授权的长期记忆和模型摘要。

### 8.2 RecentConversationSummary 契约

| JSON 字段 | 前端映射 / 含义 |
| --- | --- |
| `conversation_id` | `conversationId`，原会话 UUID |
| `title` | 原会话标题 |
| `summary` | 已完成一轮的用户消息摘录 |
| `last_message_at` | `lastMessageAt`，该轮完成时间，不伪造为今天 |
| `follow_up_text` | `followUpText`，非强迫的延续邀请 |
| `dismissed` | 推荐响应中为 false；被隐藏的候选不返回 |
| `source` | `message-excerpt`，演示卡在单独演示适配器中为 mock |
| `source_message_ids` | `sourceMessageIds`，该轮用户和已完成助手消息 ID |
| `summary_version` | 会话/用户消息/助手消息 ID 的确定性版本，前端仅当作 opaque 值 |

后端不返回可供客户端指定的 owner；前端根据当前认证身份构建 `ownerScopeId`，不可使用 preview-a/preview-b 代替权限。`ConversationHistoryPort` 接入时将原 `getRecentTopics()` 收敛为读取一个 item 的适配器，不能依靠只加载第一页会话来推断全局最近话题。

`POST /sessions/{id}/topic-dismissals`：`{"summary_version":"读取到的版本"}`。先校验归属，再检查本人已存隐藏标记；同版本重复请求 204。否则确认其为当前候选且推荐已开启后，保存本人此版本的隐藏标记。已变更为别的轮次则 409 `TOPIC_STALE`，刷新卡片，不隐藏未经用户看到的新内容。隐藏当前版本后不立即以更旧话题替换；直到出现新完成轮次或用户重新开启推荐，才重新计算。重新开启（false→true）明确清除旧隐藏标记；单纯重复设置 true 不清除。

### 8.3 前端交互约束

- 首页保留“今天还顺利吗？”、“不管发生了什么，都可以和我聊聊。”及输入框“愿意和我聊聊吗？”。卡片继续轻量，不弹窗强迫授权。
- “继续聊聊”只导航到 `/chat/{conversation_id}`，读取原会话详情与消息；不创建会话、不发送消息、不触发生成。已有会话只展示历史和状态，不重复欢迎语。
- 侧栏支持加载更早会话；选择会话仅变更读取目标。切换不会暗中终止原任务，也不会把旧流追加到新窗口。
- 删除/404 立即清除对应卡片、Query 缓存及当前路由内容；关闭推荐立即隐藏，之后以服务端状态确认。更新失败需提示，不能宣称偏好已保存。
- 所有私人 Query key 包含当前认证 scope；identity/`scopeVersion` 改变时 abort 请求、关闭流、移除原缓存。每个异步回调核对捕获的 scope 与 session/generation ID，阻止 A 的晚到响应进入 B 页面。
- 访客依旧只能体验明确标注的内存演示。登录后的真实会话和演示种子分别使用适配器/命名空间；不把 preview UUID 发给正式会话接口。
- 未登录打开不属于本页演示状态的 `/chat/{id}` 时展示登录要求，不能拿演示记录填补读取失败。已保存的私人话题卡标记“已保存的消息摘录”，不能沿用“本页消息摘录”来暗示只有本页保存；Mock 生成来源另行清楚标识。
- 移动端保留抽屉、焦点管理、输入法 composition、Shift+Enter 与 visualViewport 适配；后台标签页恢复时先同步任务快照，不能仅根据本地计时器判定完成。

## 9. 数据库变更需求（尚未执行）

后端窗口独占规划 `0004_chat_persistence`，`down_revision="0003"`；先重查版本再决定编号，若出现其他迁移不得强行占用或制造分叉 head。只向前迁移，保留现有全部表和数据，不改认证/钱包业务表。

| 实体 | 拟增加的字段/约束 |
| --- | --- |
| `ai_companions` | `is_default` false；部分唯一索引 `(owner_id) WHERE is_default`，默认伙伴始终归本用户 |
| `chat_sessions` | `last_message_at` nullable、`last_activity_at`、`deleted_at` nullable、`version>=1`、`next_message_sequence>=0`、`create_key`/`create_fingerprint` nullable；创建键 `(owner_id,create_key)` 非空唯一；owner+活动时间+id 的未删除索引 |
| `chat_messages` | `client_message_id` nullable、`status`、`completed_at`；用户 UUID `(owner_id,session_id,client_message_id)` 非空唯一；新增 `(id,session_id,owner_id)` 唯一键供复合 FK；保留 `(session_id,sequence)` 唯一；provider 允许 null 表示用户输入；角色/状态组合 CHECK |
| 新 `chat_generations` | UUID、owner/session/user_message/assistant_message/retry_of 关联；operation、IK、指纹、状态、provider/model/prompt_version、context_message_ids、时间、租约/fencing、last_event_sequence、安全错误、可空 usage；每次生成关联一个独立助手消息，助手关联唯一 |
| 新 `chat_generation_events` | owner/session/generation 复合 FK；event_sequence、event_type、JSON payload、occurred_at；`(generation_id,event_sequence)` 唯一；终态事件部分唯一；重放和保留时间索引 |
| 新 `chat_preferences` | user_id 唯一/FK、开关 false、version、consented_at、dismissed_session_id/source_message_id/summary_version；隐藏标记全部为空或全部非空 CHECK，复合 FK 确保隐藏来源属于该用户与会话 |

约束补充：

1. Generation 的会话外键以及用户/助手消息外键均包含 owner、session，防止把 B 的消息接到 A 的任务；retry_of 必须同 owner/session/用户消息，并由服务校验其角色和重试状态。来源消息集合也逐条做 owner 校验。
2. 非终态 `queued/running/cancel_requested` 的 `(session_id)` 部分唯一索引；状态与错误、完成时间匹配的 CHECK；事件 sequence>=1；终态状态和事件只允许一次。
3. Generation 的 `(owner_id,session_id,operation,idempotency_key)` 唯一；消息角色由服务端写定。旧 user/assistant/system 数据不因新 CHECK 被清除；迁移需先做兼容回填。
4. 历史 `last_activity_at`、next_message_sequence 与状态根据已有记录安全回填，再设默认/NOT NULL/约束；旧消息保留 ID、内容、sequence，旧会话创建键为 null，不伪造历史 IK。provider 原值保留。
5. `chat_preferences` 可不存在，首次明确修改再创建；不批量给旧用户授予推荐同意。取消/逻辑删除不级联删已有 memories、usage_records 等外键目标。
6. SQLite 使用可兼容的 JSON/部分索引/迁移实现跑功能测试；PostgreSQL 并发、行锁、租约和外键必须另测，不能拿 SQLite 通过代替。

按此草案会增加 3 张表，现有 P2.5 的 18 张业务/认证表将成为 21 张（另有 Alembic 版本表）；这是**未来设计数量**，不是本轮数据库状态。事件日志有额外正文副本，P3 只承诺重放窗口，不自动清理现有数据；物理保留/清理策略需另行评审，不能借迁移顺手清库。

迁移前必须重新核对目标 `127.0.0.1:25433/weibiye`、预先确认的集群标识、当前版本和真实数据情况。生成 SQL、评估锁和回填影响后再应用；有未知数据、分叉版本或连接不明确则暂停。Redis 仍是 `127.0.0.1:26380/0`，不重建专用容器。本轮没有执行以上任何迁移。

## 10. 风险与验收标准

| 风险 | 必须满足的验收 |
| --- | --- |
| Cookie/CSRF 或 owner 边界回归 | P2/P2.5 全部认证恢复测试保留；无身份 401、跨用户所有读写/事件/取消/重试/隐藏均 404；管理员同样不能越界 |
| 双击/超时重复输入或重复调用 | 同 IK 并发得到同任务；变更指纹 409；新 IK+同 client_message_id 409；SQL 中只有一条用户消息与一条初次助手记录 |
| 断线丢字或重复显示 | 事件 ID 去重、缺口快照恢复、终态替换完整内容；接流不新增消息/任务；快照与 resume cursor 一致 |
| 失败被当成成功 | 截断/EOF/SDK错误/数据库故障无伪 completed；保留已提交部分和 failed/cancelled 状态 |
| 停止/删除与完成竞态 | 行锁决定唯一终态；取消后迟到块不能追加；已删除会话、卡片和新流均不可读取 |
| 进程重启重复调用 | queued 可恢复；失效 running 只失败不自动重调；旧租约不能写入；显式重试不复制用户输入 |
| 长连接绕过退出/重置撤销 | 已打开流在一次心跳间隔内停止，清理前端旧身份缓存；无隐式认证降级 |
| Mock 误导或真实模型误启 | 默认和测试中真实 SDK 请求次数为 0；私人 Mock 正确说明保存，公开演示仍不保存；usage=null、不写钱包 |
| 历史卡片编造或跨用户泄露 | 默认关闭；真实来源 ID 可核对；无记录/null；继续原会话不生成；关闭/隐藏/删除/刷新/A→B 正确 |
| 并行开发破坏现有体验 | 桌面和移动端真实 HTTP 私人 Mock E2E；保留文案、欢迎状态、抽屉和软键盘行为 |
| 测试数据库误用 | 并发 PG 验收只用明确授权的新测试数据库；禁止对现有业务库做清空、drop、truncate 或 downgrade |

验收需要 Ruff、完整 pytest、迁移一致性、TypeScript、ESLint、构建、SSE 协议测试及 Playwright。具体责任和合并门槛见 [P3_PARALLEL_PLAN.md](P3_PARALLEL_PLAN.md)。本文本轮只完成设计审阅与文档校验，没有执行或宣称这些 P3 测试通过。

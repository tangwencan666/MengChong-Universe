# P4 长期记忆 API 契约

状态：**待确认的设计，不是已实现 API**。版本 `p4-memory/1.0-draft`，2026-11-01（Asia/Shanghai）。基线 main `ae6fd44692b4011247f3b0d333fc313d7657dab8`。统一前缀 `/api/v1/memory`，JSON snake_case、UTC RFC3339、UUID 字符串。

## 1. 统一规则

- 全部接口需要现有 Cookie 会话。所有 POST/PATCH/DELETE，包括只计算预览、检索及导出的 POST，仍执行现有 CSRF、Origin、Sec-Fetch-Site 校验。前端 Axios/fetch 带 Cookie；生产 HTTPS+Secure，不改变 P2.5 认证机制。
- owner 来自 Principal；请求禁止 owner_id/user_id、系统提示、provider/model 等越权字段，`extra=forbid`。无身份 401，访问他人/不存在对象统一 404，管理员无私人资源特权。
- 私人响应 `Cache-Control: no-store`；不使用 URL query 传记忆/检索正文。请求 JSON 上限 32 KiB，正文按 Unicode 码点检查；列表只提供有限分页。
- 内容先规范 CRLF/CR 为 LF 并 trim，不擅自改写 Unicode。标题 1–80，content 1–1000，summary ≤240，来源 ≤5，preview 候选 ≤3，非删除记忆每 owner ≤200。
- 对资源的 `version/expected_version` 为安全范围内整数；偏好无行时 version=0。BIGINT `privacy_epoch/revision` 对外为十进制字符串，不让 JS 以浮点数递增。
- 写命令采用 JSON `expected_version`，不引入当前 CORS 尚不支持的 If-Match/ETag。沿用已允许的 Content-Type、X-CSRF-Token、Idempotency-Key；SSE 的 Last-Event-ID 不作为记忆同步游标。
- 永久状态变更要求 `Idempotency-Key`（16–120 个可见 ASCII 字符），作用域为 owner+操作种类+目标；校验及事务规则见第 8 节。preview/retrieval-preview/export 无永久业务写入，不要求 IK。
- `MEMORY_V1` 缺失、服务特性未启用或内部错误不能返回假成功。0004 上新管理接口 503；长期记忆用户开关关闭时，管理读取/撤销/删除/导出仍可用，提取、激活和检索不可用。

## 2. 路径与兼容

| 方法 | 相对路径 | 成功响应 | 权限/前置 |
| --- | --- | --- | --- |
| GET | `/preferences` | 200 MemoryPreferences | 本人，缺行返回虚拟关闭状态 |
| PATCH | `/preferences` | 200 MemoryPreferences | CSRF、IK、expected_version |
| POST | `/previews` | 200 MemoryPreview | CSRF、长期记忆开启、主动选择来源，不保存 |
| POST | `/items` | 201 `{item,idempotent_replay}` | CSRF、IK、当前偏好版本、逐条确认 |
| GET | `/items` | 200 MemoryPage | 管理列表，关闭时也可读 |
| GET | `/items/{memory_id}` | 200 MemoryItem | 本人非 deleted 条目 |
| PATCH | `/items/{memory_id}` | 200 MemoryItem | CSRF、IK、active、资源及偏好版本、纠正再确认 |
| POST | `/items/{memory_id}/confirm` | 200 MemoryItem | CSRF、IK、revoked/expired 同来源重新确认；不能恢复 deleted 或补造 legacy 来源 |
| POST | `/items/{memory_id}/revocations` | 200 `{id,status,version,revision}` | CSRF、IK、expected_version，关闭时可用 |
| DELETE | `/items/{memory_id}` | 204 | CSRF、IK、JSON expected_version；关闭时可用 |
| GET | `/items/{memory_id}/sources` | 200 `{memory_id,version,items}` | 本人非 deleted，仅来源元数据 |
| GET | `/changes` | 200 MemoryChanges | 本人 metadata feed |
| POST | `/retrieval-preview` | 200 RetrievalPreview | CSRF、长期记忆开启，检索解释，不创建生成任务 |
| POST | `/export` | 200 JSON attachment | CSRF、本人，关闭时可导出 |

这是 **14 个拟议新接口**。现有 `GET /memory` 返回裸数组、`GET /memory/{memory_id}` 返回旧 MemoryView，不静默改为分页对象。未来保留安全桥接：只有符合新完整注入资格的 active 条目可通过旧接口读取，关闭时旧列表为空、旧详情404；响应字段形状保持不变。管理 revoked/expired/legacy 使用新 `/items`。

兼容代码在0004缺 MEMORY_V1 时，旧桥接直接返回数组[]/详情404，不查询任何0005列或沿用旧规则放行；新接口503。0005后服务管理开关开启才提供新管理接口，注入开关关闭不影响管理验收。

未来注册静态路径时必须先于旧 `/{memory_id}` 动态路由，防止 preferences/items/changes 被当作 UUID。桥接也应使用统一 policy predicate，不能让旧路由绕过到期/删除/授权规则。本轮不修改旧 API。

## 3. DTO 与独立授权

`MemoryPreferences`：

```json
{
  "long_term_memory_enabled": false,
  "version": 0,
  "privacy_epoch": "0",
  "context_epoch_floor": "0",
  "revision": "0",
  "sync_cursor": "opaque-owner-and-revision-bound-cursor",
  "context_not_before": null,
  "policy_version": "memory-policy/1",
  "notice_version": "memory-notice/1"
}
```

偏好写入请求：

```json
{
  "long_term_memory_enabled": true,
  "expected_version": 0,
  "consent": {
    "confirmed": true,
    "policy_version": "memory-policy/1",
    "notice_version": "memory-notice/1"
  }
}
```

开启必须确认当前披露版本；关闭请求只需 `long_term_memory_enabled=false,expected_version`，不得强制用户重新同意才能撤销。重复相同设置且版本匹配可不改变版本；网络重放由 IK 返回当前偏好。关闭会撤销所有 active 条目并推进屏障，重新开启不复活；响应是提交后的状态，不把页面本地切换当成服务器确认。

preferences.version仅在全局设置变化时递增；条目变化推进epoch/revision但不改变设置版本。sync_cursor由服务端在此读取快照签发，供后续changes使用，客户端不得自己用revision拼接游标。context_epoch_floor为历史上下文最低逻辑epoch，context_not_before仅作时间提示。

`MemoryItem`：id、title、content、summary、category、status、version、created_at、updated_at、last_confirmed_at、expires_at、consent_ref、sources、revision。`status` 为 active/revoked/expired/legacy_unconfirmed；deleted 不提供正文 DTO。过期状态按服务端当前时间投影，不等待后台更新；revision为本次owner读取快照，不是另一个行内版本。`consent_ref` 只含事件 ID、披露版本和时间，不返回会话凭据。`sources` 只含 kind、session_id/message_id（可空）、availability，不复制消息全文。summary 是显示摘录，不是新增事实。

类别为 `career_goal|communication_preference|experience|open_topic|explicit_note`。旧 legacy 条目可能缺 category、expires_at、consent_ref，DTO 允许这些为 null，并明确不可注入；新的 active 条目不允许为空。

## 4. 显式预览与确认

`POST /previews`：

```json
{
  "session_id": "019f2000-0000-4000-8000-000000000101",
  "message_ids": ["019f2000-0000-4000-8000-000000000111"],
  "expected_preferences_version": 1,
  "consent": {"confirmed": true, "notice_version": "memory-preview/1"}
}
```

来源必须是本人的未删除会话中已接受的 user 消息，按真实 sequence 排序；不能选其他 owner、assistant/system、Mock 回复或不存在记录。多条来源不能暗中扩展到全会话。缺少明确请求 422，关闭 409，越权404。

响应为 `{candidates:[{candidate_id,title,content,summary,category,source_refs,suggested_expires_at}], preview_token, expires_at, extractor_version:"local-excerpt/1", persisted:false}`。candidate_id 仅本次预览标识，不是 Memory ID。提取首版只做可解释的本地片段建议，无法合理形成候选可返回空，禁止编造经历。

preview_token 为短期签名回执，绑定 owner、认证 session、来源 ID/版本/摘要指纹、偏好版本、epoch、五分钟到期；**不包含可读正文**，不得放 URL。服务端不保存候选正文；回执不是授权替代物，确认时仍重验身份/来源/政策。来源被删除、切号、撤销或过期后旧回执失效。用户可以编辑候选；编辑后内容重新做安全/长度校验，不从回执还原未经确认的原文。

`POST /items`（手动示例）：

```json
{
  "title": "求职方向",
  "content": "希望优先了解后端开发岗位。",
  "category": "career_goal",
  "source": {"kind": "manual"},
  "expires_at": "2027-01-30T10:00:00Z",
  "expected_preferences_version": 1,
  "consent": {
    "confirmed": true,
    "policy_version": "memory-policy/1",
    "notice_version": "memory-notice/1"
  }
}
```

手动条目无消息来源，不假造 source ID；chat_message 来源提交 `{kind:"chat_message",session_id,message_ids,preview_token}`，回执和完整来源重新校验。客户端不提交 summary、active 状态、grant_id 或提取器内部版本；服务端生成。expires_at 可省略，采用类别默认值；提供时必须晚于服务端 now 且不超过365天。

同一事务保存条目、来源、明确授权事件、偏好 epoch/revision、幂等元数据并取消旧快照任务；201 才表示已经保存。开启开关、预览、聊天文字或一次生成 completed 均不是保存动作。

## 5. 管理、来源、撤销与删除

`GET /items?limit=30&cursor=...&status=active&category=career_goal&snapshot_revision=...`：默认 limit30，1–100；可选 status/category，默认所有非 deleted。按 `(updated_at DESC,id DESC)`，响应 `{items,next_cursor,has_more,snapshot_revision}`。cursor 为有版本、owner/过滤条件/排序/起始 revision 绑定的 opaque 数据，最长1024。分页期间 revision 变化返回409 `SYNC_RESTART_REQUIRED`，重新从当前快照开始，不伪装跨请求历史版本快照。

`PATCH /items/{id}`：提交 title/content/category/expires_at 的期望最终值（不能修改来源）、`expected_version`、`expected_preferences_version` 和明确 consent；active 纠正后版本递增，新内容覆盖旧正文，旧授权事件只留版本元数据。需要改变来源时撤销旧条目并显式新建。原来源已删时不得通过编辑维持 active。

`POST /items/{id}/confirm` 提交当前确认的内容/类别/有效期、`expected_version`、`expected_preferences_version`及consent；仅用于有已验证来源的revoked/expired条目，来源不允许改变，聊天来源需重新预览并核对同一组ID。过期不能仅续期按钮静默复活；deleted永远不能恢复。来源已删除或legacy缺精确证据时409 SOURCE_UNAVAILABLE，用户可以阅读旧内容后显式新建手动条目或重新选消息创建**新ID**，不能改写旧ID来源。确认与纠正同样受敏感信息策略约束。

`POST /items/{id}/revocations`：`{"expected_version":2}`，撤销后保留正文仅供本人管理，普通检索/模型不再使用。同 IK 重放返回当前状态元数据，不回旧正文。

`DELETE /items/{id}` 的 JSON body：`{"expected_version":2}`。客户端必须带 Content-Type/CSRF/IK；成功204，无响应正文。删除后 GET404；本人重复删除墓碑可返回204，非本人仍404，不通过重复删除泄露归属。旧版本首次删除409；已经删除不因旧 expected_version 而阻止安全幂等结束。

删除事务清 content/title/summary 等可读派生内容、撤销 grant、写无正文墓碑/事件/幂等结果、推进屏障、取消旧快照任务；不删全库、不改变聊天/钱包。其他端通过 changes 得知失效，晚到正文响应被 epoch 丢弃。

`GET /items/{id}/sources` 返回原始来源 ID、kind、availability=`available|source_deleted|legacy_unverified`，不直接返回聊天全文。用户点击 available 来源后仍走 P3 的 owner API。来源会话删除后可显示“来源已删除”，不得绕过 P3 去读墓碑全文。

## 6. 检索解释与生成引用

`POST /retrieval-preview`：`{"query":"后端岗位准备","limit":5,"expected_preferences_version":1}`，query1–1000码点，limit1–5。返回 `{items:[{memory_id,version,category,matched_terms,source_refs}], privacy_epoch, counter_version, budget, reason}`，不返回内部系统 Prompt、他人信息、模型诊断或原始 SQL 分数。reason 可以是 no_match/budget_exhausted；关闭时409，不伪造空成功掩盖禁用状态。

检索不保存 query、不生成新记忆、不调用模型。真正生成的引用通过拟议 `GET /api/v1/companion/sessions/{session_id}/generations/{generation_id}/memory-refs` 获取，200 `{items:[{memory_id,memory_version,availability}],privacy_epoch}`。这是本设计对 P3 的**一个新增 owner 只读端点**，不是修改既有 SSE DTO；只有实际使用的引用可见，不重放已删正文，记忆已删除时只显示 unavailable。

P3 聊天事件仍是 start/delta/completed/error/cancelled，version=1。若长期记忆变化取消生成，拟议 reason=`memory_policy_changed`，不得再误标成用户手动停止。正式开发前须同步这项加法及前端提示测试；SSE 重连本身从不触发检索、记忆写入或新 Provider 调用。

## 7. 同步与导出

`GET /changes?limit=100&cursor=...`：默认100、1–200，返回 `{items:[{revision,action,memory_id,memory_version,affected_all,occurred_at}],next_cursor,has_more,high_watermark}`，无正文。cursor 包含 owner 和已读取 revision，分页固定 high_watermark；之后的新变更下轮继续。无 cursor 返回空 items、当前 cursor 及 `reset_required=true`，要求先读取偏好+完整列表。游标超过90天窗口410 `SYNC_CURSOR_EXPIRED`，不得把未知缺失当作删除。

全量同步：读取 preferences 得到 revision C及sync_cursor → 按 C 拉取 items 各页 → 使用该sync_cursor拉取C之后changes → 对受影响 ID 读取当前详情，delete/disabled 清缓存。全量期间 C变化重新开始；同一浏览器的 BroadcastChannel 只发失效信号。两个账号的 cursor 不可互用。

`POST /export`：body=`{"format":"json","include_inactive":true}`，返回200 application/json + Content-Disposition。一个 PostgreSQL 只读一致快照内导出当前本人非 deleted 条目及来源/授权元数据，标明 exported_at、snapshot_revision、schema_version；不含密码、Cookie、邮箱令牌、聊天全文或已删正文。include_inactive=false 仅当前 active 条目；关闭仍允许导出，不代表允许模型使用。

首版最多200条、2MiB，直接流式/有界返回，不生成临时文件、可分享URL或后台导出任务。跨设备持有的旧下载不能撤回，应明确下载后的用户责任；服务端不永久缓存导出。若将来扩展更大导出，需要另审短TTL、授权重新检查及撤销机制。

## 8. 幂等、并发与错误

先认证/CSRF和 owner 查询，再在 User 锁下查 IK、比较规范化请求 HMAC 指纹、校验资源与偏好版本。相同 IK 同请求不新建事件/条目；不同内容409 `IDEMPOTENCY_CONFLICT`。事务失败不得留下“成功”的幂等记录；唯一键解决并发双创建。

幂等结果不缓存旧 DTO。创建/纠正重放后，如果条目仍 active 返回同一 ID 的当前版本；已撤销/过期返回409 `MEMORY_INACTIVE` 元数据；已删除返回410 `MEMORY_UNAVAILABLE`，不恢复、不回显旧正文。未知/他人 IK 或资源仍404；重试不得换 key 绕过重复命令。去重映射与删除墓碑保留至账户删除。

错误沿用 `{error:{code,message},request_id}`，不回显正文、验证器输入或原始数据库异常。

| HTTP | code | 语义 |
| --- | --- | --- |
| 401 | AUTHENTICATION_REQUIRED | 会话无效，清私人缓存/停止流 |
| 403 | CSRF_REJECTED | 安全校验失败，不自动重发保存 |
| 404 | RESOURCE_NOT_FOUND | 未找到或非本人，策略一致 |
| 409 | VERSION_CONFLICT / PREFERENCES_CONFLICT | 刷新后由用户决定，不自动覆盖 |
| 409 | MEMORY_DISABLED / MEMORY_INACTIVE | 不能预览/保存/注入或旧命令失效 |
| 409 | SOURCE_UNAVAILABLE / PREVIEW_STALE | 来源或回执已变，重新选择/确认 |
| 409 | SYNC_RESTART_REQUIRED / IDEMPOTENCY_CONFLICT | 重同步 / 停止冲突重试 |
| 410 | MEMORY_UNAVAILABLE / SYNC_CURSOR_EXPIRED | 仅 owner 已知命令的删除结果 / 同步窗口过期 |
| 422 | VALIDATION_ERROR / SENSITIVE_MEMORY_REJECTED / INVALID_CURSOR | 输入/安全策略拒绝，禁止回显敏感片段 |
| 429 | RATE_LIMITED / MEMORY_CAPACITY_LIMIT | 返回 Retry-After；条目上限为产品配额，不扣钱包 |
| 503 | MEMORY_STORAGE_UNAVAILABLE / MEMORY_FEATURE_DISABLED / RATE_LIMIT_UNAVAILABLE | 能力/依赖不可用，不能伪造成功 |

拟议 Redis 限额：写命令20次/分钟/owner，预览与检索各10次/分钟/owner，导出2次/分钟/owner，读取120次/分钟/owner；同一已提交 IK 重放不重复计业务次数但仍受基本请求限流。Redis认证或限流依赖故障仍按现有机制拒绝503，包括撤销/删除，不增加本地认证旁路；UI显示操作尚未确认并停止本设备继续使用。仅提交后的失效通知允许best-effort，通知失败不能推翻已提交的DB撤销/删除，其他端靠epoch复核和轮询同步。上述配额为 P4 提案，不是钱包计费规则。

记忆专属检索能力故障必须 fail closed，不能使用缓存记忆。仅当 P3 聊天存储、lease及SSE均健康、Provider尚未开始且未纳入记忆快照时，可明确跳过记忆继续普通聊天。共享PostgreSQL不可用时仍按P3失败/取消/503，不能改为无持久化回复；已授权/使用无法复核的记忆则取消原任务，不重发替代消息。契约细节与事务边界见 [架构](D:/AIProjects/WeiBiYe/docs/P4_MEMORY_ARCHITECTURE.md)。

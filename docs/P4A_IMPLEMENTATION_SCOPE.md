# P4-A 实施范围与 API 加法

基线契约：`p4-memory/1.0-draft`。分支：`codex/p4a-memory-foundation`。

六份既有设计/验收文档先独立保存在提交 `538f45f`，保留原契约历史。本文仅收紧本轮范围并记录用户明确新增的“清空记忆”接口，不改写已验收 P3 契约。

## 本阶段开放范围

- 0004/0005 显式 schema 能力、未知版本拒绝、后台/HTTP/readiness一致保护。
- 0005 记忆管理特性配置默认关闭；开启要求至少32字节的跨worker稳定 `WEIBIYE_MEMORY_HMAC_KEY`。密钥没有默认值，不写入仓库；测试使用明确的合成密钥。
- `/api/v1/memory/preferences` GET/PATCH，手工 `/items` CRUD、单条撤销、同手工来源重新确认、来源元数据、同步changes、JSON导出。
- 所有永久命令使用 Cookie、CSRF、IK；版本/owner/配额校验。全局关闭仍允许本人管理、撤销、删除、导出。
- 0004旧读取桥接保持数组[]/详情404，不读取0005新列；0005也不能用旧时间戳当新授权。

聊天来源确认、自动/半自动提取预览、检索预览、LangGraph记忆注入及真实模型本阶段不开放，相关入口明确501。`memory_injection_enabled=true`在配置校验拒绝，不能误以为开关已启用能力。新建来源表和生成引用表供后续扩展，本阶段不会写入虚假的“模型使用记录”。

前端记忆管理页面、本机/手机/宠物客户端、多端持久离线缓存不在本轮开发范围；不宣称已完成用户界面联调。

## 清空 API

`POST /api/v1/memory/clear`，JSON body：

```json
{"confirmed": true, "expected_revision": "12"}
```

必须有当前Cookie、CSRF及Idempotency-Key。expected_revision取该账户preferences.revision；版本不匹配409 `PREFERENCES_CONFLICT`。成功204，无正文。所有权来自Principal，不接受目标user_id。

同一事务内擦除当前owner所有非deleted记忆正文、标题和摘要，清grant、保留无正文墓碑；推进privacy_epoch、context_epoch_floor和revision，写账户级 `deleted/affected_all=true` 事件，合法终结旧epoch活跃任务。长期记忆开关、最近话题、聊天记录、Token钱包均不连带清空。

重放旧clear的同IK/同body只返回已提交结果，不能再次清掉该操作之后新创建的记忆；同IK不同body409。没有记忆时仍可显式推进隐私屏障，清除操作不等于撤销授权。

## 实施细节

- 偏好无行时返回虚拟false/version0；首次明确写操作需要持久化屏障时初始化默认关闭的实际行，版本为1。这一步不是授予记忆权限，之后version仅全局设置变更递增，条目变化只推进epoch/revision。
- 导出/管理读取使用一致快照；PostgreSQL事务显式REPEATABLE READ READ ONLY。导出不留服务端文件或公开URL；在途响应/用户已有下载不能召回。
- schema manifest校验绑定engine与精确revision，只有严格成功才能缓存。每次命令仍读取单head白名单；启动/readiness强制重新验证。同revision的DDL漂移由严格readiness检查发现并清缓存，不声称每请求都完整反射约束。
- active grant纠正先写新版本授权事件，再原子替换正文/version/grant；不让active行出现中间NULL grant。
- 删除/纠正/撤销推进逻辑epoch屏障，旧聊天不被删除但不再自动作为新模型上下文；普通新增仅更新epoch，不推进floor。已授权在途调用不可召回，后续delta/完成受lease+epoch fence阻止。
- 内部 `memory_policy_changed` 取消原因在原五类SSE事件内表达，不改变version1、事件ID、重放、幂等或终态唯一性。
- Redis认证/限流故障仍503；没有本地认证旁路。正文不进日志、Redis或幂等结果；幂等仅存HMAC指纹和当前资源ID。
- 本阶段不自动清理备份或审计，不声称物理删除覆盖历史备份。恢复旧备份必须隔离并应用后续删除/撤销清单后再开放；该跨备份治理能力尚未实现，不具备生产发布条件。

共享开发库本轮保持0004；0005仅在明确隔离测试库验证。实际命令、结果和剩余风险见本轮验收报告。

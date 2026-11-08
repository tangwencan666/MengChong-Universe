# P4-B 实施范围与接口补充

基于 `p4-memory/1.0-draft`，承接 P4-A；本文件说明当前后端实现，不替代五份 P4 设计文档。验收证据见 `P4B_VERIFICATION.md`。

## 开关与版本

- `memory_management_enabled`、`memory_injection_enabled` 默认仍为 false；用户的长期记忆授权也默认关闭。管理开关、注入开关和用户授权分别检查。
- 注入开启只接受 `llm_provider=mock`、`real_llm_enabled=false`，且必须开启管理并配置稳定的服务端 HMAC 密钥。未知 Provider/模型计数配置不降级为猜测预算。
- 沿用 P4-A 明确能力矩阵：0004 支持 P3，0005 支持 P3 和记忆；其他版本拒绝。P4-B 不增加迁移，不修改旧迁移；0005 的 schema 与 P4-A 相同。
- 本轮只向随机命名的隔离测试库执行向前迁移；共享开发库保持 0004，因此本轮不在共享环境开启记忆。

## 显式预览与逐条保存

`POST /api/v1/memory/previews` 实现设计中的 DTO：本人主动选择同一未删除会话的 1–5 条 completed user 消息，确认 `memory-preview/1`，携带当前偏好版本。全部来源先做安全筛查，至多返回 3 条本地原文摘录，不调用模型、不持久化候选、不读取未选中的聊天历史。截断以省略号标记；类别仅是规则建议。

预览签名回执有效期 5 分钟，绑定 owner、Cookie 对应的认证会话、偏好版本、隐私 epoch、全部所选消息及其内容 HMAC；不包含可读聊天正文。用户只保存一条候选时，可以在签名来源集合内选非空子集，不能扩大集合；确认时仍重新核对整个签名来源集合和当前状态。来源 ID 与归属先于回执校验，不向跨账号请求泄漏来源。

永久保存仍单独调用 `POST /memory/items`，必须逐条提供最终确认的 title/content/category、当前偏好版本、`memory-notice/1`/`memory-policy/1`、Idempotency-Key，以及 `source={kind:chat_message,session_id,message_ids,preview_token}`。开启、预览、模型生成和 SSE 重放均不保存长期记忆。用户可以修改候选，修改后重新执行长度与敏感内容检查。

每次保存会推进隐私 epoch；同批其余候选的旧回执随即失效，后续逐条确认必须重新预览并取得新回执。前端不能把批次回执作为多条长期授权。

对 `POST /memory/items/{id}/confirm` 增加可选 `source` 字段，格式同创建；聊天来源重新确认时必须提交新回执和与原条目完全相同的来源 ID 集合。该字段不允许更换来源；普通 PATCH 仍禁止 source。手动确认省略 source 时沿用 P4-A 的幂等指纹，旧请求不会因这个可选字段而冲突。

## 检索与引用

`POST /memory/retrieval-preview` 接受 query、limit（1–5）和 expected_preferences_version，返回设计中的引用、matched_terms、privacy_epoch、counter_version、budget、reason。query 不进入 URL、日志、数据库或 Redis。预览不创建任务、不调用模型；发现过期/来源失效时，会先单独提交必要的隐私失效元数据，这是安全屏障维护，不是保存候选或查询正文。

SQL 先过滤本人授权、active、未撤销/删除/过期、当前合法确认事件及全部有效来源，再做有界词法排序。候选扫描上限 200，最多选择 5 条；词法规则包含英文单词、中文双字词、少量岗位别名和常见话术停用词。稳定排序使用相关性、确认时间和 ID；最多 1 条明确的交流偏好可作为独立回退候选。不使用向量库或语义模型，不保证理解同义改写。

ASCII岗位别名按完整词或词组匹配，不将 curiosity 中的 ios、disregard 中的 sre 视为岗位证据；中文邻接和已定义的连字符/多词别名仍受支持。预览与检索预览使用独立限流桶，各10次/分钟/owner；任一桶耗尽不占用另一桶或其他账号额度。

新增 `GET /api/v1/companion/sessions/{session_id}/generations/{generation_id}/memory-refs`：现有 Cookie、owner 规则不变，返回实际授权发送时记录的 memory ID/version、可用状态和任务 epoch，不返回记忆正文。删除、撤销、纠正、过期或来源删除后，旧引用只投影 unavailable，不能恢复旧内容。

## LangGraph 与预算

私人生成图为 prepare → authorize_memory → retrieve_memory → budget_context → assemble_context → respond。最终发送检查发生在 Provider 迭代器创建之前；公共演示图没有私人运行时，不能通过输入状态伪造记忆注入。图不负责提取或保存，不增加 checkpointer，不启用远程 tracing。

关闭记忆注入时，私人聊天仍在 Provider 迭代器创建前执行最终 owner/status/session/lease/epoch 检查；普通历史也可能包含先前的记忆来源或派生内容，不能因注入开关关闭而绕过隐私屏障。0004下该检查只访问V4字段，不启用记忆管理或检索；公共演示不安装私人检查。

授权记忆是独立 user 角色的 JSON 数据块，包含来源元数据；正文不插入 system 角色。固定系统声明说明其为低信任资料。此结构不等于已验证真实模型能抵御提示注入，本阶段只允许 Mock。

使用明确的 `mock-token-v1` 计数单位：UTF-8 字节加固定消息封装开销，只验证 Mock 预算与装配一致，不能用作真实 tokenizer。默认容量 C=32768、输出预留 O=512、安全余量 G=256，记忆上限 min(1024, floor(0.15×(C−O−G)), 可用空间)，最多 5 条。保留系统和当前用户输入，按完整历史对移除最旧上下文，按排名装入完整记忆；不截断记忆正文。计数包含 JSON 封装，每条实际引用记录 used_tokens 和 counter_version。

## 隐私屏障与并发边界

- 共用 User → MemoryPreferences → ChatSession → ChatGeneration → ChatMessage → Memory 锁序；来源会话删除也先取得 User/Preferences，并在同事务物化相关记忆撤销。
- 接受任务、加载上下文、发送授权、delta/终态写入前检查资格。自动到期/来源失效使用可提交的独立边界，避免随后 FenceLost 异常回滚已发现的撤销。
- 授权、纠正、删除、到期与来源变化推进 epoch；有删除意义的变化还推进 context_epoch_floor，旧派生历史不能重新自动进入后续模型上下文。
- 最终授权事务重验实际命中的 ID/version/grant/来源，记录引用和 memory_snapshot_at 后提交，再调用 Provider；不持数据库锁等待模型网络。
- 撤销先提交，尚未授权发送的调用被阻止；授权发送先提交的在途输入不能保证召回。后续输出受 lease/epoch/资格屏障限制并取消，不能承诺清除用户已下载内容或历史备份。
- Redis 不缓存记忆正文或授权真相；SSE 只重放原事件，不再次检索、提取、保存或调用 Provider。Token 钱包不参与记忆保存/保留。

## 本轮未覆盖的产品能力

未实现前端记忆预览/管理交互、真实 Provider 注入、真实 tokenizer、语义检索、后台自动提取或摘要、向量库、完整多端客户端同步及备份到期物理清除。敏感内容筛查仍是保守本地规则，不能宣称识别所有敏感信息或具备心理危机干预能力。Mock 固定回复不理解输入，实际注入证据来自 SpyProvider 对收到的 messages/system_prompt 的直接断言。

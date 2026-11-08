# WeiBiYe 当前架构与演进边界

更新日期：2026-11-02。当前产品范围见 [PRODUCT_SCOPE](PRODUCT_SCOPE.md)，开发顺序见 [桌面宠物路线](DESKTOP_PET_ROADMAP.md)。P3／P4 历史契约和验收记录保留；本说明区分旧版账户级兼容与新增宠物隔离基础。

## 应用结构

当前是 React Web 客户端与 FastAPI 模块化单体，使用 PostgreSQL 和 Redis。没有 Windows 原生宿主、桌面宠物窗口或安装器，也没有通用多 Agent 调度平台、向量数据库或微服务拆分。

依赖方向保持 HTTP Router → 领域服务／运行时 → 数据库或 Provider。`core` 和 `db` 提供配置、异常、日志、会话与版本能力检查；应用工厂和依赖注入支持隔离测试。应用导入及启动不自动迁移数据库。

```text
React 主界面
├── 账户：认证、恢复、登录会话
├── 聊天：历史、SSE、取消、重放、最近话题
├── 我的宠物：独立身份、配置、隐藏／归档；桌面运行待开发
└── 记忆：授权、预览确认、管理、来源与导出
        │ Cookie / CSRF / owner 校验
FastAPI 模块化单体
├── auth / users
├── pets：身份、绑定、人格快照与宠物独立记忆
├── companion：会话、消息、生成任务、事件
├── memory：授权、存取、检索与隐私屏障
├── agent：LangGraph、上下文与 Provider
└── 遗留兼容模块：community / applications / wallet / moderation / admin
        │
PostgreSQL + Redis

Windows 宿主与多宠物窗口：未来独立客户端边界，尚未实现
```

生命周期创建并释放数据库与 Redis 连接池；领域服务显式管理事务。ORM 使用受控关联加载，私人数据只返回获授权账户，密码、Cookie 和服务端密钥不进入普通 DTO 或日志。没有通过前端传入 `user_id` 获取其他账户身份的入口。

## 现有数据模型

共享库保持0005／26张业务／认证表。本分支0006只新增8张表，隔离库目标34张；旧表、旧记录与完整迁移历史保留。

| 分组 | 表 | 当前作用 |
| --- | --- | --- |
| 账户／认证 | users、auth_sessions、email_verifications、password_resets | 用户身份、服务端会话与本地 Mock 邮件闭环 |
| 伙伴／聊天 | ai_companions、chat_sessions、chat_messages、chat_generations、chat_generation_events、chat_preferences | 伙伴归属、持久化会话、生成任务与 SSE journal、最近话题授权 |
| 记忆 | memories、memory_preferences、memory_consent_events、memory_sources、memory_generation_refs、memory_operations | 账户级授权、来源、确认与删除、检索／引用及幂等操作 |
| 待确认额度模块 | wallets、wallet_reservations、usage_records、wallet_transactions | 整数额度与账本骨架，不是宠物金币；实际支付未接入 |
| 遗留社区／求职／审核 | posts、comments、post_likes、reports、job_applications、moderation_actions | 历史兼容，前端业务入口退出；本轮不删表或数据 |

`ChatSession` 通过 `companion_id + owner_id` 复合外键关联伙伴，消息、任务及来源也保留用户归属约束。旧版AICompanion.persona保持历史兼容。新宠物保存受控persona_config，接受任务时将版本及快照存到PetGenerationContext，再由pet-v1模板纳入实际Provider上下文及Token预算。

`Memory`、`MemoryPreferences` 和隐私 epoch 目前按账户隔离，没有 `companion_id`。新宠物使用独立pet_memory_preferences、pet_memories、pet_memory_consents、pet_memory_sources和pet_memory_operations，所有授权、检索、来源及发送／写回屏障按owner＋pet；不读取旧memories作为默认输入。会话和生成通过pet_chat_bindings与pet_generation_contexts绑定。

数据库能力检查明确允许聊天使用0004／0005／0006，旧记忆使用0005／0006，宠物功能仅允许0006，未知版本或结构不符继续拒绝。旧严格0004的 P3 进程不能接入已升级数据库。开发库已提交0005的事实与完整正式升级验收状态分别记录；本轮仅向全新隔离库迁移0006，不执行共享库迁移。

## 聊天与 Agent Runtime

私人聊天通过创建会话、提交消息／生成任务、查询状态及读取 SSE 事件进行。Cookie 会话验证身份，写操作验证 CSRF 和 Origin；会话、消息、生成任务及重放游标都执行 owner 校验。

接收消息时持久化用户消息、助手占位、生成任务与初始事件；运行时后续提交增量和终态。事件包含 start、delta、completed、error、cancelled，具有可追溯的事件 ID 和序号。客户端通过 Last-Event-ID 做排他重放，重连不能再次调用 Provider 或重复保存记忆。具体字段和状态码仍以 [P3 契约](P3_CHAT_API_CONTRACT.md) 为准。

LangGraph 承担明确的对话步骤：上下文准备、授权检查、记忆检索、预算与组装、Provider 流式调用。当前 Mock／Spy 验证实际输入，不证明真实模型理解或个性化效果。人格、记忆、用户输入和系统规则需保持信任边界；模型输出不能直接成为本机系统命令。

公开 `/api/v1/companion/demo/stream` 是独立的本地固定 Mock 演示链路，不持久化，也不是私人 SSE 协议。它及其测试是否退役待确认，不把两条路径的能力混为一谈。

Provider 目前主要为 `mock|openai`，真实调用需显式配置且默认关闭。DeepSeek、消费者配置及真实模型与记忆注入尚待开发和单独验收。当前没有应继续扩张的通用 Agent 平台业务。

## 长期记忆与隐私

长期记忆默认关闭；总授权不自动保存聊天，候选预览也不持久化。每条内容由用户确认后保存，保留来源、有效期、版本和授权事件；用户可以查看、编辑、撤销、删除、清空和导出。

最近话题授权与长期记忆授权独立。撤销、删除、来源失效和到期会影响后续检索、发送及写回；在途已发出的模型输入和用户已下载副本不能被普通删除召回。P4 的详细边界见 [记忆 API](P4_MEMORY_API.md)、[安全设计](P4_MEMORY_SECURITY.md)和 [测试计划](P4_MEMORY_TEST_PLAN.md)。

旧 `career_goal` 等枚举、CHECK 和候选规则保留兼容。本轮调整产品文案，不自动清除用户提到工作或求职的私人记录，也不假定旧记忆已归属于某只宠物。

## Windows 客户端的未来边界

主界面负责账户、聊天、宠物选择和记忆管理；Windows 宿主负责透明窗口、拖动、点击、收回、托盘、多屏及 DPI。宿主技术仍待确认，当前仓库没有对应实现或运行依赖。

后续 IPC 应采用受限操作清单、调用方验证和最小权限。服务端托管密钥不进入客户端包；如选择用户自带密钥，需要操作系统安全存储与受限访问，不在 localStorage、对话或日志中保存密钥。多窗口必须共享明确的用户／宠物身份边界，不能用窗口编号代替服务端授权。

## 兼容与安全约束

- 认证、CSRF、用户隔离、角色及高风险安全响应扩展接口继续保留；移除社区不意味着删除所有 moderation 能力。Mock 不执行真实心理健康风险分析，真实模型的风险响应仍需专门验收。
- CORS 为显式来源；日志采用字段白名单与脱敏，避免正文、Cookie、密钥和完整 Prompt。
- 前端切换账户时清理私人状态，取消迟到请求；宠物切换同样重建作用域并核对每个流事件的pet_id。
- 社区／求职路由及模型暂留后端兼容，不新增业务。删除模型会影响迁移自动检测、外键和权限回归，须先独立确认退役计划。
- 不直接删除数据库表、历史数据、迁移、验收报告或备份，不执行破坏性恢复。
- 桌面、真实模型、额度商业模式、支付和公开分发均有独立验收门槛；不引入喂食、金币或等级系统。

新增模型、接口和桌面调用方式详见[宠物契约](PET_SCOPE_CONTRACT.md)与[桌面调用准备](PET_DESKTOP_API.md)。宠物最近话题、物理删除、账户级跨宠物总撤销、Windows宿主及真实模型不在本轮交付内。

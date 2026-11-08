# WeiBiYe 宠物身份与作用域基础验收

结论：PET_SCOPE_CONTRACT_VERIFIED

完成时间：2026-11-02T12:58:53+08:00。

## 工作区与保护边界

- Worktree：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot；分支 codex/consumer-desktop-pivot。
- 上轮界面改造成果先保存为本地提交83c1b0943d694a26ab728af457c5e3dc4ddccad2，原24个变更已审核并提交。当前HEAD仍为该提交，本轮宠物实现及本报告保持未暂存、未提交，供下一步审查。
- main仍为ae892ef8f834418b2f93d62bd29d7fc56babdb62。其他6个Worktree的HEAD、分支、既有工作区状态及原有分支／标签引用，与只读安全快照一致。主项目原有未提交报告保留。
- 共享数据库weibiye维持0005／26张业务及认证表，结构、逐表记录数与数据SHA-256全部未变。没有升级共享库、修改AgentForge-AI或删除历史数据、报告、备份。
- PostgreSQL及Redis专用容器ID、启动时间、健康、端口、挂载与重启计数保持不变；仅使用既有本项目资源。未执行容器启停、清理、重建或镜像拉取。
- 没有推送、合并main、部署、支付、真实模型调用、真实邮件发送或关机。

## 实现与数据模型

新增8张隔离表（共34张业务／认证表，另有Alembic版本表）：

pet_chat_bindings, pet_generation_contexts, pet_memories, pet_memory_consents, pet_memory_operations, pet_memory_preferences, pet_memory_sources, pets。

Pet使用服务端不可变UUID、owner、名称、角色、受控人格及外观配置、状态、版本与幂等记录。配置不接受任意资源URL、文件路径或脚本。每个新宠物对应新内部AICompanion，不复用旧伙伴或自动认领旧数据。

会话与生成任务通过显式binding/context绑定owner＋pet；接受时固定人格快照和版本。全部新宠物会话、消息、生成、取消、重试和SSE均保持该身份，旧v1不能通过内部companion_id绕过。

长期记忆使用独立宠物表、授权、审计、来源、HMAC回执／游标、版本、幂等域及隐私epoch。候选预览不保存；逐条确认后保存；检索只读取当前用户当前宠物。旧授权和旧记忆保持原状。

归档停止在途生成，并禁止新聊天、配置修改、记忆新增／编辑／重新确认／开启授权。仍允许关闭授权、撤销、删除、清空和导出，保留用户隐私控制。所有写操作继续检查Cookie、Origin、CSRF、owner、pet、版本及原锁顺序。

LangGraph复用P3状态机：身份与授权核对→有界检索→人格及记忆Token预算→上下文组装→调用前新鲜校验→Mock/Spy→增量与终态隐私屏障。用户禁用、删除、撤销和归档不能继续发送或写回旧授权内容。重放只读journal，不重复调用Provider或保存记忆。

前端提供宠物创建、编辑、隐藏／恢复显示、归档与选择，独立聊天和记忆页面。认证范围＋pet_id构成不可变作用域；切换时清理查询、停止旧请求和流、丢弃迟到回调。每个宠物响应和生成级SSE事件校验pet_id，校验在去重之前。

## API与桌面调用契约

完整字段、状态码、SSE及兼容规则见[PET_SCOPE_CONTRACT](PET_SCOPE_CONTRACT.md)，Windows调用顺序见[PET_DESKTOP_API](PET_DESKTOP_API.md)。

| 路径族 | 主要能力 |
| --- | --- |
| /api/v1/pets | 创建、分页列表 |
| /pets/{pet_id}、/visibility、/archive | 查询、CAS编辑、隐藏与归档 |
| /pets/{pet_id}/sessions及下级messages | 本宠物会话管理、消息持久化与分页 |
| sessions/{session_id}/generations及下级events/cancel/memory-refs | 接受／查询／重试、持久SSE、取消与引用 |
| /pets/{pet_id}/memory/preferences | 独立授权默认关闭、开启与撤销 |
| /memory/items及详情/confirm/revocations/sources | CRUD、逐条确认、撤销与来源 |
| /memory/previews/retrieval-preview/changes/clear/export | 候选、检索预览、同步、清空与导出 |

表内简写路径均接在/api/v1/pets及明确pet_id之后。Cookie／CSRF复用原机制。SSE保持P3 version=1、gid:sequence及Last-Event-ID排他重放；生成级事件增加pet_id，connection错误不冒充生成事件。重新生成的新用户命令使用新幂等键，原命令的网络重试复用原键和负载。

## 隔离数据库验证

- PostgreSQL：17.11；本项目宿主机端口25433；集群标识7703042374370492450。
- 验证库：weibiye_pet_test_e18b399adb2c4c07960d93bd58fba4ee，由本轮创建；先升级0005并通过真实认证／旧会话／已授权旧记忆API准备合成数据，再精确升级0006。
- 0005→0006为新表及其索引／约束的单事务向前变更，设置lock_timeout=5s、statement_timeout=60s；耗时0.204553秒。没有修改旧迁移或原26张表的列与约束。
- 原26张表结构、逐表记录数和业务数据哈希在该迁移前后完全一致；新8张表初始为空。没有自动归属、复制或授权。
- 最终SQLAlchemy compare_metadata为零差异。实际对象计数：主键35、外键68、UNIQUE 39、CHECK 80、索引127（含Alembic）。无无效索引或未验证约束。
- 当前隔离库活动生成任务为0。测试合成账号和数据保留，不执行清库或DROP。
- 额外保留测试库元数据：[{"database": "weibiye_pet_test_0daafecbdc8046bd96ff220f1dcb8872", "version": "0005", "tables": 26, "rows": 0}]。其中首次夹具准备因缺CSRF被拒，未写业务数据；未删除该现场。

## 实际测试结果

| 验证 | 结果与边界 |
| --- | --- |
| 冻结源码后的完整pytest | 603通过、0失败、0错误、47条件跳过，共650；2个独立低优先级进程，全部收集用例按文件无重叠覆盖，执行前后源码哈希一致 |
| 上述完整pytest内真实PostgreSQL专项 | 5通过，包含双账号各2宠物、并发幂等、CAS、取消唯一终态及复合FK；不与生成Worker同时使用同测试库 |
| 归档隐私后端专项 | 25通过、0失败／跳过，包含新增8项及既有17项，结果另列不重复累加至完整套件 |
| 补充真实PostgreSQL记忆API | 57命名检查点通过、0失败／跳过；真实PG，认证辅助与限流使用内存，不使用Redis或浏览器，不启动Runner、不请求生成；不是57个pytest用例 |
| TypeScript、ESLint、前端构建 | 全部退出码0 |
| 前端单元测试 | 39通过、0失败／跳过 |
| 通用浏览器回归 | 89通过、0失败／跳过／flaky；独立SQLite HTTP环境，部分P3网络故障采用契约模拟 |
| 旧版P4真实浏览器回归 | 18通过、0失败／跳过／flaky；真实FastAPI、PG、命名空间Redis与React，Provider为本地Mock |
| 新宠物真实浏览器验收 | 8通过、0失败／跳过／flaky；真实API／PG／Redis，包含独立聊天、完整SSE、刷新、切换、取消／重放、幂等、记忆确认／来源／导出／删除、双账号、归档隐私及移动端 |
| Ruff与格式 | check退出码0；152个文件格式检查通过 |
| 健康及Redis | 测试API readiness200，Redis PING与独立TTL键读写通过；实际认证、限流及流槽使用专用命名空间，未FLUSH或清理原键 |
| 安全收尾 | 测试端口25176/28106/35306/38306均释放，本轮测试服务／进程已退出；原库、原Worktree、备份与专用容器核对通过 |

完整后端复验时间：2026-11-02T04:45:16.328729+00:00至2026-11-02T04:55:26.208875+00:00。浏览器共115项，其中26项使用真实PG与Redis，全部模型输出仍为Mock；没有真实GPT／DeepSeek或人格效果验收。

### 条件跳过

| 旧基础设施测试模块 | 数量 |
| --- | --- |
| tests.integration.test_auth_postgres | 1 |
| tests.integration.test_chat_postgres | 10 |
| tests.integration.test_local_infrastructure | 9 |
| tests.integration.test_memory_p4b_postgres | 13 |
| tests.integration.test_memory_postgres | 10 |
| tests.integration.test_memory_races | 2 |
| tests.integration.test_memory_redis | 1 |
| tests.integration.test_p3_redis_pool | 1 |

这些旧组需要各自明确命名、特定版本的P2/P3/P4隔离数据库或Redis租约，未提供其环境变量，因此按既有安全条件跳过。本轮没有把0006库伪装为0003／0004／0005，也未修改skip或权限断言。新宠物真实PG组、真实浏览器及跨版本SQLite验证均实际运行。

### 发现的问题及修正

1. 先前成果未提交：审核并仅在当前功能分支保存83c1b094，保留main及旧Worktree。
2. 新增schema使旧默认head表数量、纯预览夹具迁移元数据及SSE Writer测试替身落后：分别适配0006／34、明确0005元数据和revision查询；保留原结构漂移、来源、回执与SSE断言。首轮完整结果573通过／22失败／47跳过，日志保留。
3. 多线程测试应用并发冷构建路由使框架内部警告逃逸成500：仅让测试应用顺序初始化和预构建路由，真实HTTP和独立DB连接继续并发；未放宽警告策略、认证或断言。
4. 浏览器Worker曾消费同库并发测试的queued任务：将相关数据库测试与生成Worker串行执行，未把合法运行中取消202改成错误的200断言。
5. 修复读取误占写限额、SQLite同秒分页、旧v1宠物旁路、账号禁用后输入／流屏障、0005新记忆引用明确503等，并保留回归。
6. 归档不可逆不应封死用户删除权：新增仅隐私缩减命令的归档例外，前端保留撤销／删除／清空控制并补8项后端及真实浏览器验收。
7. 旧记忆清空确认文案影响原有浏览器定位：保留旧入口标签，同时让宠物作用域提示明确；失败日志及通过复验均保留。

## 日志与备份边界

应用日志继续字段白名单和脱敏，新增代码不记录聊天／记忆正文、Cookie或密钥。已有敏感日志回归、Spy输入及额外PG日志白名单通过；Mock观测记录只保存记忆ID、版本及合成正文摘要。测试失败日志可能包含合成fixtures，不含原库行内容；原库证据仅为结构、计数及哈希。

原0004备份仍保留：C:/Users/20982/WeiBiYe-backups/p4-isolated-acceptance-20261101-232317-c3ba2878/weibiye-0004.pgdump。SHA-256仍为054e4c21e8c71c03860ddd4b3ff0fed21a714877c847d9bb2c573079448371f9。本轮没有重新备份、恢复覆盖或修改旧备份权限。

## 尚未实现与下一步

- 共享库仍0005，已登录新宠物API在该schema明确503。需要审查本分支并单独授权0005备份、恢复演练及0006升级，不能直接运行共享库upgrade head。
- Windows宿主、桌面窗口、动画、拖动／收回、多屏、托盘、安装器尚未实现；当前外观是受控配置及占位图标。
- 真实模型、DeepSeek与消费者密钥模式尚未实现或验收；Mock／Spy证明输入边界，不证明真实人格或模型理解效果。
- 宠物最近话题、旧数据归属变更、取消归档、物理删宠物、账户级跨宠物一键总撤销和正式桌面SDK尚未实现。旧版最近话题授权独立，宠物页不读取它。
- 旧v1仍保留legacy读写兼容，桌面新客户端必须使用显式pet路径；旧版新建关闭策略需另行确认，不能把legacy等同所有宠物。
- 部分新宠物响应未提供独立OpenAPI response_model，桌面代码生成前应补齐严格pet DTO；当前文档和运行时校验已明确字段。
- 沿用P3账户并发限制及User锁，后续多窗口阶段须测资源预算；本轮不宣称无限宠物并行或消费者发布就绪。
- 钱包、后台、遗留社区后端及旧分类的待确认状态不变；社区和求职前端清理成果保留，不删除历史数据。

建议顺序：审查并保存本轮代码→单独授权数据库0006发布流程→明确旧入口切换策略→选择Windows宿主、最小受限IPC与单宠物窗口→多窗口资源验收→另行授权模型提供商。

## 证据与截图

本轮证据目录：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\pet-scope。包含迁移前后逐表结构／计数／哈希、冻结源码清单、完整及分组JUnit、全部初轮失败与复验日志、浏览器JSON、PG补验、静态检查、进程和资源快照。Redis测试键有TTL，不全库清理；测试数据及环境保留。

- 桌面截图（已查看）：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\pet-scope\pet-chat-desktop.png
- 移动截图（已查看）：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\pet-scope\pet-memory-mobile.png
- 完整后端分组目录：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\pet-scope\release-8d80355f946b496d813def825b823e35

## 修改文件（75项）

- [README.md](../README.md)
- [backend/app/agent/chat_protocol.py](../backend/app/agent/chat_protocol.py)
- [backend/app/agent/chat_runner.py](../backend/app/agent/chat_runner.py)
- [backend/app/agent/graph.py](../backend/app/agent/graph.py)
- [backend/app/agent/memory_boundary.py](../backend/app/agent/memory_boundary.py)
- [backend/app/agent/prompts.py](../backend/app/agent/prompts.py)
- [backend/app/agent/state.py](../backend/app/agent/state.py)
- [backend/app/api/router.py](../backend/app/api/router.py)
- [backend/app/db/capabilities.py](../backend/app/db/capabilities.py)
- [backend/app/db/models.py](../backend/app/db/models.py)
- [backend/app/modules/companion/events.py](../backend/app/modules/companion/events.py)
- [backend/app/modules/companion/service.py](../backend/app/modules/companion/service.py)
- [backend/app/modules/memory/policy.py](../backend/app/modules/memory/policy.py)
- [backend/app/modules/memory/previews.py](../backend/app/modules/memory/previews.py)
- [backend/app/modules/pets/__init__.py](../backend/app/modules/pets/__init__.py)
- [backend/app/modules/pets/access.py](../backend/app/modules/pets/access.py)
- [backend/app/modules/pets/chat.py](../backend/app/modules/pets/chat.py)
- [backend/app/modules/pets/chat_router.py](../backend/app/modules/pets/chat_router.py)
- [backend/app/modules/pets/memory_policy.py](../backend/app/modules/pets/memory_policy.py)
- [backend/app/modules/pets/memory_previews.py](../backend/app/modules/pets/memory_previews.py)
- [backend/app/modules/pets/memory_router.py](../backend/app/modules/pets/memory_router.py)
- [backend/app/modules/pets/memory_runtime.py](../backend/app/modules/pets/memory_runtime.py)
- [backend/app/modules/pets/memory_service.py](../backend/app/modules/pets/memory_service.py)
- [backend/app/modules/pets/models.py](../backend/app/modules/pets/models.py)
- [backend/app/modules/pets/router.py](../backend/app/modules/pets/router.py)
- [backend/app/modules/pets/schemas.py](../backend/app/modules/pets/schemas.py)
- [backend/app/modules/pets/service.py](../backend/app/modules/pets/service.py)
- [backend/migrations/versions/0006_pet_scope.py](../backend/migrations/versions/0006_pet_scope.py)
- [backend/scripts/pet_scope_database.py](../backend/scripts/pet_scope_database.py)
- [backend/scripts/pet_scope_server.py](../backend/scripts/pet_scope_server.py)
- [backend/tests/integration/test_pet_postgres.py](../backend/tests/integration/test_pet_postgres.py)
- [backend/tests/test_auth_migration.py](../backend/tests/test_auth_migration.py)
- [backend/tests/test_chat_migration.py](../backend/tests/test_chat_migration.py)
- [backend/tests/test_chat_runtime_review.py](../backend/tests/test_chat_runtime_review.py)
- [backend/tests/test_database.py](../backend/tests/test_database.py)
- [backend/tests/test_memory_migration.py](../backend/tests/test_memory_migration.py)
- [backend/tests/test_memory_previews.py](../backend/tests/test_memory_previews.py)
- [backend/tests/test_pet_chat.py](../backend/tests/test_pet_chat.py)
- [backend/tests/test_pet_memory.py](../backend/tests/test_pet_memory.py)
- [backend/tests/test_pet_memory_races.py](../backend/tests/test_pet_memory_races.py)
- [backend/tests/test_pet_migration.py](../backend/tests/test_pet_migration.py)
- [backend/tests/test_pet_stream.py](../backend/tests/test_pet_stream.py)
- [backend/tests/test_pets.py](../backend/tests/test_pets.py)
- [backend/tests/test_schema_capabilities.py](../backend/tests/test_schema_capabilities.py)
- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- [docs/DESKTOP_PET_ROADMAP.md](../docs/DESKTOP_PET_ROADMAP.md)
- [docs/PET_DESKTOP_API.md](../docs/PET_DESKTOP_API.md)
- [docs/PET_SCOPE_CONTRACT.md](../docs/PET_SCOPE_CONTRACT.md)
- [docs/PET_SCOPE_VERIFICATION.md](../docs/PET_SCOPE_VERIFICATION.md)
- [docs/PRODUCT_SCOPE.md](../docs/PRODUCT_SCOPE.md)
- [frontend/e2e-memory/helpers.ts](../frontend/e2e-memory/helpers.ts)
- [frontend/e2e-pets/pet-scope.spec.ts](../frontend/e2e-pets/pet-scope.spec.ts)
- [frontend/e2e/chat-layout.spec.ts](../frontend/e2e/chat-layout.spec.ts)
- [frontend/playwright.pets.config.ts](../frontend/playwright.pets.config.ts)
- [frontend/src/App.tsx](../frontend/src/App.tsx)
- [frontend/src/components/layout.tsx](../frontend/src/components/layout.tsx)
- [frontend/src/features/chat/ChatProvider.tsx](../frontend/src/features/chat/ChatProvider.tsx)
- [frontend/src/features/chat/PrivateChatProvider.tsx](../frontend/src/features/chat/PrivateChatProvider.tsx)
- [frontend/src/features/chat/api-types.ts](../frontend/src/features/chat/api-types.ts)
- [frontend/src/features/chat/api.ts](../frontend/src/features/chat/api.ts)
- [frontend/src/features/chat/private-stream.ts](../frontend/src/features/chat/private-stream.ts)
- [frontend/src/features/memory/ChatMemory.tsx](../frontend/src/features/memory/ChatMemory.tsx)
- [frontend/src/features/memory/MemoryProvider.tsx](../frontend/src/features/memory/MemoryProvider.tsx)
- [frontend/src/features/memory/api.ts](../frontend/src/features/memory/api.ts)
- [frontend/src/features/memory/contracts.ts](../frontend/src/features/memory/contracts.ts)
- [frontend/src/features/memory/types.ts](../frontend/src/features/memory/types.ts)
- [frontend/src/features/pets/PetScopeProvider.tsx](../frontend/src/features/pets/PetScopeProvider.tsx)
- [frontend/src/features/pets/api.ts](../frontend/src/features/pets/api.ts)
- [frontend/src/features/pets/context.tsx](../frontend/src/features/pets/context.tsx)
- [frontend/src/features/pets/scope.ts](../frontend/src/features/pets/scope.ts)
- [frontend/src/pages/companion.tsx](../frontend/src/pages/companion.tsx)
- [frontend/src/pages/companions.tsx](../frontend/src/pages/companions.tsx)
- [frontend/src/pages/memory.tsx](../frontend/src/pages/memory.tsx)
- [frontend/src/styles.css](../frontend/src/styles.css)
- [frontend/tests/private-chat.test.mjs](../frontend/tests/private-chat.test.mjs)

本轮到此暂停，不自行提交宠物实现、合并、推送、升级共享数据库或开展桌面下一阶段。

# 消费者桌面宠物产品定位与界面范围验收

完成时间：2026-11-02T11:29:17+08:00。本轮定位与明确界面清理完成，未提交或合并。Windows 桌面产品本身尚未完成。

## 范围与分支

- Worktree：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot；分支 codex/consumer-desktop-pivot；基线 ae892ef8f834418b2f93d62bd29d7fc56babdb62。
- main 及原有6个 Worktree 的 HEAD、分支、原有工作区状态保持不变。只新增本轮分支，没有暂存、提交、推送或部署。
- 保留：真实认证、账户权限、安全、P3 会话/消息/SSE/取消/重放、P4 授权记忆/来源/删除屏障及必要 Agent Runtime。
- 移除：社区、帖子、求职记录的前端路由、导航、页面、首页推荐和虚构展示数据。旧路径进入通用 NotFound，不调用旧业务 API。通用状态提示已移出社区组件。
- 更新：消费者产品说明、我的宠物入口、普通聊天快捷操作及 Mock 历史文案。记忆新建默认 explicit_note；career_goal 契约值保留，只调整显示名称，不改写历史内容。
- 待确认：钱包/Token 入口、后台、社区审核遗留、旧分类/词法/Prompt、公开 Mock 与访客演示工具、桌面宿主、本地/云端和密钥模式。后端旧 API、模型、历史迁移和数据不删除。

## 实际测试结果

| 检查 | 本轮实际结果 |
| --- | --- |
| 前端 npm ci、后端 uv sync --frozen | 成功，依赖仅安装到本 Worktree |
| TypeScript、ESLint、前端构建 | 通过；新增测试后类型与 lint 再检查通过 |
| 前端单元测试 | 37通过、0失败/跳过 |
| 通用浏览器回归 | 89通过、0失败/跳过/flaky；267.28秒 |
| P4记忆真实HTTP浏览器回归 | 18通过、0失败/跳过/flaky；128.88秒 |
| 最终完整 pytest | 525通过、0失败、0错误、47条件跳过；收集572项，527.67秒 |
| Ruff check / format --check | 通过，136个Python文件 |
| 原库/既有隔离库/备份/旧Worktree/专用容器 | 只读检查通过，既有快照或引用一致 |
| 本轮测试服务退出 | 四个测试端口释放，无本轮遗留测试服务 |

初轮完整后端是524通过、1失败、47跳过。唯一失败为既有邮件CLI安全测试硬编码当前 checkout 的 .venv 路径，而本轮最初复用主目录解释器。随后在本 Worktree 按锁文件创建本地 venv，该用例复验1通过，再执行上表完整最终轮。原失败日志和 JUnit 保留；没有修改后端业务或测试源码、删用例、改断言或增加 skip。

47项跳过来自未开启的真实基础设施入口。本轮不向既有 PostgreSQL 写测试数据，也不开启共享库 fallback：

| 模块 | 条件跳过数 |
| --- | ---: |
| tests.integration.test_auth_postgres | 1 |
| tests.integration.test_chat_postgres | 10 |
| tests.integration.test_local_infrastructure | 9 |
| tests.integration.test_memory_p4b_postgres | 13 |
| tests.integration.test_memory_postgres | 10 |
| tests.integration.test_memory_races | 2 |
| tests.integration.test_memory_redis | 1 |
| tests.integration.test_p3_redis_pool | 1 |

## 测试环境与真实性边界

通用浏览器套件使用真实本地认证及 SQLite，同时包含既有 P3 HTTP 契约 Mock，不能全部称为真实聊天数据库联调。

P4 浏览器套件使用真实浏览器、FastAPI HTTP、Cookie/CSRF 和 owner 校验、新建 UUID SQLite 持久化；认证/限流缓存为内存实现。现有 Redis 只允许真实健康 PING，其他命令由测试夹具拒绝，不写共享键。模型是本地 ObservingMock，观察记录只保存记忆ID/版本/摘要，没有 GPT/DeepSeek 调用。

覆盖授权默认关闭、逐条确认、CRUD/导出/来源、撤销/删除后禁止使用、双账号隔离、SSE取消/恢复，以及新记忆默认普通事项、旧枚举兼容。原 P4C PostgreSQL 配置及库名/租约守卫未修改；此轮不是 PostgreSQL/Redis 认证或并发专项验收。

临时 SQLite 启动器与配置在忽略目录保留，不成为产品运行依赖。memory-local-source.json 中 real_redis:false 仅表示未使用 Redis 业务缓存；真实 PING 限定另见 memory-lane-environment.json。

## 数据与上轮中断的边界

上轮已授权的开发库 0004→0005 在本轮开始前已提交，原库现为0005/26表，原21表数据保留及5项只读健康/权限检查已有证据；该轮最终写入型冒烟和正式升级报告尚未收尾。本轮不重复迁移，也不把当前 SQLite 结果冒称该轮完整 PostgreSQL 正式验收。

原库完整提交后快照、上轮新建隔离 PostgreSQL 快照、原0004备份、51份既有证据均保持一致。未修改旧报告、备份或其他项目。本轮仅测试夹具对新建 SQLite 文件建表，没有对既有数据库执行DDL。

## 当前缺口与下一阶段

当前没有 Windows 宿主/安装包/桌面多宠物，也没有每宠物独立人格或记忆。persona 尚未真正注入 Provider，记忆仍按账户而非宠物过滤。新页面明确这些限制，不能作为宠物间隔离已完成的证据。

下一步先冻结用户＋宠物、人格、会话/记忆/授权及检索契约，旧记忆归属由用户确认；再评审 Windows 宿主和受限 IPC，完成单宠物窗口后扩展多宠物；随后按明确启用与安全验收接入 GPT/DeepSeek，完成安装、签名、升级。不要求消费者安装开发用 Docker/数据库环境，不加入喂食、金币、等级或通用 Agent 平台。

三分类与影响见 [PRODUCT_SCOPE.md](PRODUCT_SCOPE.md)，路线见 [DESKTOP_PET_ROADMAP.md](DESKTOP_PET_ROADMAP.md)。未确认事项保持原状。

## 证据与修改文件

证据目录：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\product-pivot。保留后端初轮/最终日志及 JUnit、CLI 复验、两套浏览器 JSON/日志、静态检查日志、临时测试夹具和 safety.json。

截图已实际查看：frontend/.verification/recent-topic-empty-desktop.png 和 recent-topic-empty-mobile.png。记忆浏览器另保留本 Worktree 截图及摘要观察记录。

变更文件（生成本报告前；本报告另为新增文档）：

- M README.md
-  M docs/ARCHITECTURE.md
-  M frontend/e2e-memory/memory.spec.ts
-  M frontend/e2e/chat-layout.spec.ts
-  M frontend/e2e/foundation.spec.ts
-  M frontend/e2e/recent-topics.spec.ts
-  M frontend/index.html
-  M frontend/src/App.tsx
-  M frontend/src/components/layout.tsx
-  M frontend/src/data/chat-demo.ts
-  D frontend/src/data/demo.ts
-  M frontend/src/features/memory/ChatMemory.tsx
-  D frontend/src/pages/community.tsx
-  M frontend/src/pages/companion.tsx
-  M frontend/src/pages/companions.tsx
-  M frontend/src/pages/conversation-preferences.tsx
-  M frontend/src/pages/home.tsx
-  M frontend/src/pages/memory.tsx
-  M frontend/src/pages/workspace.tsx
- ?? docs/DESKTOP_PET_ROADMAP.md
- ?? docs/PRODUCT_SCOPE.md
- ?? frontend/e2e-memory/product-scope.spec.ts
- ?? frontend/src/components/demo-notice.tsx

# P4-C 长期记忆前端与真实 API 验收

结果：**P4C_VERIFIED**。验收日期：2026-11-01（Asia/Shanghai）。

## 1. 范围与 Git 基线

- 工作目录：`D:/AIProjects/WeiBiYe-worktrees/p4c-frontend`。
- 功能分支：`codex/p4c-memory-frontend`。
- 从已验收 P4-B 提交 `3f1b540faa95bb3bf34f7f800a7d73a2c2ea5565` 创建独立 Worktree；创建前确认路径、分支无冲突，原工作区干净。
- 阅读了 P4 的 PRD、ARCHITECTURE、API、SECURITY、TEST_PLAN 五份文档及 `P4B_VERIFICATION.md`，复用 `p4-memory/1.0-draft` 契约。
- 原目录 `D:/AIProjects/WeiBiYe` 仍为 `codex/p4a-memory-foundation`，HEAD 为 P4-B 验收提交；`main` 仍为 `ae6fd44692b4011247f3b0d333fc313d7657dab8`。
- P3 后端、前端、集成 Worktree 的 HEAD 分别保持 `122fa859`、`4ce42624`、`ae6fd446`，只读核查均干净；本轮没有修改其他 Worktree、已有分支引用或共享契约。
- 仅新增两个后端**测试脚本**，没有修改后端业务代码、模型、迁移或认证安全机制。没有合并、远程推送或部署。

## 2. 已实现的前端功能

### 记忆管理

- `/memory` 使用现有登录保护与温暖简洁的视觉样式，说明为“这些是你允许我记住的事情。”
- 长期记忆默认关闭；开启需要阅读说明、勾选明确同意并确认。关闭、单条撤销、删除、清空均有对应说明与确认。
- 列表、分类筛选、详情、来源、本人手动新增、编辑、单条删除、单条停止使用、清空全部记忆、JSON 导出。
- 编辑内容会清除先前的确认勾选，必须重新核对；关闭授权后仍可管理、查看和删除保留的本人内容。
- 已撤销记录不会在再次开启总授权时自动恢复使用；当前界面没有原 ID 的重新授权按钮，提供明确重新添加的方式。
- 最近话题与长期记忆分别管理、分别显示状态，关闭其中一项不修改另一项。

### 候选与聊天

- 在本人已完成的用户消息下提供“记住这条”，先明确允许生成临时候选，再核对或编辑单条内容并确认保存。
- 预览只处理当前选择的一条用户消息；没有后台自动扫描、自动保存、批量默认确认或调用真实模型。
- 候选正文、草稿及临时回执只存在内存，关闭对话框、账号改变、隐私状态失效或五分钟回执到期后清除。
- 成功保存的来源包含原会话及消息 ID。已完成的私人 AI 回复可展示本次 Mock 上下文的记忆引用数量和失效状态，不复制旧记忆正文。
- 首页三句文案完整保留：
  - 今天还顺利吗？
  - 不管发生了什么，都可以和我聊聊。
  - 愿意和我聊聊吗？

### 状态、安全与同步

- 所有请求复用现有 Axios Cookie/CSRF 拦截器；未新增本地认证 Token 或身份传参。
- 以认证 scope 重挂私人状态，AbortController、会话对象身份及失效序号共同丢弃旧账号或旧授权响应；没有将记忆正文写入 localStorage、sessionStorage、IndexedDB 或 URL。
- 用服务器 revision 约束完整分页快照，再核对变化游标；重复页、循环游标、版本漂移及未知授权结构均不展示为可信状态。
- 通过聚焦、在线恢复、可见性变化、30 秒轮询和不含正文的 BroadcastChannel 失效通知同步其他标签页；服务器仍是授权与注入的最终权限边界。
- 不确定是否成功的写请求保留同一个幂等键和原始请求体；明确拒绝、账号切换或隐私状态失效时清理，不把网络错误显示成成功。
- 管理服务不可用时显示真实不可用状态；没有回退到演示记忆或伪造持久化结果。

## 3. API 联调范围

以下均使用现有 `/api/v1` 契约，没有更改共同 API：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / PATCH | `/memory/preferences` | 授权查询与版本化修改 |
| GET / POST | `/memory/items` | 快照分页、明确确认后创建 |
| GET / PATCH / DELETE | `/memory/items/{id}` | 本人详情、纠正、删除 |
| POST | `/memory/items/{id}/revocations` | 单条停止使用 |
| GET | `/memory/items/{id}/sources` | 真实测试核对来源及跨用户权限；界面使用详情中的 sources |
| GET | `/memory/changes` | 同步变化与快照失效校验 |
| POST | `/memory/clear` | revision 校验及明确确认后的清空 |
| POST | `/memory/export` | 本人 JSON 导出 |
| POST | `/memory/previews` | 临时候选与来源回执 |
| POST | `/memory/retrieval-preview` | 真实测试验证检索与删除/撤销后的排除 |
| GET | `/companion/sessions/{session_id}/generations/{generation_id}/memory-refs` | 生成引用及 owner 校验 |

注册、登录、退出、CSRF 获取、聊天会话、消息、生成任务和 SSE 均复用已验收的 P2/P3 服务。本轮未发送真实邮件。

## 4. 独立数据库与基础设施

测试身份在执行前及测试服务启动前均有强制校验：

| 项目 | 实际值 |
| --- | --- |
| PostgreSQL | `127.0.0.1:25433`，用户 `weibiye` |
| 集群标识 | `7703042374370492450` |
| 隔离数据库 | `weibiye_p4c_test_b957b49528c945298c5a943421d9630a` |
| 向前迁移目标 | 明确执行 `0005` |
| 表数量 | 26 张业务/认证表，另有 `alembic_version` |
| SQLAlchemy 模型比较 | `compare_metadata` 差异 0 |
| Redis | `127.0.0.1:26380/0`，真实 PING、认证存储、限流及 SSE 槽位 |
| Redis 写入隔离 | `p4c:test:b957b49528c945298c5a943421d9630a:` 命名空间与 TTL |
| 真实测试 API / UI | `127.0.0.1:38305` / `127.0.0.1:35305` |
| 原有浏览器回归 API / UI | `127.0.0.1:28101` / `127.0.0.1:25174` |

- 隔离库是本轮新建的唯一数据库。没有 drop、truncate、downgrade、删除测试库或修改其他项目数据库。
- 共享开发库 `weibiye` 全程保持 **0004 / 21 张业务认证表**。测试前后比较完整表结构、每表记录数及每表全部记录的 SHA-256，完全一致。
- 两个未毕业专用容器的 ID、运行/健康状态、启动时间、重启次数、端口与挂载保持一致。只读 inspect，没有启动、停止、重建或清理 Docker 资源。
- Redis 实例 run ID 一致，测试写入受独立前缀隔离；不声称 Redis 中完全没有新增测试键。
- 测试数据为合成数据，所有写入仅在隔离库。包括排错重跑后，隔离库保留 43 个测试账号、20 次生成、40 条聊天消息及 28 条记忆记录（含已撤销/删除墓碑）；未进行破坏性清理。
- 收尾时模型比较仍为 0，隔离库无遗留 idle-in-transaction 连接。

## 5. 实际测试结果

以下为**修复后同一份冻结前端代码**的最终结果，不把重跑累计为新增测试：

| 检查 | 通过 | 失败 | 跳过 | 说明 |
| --- | ---: | ---: | ---: | --- |
| TypeScript | 通过 | 0 | 0 | `npm run typecheck` |
| ESLint | 通过 | 0 | 0 | `npm run lint`，max-warnings 0 |
| 前端构建 | 通过 | 0 | 0 | `npm run build`，Vite 构建 9.83 秒 |
| 前端单元测试 | 37 | 0 | 0 | `npm run test:unit`，其中新增 9 项记忆契约/快照/幂等测试 |
| 既有完整浏览器回归 | 87 | 0 | 0 | 291.35 秒；retries=0，flaky=0，全局错误 0 |
| P4-C 真实 API 浏览器验收 | 13 | 0 | 0 | 146.64 秒；retries=0，flaky=0，全局错误 0 |
| 新增后端测试脚本 Ruff | 通过 | 0 | 0 | `ruff check` 与 `ruff format --check`，2 个文件 |
| 隔离库迁移与最终完整性核对 | 通过 | 0 | 0 | 0005/26 表、模型差异 0、共享库及专用容器快照一致 |

浏览器合计 **100 个不同用例通过**，使用已安装的 Chrome。87 项既有回归保留原断言，其中 P3 HTTP 契约用例包含显式 Mock；其认证服务使用原有 SQLite/内存测试夹具。它们不能算作 87 项 PostgreSQL 联调。

另 13 项为真实 React → FastAPI → 独立 PostgreSQL / Redis 的联调，没有伪造成功业务响应。它们包含：

1. 默认关闭、明确开启、关闭、刷新与最近话题授权独立。
2. 延迟真实 `/auth/me` 时不展示可发送的访客输入框；恢复身份后只创建真实私人会话。
3. 手动创建、纠正、详情、来源、下载 JSON、删除后 404、旧创建幂等请求 410、检索无已删除项。
4. 单条撤销、管理保留内容、清空单独确认、导出排除已删除内容。
5. 候选预览不写入，逐条确认后来源正确；实际 Mock 输入中 memory ID、version 与内容 SHA-256 符合预期。
6. 两个独立账号的授权、详情、来源、会话、生成引用及检索隔离；越权返回 404，退出后返回 401；同一页面切号不残留另一用户内容。
7. 五分钟后清除候选正文、草稿、回执及勾选，原聊天不受影响。
8. 同账号另一标签页关闭授权后同步；再次开启不复活旧已撤销记忆。
9. 同页切号后丢弃账号 A 已返回但延迟送达的真实记忆响应。
10. HttpOnly / SameSite Cookie、缺失 CSRF 返回 403、伪造 owner 字段返回 422；取消生成与排他事件重放不保存记忆。
11. 首个真实 SSE 请求发生连接故障后恢复，数据库与界面仍各一条用户/助手消息、记忆不重复。
12. 离线写入不显示成功，恢复后重新读取真实服务器状态。
13. 390×844 移动视口中授权、创建、详情及 SSE 聊天可用，无横向溢出。

故障注入仅包含：延迟真实身份或记忆响应、首次 SSE 请求 `route.abort`、浏览器离线及浏览器时钟推进。API 的成功响应、Cookie、CSRF、owner 检查、数据库落盘与检索结果均来自真实服务。

本轮没有重跑未修改的全部后端 pytest；P4-B 既有后端验收不能作为本轮新执行数量。删除/撤销后的本轮浏览器负例直接验证检索排除和授权失效，未再次发起聊天并直接断言 Spy 负输入；该输入屏障的后端覆盖见既有 P4-B 验收。

### 排错记录

- 首轮真实浏览器 9 通过 / 3 失败；既有浏览器回归 85 通过 / 2 失败。发现身份恢复期间可能暂时使用访客聊天、候选表单 label 关联不准确，以及空白会话依赖 `location.key` 导致重复首页导航重挂输入框。
- 修复身份加载门控，新增确定性延迟真实 `/auth/me` 回归；修复真实可访问标签关联，并补齐候选五分钟清除与回归、小屏对话框限高滚动。
- 第二轮真实联调 13 通过；既有回归 86 通过 / 1 失败。保留了 P3 原断言，修复稳定空白会话 key，并通过显式“新建聊天”事件清空草稿，避免重复导航丢失输入或发送后的路由状态。
- 原 P3 超时幂等重试用例首轮曾等待按钮失败，后续两轮均通过；没有修改该用例或放宽其断言。
- 修复后原先失败的新建聊天用例单独通过，随后再次完整执行，得到上表最终 87 + 13 全通过结果。没有删除测试、跳过失败或降低权限检查。

## 6. 本地证据与截图

下列证据位于本 Worktree 的 `.verification/`，受 `.gitignore` 排除，不提交账号数据、快照、日志或测试产物：

| 文件 | SHA-256 |
| --- | --- |
| `p4c-memory-verified-results.json` | `4aed9bdc702d1aecb7009a7e2f7628687f017a646666ff8a6204c721aa611e54` |
| `p4c-regression-verified-results.json` | `3f4b1c8f1966ffe5594fec396dd5089b44d330502f2ae9c18873246a5471d4c1` |
| `p4c-isolated-final.json` | `50c93f67c1c1d322f6311408fe6903c5345837b0e591a7b64ac5021701bcc68a` |

- 最终日志：`.verification/p4c-memory-verified.log`、`p4c-regression-verified.log`、`p4c-typecheck.log`、`p4c-eslint.log`、`p4c-build.log`、`p4c-unit.log`。
- 已保留早期失败的报告、日志及后续独立输出目录，没有用最终成功覆盖排错证据。
- 桌面截图：`D:/AIProjects/WeiBiYe-worktrees/p4c-frontend/.verification/screenshots/p4c-memory-desktop.png`。
- 移动截图：`D:/AIProjects/WeiBiYe-worktrees/p4c-frontend/.verification/screenshots/p4c-memory-mobile.png`。
- 已实际查看两张截图；这是 Chromium 移动视口验证，不是原生 App、真机软键盘或辅助技术的完整验收。

## 7. 修改文件清单（23 个）

```text
backend/scripts/p4c_memory_database.py
backend/scripts/p4c_memory_server.py
docs/P4C_VERIFICATION.md
frontend/e2e-memory/helpers.ts
frontend/e2e-memory/memory.spec.ts
frontend/playwright.memory.config.ts
frontend/src/App.tsx
frontend/src/chat.css
frontend/src/components/layout.tsx
frontend/src/features/chat/ChatProvider.tsx
frontend/src/features/memory/ChatMemory.tsx
frontend/src/features/memory/MemoryProvider.tsx
frontend/src/features/memory/api.ts
frontend/src/features/memory/context.ts
frontend/src/features/memory/contracts.ts
frontend/src/features/memory/types.ts
frontend/src/main.tsx
frontend/src/memory.css
frontend/src/pages/companion.tsx
frontend/src/pages/conversation-preferences.tsx
frontend/src/pages/memory.tsx
frontend/tests/memory.test.mjs
frontend/tsconfig.json
```

## 8. 收尾、安全边界与遗留事项

- Playwright 两套最终执行均正常以 exit code 0 结束。收尾查询四个测试端口均无监听，未发现本 Worktree 的测试 Python/Node 进程；没有停止其他进程。
- 待提交内容只包含上述源码、测试与文档，排除 `.verification`、`.venv`、`node_modules`、`dist`、下载、缓存及密钥文件。新增配置中的测试 HMAC 标记为 test-only，不是生产凭据。
- 对改动文件进行了私钥、常见真实 API 密钥和带明文凭据数据库 URL 的模式扫描，无匹配；最终 API 日志及 Mock 观察记录未出现测试记忆正文或会话 Cookie 值。观察记录只保存 ID、版本和合成正文摘要，不保存完整 Prompt。
- 导出是用户主动下载的本人数据，下载完成后服务器无法撤回用户保存的副本；Blob URL 会回收。前端内存清除不等同于操作系统内存取证清除或备份物理擦除。
- 跨标签同步是失效通知和轮询机制，不能撤回已经交付给浏览器或模型的内容；新使用仍由 P4-B 服务端授权/epoch 屏障控制。
- **真实 API、数据库、Redis 与权限联调已通过；AI 回复仍是本地 Mock。真实付费模型、语义向量检索及真实模型的长期记忆效果没有实现或验收。**
- 原有 LangGraph 通过本地 observing Mock 验证实际收到授权内容，并非仅在前端显示引用；没有引入复杂多智能体。
- 共享开发库保持 0004，默认长期记忆开关未改动。若要在共享开发环境使用 P4 功能，需要另行授权升级到 0005，并按现有设计配置管理/注入开关及专用 HMAC 密钥。
- 生产级备份保留与物理擦除、多端原生同步、原生软键盘、语义检索和原 ID 重新授权交互属于后续阶段。
- 本轮仅在 `codex/p4c-memory-frontend` 创建本地提交，未合并 main、未推送。提交哈希通过最终交付与 `git log -1` 获取，避免文档自引用提交哈希。

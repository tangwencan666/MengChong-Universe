# P3 集成修复与工程验收

最终状态：**P3_INTEGRATION_VERIFIED**。全部必要本地验收通过；仅准备并创建集成分支的本地提交。

日期：2026-11-01，Asia/Shanghai。所有修改仅在
`D:\AIProjects\WeiBiYe-worktrees\p3-integration` 的
`codex/p3-chat-integration` 分支。本报告随本地验收提交保存，不推送、不合并主分支。

## 基线与隔离

| 项目 | 固定版本 / 目标 |
| --- | --- |
| 共同契约基线 | `e62d3864ee094404a995a79b1ea10429ac9966ff` |
| 后端最终提交 | `122fa85945af87e72cbe4d9e1d18cb98e4b1ec65` |
| 前端最终提交 | `4ce426241cb7df9ccd6433dd2f407a495cc16c7a` |
| 已有后端集成提交 | `92e1d0f1263cfd5bbcc1fa767ecddb7cc1ae1d90` |
| 已有前端集成提交 | `b309c8e7a4f83cacdb1f4380f4dfc0565ee33f6f` |
| 独立聊天测试库 | `weibiye_p3_test_3718ead5af094090b74f884e3309fa93` |
| 独立认证回滚测试库 | `weibiye_p3_test_ed8135907c9944f5b5525cfbd460dcfa` |
| PostgreSQL | `127.0.0.1:25433`，专用实例、用户 `weibiye` |
| PostgreSQL 集群标识 | `7703042374370492450` |
| 独立 Redis | `127.0.0.1:26380/15`，实例与随机所有权 lease 双重检查 |
| 真实联调 UI / API | `127.0.0.1:35174` / `127.0.0.1:38101` |
| SQLite / HTTP 夹具回归 UI / API | `127.0.0.1:25174` / `127.0.0.1:28101` |

接管时两个功能分支的 HEAD 均符合验收版本且干净；集成目录已包含上述两次合并和在途测试，未重新创建 Worktree、未重复启动原有 76 项测试。其他窗口暂停写入后，本窗口接管后续修复。原功能 Worktree 和主项目仅做只读核验。

所有真实写入均限定上述隔离库，不复用开发库。Redis `/15` 在准备时为空，随后以随机 lease 占用；不清空逻辑库、不修改 `/0`。连接信息通过子进程环境传递，不记录密码、Cookie 或邮件令牌。

## 修复及契约同步

1. connection `STREAM_UNAVAILABLE` 与 HTTP 410 都先读一致性快照，再从权威游标恢复；不重新 POST 生成任务。
2. cancel 200 的 queued 取消或完成先赢得竞态，都直接同步已保存助手消息；终态快照读取失败保留 GET 重新连接入口，不重复取消。
3. Message / Generation 新增 `finish_reason: stop|length|null`。从同 owner、同 session 的持久 completed 事件读取，快照、历史、终态取消和幂等重放一致；历史查询无 N+1。旧数据没有依据时返回 null。
4. CORS 暴露 `Retry-After`，保留精确 Origin 白名单、Cookie、CSRF 和原权限机制。真实跨源浏览器检查响应头可读；单元测试验证退避。
5. 终态主动取消旧详情请求再刷新；历史与详情按较高版本合并。重命名先读取服务端元数据再打开编辑框；保存保持编辑开始时的版本，409 不覆盖另一窗口修改。
6. 首页/聊天重新聚焦同步历史、消息、授权与话题。授权复核期间隐藏旧推荐，失败保持关闭；隐藏话题后重新同步偏好版本，阻止旧版本写入。
7. Redis 连接池上限 32；真实池耗尽时 readiness 与认证关闭访问，释放后恢复，无需重启 Redis。
8. HTTP 契约夹具先停止页面请求，等待全部在途认证 handler，再卸载路由，修复卸载时自动放行导致的重复处理。没有删除测试或弱化业务断言。

集成协调窗口将文档同步为 `p3-chat/1.0-integration.1`，SSE 数据版本仍为 `1`；原始功能分支及其契约不变。REST 路径、方法、身份来源与写请求 CSRF 规则保持一致。未修改任何历史迁移、数据库模型或认证业务实现。

## 本次修复提交文件

相对于已有前后端集成提交 `b309c8e`，本次包含以下文件（不含已在两个功能提交中的原 P3 实现）：

- `backend/app/main.py`
- `backend/app/modules/companion/schemas.py`
- `backend/app/modules/companion/service.py`
- `backend/scripts/p3_integration_acceptance.py`
- `backend/scripts/p3_integration_audit.py`
- `backend/scripts/p3_integration_database.py`
- `backend/scripts/p3_integration_server.py`
- `backend/tests/integration/test_auth_postgres.py`
- `backend/tests/integration/test_p3_redis_pool.py`
- `backend/tests/test_chat_cors.py`
- `backend/tests/test_chat_integration_regressions.py`
- `backend/tests/test_integration_harness_guards.py`
- `docs/P3_CHAT_API_CONTRACT.md`
- `docs/P3_INTEGRATION_REPORT.md`
- `frontend/e2e-integration/p3-real.spec.ts`
- `frontend/e2e/auth.spec.ts`
- `frontend/e2e/helpers/p3-chat-mock.ts`
- `frontend/e2e/p3-chat.spec.ts`
- `frontend/e2e/p3-integration-regressions.spec.ts`
- `frontend/playwright.config.ts`
- `frontend/playwright.integration.config.ts`
- `frontend/src/components/layout.tsx`
- `frontend/src/features/chat/PrivateChatProvider.tsx`
- `frontend/src/features/chat/api-types.ts`
- `frontend/src/features/chat/private-stream.ts`
- `frontend/src/features/chat/types.ts`
- `frontend/tests/private-chat.test.mjs`
- `frontend/tsconfig.json`

## 数据库与外部状态

隔离聊天库已实际按 `0003 → 0004` 前向迁移，18 → 21 张业务/认证表，另有 `alembic_version`。实际目录核验：36 个外键、24 个唯一约束、42 个 CHECK、35 个独立索引，无无效索引或未验证约束。模型与真实数据库元数据漂移、最终连接清理见末尾验收结果。

开发库 `weibiye` 的原始准备记录为 `0003`、18 张业务/认证表，所有表计数为 0。接管时补充了结构、约束、索引与计数 SHA-256，以及三个原 Worktree 的全部受跟踪文件 SHA-256。

Docker 全量细粒度快照从 **16:52:23 接管时点**开始，包含 420 个既有容器；不能将它描述为最初集成启动前的完整快照。原始准备阶段的开发库版本/表数/记录计数另行对照。Project Sentinel 在本轮前即存在自动重启，最终报告单列实际变化，不宣称全部容器运行状态完全静止。

没有执行 Docker 启停、重建、删除、prune，或 PostgreSQL downgrade、drop、truncate。现有容器工作目录标签不改，仍通过宿主机专用端口使用现有实例。隔离数据库、合成账号及测试证据保留，不执行清库。

## 真实浏览器验收范围

真实测试启动单个 FastAPI / LangGraph runner，使用 PostgreSQL、Redis 认证/限流与 React。注册账号均为本轮生成的 `browser-<uuid>@example.com`，没有真实用户内容或真实邮件发送。

- 注册、登录、退出、HttpOnly / SameSite Cookie、CSRF、CORS，以及浏览器持久化存储中无长期认证令牌。
- 新建、多轮发送、流式回复、刷新和重新登录后的历史恢复、重命名及逻辑删除。
- SSE 顺序、排他 Last-Event-ID 重放、断网、真实浏览器传输停滞后的超时与恢复。
- cancel 等待服务器终态，部分消息持久化；重复提交、已提交但响应丢失后使用原幂等键重试。
- 事件日志缺口由后端返回 connection error；重放过期返回 410；浏览器恢复相同任务的权威快照。仅在明确归属的隔离测试记录上制造故障，日志序号及时间在 finally 中恢复，不删除事件。
- 长度截断后的首次快照、历史刷新与会话切换保留 length 提示。长度边界仅由受保护测试启动器内的显式合成 Mock 场景产生。
- 双账号会话、消息、事件、重命名、删除、取消、重试、话题隐藏均校验 owner；最近话题来源 ID 与授权偏好互不泄露；同一浏览器 A → B 清理旧缓存。
- 服务端认证会话确实过期、Cookie 仍存在时返回 401，页面清理私人内容；另有客户端清 Cookie 场景。
- 真实跨源 SSE 429 暴露 Retry-After，Redis SSE 配额断开后释放。
- 桌面、390px / 320px、抽屉、移动输入换行与无横向溢出；物理手机软键盘属于后续人工设备检查。

**真实 API / 数据库联调与 AI 能力分开：** 上述会话、消息、认证、授权均使用真实 API 与存储；AI 回复由本地固定 Mock Provider 生成，usage 为 null，不调用付费模型、不写钱包账本。长期记忆的授权、摘要与检索尚未实现，最近话题只摘录已保存消息，并不等于长期记忆。

## 实际测试记录

失败记录均保留在 ignored `.verification`，未用覆盖或跳过断言伪装通过。定向与全量运行有重叠，不能把各轮数字相加为不同用例总数。

| 轮次 | 结果 | 说明 |
| --- | --- | --- |
| 接管的原在途浏览器 | 76 通过，0 失败，0 跳过 | SQLite 认证与聊天 HTTP 夹具；未重复启动 |
| 第一版完整后端 | 190 通过，0 失败，9 跳过 | 包含真实隔离 PostgreSQL/Redis 测试 |
| 第一版完整浏览器 | 83 通过，0 失败，0 跳过 | 修复 SSE / metadata 后 |
| 取消快照失败专项首次 | 7 通过，1 失败 | 路由夹具卸载竞态；修复后 8 通过 |
| 真实浏览器首次 | 19 通过，2 失败 | 话题保存前过早刷新、正常重命名旧版本；据此补同步与断言 |
| 扩展完整浏览器首次 | 82 通过，4 失败 | 3 个夹具卸载竞态，1 个初次旧详情请求未取消 |
| 真实浏览器中间复验 | 19 通过，2 失败 | 吞吐限速不确定性及授权复选框读取前空操作；均修复测试时序，不删除功能断言 |
| 真实定向复验 | 2 通过，0 失败，0 跳过 | 实际 SSE 响应传输暂停、话题授权完整流程 |
| 专项 10 项 | 10 通过，0 失败，0 跳过 | 取消、事件缺口、元数据、版本与偏好同步 |
| 完整浏览器后续复验 | 86 通过，0 失败，0 跳过 | 正确卸载夹具及旧详情请求取消后 |
| 真实浏览器后续复验 | 20 通过，1 失败 | 快速打开重命名编辑框仍取旧版本；继续修复，不认定通过 |
| 离线隔离守卫 | 39 通过，0 失败，0 跳过 | 临时文件，所有外部依赖被阻断 |
| 最终完整 pytest | 229 通过，0 失败，9 跳过 | 238 项收集；新增守卫纳入全量，237.39 秒 |
| 移动端认证恢复等待修复前 | 86 通过，1 失败 | 刷新后过早打开访客导航；新增明确账户恢复前置断言，原导航断言保留 |
| 最终完整浏览器 | 87 通过，0 失败，0 跳过 | 11 项新增集成回归纳入全量；4.3 分钟 |
| 最终真实 API / PostgreSQL / Redis 浏览器 | 21 通过，0 失败，0 跳过 | 独立账号、真实存储与传输；2.9 分钟 |
| TypeScript / ESLint / build / unit / Ruff | 全部通过；unit 28 通过，0 失败，0 跳过 | Ruff check / format：100 个 Python 文件；构建成功 |

9 项跳过是显式启用的旧本地基础设施套件，其原连接目标为开发库；本轮未启用会复用开发库的检查，不把跳过计作通过。对应真实健康、连接、迁移、并发及权限在隔离目标验收。

## 复验命令与证据

以下在集成目录的 `backend` 执行，使用本项目虚拟环境，不安装全局软件：

```powershell
.venv/Scripts/python.exe -B scripts/p3_integration_acceptance.py backend -q
.venv/Scripts/python.exe -B scripts/p3_integration_acceptance.py browser
.venv/Scripts/python.exe -B scripts/p3_integration_database.py verify
.venv/Scripts/python.exe -B scripts/p3_integration_audit.py verify
.venv/Scripts/python.exe -B -m ruff check app tests scripts
.venv/Scripts/python.exe -B -m ruff format --check app tests scripts
```

在 `frontend` 执行：

```powershell
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```

真实测试命令要求本 checkout 已核准的 `.verification/p3-integration-target.json` 与 Redis 所有权 lease；不会回退到开发库。全新验收必须在 manifest 不存在且 Redis `/15` 空闲时单独执行 `p3_integration_database.py prepare`，创建两个新的随机库并仅向前迁移；已有 manifest 会拒绝重复准备。当前已存在的库不重新创建。自动双库准备路径的守卫有离线测试，本轮未为了复演新增初始化逻辑而再造一组数据库。

真实截图位于：

- `D:\AIProjects\WeiBiYe-worktrees\p3-integration\frontend\.verification\p3-real\desktop.png`
- `D:\AIProjects\WeiBiYe-worktrees\p3-integration\frontend\.verification\p3-real\mobile.png`

迁移与安全证据：`.verification/p3-integration-target.json`、`p3-safety-before.json`、最终 `p3-safety-after.json`。最终测试 XML 为 `.verification/backend-acceptance.xml`、`browser-full-final-pass.xml`、`browser-real-acceptance.xml`；另有 `test-process-cleanup.json`、`acceptance-source-sha256.json` 及静态检查日志。上述机器证据均不暂存。

## 最终安全核验与限制

所有测试命令已结束并返回成功（最终 pytest、两套浏览器、Ruff、TypeScript、ESLint、单元与构建）；失败轮次保留，不计作最终通过。

- `2026-11-01T17:35:29+08:00`：四个测试端口 25174 / 28101 / 35174 / 38101 无监听，项目测试 Python / Node 服务进程为 0。Playwright 管理的测试进程树已退出；未停止任何其他服务。
- PostgreSQL / Redis 原专用端口继续仅监听 `127.0.0.1`。两专用容器与接管快照完全一致，健康、启动时间、重启计数、镜像、端口及网络均未改变。
- 420 个原容器 ID 集合不变；不可变配置未变化；意外容器变化为 0。8 个 `project-sentinel-*` 既有容器发生其原重启策略下的自动重启/动态网络与健康变化，明确列在 `p3-safety-after.json`，本轮没有操作这些容器，不能说它们的所有状态未变。
- 开发库仍为 `0003`、18 张业务/认证表且全为 0 行；与原始准备记录一致，与接管时结构、约束、索引和计数 SHA-256 也完全一致。
- 集成库仍为 `0004`、21 张业务/认证表；模型漂移为 0，`idle in transaction` 为 0。测试库保留合成数据；wallets、wallet_transactions、wallet_reservations、usage_records、memories、job_applications 与社区表均无新增业务记录。
- 主项目及后端/前端原 Worktree 的分支、HEAD、干净状态和全部受跟踪文件 SHA-256 与接管基线一致。
- 171 个代码、测试及 CI 文件的冻结 SHA-256 已复验；最后一次真实浏览器后仅增加认证测试的等待断言，生产源码不变。最终浏览器运行与 `acceptance-source-sha256.json` 一致。
- 提交仅包含本报告列出的 28 个集成文件。暂存审查排除凭据、缓存、虚拟环境、node_modules、数据库、截图、日志及其他测试产物；本报告随该本地提交保存，最终哈希以集成分支 `git log -1` 和交付消息为准。不推送、不合并主分支。

尚未实现或未验收的能力包括：真实模型调用、真实模型语义质量、安全分类器、长期记忆摘要/检索、物理数据擦除及完整保留策略、支付与计费、多进程部署和生产负载。现有事件物理保留与逻辑删除遵循 P3 契约；未来清理事件前必须保存完成原因等持久元数据。没有公网部署或远程 CI 执行，本轮不以 CodeRabbit 的结果替代安全与浏览器验收。

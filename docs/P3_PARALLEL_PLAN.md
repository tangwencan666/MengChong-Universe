# P3 前后端并行开发计划

状态：**用户已授权审核后仅提交两份契约文档并创建两个 Worktree；不启动 P3 业务编码。**

第 1–9 节保留前次设计阶段的检查记录与后续开发规划，其中“本轮不提交/不创建”描述的是前次设计任务。当前环境准备以第 10 节及用户最新授权为准；此前关于业务实现、数据库、Docker 与合并的限制继续有效。

本计划依据 [P3_CHAT_API_CONTRACT.md](P3_CHAT_API_CONTRACT.md) 的 `p3-chat/1.0-draft`。检查日期 2026-11-01。

## 1. 已检查的起点

| 项目 | 本轮结果 |
| --- | --- |
| 独立 Git 根目录 | `D:/AIProjects/WeiBiYe` |
| 当前分支 | `codex/p25-auth-recovery` |
| 当前 HEAD | `37de383539ec73b512cbbd61e6ae7b9e3607109e`，`feat(auth): complete local verification and password recovery` |
| 前一提交 | `967d68b2de25c48cac98b1f6e8b36bd924646d4b`，`chore: establish verified WeiBiYe P2 baseline` |
| 开始时 Git 状态 | 干净；237 个已跟踪文件 |
| 已有 Worktree | 仅根工作目录，没有前后端并行目录 |
| 新增交付 | 两份 P3 文档；无业务代码变化 |
| 迁移代码 head | `0003`，`0003_password_recovery.py`；未查询在线数据库 |
| 认证边界 | 复用现有 Cookie/CSRF/Origin/撤销与 owner 404 策略 |
| 现有聊天 | 公共单轮无状态 Mock；私人读取，发送 501；前端历史仅内存 |
| 现有 CI | 独立仓库的 `.github/workflows/weibiye-ci.yml`；本地相对路径 `frontend/`、`backend/`；权限 contents:read，没有部署或推送步骤 |

P2.5 报告中的 102 passed/9 skipped 与 49 浏览器通过属于此前验收，不能当作 P3 测试结果。本轮不复跑服务、容器或数据库验收。

## 2. 准备两个 Worktree

### 2.1 分支与目录

| 用途 | 规划分支 | 规划路径 |
| --- | --- | --- |
| 后端窗口 | `codex/p3-chat-backend` | `D:\AIProjects\WeiBiYe-worktrees\p3-backend` |
| 前端窗口 | `codex/p3-chat-frontend` | `D:\AIProjects\WeiBiYe-worktrees\p3-frontend` |
| 协调与集成 | `codex/p3-chat-integration` | 保留主目录 `D:\AIProjects\WeiBiYe`，后续授权时切换 |

Worktree 是同一独立 Git 仓库的不同分支/目录，共享提交对象，不是复制项目再 git init。两个开发窗口不可检出同一分支，不可在另一个窗口目录运行写命令。不得使用旧 AgentForge-AI 目录。

**当前不创建这些目录，也未检查它们未来是否可用。**实施前重新核对 `git status`、`git worktree list`、分支是否存在、路径是否存在；发现已占用或非空即停，不删除、不强制覆盖、不 prune。

### 2.2 基线与未来命令

当前 P2.5 基线是 `37de383...`，但本轮契约尚未提交，其他 Worktree 不会自动得到未跟踪文档。用户确认设计后，由协调窗口先审阅并按授权建立包含两份契约的本地提交，记录它的完整 SHA 为 `P3_BASE_SHA`。两个 Worktree 必须从这个**相同提交**创建，而不是各自从变化中的 HEAD 起步。

以下是供下一轮授权后执行的命令模板，`<P3_BASE_SHA>` 要替换为实际契约基线；**本轮没有执行**：

```powershell
git -C D:\AIProjects\WeiBiYe status --short
git -C D:\AIProjects\WeiBiYe worktree list --porcelain
git -C D:\AIProjects\WeiBiYe branch --list codex/p3-chat-backend codex/p3-chat-frontend codex/p3-chat-integration

git -C D:\AIProjects\WeiBiYe worktree add -b codex/p3-chat-backend D:\AIProjects\WeiBiYe-worktrees\p3-backend <P3_BASE_SHA>
git -C D:\AIProjects\WeiBiYe worktree add -b codex/p3-chat-frontend D:\AIProjects\WeiBiYe-worktrees\p3-frontend <P3_BASE_SHA>
```

执行前还须单独用 `Test-Path` 检查两个路径；模板没有授予覆写权限。若已有同名分支/Worktree，先核查其用途，不用 `--force`。本轮不提交契约，也不替用户创建新的 Codex 窗口。

## 3. 文件修改边界

### 3.1 后端窗口独占

- `backend/app/modules/companion/**`：会话、消息、任务、偏好和最近话题的 schema/router/service/repository。
- `backend/app/agent/**`：有界上下文、私人 Mock、生成流程、事件编码、取消/超时；保留公开演示协议。
- `backend/migrations/**` 与 `backend/app/db/models.py`：只由后端创建一次 `0004`，注册新实体；不能各自产生迁移 head。
- `backend/tests/**`：新接口、安全、协议、重启与并发测试；维护现有测试，不能删除断言来消除回归。
- `backend/scripts/**`：测试服务参数化、非破坏性目标校验和迁移检查；保留“未知目标即拒绝”的保护。
- `backend/app/main.py`：仅增加 runner 生命周期、必要的 `Last-Event-ID` CORS 允许头等集成。现有认证中间件、CSRF 和 Origin 语义不变。
- `backend/app/core/config.py`、`core/rate_limit.py`、`core/errors.py`：仅新增聊天所需配置、命名空间和安全错误，不改现有 auth 限流/安全默认值。
- `backend/pyproject.toml`、`backend/uv.lock`：仅确需依赖变更时成对维护，不顺手升级技术栈。

**受保护区域：**`modules/auth/**`、`modules/users/**`、`core/security.py`、`core/ownership.py`、现有认证表与 `0001–0003` 迁移，原则上不改。若 P3 真有必须修改的公共接口，先由协调窗口更新契约并确认范围；不能借聊天开发重构认证。新增聊天 owner 过滤不应依赖修改这些文件。

### 3.2 前端窗口独占

- `frontend/src/features/chat/**`：服务端 DTO 适配、Query keys、真实会话状态、流去重恢复、卡片与演示隔离。
- `frontend/src/lib/sse.ts` 或新增私人流模块：保留公开 `streamMock`，分离私人 GET SSE 解析与恢复策略。
- `frontend/src/lib/api.ts`：复用现有 Axios 命令及错误处理；只允许聊天接入所需的增量适配，保留 Cookie、CSRF、scope 隔离和登录过期语义，不改令牌存储方式。
- `frontend/src/App.tsx`、`pages/companion.tsx`、`pages/conversation-preferences.tsx`、布局与导航组件、聊天样式：仅连接真实聊天所需调整，保留文案及移动端行为。
- `frontend/e2e/**`：新增聊天测试和明确标注的契约 fixture，保留原认证/恢复及演示回归场景。
- `frontend/playwright.config.ts`、`vite.config.ts`、`package.json/package-lock.json`：必要端口参数化、测试和构建配置，不改后端脚本。

**受保护区域：**认证状态机与登录/恢复页面、安全相关 API 拦截器逻辑不得为 Mock 方便而绕过。若需共用“身份失效”处理，复用 `weibiye:unauthenticated` 与 `scopeVersion`，不复制一个更宽松的认证实现。

前端不能编辑 `backend/**` 修复契约问题；后端不能编辑 `frontend/**` 配合自己的响应。需要两侧变化时，由协调窗口按第 7 节安排串行交接。

### 3.3 协调窗口独占

- `docs/P3_CHAT_API_CONTRACT.md`、`docs/P3_PARALLEL_PLAN.md` 及后续 P3 总验收报告。
- 根 `.env.example`、README、`.github/workflows/**` 等跨前后端文件。双方提出建议，由协调窗口落地。
- 契约版本、错误码/字段变更、测试端口分配、迁移目标确认与最终合并。
- 本轮及 P3 常规编码均不修改 Compose 或操作已有 Docker 资源；若未来确需变更，另行请求授权。

提交前各窗口检查文件列表，只包含自己拥有的路径。发现别人未提交修改或超出边界的文件，停止相应编辑并报告，不能恢复、清理或覆盖。

## 4. 环境与数据隔离

### 4.1 不共享运行产物

每个 Worktree 自己创建被忽略的 `.venv`、`node_modules`、`.verification`、Mock 邮件目录和测试 SQLite 文件；不复制旧缓存，不共享数据库文件、不读取其他项目 .env，也不提交生成的凭据/恢复令牌。

`Settings` 当前不隐式加载 `.env`，后续启动命令显式设置本窗口的 `WEIBIYE_*`，不使用全局 `setx`。真实模型开关始终 false，公开演示仍固定 Mock。不得因为测试需要降低生产 Cookie/邮箱验证/Redis 配置校验。

### 4.2 规划端口

下表只是分配草案，**本轮未检测占用、绑定或启动服务**。每次启动前检测对应端口和已运行进程，发现占用停止，不杀其他进程。全部仅绑定 `127.0.0.1`。

| 窗口 | 手工 UI / API | Playwright UI / API |
| --- | --- | --- |
| 后端 | UI 按需 `35184` / API `38111` | `25184` / `28111` |
| 前端 | UI `35185` / API（确需本地联调时）`38112` | `25185` / `28112` |
| 最终集成（原默认） | `35174` / `38101` | `25174` / `28101` |

**现有固定端口不能直接让两套浏览器测试同时跑。**后端先给 `backend/scripts/e2e_server.py` 增加显式测试端口/Origin 参数；前端同时给 Playwright 增加对应参数，并保留现有默认值。串行交接以实际合并的提交 SHA 为依据；参数化完成前，沿用单一 E2E 运行锁，两个窗口不得并发执行整套浏览器测试。

Vite 当前支持 `WEIBIYE_DEV_API_TARGET`，未来手工前端可指定本窗口 API。CORS/`frontend_origin` 精确列出本窗口 UI Origin；不能用 `*`。Windows 后端保留 `app.core.event_loop:new_event_loop`。不启用 `reuseExistingServer: true` 复用不明身份的后端。

### 4.3 数据库与 Redis

- 既有专用 PostgreSQL `127.0.0.1:25433/weibiye` 和 Redis `127.0.0.1:26380/0` 保持原状。容器工作目录标签仍处于历史迁移过渡状态，本轮不检查或修改标签，不重建容器。
- 并行默认测试使用各 Worktree 新建的 SQLite 数据库与进程内测试 AuthStore/限流；不能用开发 `weibiye` 库作为两边共享写入沙箱。
- PostgreSQL 的行锁、部分唯一约束、独立连接可见性、崩溃恢复与 lease 竞争需要真实实例验收。实施阶段需明确授权创建全新 `weibiye_p3_test_<run_id>` 测试数据库，或指定一个已确认专用且隔离的测试库；只使用现有未毕业实例，不创建/操作其他项目容器。
- 该授权和目标未满足时，真实 PG 并发验收标记阻塞；不能用 SQLite 或 skip 数量掩盖。绝不清空既有开发库来满足 fixture 的空库前提。
- 现有 `tests/integration/test_auth_postgres.py` 硬编码 head `0003`、要求现有数据全空，并把请求绑定同一外部事务。后端需针对新迁移维护版本断言；该单连接 savepoint 方案不能用作后台 runner/并发事务正确性的证据。新聊天并发测试使用独立连接和专用新测试库，不共享 AsyncSession。
- 新测试库可保留为证据，不在本任务范围中自动 drop。其他验收写入通过已审阅的独立测试资源或外层事务回滚，不能触发业务表清空；原有数据库/卷零删除。
- Redis 测试使用本轮唯一前缀与 TTL，如 `weibiye:chat:test:<run_id>:...`，不执行 FLUSHDB/FLUSHALL，不碰 auth 或其他项目键。需要真实 Redis 验收时串行执行并记录键前缀。

## 5. 前后端并行交接的契约

### 后端提供给前端

1. 15 个接口的 OpenAPI/Pydantic schema 与本契约一致，提供可空字段、错误码、状态和分页真实样例。
2. 默认只用私人 Mock 的可运行本地 API；不要求真实模型密钥或支付凭据。
3. 五类持久 SSE 事件与 connection 级 error、重放/缺口/过期行为的 fixture；样例不得含真实用户正文或 Cookie。
4. `GenerationSnapshot` 的原子文本+游标语义、cancel 200/202 区别和逻辑删除语义不能在实现中简化为假成功。
5. 后端受测提交号、迁移编号和接口差异清单。

### 前端向后端保证

1. 命令通过既有 Cookie/CSRF；发送和重试保持 IK 语义，不传 owner 或模型开关。
2. 将 `queued/streaming/completed/failed/cancelled` 明确映射到 UI；原类型 `complete/interrupted/error` 只作展示层映射。
3. GET SSE 带 Cookie，按事件序号去重，完成时替换全文，EOF 不伪完成，切换账户阻止晚到回调。
4. 一次点击继续仅恢复原会话；刷新从 API 恢复，访客演示不冒充持久化历史。
5. 前端受测提交号、移动/桌面截图与契约未覆盖的问题清单。

### 后端尚未完成时的前端工作

前端可先写 DTO、独立流解析器、Query 状态及 Playwright HTTP 拦截 fixture；拦截只在测试中启用，标记为契约测试。认证流程仍使用真实本地 P2.5 测试服务；不引入万能假用户头、不把 fixture 作为正常 API 成功回退。

契约 Mock 测试通过不等于真实前后端联调通过。后端完成后，最后一组浏览器测试必须关闭这些拦截，调用真实本地 API + 私人 Mock Provider + 已迁移的独立数据库。

## 6. 测试责任与验收矩阵

| 范围 | 后端窗口 | 前端窗口 | 协调窗口验收 |
| --- | --- | --- | --- |
| 认证/恢复回归 | 完整 pytest，不改已有安全断言 | auth/recovery 浏览器回归 | Cookie/CSRF/撤销及过期均保持 |
| owner 隔离 | A/B/管理员对每个接口、分页、事件、取消、重试、卡片的 401/404 | 登录 A→B、退出、过期、晚到网络响应 | 真实 API E2E，不只验证隐藏按钮 |
| 会话和消息 | CRUD/墓碑/顺序/分页/版本；空会话默认伙伴归属 | 侧栏、重命名、旧历史、刷新、路由 404 | 无重复会话/输入、旧页面保留 |
| 幂等与并发 | 同键并发、不同正文冲突、重复 client ID、单活跃任务、独立连接 PG | 双击、POST 超时后复用键、无自动重生成 | SQL 记录数与调用次数核对 |
| SSE | 五类持久事件、持久先于输出、唯一终态、Last-Event-ID、24h 窗口 | 中文分块、CR/LF、注释、多行 data、ID 去重、缺口、缓冲上限 | 断网/恢复、过期快照重接、终态全文一致 |
| 取消与重启 | cancel/complete/delete 竞态、lease fencing、queued 恢复、running 不重调 | 停止 pending/失败提示、切换会话不串消息 | 本地 Mock 故障注入，无付费调用 |
| 卡片与授权 | false 默认、已完成来源、隐藏版本、关闭、删除和 A/B | 继续原会话、无欢迎重复、无历史不显示、刷新偏好 | 没有长期记忆写入或虚构经历 |
| 提供商与钱包 | 默认 SDK 调用 0、公共演示无存储、私人 Mock 真存储、usage 可空 | 明确模式标识、未知余额不伪造 | 钱包表/余额/计费规则无变化 |
| 迁移 | 新 SQLite 向前迁移、既有数据回填、PG 前后约束和 alembic check | 不产生迁移 | 唯一 head、原表/数据保留、目标正确 |
| 响应式布局 | 提供稳定测试事件与延迟 | 桌面 1440×900、小屏 390×844/320px、抽屉/输入法/软键盘 | 截图及键盘交互复核 |

需要运行的已有工程命令（将来在各自 Worktree 对应子目录执行）：

```powershell
# backend
uv run ruff check .
uv run ruff format --check .
uv run pytest -q

# frontend
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

这不包含默认允许对开发库执行的迁移/数据库验收命令。真实数据库测试在连接保护、授权与新测试库明确后单独运行，记录 passed/failed/skipped 及原因。所有原测试保留；新增测试针对行为和失败边界，避免仅镜像实现。

CI 由协调窗口在集成阶段更新：保留仓库内相对目录，使用 GitHub runner 的 `weibiye_ci` PostgreSQL/Redis 服务，真实模型 OFF、Mock 邮件、无真实凭据；增加新迁移、持久聊天与实际 HTTP E2E 验收。CI 的服务不等于操作本地 Docker。工作流不添加部署、推送或外部邮件步骤。

## 7. 开发里程碑与合并顺序

1. **契约冻结（协调）**：用户确认本文；建立含契约的本地基线提交，记录 P3_BASE_SHA。此后接口改动先提议并更新契约版本，再由双方同步，不能各改一个响应字段。
2. **并行开发开始**：按边界创建两个 Worktree。后端先完成 schema/迁移与服务；前端从 frozen fixture 完成页面和解析器。两边都不能自行操作开发数据库或 Docker。
3. **串行交接公共测试参数**：后端完成 e2e_server 参数化，前端配套 Playwright 参数；合并前保留单一 E2E 执行锁。交接只通过已审阅提交，不能互相直接写文件。
4. **后端先验收**：完整后端检查、新迁移测试、Mock 流与异常测试通过后，提供确切提交号。真实 PG 并发验证若有阻塞必须显式保留，不能提前标记全通过。
5. **集成后端**：协调窗口从 P3_BASE_SHA 建立 `codex/p3-chat-integration`，先合并后端分支，再核对契约和迁移唯一 head。不能直接覆盖 P2.5 分支的未提交内容。
6. **再集成前端**：合并通过自身检查的前端分支。前端文件不与后端竞争；若共同测试接口有变化，由协调窗口解决并分别回馈，不允许无审阅“取一边全部覆盖”。不要求前端窗口自行 rebase/merge 后端分支来扩张文件范围。
7. **联合验收**：关闭 HTTP fixture，真实本地注册/登录后进行多轮私人 Mock 聊天、刷新恢复、A/B、断线、取消、删除、卡片及移动端测试；使用独立新测试数据库。协调窗口串行处理目标确认后的向前迁移，不做 downgrade。
8. **记录并暂停**：记录 Git SHA、文件变化、迁移目标/版本、测试输出、截图、阻塞与未实现能力。无自动公网部署/推送；是否提交集成成果按后续明确授权执行。

本轮不执行这些里程碑命令，不创建分支/Worktree、不提交。

## 8. 主要风险、完成标准与未实现项

| 风险 | 对策 / 验收门槛 |
| --- | --- |
| 未提交的契约没有进入子工作目录 | 先建立被确认的契约基线，双方核对同一完整 SHA |
| 两个测试服务端口冲突 | 端口参数化前 E2E 串行；启动前占用检测；不杀/复用未知服务 |
| 不同 Worktree 运行同一库造成重复 runner 或迁移 | 分开测试库/文件；开发库迁移只由协调窗口串行执行 |
| 改分页格式破坏旧客户端 | 明确升级现有私人 API DTO，两边共同上线本地集成；公开演示契约保留 |
| 事件与消息不一致或重复触发模型 | 同事务写状态/事件；GET 接流无副作用；IK 与 client ID 双重保护 |
| 物理删除与账本/记忆外键冲突 | P3 仅软删除并即时隐藏，不级联删除钱包或记忆 |
| 无真实 PG 并发证据 | 验收阻塞明确保留；SQLite、契约 Mock 和历史 P2.5 结果均不能替代 |
| 真实模型、外部 tracing 或邮件误启 | 维持已有门控，默认 Mock、tracing OFF、本地邮件；测试验证外部请求为 0 |

P3 完成应同时具备：两侧既有检查与新增边界测试通过、真实 HTTP 私人 Mock 聊天可持久化恢复、真实 PG 并发与前向迁移证据、认证隔离不回归、桌面/移动截图、未修改钱包与旧项目、无付费调用。任何必需项失败或阻塞均不得报告“P3 已完成”。

当前依然未实现：私人聊天写入、任务 runner、持久 SSE、真实历史分页/推荐偏好、取消与崩溃恢复。这些是下一轮按契约开发的工作。真实模型上线、长期记忆摘要/检索、完整物理删除、生产多实例调度、钱包计费及公开部署均不在本 P3 默认实施范围。

## 9. 本轮验证记录

- 只读核对 Git 根目录、分支、两次提交、干净状态和现有 Worktree。
- 阅读认证/归属、聊天模型/路由、Agent/Provider/SSE、长期记忆/使用量外键、前端聊天/卡片/传输、测试脚本和 CI。
- 文档静态校验通过：15 个互不重复的方法/路径组合、4 个 JSON 示例、6 个 SSE 帧（五类持久事件及一个连接错误）均可解析；事件 ID/序号对应，帧尺寸符合上限，文档相互链接有效。
- 校验时已跟踪文件无差异，237 个已跟踪路径的清单 SHA-256 保持 `262ec28790c19c7c8fb47aeb749dc5ff5067e8ad01bc81906adc600b6dc8713b`；仅新增本计划与 API 契约两个未跟踪文件，HEAD/分支/Worktree 不变。
- 没有运行应用测试、构建、服务、在线数据库检查或迁移，因为本轮交付只有文档；不借用历史测试结果宣称新接口通过。
- 未创建 Worktree、提交或推送；未操作 Docker、旧 AgentForge-AI、真实模型、邮件、支付或公网部署。

## 10. 双窗口环境准备与启动说明

本节适用于静态审核通过后建立的两个 Worktree，不授权启动业务开发。启动命令供用户手动执行，本轮不启动额外 Codex 会话。

### 10.1 本次审核与共同基线

- 起始 HEAD 仍为 `37de383539ec73b512cbbd61e6ae7b9e3607109e`，分支 `codex/p25-auth-recovery`；起始只有两份 P3 文档未跟踪，暂存区为空，已有源码无改动。
- 两份文档经全文敏感信息审核，未发现真实密钥、密码、认证 Token、Cookie/CSRF 值、恢复令牌或私人聊天。示例 UUID、示例正文、本地地址、配置键名与 Git SHA 不视为真实凭据。
- 认证兼容性审核通过：写请求复用现有 Cookie/CSRF/Origin；owner 查询沿用非本人 404（含管理员）；只读 GET SSE 可复用 session_user，并在输出/心跳前复核到期和撤销。
- Last-Event-ID CORS 头、流内持续鉴权、前端流身份隔离均是下一阶段实现工作；本轮不修改安全代码，也不宣称相关运行测试已通过。
- 仅把 `docs/P3_CHAT_API_CONTRACT.md` 与本文件放入一次本地提交。两个新分支从该同一个完整提交 SHA 创建，实际 SHA 记录在最终交付回复；文档不嵌入自身提交哈希。
- 契约版本保持 **`p3-chat/1.0-draft`**，SSE 数据版本 **`1`**。本次只固定共同开发依据，不将未实现接口标为已实现。

### 10.2 Codex A：后端窗口

工作目录：`D:\AIProjects\WeiBiYe-worktrees\p3-backend`。

预期分支：`codex/p3-chat-backend`。

打开一个 PowerShell 窗口，执行下面的**只读环境确认**启动命令：

```powershell
codex --cd "D:\AIProjects\WeiBiYe-worktrees\p3-backend" --sandbox read-only "你是未毕业 Codex A 后端窗口。先读取 docs/P3_CHAT_API_CONTRACT.md 和 docs/P3_PARALLEL_PLAN.md。只读确认 Git 根目录、分支 codex/p3-chat-backend、HEAD 和工作区状态，并确认契约版本 p3-chat/1.0-draft、SSE 版本 1。后续文件职责只限并行计划第 3.1 节，认证受保护区不改，不改 frontend、共享文档或根配置。本轮不编码、不安装依赖、不启动服务、不迁移数据库、不操作 Docker、不调用真实模型、不提交、不合并、不推送。报告环境与职责后暂停，等待用户明确授权 P3 后端开发。"
```

后续获得业务开发授权时，允许范围是第 3.1 节列出的 companion、agent、唯一新迁移、模型注册、后端测试/脚本、必要的 main/core 聊天配置及后端锁文件。`modules/auth/**`、`modules/users/**`、security/ownership 与旧迁移仍受保护。不能为了联调直接修改前端。

### 10.3 Codex B：前端窗口

工作目录：`D:\AIProjects\WeiBiYe-worktrees\p3-frontend`。

预期分支：`codex/p3-chat-frontend`。

在另一个 PowerShell 窗口执行：

```powershell
codex --cd "D:\AIProjects\WeiBiYe-worktrees\p3-frontend" --sandbox read-only "你是未毕业 Codex B 前端窗口。先读取 docs/P3_CHAT_API_CONTRACT.md 和 docs/P3_PARALLEL_PLAN.md。只读确认 Git 根目录、分支 codex/p3-chat-frontend、HEAD 和工作区状态，并确认契约版本 p3-chat/1.0-draft、SSE 版本 1。后续文件职责只限并行计划第 3.2 节，保留 Cookie、CSRF、scope 隔离、首页文案和响应式布局，不改 backend、共享文档或根配置。本轮不编码、不安装依赖、不启动服务、不迁移数据库、不操作 Docker、不调用真实模型、不提交、不合并、不推送。报告环境与职责后暂停，等待用户明确授权 P3 前端开发。"
```

后续获得业务开发授权时，允许范围是第 3.2 节列出的聊天状态/适配器、SSE、必要 API 增量适配、路由/聊天页/布局样式、E2E、Vite/Playwright 与前端锁文件。认证状态机、登录恢复流程及安全拦截器语义继续受保护。不能为处理后端 501 或契约差异私自修改后端。

命令参数已通过本机 `codex --help` 核对，CLI 当前可用；本轮只查看帮助，没有启动另一会话。工作目录启动方式与手工 Git Worktree 的区别参见 [官方开发命令文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli) 和 [官方 Worktree 文档](https://learn.chatgpt.com/docs/environments/git-worktrees)。

如使用桌面端，在两个目标目录分别建立本地会话，并粘贴相应命令中的初始提示词；确认界面显示该目录与预期分支。不要再选择“创建 Worktree”生成第三个目录，也不要使用 Handoff 自动移动分支。最终以会话实际执行的 `git rev-parse --show-toplevel` 为准；若客户端不能选择指定目录，则用以上已核实的 CLI 方式。

### 10.4 开始业务开发前仍需处理

- 两个 Worktree 只有已跟踪文件，不复制 `.venv`、node_modules、真实环境文件、缓存或私有收件箱。本轮不安装依赖；环境确认完成不代表前后端已经可运行。
- 上面的 CLI 会话使用 read-only，适合当前只读确认。下一轮获得明确业务授权后，再为对应 Worktree 启用写入权限，且仍遵守文件边界。
- E2E 固定端口尚未参数化，两个窗口不能同时执行现有完整浏览器套件；不得自行启动共享数据库上的第二个 runner。
- PostgreSQL 并发验收仍需要确认并授权独立新测试库；本轮不进行迁移或数据库测试。真实模型始终关闭。
- Worktree 提供文件和分支隔离，不限制进程访问其他目录；每个窗口必须固定在自己的根目录，不能把 Git 隔离当作权限沙箱。
- 契约/根环境示例/CI/README 只由协调窗口维护；后端先验收再集成、前端随后。本轮没有建立集成分支或进行合并。

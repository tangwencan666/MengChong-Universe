# P4 长期记忆系统最终集成验收

日期：2026-11-01（Asia/Shanghai）。状态：**P4_INTEGRATION_VERIFIED**。所有必要验收通过，范围为本地独立集成环境，不代表 main 合并、共享开发库升级或真实模型上线。

## 1. Git 基线与集成方式

| 项目 | 提交 |
| --- | --- |
| main / P3 稳定基线 | `ae6fd44692b4011247f3b0d333fc313d7657dab8` |
| P4 后端验收 | `3f1b540faa95bb3bf34f7f800a7d73a2c2ea5565` |
| P4 前端验收 | `22fa14aeb8e4c47118d3a1dfb897f8448c0cc118` |

开始时上述引用及五个已有 Worktree 均与验收状态一致，工作区与暂存区干净，无 Git 锁或并发 Git 写进程。未发现其他窗口写入。主目录实际仍检出 `codex/p4a-memory-foundation`，main 引用为上述 P3 基线；没有切换主目录分支。

祖先关系为 P3 → P4-A → P4-B → P4-C。前端已包含后端，不重复合并后端，也不 cherry-pick：

1. 确认目标路径及分支不存在。
2. 从 P3 基线创建 `D:/AIProjects/WeiBiYe-worktrees/p4-integration`，分支 `codex/p4-memory-integration`。
3. 在该 Worktree 仅执行一次 `git merge --ff-only 22fa14aeb8e4c47118d3a1dfb897f8448c0cc118`。
4. 集成修复与验收均只在此目录进行；没有修改其他 Worktree、main、功能分支或共同契约。

P4 五份设计、API、P4-A/P4-B 实施范围和 P4-B/P4-C 验收报告已对照。契约仍为 `p4-memory/1.0-draft`，`/clear`、隐私取消原因及来源回执规则的实施补充均已存在，不是本轮擅自变更。

## 2. 集成修复

### 2.1 记忆到期状态与操作入口

原页面时间固定在首次进入时，长期驻留后可能仍显示“允许参考”；已撤销条目到期后还会被显示为“已过期”。后端资格检查正确，此问题不构成记忆越权注入。

修复：仅 active 记录按当前时间投影为 expired，显式 revoked/legacy/expired 状态优先。最近到期计时器、聚焦及恢复可见时更新时间，完整清理事件与计时器，并对超长 timeout 分段。列表、筛选、详情、编辑表单及撤销确认使用同一有效状态；到期后保留查看、导出和删除。

新增真实 API 浏览器时钟回归，同时验证已撤销状态不被覆盖。只移动浏览器时间，不伪造服务器时间或成功业务响应。

### 2.2 0004 PostgreSQL 回归测试投影

实际首次执行旧 P3 PostgreSQL 用例得到 2 通过 / 1 失败（`-x` 停止，7.18 秒）。失败是测试用 `select(ChatGeneration.__table__)` 将 P4 新列投影到严格 0004 的库，触发 `UndefinedColumn: chat_generations.memory_epoch`；不是本轮修改业务生成逻辑。

仅将测试快照查询改为完整原有 V4 列投影，排除三列 P4 字段；保留 0004、实例身份、并发与持久化的全部原断言。没有把测试库偷偷升为 0005。

### 2.3 旧认证与 Redis 专项隔离

旧认证专项存在共享库回退和“legacy consent timestamp 即可读取记忆”的陈旧预期。现在 opt-in 时强制显式隔离数据库/Redis URL，保留数据库身份、head、全空库和事务回滚检查；legacy 记忆本人及他人均为 404，本人旧列表为空，其他私人资源原断言保留。

Redis DB15 已有数据，本轮原子检测未取得租约，**没有修改、清理或夺取该 DB15**。为运行实际认证及连接池验收，新增严格校验本轮 Redis0 owner 租约与命名空间的模式，本轮认证/限流写路径的命令真实转发且写入有 TTL。原始客户端仍用于健康检查和本应用连接池，不声称所有未来 API 都自动获得前缀隔离；原 DB15 租约模式保留。

连接池耗尽只占用测试应用自己的 32 个连接，保留 503 拒绝、释放后恢复的原断言；不重启或耗尽整个 Redis 服务。修复后的 PostgreSQL/认证/Redis 三模块专项 **12 通过、0 失败/跳过，20.69 秒**。

## 3. 独立测试数据库与迁移

共享开发库只读目标：`127.0.0.1:25433/weibiye`，用户 `weibiye`，集群标识 `7703042374370492450`，仍为 **0004 / 21 张业务认证表**。报告、manifest 和命令日志不包含连接密码。

本轮创建并保留下列五个新库，没有复用上轮验收库：

| 角色 | 数据库 | 最终版本 |
| --- | --- | --- |
| P4-A、非空迁移与竞态 | `weibiye_p4a_test_6b3d1006ec054d59b8af3b362fe5aef7` | 0005 |
| P4-B 检索/注入/Provider guard | `weibiye_p4b_test_6b3d1006ec054d59b8af3b362fe5aef7` | 0005 |
| 真实浏览器 | `weibiye_p4c_test_6b3d1006ec054d59b8af3b362fe5aef7` | 0005 |
| P3 聊天兼容 | `weibiye_p3_test_6b3d1006ec054d59b8af3b362fe5aef7` | 0004 |
| SQL 事务回滚认证 | `weibiye_p3_test_e1c340dec36a474ca4d665b072b647cf` | 0005 |

新编排脚本要求所有名字、地址、用户、集群及 manifest 精确匹配；先确认全部目标不存在，才创建。manifest 或数据库已存在时拒绝复用；部分迁移失败时不自动续跑或破坏性回滚。42 项新增离线守卫测试覆盖拒绝路径，禁止其访问任何真实依赖。

迁移顺序：

1. 五个新库精确向前到 `0004`。
2. 仅在 P4-A 隔离 0004 库运行真实注册登录、Cookie/CSRF、Redis、Mock LangGraph、SSE、两消息落盘及新应用实例恢复；记忆管理返回 503。写入一条明确合成的旧记忆，供非空迁移验证。
3. 保存所有原表原列的记录数和行内容 SHA-256，只将 P4-A/P4-B/浏览器/认证四库精确向前到 `0005`，P3 库保留 `0004`。
4. 四库的原有列数据数量和 SHA-256 全部保持一致；0005 为 26 张业务认证表（另有 Alembic 表），模型差异 0；0004 保持 21 张。额外只读验证旧记忆迁移后为 `legacy_unconfirmed`、active grant 为 NULL、该合成用户的新增授权事件为 0，没有将旧 consent timestamp 当成新授权。

辅助只读核对曾误将 API 投影 `last_confirmed_at` 当成物理列；按模型修正查询后上述资格断言通过，未修改数据库。旧时间戳按原样保留，不是 P4 使用授权。

本轮未修改任何迁移脚本。0004/0005 明确能力白名单、结构 manifest、无效约束/索引拒绝及未知版本保护均保留。PostgreSQL 编排不使用 `upgrade head`；没有数据库降级、drop、truncate、清库或共享开发库升级。已有 pytest 在自己的临时 SQLite 库使用 head，并验证 downgrade 函数主动拒绝执行，不会降级任何真实数据库。

Redis 为真实 `127.0.0.1:26380`。P4-C、V4 冒烟、认证、P4-A 及 SSE 使用独立运行前缀/作用域；测试键有 TTL，不执行 FLUSH、删除或其他项目键清理。V4 冒烟实测 eval16、set1、get16、zrem1。

## 4. API、权限和模型边界

- 默认关闭长期记忆，明确开启后仍需每条确认。预览与 SSE 重放不自动保存；聊天图没有自动写入记忆节点。
- 列表、详情、创建、编辑、删除、单条撤销、清空、导出、变化游标、候选及生成引用复用 P4 API，无共享契约修改。
- Cookie、CSRF、Origin、输入白名单、no-store 与 owner 校验沿用既有实现；跨用户详情、来源、会话、引用为 404，未认证为 401。
- 最近话题与长期记忆授权独立；切号和迟到响应由身份 scope、AbortController、revision/epoch 栅栏隔离，正文不落浏览器持久化缓存。
- PostgreSQL 并发专项验证删除/撤销的锁序和发送/写回屏障；不通过延长固定 sleep 或放宽权限取得通过。
- 浏览器新增三项先真实命中记忆，再分别删除、单条撤销或关闭总授权；新会话再次查询，直接核对新增 Provider 观察记录中无旧记忆且 memory-refs 为空。
- 来源指向本人原始会话/消息；过期或删除的引用不会恢复正文。SSE 取消、Last-Event-ID 排他重放及首次连接故障恢复不重复保存或调用 Provider。
- **API、PostgreSQL、Redis 与浏览器身份认证是真实联调；AI 回复始终为本地 Mock。** Spy/观察记录只证明 LangGraph 实际装配和发送授权内容，不证明模型理解、真实个性化建议或真实 tokenizer 效果。

## 5. 实际执行结果

| 检查 | 实际结果 |
| --- | --- |
| TypeScript | 通过 |
| ESLint（max-warnings 0） | 通过 |
| 前端构建 | 通过，Vite 9.62 秒 |
| 前端单元测试 | 37 通过、0 失败/跳过 |
| 完整既有浏览器回归 | 87 通过、0 失败/跳过，278.21 秒；retries=0、flaky=0、全局错误0 |
| 真实 API 浏览器联调 | 17 通过、0 失败/跳过，150.16 秒；retries=0、flaky=0、全局错误0 |
| PostgreSQL/认证/Redis 旧专项 | 12 通过、0 失败/跳过，20.69 秒 |
| 完整 pytest（包含启用的真实依赖专项） | **563 通过、0 失败、0 错误、9 条件跳过**；收集572项，639.79 秒，exit code 0 |
| Ruff check / format --check | 通过，136 个 Python 文件 |
| 0004 实际 Graph/SSE/历史恢复 | 通过 |
| 隔离非空 0004→0005、原列保留 | 通过 |
| 最终共享库、专用容器、Redis 实例及五个隔离库 | 通过；共享完整 schema/记录数/行内容 SHA 未变，隔离库无其他连接 |
| 测试服务与进程退出 | 通过；四个测试端口无监听，本 Worktree 测试 Python/Node 进程0 |
| 其他 Worktree 和已有分支 | 通过；原五个 Worktree 干净，HEAD/已有分支引用及 P3 标签不变 |

单独专项和离线守卫的重复运行不加入完整 pytest 的独立用例总数。浏览器合计104个不同用例通过。既有 87 项浏览器用例包含显式 HTTP 契约 Mock 和 SQLite/内存认证夹具，不能都描述为 PostgreSQL 联调。17 项专用浏览器用例的成功响应来自真实服务；故障仅注入网络中止/离线、延迟真实响应和浏览器时钟推进。

完整 pytest 内 **38 项真实 PostgreSQL/Redis 专项全部通过**：P4-A PostgreSQL10、P4-A隐私竞态2、P4-A真实Redis1、P4-B PostgreSQL/Spy13、P3 PostgreSQL10、真实认证1、Redis连接池1。P4-A/P4-B的多数PG用例使用内存认证/限流夹具，只宣称数据库真实；真实Redis链路由明确的Redis专项、V4冒烟及17项浏览器覆盖。42项新离线编排守卫也包含在563内，不额外相加。

9项跳过均来自原 `test_local_infrastructure.py` 的 shared-only 手工 opt-in 入口。本轮未启用该共享库入口，也没有新增 skip、删除或弱化其断言；其版本、表结构/约束/索引、Redis读写/限流、readiness及依赖故障目标由上述明确隔离的测试与核对完成。没有将跳过项计为通过。

## 6. 本地证据与复验方式

证据根目录：`D:/AIProjects/WeiBiYe-worktrees/p4-integration/.verification/`。全部被忽略，不提交数据库快照、日志、Cookie、账号产物或缓存。

- 数据库：`p4-integration-target.json`、`p4-integration-prepared.json`、`p4-v4-smoke.json`、`p4-integration-before-v5.json`、`p4-integration-promoted.json`、`p4-legacy-forward-state.json`。
- pytest：`p4-pytest-full.log/xml`、`p4-p3-v4-initial.log/xml`、`p4-legacy-postgres-final.log/xml`；实际环境装配代码保存为 `p4-pytest-invocation.py`，只由目标 manifest 在进程内构造 URL，不含连接密码字面量。
- 浏览器：`p4-browser-regression-results.json`、`p4-browser-real-results.json`，独立输出目录保留截图与失败证据。
- 静态检查：`p4-frontend-*.log`、`p4-ruff-check.log`、`p4-ruff-format.log`。
- Provider：`p4c-provider-observations.jsonl` 仅保存合成内容的 ID/版本/SHA-256，不保存正文或完整 Prompt。
- 截图：`screenshots/p4c-memory-desktop.png`、`screenshots/p4c-memory-mobile.png`，已实际查看桌面及移动布局，无横向溢出。

最终证据校验：

| 文件 | SHA-256 |
| --- | --- |
| `p4-pytest-full.xml` | `3d8cb54aaa4680cd37ed12df6d2587e90752efceb28858e9705241b40e81637c` |
| `p4-browser-regression-results.json` | `cfcfb499f3cc891818519c8b606c234cb9d52bc95ac3e1a371c30f5750dff05b` |
| `p4-browser-real-results.json` | `3d03089b5cf911f389ae803da92e54fc2426045f0da6f2cf0d86d8fe69c97ac0` |
| `p4-integration-final-database.json` | `70fb5033321dc2a573384e04a850d877d4b76eaa39d089457da4e7626f15d9c6` |
| `p4-legacy-forward-state.json` | `e58cb82e979e8b8605fb668a52356438fa11812124d2b14b0f54fdfd53f39566` |

编排脚本位于 `backend/scripts/p4_integration_database.py`，`prepare → p4_integration_v4_smoke.py → promote → tests → verify`；所有命令必须在当前集成 Worktree 使用自己的 `.venv`。现有 manifest 禁止重复 prepare/promote，不应在原共享库直接复制命令执行。

测试 URL 只由 `target_url(read_manifest(), role)` 在进程内构造；pytest 的常规配置使用 SQLite/不可达 Redis 哨兵，只有明确授权的 PG/Redis 专项获得目标 URL。浏览器使用现有 `playwright.memory.config.ts` 与本轮 P4-C 兼容 manifest，端口 35305/38305；原有回归端口 25174/28101。全部只绑定 loopback。

## 7. 本轮额外修改文件

```text
backend/scripts/p4_integration_database.py
backend/scripts/p4_integration_v4_smoke.py
backend/tests/test_p4_integration_guards.py
backend/tests/integration/test_auth_postgres.py
backend/tests/integration/test_chat_postgres.py
backend/tests/integration/test_p3_redis_pool.py
frontend/src/pages/memory.tsx
frontend/e2e-memory/memory.spec.ts
docs/P4_INTEGRATION_REPORT.md
```

已验收 P4 后端和前端的完整修改历史保留在原提交链中，不重新拷贝或重写。没有修改后端业务、认证机制、钱包、Docker 或真实模型配置。

## 8. 收尾和遗留边界

测试结束后的独立 `verify` 已通过：共享开发库保持0004/21表，所有原列结构、约束/索引、每表行数及完整行SHA与开始时相同。两专用容器ID、running/healthy、启动时间、重启次数、端口和挂载未变，Redis run ID 未变。没有操作其他项目的容器或数据库；卷内仅新增本轮获准的隔离数据库与测试记录，不声称测试没有写入任何卷数据。

五库最终均通过身份、版本、表数和结构检查；0005四库模型差异0，0004兼容manifest匹配，无其他遗留数据库连接。认证库全部业务记录仍为0，证明SQL外层事务回滚；其余合成数据保留，不自动删除测试库。

测试期间观察专用PostgreSQL内存186.9MiB/512MiB、Redis8.58MiB/128MiB；这是单次观测而非峰值。磁盘空间充足，没有启动或重建任何Docker资源。

源码敏感模式扫描的匹配均为已存在的公开本地开发默认值、离线DDL测试占位及标明synthetic的拒绝测试向量；本轮新增内容无真实密钥。最终API、V4冒烟、完整pytest日志及Provider观察记录未出现测试记忆正文或会话Cookie值，不记录完整Prompt；真实凭据、缓存及运行产物不暂存。

本轮仅将第7节9个文件纳入集成分支本地提交，完整哈希以最终交付及 `git log -1` 为准，避免报告自引用。main、P4后端/前端分支以及原五个Worktree均保持原HEAD与干净状态；没有合并main、推送、部署、删除Worktree或Git强制操作。

- 共享开发库仍需另行授权备份/恢复演练和精确 0005 升级，默认管理/注入开关未改。
- 真实模型、真实 tokenizer、向量语义检索、自动记忆提取/摘要、原生多端应用、原 ID 重新授权 UI 和生产备份物理擦除未完成。
- 用户已下载副本、已返回浏览器内容及已授权发出的在途模型输入不能由普通删除召回；后续使用受服务端隐私栅栏控制。
- 移动验收为 Chromium 390×844 视口，不等于真机软键盘或原生客户端验收。
- 旧共享库基础设施入口仍保留为手工opt-in；后续若整理CI，应改为同等严格的独立目标，不能自动对共享开发库启用。
- 仅允许在集成分支创建本地提交；本报告不授予 main 合并、远程推送、公开部署或共享开发库升级授权。

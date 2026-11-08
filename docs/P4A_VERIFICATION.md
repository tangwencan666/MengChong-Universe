# P4-A 长期记忆基础与授权验收

状态：**P4A_VERIFIED**。本阶段后端实现及隔离验收通过；不是完整P4记忆注入验收，也不是共享开发库升级或生产发布。

日期：2026-11-01（Asia/Shanghai）。范围：后端数据库兼容、明确授权、手工记忆管理及安全边界；不包括自动提取、检索注入、真实模型或前端记忆页面。

## 1. Git 与开发前检查

- 项目为独立仓库 `D:\AIProjects\WeiBiYe`，开始时 main=`ae6fd44692b4011247f3b0d333fc313d7657dab8`。
- 初始六个未跟踪文件均为已知的 P3 开发库升级报告和五份 P4 设计文档，无业务改动。文档内容及敏感模式审查完成，原 P3 报告 SHA 未改变。
- 新建功能分支 `codex/p4a-memory-foundation`；六文档单独提交为 **`538f45f26f630978529e3854e0570e5f3fcad025`**。没有在 main 编写 P4 业务代码。
- 开发前两次状态检查一致，无Git锁文件，未发现本项目并发写入迹象。既有Vite进程属于旧AgentForge-AI目录，未停止、重启或修改。受本轮协调的子任务仅在本功能分支按文件范围分工。
- 开发库身份：`127.0.0.1:25433/weibiye`，用户weibiye，集群`7703042374370492450`，版本0004，21张业务/认证表。记录数与P3报告一致；Redis26380 PING正常。

## 2. 实现文件

业务与兼容：

- `backend/app/core/config.py`：默认关闭的管理开关、强制禁止本阶段注入、稳定HMAC配置校验。
- `backend/app/db/capabilities.py`：显式版本/结构manifest与engine级校验缓存。
- `backend/app/db/models.py`、`backend/app/modules/memory/models.py`：模型注册、5张新表及记忆生命周期。
- `backend/migrations/versions/0005_memory_foundation.py`：固定向前DDL快照，不改旧迁移。
- `backend/app/modules/memory/schemas.py`、`privacy.py`、`service.py`、`router.py`：强类型输入、敏感内容规则、授权、手工CRUD、清空、导出、同步及旧桥接。
- `backend/app/agent/memory_boundary.py`、`chat_runner.py`、`chat_protocol.py`、`backend/app/modules/companion/service.py`：epoch固定、历史屏障、旧任务取消及原SSE原因兼容。
- `backend/app/api/health.py`、`backend/app/main.py`：启动/readiness/后台能力保护。

新增测试：`test_memory_api.py`、`test_memory_security.py`、`test_memory_boundaries.py`、`test_memory_migration.py`、`test_schema_capabilities.py`、`integration/test_memory_postgres.py`、`integration/test_memory_races.py`、`integration/test_memory_redis.py`。

调整既有测试：`test_auth.py`保留归属测试并收紧旧记忆桥接；`test_auth_migration.py`、`test_chat_migration.py`、`test_database.py`按最新head更新明确版本/表数，未删除测试、跳过断言或放宽未知版本保护。所有上述测试路径均位于`backend/tests`。

文档：[P4A_IMPLEMENTATION_SCOPE.md](D:/AIProjects/WeiBiYe/docs/P4A_IMPLEMENTATION_SCOPE.md)记录清空API加法及阶段边界；本文件记录实际验收。前端、认证实现、旧迁移、Docker、钱包业务代码及其他Worktree没有修改。

## 3. 数据库兼容与迁移

`CHAT_V1`只接受0004/0005，`MEMORY_V1`只接受0005；未知版本、空版本、多head拒绝。校验列类型/nullable、PK、FK目标及列、UNIQUE列、CHECK名称、索引列/唯一性；PostgreSQL另校验索引有效和约束已验证。

严格manifest成功后按engine+精确revision缓存；普通命令仍读取单head白名单，启动和readiness强制重验。同revision DDL漂移由严格readiness检查发现并清缓存，不宣称每次请求完整反射全部结构。

P3 ChatGeneration mapper仍只包含V4字段；新增memory_epoch、memory_context_not_before、memory_snapshot_at仅进入Table metadata，0005用显式Core读写。已验证0004真实ORM读写与runner，未通过删除版本判断实现兼容。

隔离数据库：**`weibiye_p4a_test_5ce07680a8984b7e84ccf9d11248af5e`**，宿主端口25433、上述专用集群。创建前确认不存在，以template0新建；未复用或清空现有库。

执行过程：

1. 隔离库精确向前迁移0004。
2. 当前功能代码在0004注册登录、创建聊天、Mock SSE完成、消息落盘；新应用实例携带原Cookie恢复同一消息ID。真实Redis PING参与readiness。
3. 添加可识别的旧记忆fixture，保存原21业务表旧列、记录数和SHA-256。
4. 仅对隔离库精确向前迁移0005，检查模型差异0、26业务/认证表（另有版本表）。原21表旧列记录数及摘要全部一致；旧记忆为legacy_unconfirmed，无新授权事件或默认开启。
5. 后续全部PG写入测试仍仅用该隔离库；未drop、truncate、downgrade或删除测试库。

**共享开发库未执行迁移，仍为0004。** 不应把本次结果理解为开发环境已开启长期记忆；默认配置仍关闭管理。

## 4. 授权与 API

所有新接口前缀`/api/v1/memory`，沿用现有Cookie/CSRF、Origin和身份依赖。owner只取Principal，私人资源不归属统一404，管理员不绕过。JSON输入extra=forbid；确认只接受真正JSON布尔true，不接受1或字符串。

| 方法 | 路径 | 本阶段行为 |
| --- | --- | --- |
| GET / PATCH | `/preferences` | 默认关闭、明确开启/关闭、乐观版本、审计、epoch及同步cursor |
| POST / GET | `/items` | 逐条确认手工创建201 / 有界keyset列表200 |
| GET / PATCH / DELETE | `/items/{id}` | 本人详情 / 确认纠正 / 正文擦除与墓碑204 |
| POST | `/items/{id}/confirm` | 本人同手工来源重新确认，不复活deleted/legacy |
| POST | `/items/{id}/revocations` | 单条撤销，保留本人管理能力 |
| GET | `/items/{id}/sources` | 来源元数据，不复制聊天正文 |
| GET | `/changes` | owner绑定的签名游标、无正文失效事件 |
| POST | `/export` | 单个一致只读快照的JSON下载，关闭时仍可导出 |
| POST | `/clear` | confirmed+expected_revision+IK，清本人正文，不改授权或最近话题 |
| POST | `/previews`、`/retrieval-preview` | 明确501，未实现提取/检索 |

聊天来源创建明确501，不接受伪造预览回执。旧GET `/memory`/`/{id}`保留原响应形状但收紧权限：0004直接[]/404；0005也必须有效P4授权、未撤销/删除/过期，不能凭旧时间戳读取。

长期记忆与最近话题使用不同表/版本，互不替代授权。全局关闭撤销active条目；再开启不复活，需逐条确认。Token钱包不参与记忆保留或隐私管理。

## 5. 安全与并发

- User→Prefs→Session→Generation→Message→Memory顺序；Provider和限流网络不在持User锁事务内等待。
- 幂等仅保存HMAC指纹/目标ID，重放读取当前状态，不缓存旧正文。删除后旧创建请求410，旧clear重放不误删之后新增条目，旧enable重放不重新授权。
- 基础请求保护与新业务写入额度分离，已提交IK重放不再计业务写次数；并发入场仍由数据库唯一键/锁最终去重。
- 删除/纠正/撤销推进privacy_epoch及context_epoch_floor，旧任务合法取消；未来历史只使用逻辑屏障后的完整轮次，旧NULL按0，不能用时钟偏差绕过。普通新增不推进floor。
- PostgreSQL真实竞态通过pg_blocking_pids确认旧running写被删除事务阻塞；删除提交后旧_flush被fence拒绝、旧_finish不提交，事件恰为start/delta/cancelled，唯一memory_policy_changed终态，原partial保留但无晚到新内容。
- 摘要为带省略标记的确定性显示摘录；原正文保持完整。自然到期后keyset翻页不因offset移位漏掉仍有效条目。
- 导出使用REPEATABLE READ READ ONLY，不创建可分享URL或永久导出文件；已经开始的响应和客户端已有副本无法召回。
- 记忆正文不放Redis、业务日志、审计事件或幂等DTO；Redis认证/限流故障503，没有本地认证旁路。私人记忆不接入公开demo、社区或moderation Prompt。
- 敏感信息仅为保守本地规则筛查，包含凭据、证件/金融、精确地址、诊断/危机表达等常见形式；不宣称能识别所有敏感信息或提供心理危机干预。

## 6. 实际测试记录

| 验证 | 实际结果 |
| --- | --- |
| 新API/安全首轮 | 34通过、19失败；发现真实实现问题，已保留失败日志 |
| 修复后新API/安全复验 | 53通过、0失败、0跳过；117.69秒（不含后来新增回归） |
| 第一次完整pytest | 289通过、5失败、31跳过、1错误；394.10秒 |
| 迁移/元数据/布尔确认/分页/摘要/IK定向复验 | 30通过、0失败、0跳过；41.24秒 |
| 最终完整pytest | **304通过、0失败、0错误、34跳过；412.11秒**，包含最新62项API/安全用例 |
| 真实PG并发及在途隐私屏障 | 12通过、0失败、0跳过；28.93秒 |
| 真实Redis+PG认证和双账号记忆管理 | 修正测试CookieJar复制后1通过、0失败、0跳过；2.95秒 |
| 余额耗尽独立补充回归 | **1通过、0失败、0跳过；3.41秒**，证明保留、创建、导出和主动清空均不受余额0影响 |
| Ruff check / format --check | **通过；119个Python文件格式符合要求** |
| 独立PG0005迁移与模型比较 | 已通过，26表、模型差异0、旧列摘要保留 |
| Alembic current / check、独立真实依赖检查脚本 | **0005(head)、无模型差异、live/ready均200；退出码0** |

余额回归是在完整套件收集后单独补充并运行，未将其混算进304。34项skip中，本阶段PG10、隐私竞态2、Redis1已用明确隔离配置另行全部执行通过；其余21项为旧auth PG1、P3 chat PG10、local infrastructure9、P3 Redis pool1，本轮未重新运行其原专用入口，不冒充通过。P3本轮回归依据为完整通用套件、0004/0005兼容矩阵和两版实际PG Mock SSE证据。

首轮API的503来自异步ORM server onupdate更新时间过期读取触发MissingGreenlet；改为显式更新时间。另修复中文“密码是/为”分隔形式和legacy重新确认错误码。未降低约束或删除测试。

完整首轮的5失败是固定0004/21表的旧head断言；更新为最新0005/26并保留专门0004回归。两个早期失败测试未走到engine.dispose，引发后续一次SQLite资源警告错误；警告策略保持error，不通过屏蔽警告处理。

真实Redis首轮直到正文删除/旧IK410均通过，失败来自测试将有domain的CookieJar转dict导致同名CSRF冲突。修正为保留域信息的CookieJar副本，退出后旧Cookie401断言保留。

真实PG12项使用内存认证/限流，仅其数据库是实际PostgreSQL；另1项才是实际Redis认证/限流联调。后者通过透明测试前缀包装，仅给AuthStore键加本轮UUID命名空间；业务认证逻辑不变，实际get/set/Lua/撤销写均有计数证据。未使用FLUSH或扫描删除键，测试键按TTL自然过期。

本轮没有执行浏览器、前端构建/类型/ESLint；前端文件未改。实际API请求由TestClient执行真实FastAPI代码，连接真实PG/Redis，不冒充公网HTTP或浏览器验收。Mock不理解记忆，本阶段无记忆注入。

## 7. 最终完整性与提交

2026-11-01 19:42 +08:00收尾核对：开发库仍为0004、21表，全部原业务/认证表及版本表记录数和行摘要与本轮开始时一致。没有向共享开发库注册账号或写入记忆。

专用PostgreSQL、Redis容器ID、running/healthy状态、启动时间、restart_count、端口绑定及挂载与开始快照完全相同；宿主端口仍仅127.0.0.1:25433及26380。没有停止、重启、重建、删除Docker资源或操作其他项目数据库。

本轮pytest、Alembic和依赖检查进程均已退出，测试进程计数0；38304/35304/38204/35204无测试监听。API实际在TestClient中执行，未启动公网或常驻HTTP服务器。其他三个Worktree仍干净、分支与HEAD不变；main及p3-chat-verified仍指向ae6fd446。

隔离库保留49个可识别合成账号、29条记忆（包括墓碑及旧legacy fixture）、70条授权事件和70条幂等元数据，包含失败尝试产生的数据；未清库或删除证据。memory_generation_refs为0，没有伪造模型记忆使用。结构为48FK、29UNIQUE、58CHECK、43独立索引/99总索引，无无效索引或未验证约束。

提交前对新增/修改文件及报告进行敏感模式与暂存路径检查，排除真实密钥、缓存、备份、运行日志及.verification；唯一类似模型密钥的测试样本明确标为synthetic-not-a-real-key，经人工核对后列为合成安全金标，不是真实凭据。

本地实现提交：**`07393bdd05f6ce5f7a65fa8e474c925f38cabbe9`**（28个实现/测试/阶段说明文件）；文档基线提交见第1节。本报告另作本地验收文档提交，最终回复提供报告提交哈希。提交后复核工作区和暂存区干净，main仍为ae6fd446；不合并、不推送、不部署。

当前测试清单收集为339项：最终通用套件338项（304通过/34条件跳过），另1项余额补充已单独通过，无未收集的新回归。不能将重复运行的定向/专项结果累加成独立测试总数。

## 8. 证据与遗留事项

证据目录：`D:\AIProjects\WeiBiYe\.verification\p4a-5ce07680a8984b7e84ccf9d11248af5e`；脚本/日志/JSON/JUnit被Git忽略，不提交测试产物或密钥。

关键证据：before.json、v4-api-smoke.json、v4-nonempty-before.json、isolated-0004.json、isolated-0005.json、nonempty-migration-preservation.json、postgres-final.xml/log、redis-recheck.xml/log、targeted.xml/log、pytest-final.xml/log、wallet.xml/log、after.json、process-exit.json、worktrees.json、result-summary.json。首轮失败证据保留，未删除测试或失败记录。

主要命令在`D:\AIProjects\WeiBiYe\backend`执行：

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m ruff format --check .
```

专项测试另显式设置`WEIBIYE_P4A_TEST_DATABASE_URL`为第3节隔离库，运行`tests/integration/test_memory_postgres.py`及`test_memory_races.py`；Redis专项还设置`WEIBIYE_P4A_TEST_REDIS_URL=redis://127.0.0.1:26380/0`，运行`test_memory_redis.py`。守卫拒绝共享weibiye库。Alembic current/check和integration_check.py亦仅在明确隔离URL下执行，未对共享开发库执行升级命令。

尚未实现：聊天来源签名预览、自动提取、词法/向量检索、LangGraph注入/Token预算、真实模型、前端管理页面、Windows/App/宠物、自动到期/来源失效懒处理及跨备份删除清单治理。由于注入被强制关闭，不应将当前到期显示与旧任务fence称为完整检索注入验收。

正文擦除针对当前主存储；聊天历史与此前手工备份不能自动物理擦除。备份恢复必须隔离并落实后续删除/撤销清单，当前并无完整治理系统，不能公开上线。

下一阶段建议：先审查P4-A代码与接口，再单独授权开发库备份/恢复验证及精确0005升级，随后做前端记忆管理联调；提取/检索/注入另阶段实施并通过SpyProvider和隐私竞态验收，真实模型继续关闭。

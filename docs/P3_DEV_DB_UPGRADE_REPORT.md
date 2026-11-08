# P3 开发数据库升级与最终冒烟验收

结论：**P3_DEV_DB_UPGRADE_VERIFIED**。

日期：2026-11-01，Asia/Shanghai。本次将专用开发库从 `0003` 精确升级到 `0004`，已完成升级前逻辑备份、隔离恢复验证、真实前后端冒烟及服务退出检查。业务源码没有修改；未执行 Git 合并、切换、提交、推送或部署。

## 1. 代码及目标身份

| 项目 | 实际值 |
| --- | --- |
| 项目目录 | `D:\AIProjects\WeiBiYe` |
| 分支 | `main` |
| HEAD / 稳定标签目标 | `ae6fd44692b4011247f3b0d333fc313d7657dab8` / `p3-chat-verified` |
| PostgreSQL 宿主机连接 | `127.0.0.1:25433/weibiye`，用户 `weibiye` |
| PostgreSQL 集群标识 | `7703042374370492450` |
| PostgreSQL / 工具版本 | `17.11` / `pg_dump、pg_restore 17.11` |
| Redis | `127.0.0.1:26380/0`，版本 `7.4.11`，PING 成功 |
| 验收标识 | `ca0726b1632247d9abcb78d01158b3e7` |

连接使用仓库已公开的本地开发默认配置，未读取生产凭据或输出连接密码。升级前再次核对宿主机端口、数据库名、数据库用户、集群标识和迁移版本；容器内 Unix socket 身份亦与宿主机连接核对一致。

## 2. 升级前检查

2026-11-01 18:18:13 的只读快照：

- Alembic 为 `0003`；18 张业务/认证表，另有 `alembic_version`。18 张表均为 **0 行**，没有真实用户数据需要迁移。
- 28 个外键、16 个 UNIQUE 约束、25 个 CHECK 约束、26 个独立索引；含约束索引共 61 个。无无效索引、无未验证约束。
- 其他连接、长事务、idle in transaction、等待锁均为 0；数据库大小为 9,074,355 字节。
- main、后端、前端、集成四个 Worktree 分支与提交符合稳定基线，工作区及暂存区初始均干净；已记录全部跟踪文件 SHA-256。
- 专用 PostgreSQL / Redis 均 running、healthy，重启次数均为 0。
- 宿主机 C 盘剩余 21,717,528,576 字节，D 盘剩余 148,612,014,080 字节。
- PostgreSQL 数据目录 `du` 为 104,284 KiB；容器文件系统显示可用 1,000,200,044,544 字节。该值属于 Docker 虚拟文件系统容量，不替代宿主机实际剩余空间判断。
- 数据卷为 `weibiye_weibiye_pgdata`，容器挂载点 `/var/lib/postgresql/data`；未重建或修改卷配置。

## 3. 备份与隔离恢复

备份位于项目之外：

`D:\AIProjects\WeiBiYe-backups\p3-dev-0003-20261101-181420-ca0726b1\weibiye-before-0004.pgdump`

| 项目 | 结果 |
| --- | --- |
| 格式 | PostgreSQL custom，`PGDMP` 文件头，目录可读取 |
| 大小 | **54,670 字节** |
| SHA-256 | `46ee1290374baed6e1a6378bc69dce454bb41949ff29ccd30ef94f905afe387c` |
| 隔离恢复数据库 | `weibiye_p3_restore_ca0726b1632247d9abcb78d01158b3e7` |
| 恢复后版本 / 表数 | `0003` / 18 张业务认证表，另有版本表 |
| 原列内容摘要及记录数 | 全部一致，均为空表 |
| owner、ACL、编码、locale、列类型及 collation | 一致 |
| 恢复验收时间 | 2026-11-01 18:22:34 +08:00 |

宿主机无 PostgreSQL CLI，使用**已存在的本项目 PostgreSQL 容器**内工具，未安装全局软件或创建新容器。备份二进制直接写入新文件并同步，未经过 PowerShell 文本重定向。隔离恢复库创建前确认不存在，创建后确认为空；未向原库执行恢复。

实际命令参数（`<专用PG容器ID>` 固定为下节记录的容器）：

```text
docker exec <专用PG容器ID> pg_dump --format=custom --no-password --host=/var/run/postgresql --port=5432 --username=weibiye --dbname=weibiye --lock-wait-timeout=5s
docker exec -i <专用PG容器ID> pg_restore --no-password --host=/var/run/postgresql --port=5432 --username=weibiye --dbname=weibiye_p3_restore_ca0726b1632247d9abcb78d01158b3e7 --exit-on-error --single-transaction
```

恢复命令未使用 `--clean`、`--create`、`--no-owner` 或 `--no-privileges`。备份、TOC、恢复证据和隔离恢复数据库均保留。

### CHECK 反编译表示差异

第一次严格结构比较发现 **10 个已知 CHECK** 的数组 cast 反编译文本不同，因此当时暂停正式升级。源库与恢复库的原始 schema SHA-256 分别为：

- 源库：`04106bab0fd9368734d148821b0bdb8cdb6b37624d20243a1970d59eb8d24f89`
- 恢复库：`95508fdda62e4415b327888fc778906b58615a8a6acad16ba46c3fad56017007`

差异是 `ARRAY[...::character varying]::text[]` 与逐元素 `::character varying::text` 的表示。验证器仅允许这 10 个具体 CHECK 各一处此种转换，其余结构必须精确一致；没有泛化忽略约束。核对两库编码、locale、列类型及 collation 后，在源库只读连接内对两组提取表达式执行 **175 组真值对照**，包括合法值、非法值、大小写、Unicode、NULL 及钱包 kind × delta，TRUE/FALSE/NULL 结果全部一致。未插入探针数据。

因此本次恢复验收为**受限结构等价与内容校验通过**，不宣称原始 DDL 文本或 schema SHA 相同。这不是对任意未来 SQL 差异的等价证明。

## 4. 正式向前迁移

审查脚本为 [0004_chat_persistence.py](D:/AIProjects/WeiBiYe/backend/migrations/versions/0004_chat_persistence.py)。PostgreSQL 升级路径新增字段、约束、索引及三张表，回填现有聊天结构；不删除或重建原业务表。原列预期调整包括 `chat_messages.provider` 允许 NULL。SQLite 表复制分支未使用。

执行前再次核对 `127.0.0.1:25433/weibiye`、集群标识和 **恰为 `0003`**，并复核备份 SHA、恢复证明、原库快照、空闲连接及容器状态。

| 项目 | 实际执行 |
| --- | --- |
| 开始 / 完成 | 2026-11-01 18:23:04.026 / 18:23:05.472 +08:00 |
| 迁移目标 | **`alembic upgrade 0004`** |
| 调用方式 | Alembic `command.upgrade(config, "0004")`，传入同一已验证连接 |
| 事务 | PostgreSQL 单事务，`lock_timeout=5s`、`statement_timeout=60s` |
| 结果 | 成功提交，版本 `0004` |

未执行 `upgrade head`、downgrade、drop、truncate 或破坏性回滚。正式迁移仅执行一次。

## 5. 结构及原数据验证

| 指标 | 升级前 | 升级后 / 最终 |
| --- | ---: | ---: |
| Alembic | 0003 | **0004** |
| 业务/认证表 | 18 | **21** |
| 外键 | 28 | **36** |
| UNIQUE 约束 | 16 | **24** |
| CHECK 约束 | 25 | **42** |
| 独立索引 | 26 | **35** |
| 含约束索引总数 | 61 | **81** |
| 无效索引 / 未验证约束 | 0 / 0 | **0 / 0** |
| SQLAlchemy 模型差异 | 未用 P3 模型比较旧版 | **0** |

恰好新增 `chat_generations`、`chat_generation_events`、`chat_preferences`。原 18 张业务表保留，原有约束/索引定义保留；owner、ACL、原 schema 与 routine 无意外变化。新增对象为预期的三张表及其相关索引。

**迁移完成、冒烟写入之前**，21 张业务表均为空；原 18 表的原列内容摘要与记录数完全一致。冒烟结束后的 schema SHA 与刚迁移完成时相同。由于原库为空，本轮不构成对真实非空用户数据迁移的验证。

## 6. 真实 P3 冒烟

使用 main 稳定代码、真实 FastAPI、React、升级后的开发 PostgreSQL 和 Redis；后端监听 `127.0.0.1:38204`，前端监听 `127.0.0.1:35204`。Provider 强制 Mock、真实模型关闭、模型名为空，未配置真实模型密钥。

测试启动器只为使流式交互可观测而延长本地 Mock 每块输出间隔，未更改回复内容、认证、路由或数据库处理。使用真实浏览器，未伪造 API 成功响应，未通过 SQL 故障注入或清库控制测试。

**最终 Playwright：1 个顺序浏览器用例通过，0 失败、0 跳过；含以下 14/14 检查点，总运行约 38 秒。**

| 检查 | 结果 |
| --- | --- |
| FastAPI 启动 | 通过 |
| `/health/live` | HTTP 200，通过 |
| `/health/ready`，数据库与 Redis 就绪 | HTTP 200，通过 |
| 两个可识别账号注册、登录 | 通过；账号由首轮创建，复验复用相同账号 |
| Cookie 与 CSRF | HttpOnly、SameSite=Lax、localhost Secure=false；缺少 CSRF 返回 403 |
| 私人会话创建 | 两个账号分别创建自有会话，通过 |
| 用户消息接受及幂等重试 | 原消息/任务保持一致，未重复创建，通过 |
| Mock AI SSE | start、delta、completed 及持久化序号/元数据，通过 |
| 消息持久化 | 权威 API 历史与终态正文一致，通过 |
| 页面完整刷新恢复历史 | 会话与消息 ID 保持一致，通过 |
| 退出后私人数据不可访问 | 私人详情及消息返回 401，另一账号仍可访问自身资源 |
| 双账号数据隔离 | 双向会话/消息访问 404，B 读取 A 生成任务和事件 404，通过 |
| 最近话题授权 | 默认关闭；A 授权后来源追溯到本会话消息，关闭后刷新仍关闭；B 不受影响 |
| 取消及断线恢复 | 运行中取消后唯一 cancelled 终态；网络故障后恢复原任务，通过 |

健康路径已获得用户确认：现有应用使用 `/health/live`、`/health/ready`。裸路径 `/live`、`/ready` 实测为 404，保持已验收代码不变。

取消在首个 delta 后发起；持久化终态为 `cancelled`、`reason=user_cancelled`。完成终态 `usage=null`、`finish_reason=stop`，没有真实计费。

断线通过 CDP 对真实 HTTP 200 SSE 响应注入 `ConnectionClosed`，未伪造数据。前端随后读取原任务快照并携带 `Last-Event-ID: …:3` 对**同一 generation**重新连接；恢复任务共 6 个持久化事件。另验证排他游标重放。最终三轮用户消息 POST 为 3 次，没有因恢复生成重复消息。

### 测试过程中的两次失败

实际执行了三次冒烟尝试，最终一次成功；前两次失败证据保留，没有删除测试或弱化业务断言：

1. 首次测试错误地要求运行中取消使用排队取消的 `user_requested`。核对稳定实现后，将测试修正为运行中取消的准确值 `user_cancelled`；业务代码未改。
2. 第二次用浏览器 offline 切换没有实际切断已建立 SSE，严格的恢复断言失败。改为真实响应上的 CDP 传输失败注入，再次验证同任务恢复；业务代码未改。

首轮实际注册创建了两个账号；后两轮的注册受理返回 202 并复用原账号，因此没有将重复受理伪称为新账号创建。

## 7. 冒烟数据与直接 SQL 证明

两个测试邮箱为 `p3dev-ca0726b1632247d9abcb78d01158b3e7-a@example.com` 和对应的 `-b@example.com`。会话标题及用户测试消息含 `P3DEV_ca0726b1632247d9abcb78d01158b3e7_` 前缀。账号、会话及失败轮次记录全部保留，未执行删除清理。

最终只读 SQL 审计确认：

| 表 | 最终记录数 |
| --- | ---: |
| users / ai_companions | 2 / 2 |
| auth_sessions / email_verifications | 6 / 2 |
| chat_sessions | 6 |
| chat_messages | 16 |
| chat_generations | 8 |
| chat_generation_events | 39 |
| chat_preferences | 1，A 最终关闭，version=2；B 无记录，走默认关闭 |
| comments、job_applications、memories、moderation_actions、password_resets、post_likes、posts、reports、usage_records、wallet_reservations、wallet_transactions、wallets | 各 0 |

全部用户和会话均属于本轮测试标识；消息、生成任务及事件无跨 owner 关联。8 个生成任务均为 Mock、model/usage 为空，均已有唯一终态；事件序号连续，delta 拼接、终态正文与保存消息一致。最终成功用例的 A 会话有 6 条消息，sequence 为 0–5，对应 completed/cancelled/completed 三轮，刷新后 ID 一致。

18:35 的只读复核确认备份 SHA 未变化、隔离恢复库仍为 `0003`、18 张空业务表且结构未变。原数据库的新增记录均来自已授权、明确标记的冒烟数据；不宣称冒烟写入后记录数仍是升级前的零行。

## 8. 容器、进程及工作区收尾

| 专用容器 | ID |
| --- | --- |
| weibiye-postgres-1 | `62b27f33f5d601c29d77f73926f23cef8cd6c079cec3f27ca9c932c9bb9bcd4f` |
| weibiye-redis-1 | `50a4a890c1900f80fd65b09c6edc274e7aa97b3908aa2ebad910734d8c64a15e` |

专用容器前后 running/healthy、ID、启动时间、重启次数、端口、挂载均未变；Redis PING 成功且实例 run_id 未变。宿主机端口仍仅绑定 `127.0.0.1:25433` 和 `127.0.0.1:26380`。

只读比对的 420 个现有 Docker 容器 ID 集合未变，未发现意外配置变化。**8 个 Project Sentinel 既有容器的自动重启计数/启动时间及部分动态网络字段变化**被单独记录；没有将这些变化误报为完全不变。本轮未向其他项目执行启动、停止、重启、重建或数据库写入，也未处理其重启问题。

Playwright 已退出，退出码 0；本轮测试服务已退出。18:35:54 检查测试端口 38204、35204 无监听，相关测试进程为 0。数据库其他连接、长事务、idle in transaction、锁等待均为 0，未发现连接泄漏。

四个 Worktree 的原有跟踪文件 SHA、分支及 HEAD 前后相同；其他 Worktree 保持干净。主项目 main/tag 仍指向 `ae6fd446...`，暂存区为空。生成本报告后，预期且实际可见的唯一未跟踪文件为 `docs/P3_DEV_DB_UPGRADE_REPORT.md`；不能将此时工作区描述为完全干净。本轮未提交。

运行脚本、浏览器结果和 Mock 邮件均在 `.gitignore` 排除的 `.verification` 内；报告不包含密码、Cookie、CSRF 值、邮件验证令牌或聊天正文。未向暂存区加入密钥、备份或测试产物。

## 9. 证据路径

运行证据根目录：`D:\AIProjects\WeiBiYe\.verification\p3-dev-db-upgrade-20261101-ca0726b1`。

- `before.json`：升级前数据库、逐表原列摘要、Git/Worktree、容器及磁盘快照。
- `backup-restore.json`、`restore-validation.log`：恢复、受限 CHECK 等价及 175 组真值对照证明；首次严格比较失败日志亦保留。
- `migration-after.json`、`migration.log`：正式升级记录、迁移完成且冒烟写入前的结构和数据检查。
- `smoke-result.json`、`smoke.xml`、`smoke-verified.log`：最终通过的真实浏览器结果。
- `attempt-1*`、`attempt-2*`：前两次失败尝试的结果、日志和浏览器诊断。
- `smoke-sql-proof.json`：只读数据归属、消息/事件持久化、测试数据范围及备份再次校验。
- `final.json`、`finalize.log`、`process-exit.json`：最终结构、Docker/Git 比对及服务退出。
- 外部备份目录中的 `archive-toc.txt`、`backup-verification.json`：备份 TOC 与恢复摘要。

## 10. 遗留边界

- 本轮运行的是数据库升级验收和 1 个真实浏览器冒烟用例；**未重新运行**此前已验收的 229 项后端测试、87 项浏览器测试或 21 项集成测试，也未将其算作本轮结果。
- 原开发库为空；非空历史数据的大规模迁移、生产 HTTPS Cookie、长时间负载和异主机灾备不在本次证明范围内。
- 逻辑备份为升级前 `0003` 快照，不包含冒烟新增数据。恢复验证使用同一专用集群内的新数据库；不是整个集群、跨版本或 PITR 灾备演练。备份、恢复库及测试数据保留，后续清理需要另行授权。
- AI 回复仅由本地 Mock Provider 生成；未调用真实模型，未接入支付，未实现长期记忆。最近话题授权与来源追溯不等同于长期记忆能力。
- 未来新增 `0005` 等迁移时，应同步更新就绪检查及测试中精确版本约束，不应继续沿用本轮固定 `0004` 的操作脚本。

本轮验收完成，暂停等待下一步确认。

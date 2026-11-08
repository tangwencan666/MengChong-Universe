# WeiBiYe P2：认证与用户数据隔离验收

> 本文是 P2 阶段的历史验收。P2.5 的当前功能、迁移版本和测试结果见 [P25_AUTH_VERIFICATION.md](P25_AUTH_VERIFICATION.md)。

日期：2026-11-01（Asia/Shanghai）。项目根目录：`D:\AIProjects\WeiBiYe`。

**P2 已实现并通过本地验收。** 注册、登录、Cookie 服务端会话、退出/撤销、当前用户、CSRF、认证限流及私人资源 owner 读取过滤已接通。邮件保持本地 Mock；没有调用真实 AI、支付、真实邮件或公网部署。

## 开发前状态

- Git 根目录为本项目，分支 `main`，尚无提交或远程；已有项目文件处于未跟踪状态，本轮按文件 SHA-256 基线保留已有内容。
- 专用 PostgreSQL：`127.0.0.1:25433`，数据库/用户 `weibiye`，集群标识 `7703042374370492450`。迁移前版本为 `0001`，15 张业务表全部为空，没有真实用户数据需要搬迁。
- Redis：`127.0.0.1:26380/0`，PING 成功；两个专用容器健康。本轮没有容器启动、停止、重启、重建或清理操作。
- 旧认证入口返回 501；用户表已具有唯一邮箱、密码哈希、昵称、角色及 active/disabled 状态。
- 没有修改 AgentForge-AI 或旧 weibiye 项目。

预检查证据：[preflight.json](auth/preflight.json)。

## 修改文件

源码、配置、测试及 README 共 **30 个修改、20 个新增、0 个删除**。逐文件清单见 [CHANGES.md](auth/CHANGES.md)，前后 SHA-256 见 [changes.json](auth/changes.json)。本报告及 `docs/auth/` 的验收证据单独列入文档交付。

| 范围 | 主要文件与作用 |
| --- | --- |
| 认证领域 | `backend/app/modules/auth/`：模型、输入/输出契约、Argon2id、认证服务、Cookie/CSRF、Redis 存取、限流、Mock 邮件和路由 |
| 身份与依赖 | `core/security.py`、`core/config.py`、`core/errors.py`、`main.py`：真实 Principal、生产配置约束、依赖错误和应用生命周期 |
| 用户资料 | `users/models.py`、`users/router.py`：邮箱验证字段及当前用户接口 |
| 数据隔离 | `core/ownership.py` 与 companion/applications/memory/wallet 路由：数据库 owner 条件、详情与子资源读取 |
| 迁移 | `0002_auth_sessions.py`、`migrations/env.py`、`scripts/upgrade_auth.py`：增加认证结构、受控事务连接和目标实例保护 |
| 前端 | `features/auth/`、`pages/auth.tsx`、`pages/sessions.tsx`、`workspace.tsx`、`App.tsx`、`layout.tsx`、`lib/api.ts`：真实表单、身份恢复、会话管理、路由保护、账户菜单及 CSRF 请求 |
| 测试 | `test_auth.py`、`test_auth_migration.py`、`integration/test_auth_postgres.py`、`e2e/auth.spec.ts`、辅助脚本及已有契约测试 |

Compose 文件、钱包模型/计费服务、原始 `0001` 迁移、Agent 框架、AI 聊天页及历史话题核心文件共 21 个受检文件与开发前哈希一致，见 [protected-files.json](auth/protected-files.json)。未删除测试；旧 501 断言随真实功能实现更新，原迁移往返测试改为向前幂等及数据保留检查，另增加 `0001 → 0002` 保留既有用户的测试。

## 认证架构与隐私边界

密码使用 Argon2id，参数为 64 MiB、3 次迭代、并行度 2，随机盐由库生成；验证时支持需要时重新哈希。未知邮箱使用相同参数的 dummy hash 校验，错误密码、未知邮箱、禁用账户统一返回登录失败信息。哈希在工作线程执行，单进程限制最多 2 个并发哈希任务。参考：[argon2-cffi 官方 API](https://argon2-cffi.readthedocs.io/en/stable/api.html)。

注册要求邮箱有效、昵称 1–60 字、密码 12–128 位且至少包含大小写字母、数字、符号中的三类，并拒绝内置少量常见弱密码。邮箱统一小写并由数据库唯一约束兜底；新邮箱和重复邮箱都返回相同 202 提示，不修改已有账户的昵称或密码。客户端不能通过注册设置 role/status/user_id。

登录产生 32 字节随机 opaque session token。Cookie 保存原始值，PostgreSQL 只保存 SHA-256；每次私人请求都查数据库，验证用户状态、会话期限、撤销状态及生产邮箱验证要求。Redis 撤销提示只是辅助，数据库撤销在提示丢失或进程重启后仍然有效。默认绝对期限 86400 秒，可配置至最多 7 天；最后访问时间按 5 分钟粒度更新，不延长绝对期限。

Cookie 为 HttpOnly、SameSite=Lax、Path=/、无 Domain 属性。生产配置必须启用 Secure、HTTPS 来源、Redis 及邮箱验证，Cookie 使用 `__Host-` 前缀；生产认证写请求拒绝 HTTP。只有本地回环 HTTP 开发使用非 Secure Cookie。测试使用 HTTPS ASGI 传输检查生产属性，没有进行公网 TLS 部署验收。

CSRF 采用服务端校验：登录前 nonce 存于 Redis，10 分钟有效；登录后 nonce 哈希绑定具体会话。原始 nonce 通过专用 GET 接口交给前端内存，并要求每个认证写请求提供匹配的 HttpOnly CSRF Cookie 和 `X-CSRF-Token`。同时精确检查 Origin 白名单，拒绝 cross-site Fetch 请求；匿名且无副作用的固定 Mock AI 演示保持独立。SameSite 只是其中一层保护，参考 [OWASP CSRF 防护说明](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。

登录限流为每 IP 30 次 / 15 分钟、每规范化邮箱 8 次 / 15 分钟；注册为每 IP 8 次 / 15 分钟。Redis 使用原子计数和 TTL，键中的邮箱/IP 均为哈希。Redis 不可用时拒绝认证操作；内存实现只在显式测试/开发配置使用，生产禁止回退。输入错误、数据库/Redis 异常均使用不回显密码、Cookie、连接串或异常细节的错误信封。

## 邮箱验证与 Mock 边界

`MailSender` 是可注入的异步发送契约。当前只接入进程内 `MockMailSender`，不会联网、发送真实邮件或记录验证令牌到日志。没有公开的 Mock 收件箱 HTTP 接口；测试可通过应用对象检查 Mock 队列。

邮箱验证令牌随机生成，数据库仅存哈希，24 小时有效且只能消费一次；验证成功写入 `users.email_verified_at`。默认本地开发允许未验证邮箱登录，并在表单和个人中心明确说明；生产强制 `require_verified_email=true`。真实邮件提供商、持久化投递队列、重发和找回密码仍未实现，当前不是生产邮件验证闭环。

## API 契约

以下路径均带 `/api/v1` 前缀。认证写操作要求 Origin 和 CSRF；私人接口未认证 401，资源越权与不存在统一 404，角色不足 403。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /auth/csrf` | 获取当前 nonce，响应不可缓存；不会返回认证 token |
| `POST /auth/register` | `{email,password,display_name}`；新建或重复均为通用 202 提示 |
| `POST /auth/login` | `{email,password}`；成功返回用户 DTO 并设置两个 HttpOnly Cookie；失败统一 401 |
| `GET /auth/me`、`GET /users/me` | 当前用户 id/email/display_name/role/status/email_verified，无密码或会话哈希 |
| `POST /auth/logout` | 撤销当前会话并清 Cookie，204 |
| `POST /auth/logout-all` | 撤销本人所有会话并清 Cookie，204 |
| `GET /auth/sessions` | 本人有效会话元数据，标记当前会话，不暴露 token/hash |
| `DELETE /auth/sessions/{id}` | 仅能撤销本人的指定会话；撤销当前会话时清 Cookie |
| `POST /auth/verify-email` | `{token}`；单次消费，成功 200，失效/重放 400 |

私人读取接口：

| 路径 | 隔离策略 |
| --- | --- |
| `/companion/companions`、`/{id}` | 伙伴 owner 过滤 |
| `/companion/sessions`、`/{id}`、`/{id}/messages` | 会话和消息 owner 过滤；子资源先核对父会话 |
| `/applications`、`/{id}` | 求职记录 owner 过滤 |
| `/memory`、`/{id}` | owner 过滤，且授权未撤销 |
| `/wallet`、`/{id}`、`/{id}/transactions` | 本人账户，账本联表检查账户 owner；无钱包返回 404 |

列表默认上限 50、最大 100，忽略客户端用于越权的 `user_id`，不据此决定 owner。管理员也不绕过私人数据归属。没有创建钱包、修改余额或计费规则；私人 AI 消息写入、钱包预留等业务仍明确返回 501。

## 数据库迁移结果

新增 `auth_sessions`、`email_verifications`，并给 `users` 增加可空 `email_verified_at`。会话具有用户外键、唯一 token 哈希、到期/撤销/最后访问元数据、期限约束和索引；邮件令牌具有用户外键、唯一哈希、期限和消费状态。原有 15 张业务表保留。

实际升级在一个 PostgreSQL 事务内完成：再次检查集群标识、数据库/用户/端口、原版本 `0001`、原表集合和空业务数据；使用迁移互斥锁及 5 秒锁等待限制，然后执行 `0002` 并检查模型差异。最终审查又将升级脚本的保护断言改为始终生效的运行时检查，并补充拒绝错误目标的测试；没有重复执行已完成的升级。`0002` 的 downgrade 显式禁止执行。

结果：**版本 `0002`，17 张业务/认证表 + Alembic 版本表，模型差异为 0，未删除表、未覆盖记录。** 实际结构校验包含 27 个外键、15 个唯一约束、24 个独立索引、24 个 CHECK 约束，索引有效，FastAPI live/ready 均为 200。详见 [migration.json](auth/migration.json) 及 [readiness.txt](auth/validation-output/readiness.txt)。

真实 PostgreSQL/Redis 认证测试使用外层事务及应用内部 savepoint，注册、登录、隔离读取和退出正常执行，最后回滚本次测试写入。17 张表验收前后记录数均为 0，见 [postgres-acceptance.json](auth/postgres-acceptance.json)。Redis 只在 `weibiye:auth:` 命名空间留下有 TTL 的测试辅助键，没有清理其他键。

## 前端联调结果

- 登录/注册表单、当前用户、个人中心、会话列表、退出当前/所有会话已接入真实 API。
- 私人页面需要登录，管理员页面额外检查角色；回跳路径限定同源，处理大小写/尾斜杠的认证页回跳，避免循环。
- 当前用户和 CSRF 只保存在内存，未使用 localStorage/sessionStorage 保存认证 token。HttpOnly Cookie 在刷新后恢复服务器身份。
- API 401、窗口聚焦和定期检查处理失效会话；账户切换清空查询缓存并重新挂载聊天预览，旧请求响应不会恢复前一账户身份。
- BroadcastChannel 仅广播账户状态变化信号，其他标签页先清空旧预览再重新确认身份，不广播凭据或聊天内容。
- 首页三段文案、历史话题卡片/授权、继续原会话、演示访客工具和移动抽屉保留。聊天仍为本地内存 Mock 预览，刷新清空；并未因为认证实现而宣称会话持久化或跨天恢复完成。
- 桌面和 390px 移动布局已检查，个人中心长邮箱可换行；移动测试仍是桌面浏览器模拟，不是实体手机软键盘验收。

截图全部为测试账户和虚构聊天数据：[桌面个人中心](auth/screenshots/profile-desktop.png)、[移动注册](auth/screenshots/register-mobile.png)、[移动个人中心](auth/screenshots/profile-mobile.png)、[移动聊天](auth/screenshots/chat-mobile.png)、[保留的历史话题卡片](auth/screenshots/recent-topic-card-desktop.png)。

## 实际测试结果

| 检查 | 结果 |
| --- | --- |
| 完整 pytest（含真实 PG/Redis 认证组） | **79 passed, 9 skipped**，42.04 秒，无排除项 |
| Ruff / format | 通过；77 个 Python 文件格式检查通过 |
| 冻结依赖锁检查 | `uv lock --check --offline` 通过 |
| TypeScript | 通过 |
| ESLint | 通过，0 warnings |
| 前端构建 | 通过；JS 417.07 kB、CSS 45.59 kB |
| 完整浏览器套件 | **42 passed**，约 1.6 分钟；33 项既有覆盖 + 9 项认证覆盖 |
| UI 间距/长邮箱复测 | 8 项认证场景通过，并补充移动个人中心布局断言 |
| 最后回跳路径加固复测 | 对私人路由、正常回跳、角色保护及大小写/尾斜杠回跳场景复测 **1 passed**；其后类型、lint、构建通过 |
| 实际 PostgreSQL / Redis / readiness | 通过，迁移版本与模型一致，测试事务未遗留账户 |

完整 42 项浏览器通过后，最后仅加固了登录返回路径归一化；该小改动执行了上表中的针对性复测，未再次重复完整套件。浏览器认证使用真实本地 HTTP 服务和每轮新建的隔离 SQLite 数据库；专用 PostgreSQL 与真实 Redis 则由独立认证集成测试验证，不把 SQLite 结果当作 PostgreSQL 结果。

9 项跳过项来自旧 `test_local_infrastructure.py`，其 fixture 会执行 Docker 容器内命令；本轮没有开启该组。新增真实 PostgreSQL 认证组已显式启用且通过，覆盖五类私人资源、Redis 认证存取及事务清理。原本包含 downgrade 的测试已改为向前幂等/数据保留，并非通过删除测试规避失败。

浏览器首次为 39 通过、2 失败：旧导航测试未先登录，另一个过期提示场景使用了会清空前端状态的整页导航。改为真实登录准备和当前应用内的会话失效导航后，全套通过。后续增加跨标签页隔离场景并通过 42 项全套。没有伪造测试成功。

JUnit：[后端](auth/backend-final.xml)、[浏览器全套](auth/browser.xml)、[最后回跳复测](auth/browser-return.xml)。控制台日志位于 `auth/validation-output/`。

## 本地使用与复核

现有 PostgreSQL/Redis 继续使用 `25433/26380`，容器旧工作目录标签未改变。不要通过重建容器修复标签，也不要使用旧目录开发。

```powershell
cd D:\AIProjects\WeiBiYe\backend
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 38101 --loop app.core.event_loop:new_event_loop --no-access-log --no-proxy-headers
```

另一个终端：

```powershell
cd D:\AIProjects\WeiBiYe\frontend
npm run dev
```

浏览器访问 `http://127.0.0.1:35174/register`。注册后在登录页登录；本地 Mock 邮件不会真实投递。数据库已经升级，不需要重跑专用于 `0001 → 0002` 的保护脚本。

常规测试：`uv run pytest -q`，默认跳过真实基础设施 opt-in 组。真实 PostgreSQL 认证验收需要空开发库和显式 `WEIBIYE_AUTH_PG_TESTS=1`、`WEIBIYE_EXPECTED_PG_CLUSTER_ID=7703042374370492450` 及专用连接配置；一旦已有开发账户，应改用独立测试库，不能清空现有数据来满足测试前置条件。

验收进程已回收。没有提交、推送、配置远程或部署；所有文件仍留在独立仓库供审阅。

## 尚未实现与下一阶段

当前还没有真实邮件投递、密码找回、MFA、可配置设备信息/安全审计和会话清理保留策略。真实 AI 会话前端持久化、长期记忆授权工作流、求职写入和钱包资金操作也未实现；现有页面保留其演示或未开放说明。

建议下一阶段先接入经授权的邮件提供商、邮箱验证页面与找回密码闭环，并把 PostgreSQL 认证验收接到独立 CI 测试库；随后实现用户自己的会话持久化与最近话题偏好存取。上线前仍需单独的 HTTPS/代理、密钥、邮件投递及生产安全验收。本轮到此暂停，等待确认。

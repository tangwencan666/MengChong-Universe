# WeiBiYe P2.5：认证补全与本地安全验收

日期：2026-11-01。范围：`D:\AIProjects\WeiBiYe`，仅本地开发与 Mock 邮件。

**P2.5 本地 Mock 闭环已完成并验证。** 没有发送真实邮件、接入真实 AI、支付、推送或公网部署。真实邮件投递仍未完成，不能把本报告理解为生产邮箱验证或独立渗透测试通过。

## Git 基线与本轮范围

首个本地提交为 `967d68b2de25c48cac98b1f6e8b36bd924646d4b`，提交说明 `chore: establish verified WeiBiYe P2 baseline`，保存在 `main`。提交前重新阅读认证与隔离代码、扫描候选文件并实际运行测试：后端 79 通过 / 9 跳过，浏览器完整 42 通过；详见 [P2_BASELINE_REVIEW.md](P2_BASELINE_REVIEW.md)。没有使用虚构 Git 作者或修改全局 Git 设置。

P2.5 在 `codex/p25-auth-recovery` 分支开发，本报告随本轮代码保存为本地提交；实际提交号见最终交付回复或 `git log -1`。没有配置远程或推送。P2 基线是代码对照点；数据库保持向前迁移，不应通过 Git 回退去执行数据库 downgrade。

本轮修改清单见 [p25/CHANGES.md](p25/CHANGES.md)，SHA-256 见 [p25/changes.json](p25/changes.json)。源码、配置、测试及当前文档共 28 个修改、10 个新增；本报告和 `docs/p25/` 的验收资料单独列出。没有删除测试或文件。

## 已完成

- 邮箱验证页面、重发验证邮件、当前用户验证状态更新。
- 重发后旧验证链接失效；验证令牌一次性消费，24 小时有效。
- 找回密码请求、新密码页面、确认密码及与注册一致的强度校验。
- 重置令牌默认 30 分钟有效、随机生成、仅保存 SHA-256，不能当作邮箱验证令牌使用。
- 重置成功不自动登录，清除浏览器 Cookie，撤销该用户全部旧会话和未消费的恢复/验证令牌。
- 其他用户密码与会话保持不变，客户端不能指定 `user_id` 或提升角色。
- 已知、未知、禁用或不符合验证策略的邮箱，恢复申请均使用相同 202 提示。
- 每 IP / 邮箱的恢复申请限流、CSRF/Origin 校验、成功后的密码变更 Mock 通知。
- 固定前端 origin 生成邮件链接，忽略不可信 Host；令牌在 fragment 中传递，页面捕获后清除地址中的凭据。
- 同一页面打开新链接时重建令牌表单；等待登录状态恢复后才清除 fragment，避免身份恢复导致令牌丢失。
- 私有本地 Mock 收件箱与 CLI，不提供公开收件箱 API；开发服务器也拒绝访问私有文件。

重置流程的短时单次令牌、通用申请提示、会话失效和不自动登录设计参考 [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)。实现细节与结果由本项目代码和测试验证，不将参考文档当作安全认证。

## 新增 API 与页面

所有认证 API 带 `/api/v1` 前缀，写操作要求 CSRF 和可信 Origin。

| API | 行为 |
| --- | --- |
| `POST /auth/resend-verification` | `{email}`；通用 202。仅 active 且未验证的账户产生新验证邮件，旧令牌失效 |
| `POST /auth/forgot-password` | `{email}`；通用 202。生产邮箱验证策略开启时，不为未验证账户签发恢复令牌 |
| `POST /auth/reset-password` | `{token,password}`；成功 200，清 Cookie；无效/过期/重放 400，弱密码 422 |
| `POST /auth/verify-email` | 保留 P2 契约，改为用户优先的事务锁序，消费后更新验证状态 |

页面：`/resend-verification`、`/verify-email`、`/forgot-password`、`/reset-password`。登录页及个人中心提供入口。保留 AI 首页的三段文案、历史话题、侧栏、移动布局、原有页面及私有路由保护。

## 安全实现

恢复申请默认每 IP 8 次 / 15 分钟、每规范化邮箱 3 次 / 15 分钟；重置消费每 IP 20 次 / 15 分钟。Redis 不可用时认证请求失败关闭。申请对不同账户状态使用相同状态码/消息和统一的最小响应窗口；这降低常见本地时延差异，不是严格恒定时间保证。

请求、重发、验证与重置均校验 CSRF 和 Origin。重置初步查验令牌后才执行 Argon2id，最终事务先锁用户，再重新查验并锁定令牌，原子更新密码、消费未使用令牌并撤销会话。此锁序与登录的用户锁一致，避免登录与密码重置的旧凭据窗口。已有数据库仍是会话撤销的权威来源，不依赖 Redis 撤销提示才能拒绝旧会话。

邮箱验证、恢复令牌分表存储，不能互换用途。重置不会自动标记邮箱已验证，也不会修改另一用户的密码、角色、状态或会话。投递异常只记录无地址/令牌的事件，保持通用申请响应；密码变更通知失败不会将已完成的重置报告为失败。真实投递以后仍需可靠队列和告警。

邮件链接只能使用配置的 `WEIBIYE_FRONTEND_ORIGIN`，不从请求 Host 拼接。URL fragment 不作为 API 查询参数发送；页面对令牌使用密码型输入，不写入 localStorage/sessionStorage。密码重置后通知其他标签页清空旧身份与聊天预览。

## Mock 邮件与手工体验

默认 Mock 只保存在进程内。若需手工打开邮件链接，在启动后端前显式开启私有文件收件箱：

```powershell
cd D:\AIProjects\WeiBiYe\backend
$env:WEIBIYE_MOCK_MAIL_DIR='D:/AIProjects/WeiBiYe/.verification/mock-mail'
$env:WEIBIYE_FRONTEND_ORIGIN='http://127.0.0.1:35174'
uv run uvicorn app.main:app --host 127.0.0.1 --port 38101 --loop app.core.event_loop:new_event_loop --no-access-log --no-proxy-headers
```

前端从 `D:\AIProjects\WeiBiYe\frontend` 执行 `npm run dev`，访问 `http://127.0.0.1:35174`。

另一个本机终端可执行：

```powershell
cd D:\AIProjects\WeiBiYe\backend
uv run python scripts/mock_mailbox.py list --directory D:/AIProjects/WeiBiYe/.verification/mock-mail
uv run python scripts/mock_mailbox.py show MESSAGE_ID --reveal --directory D:/AIProjects/WeiBiYe/.verification/mock-mail
```

`list` 只显示邮件元数据；必须显式 `show --reveal` 才显示指定 Mock 链接。链接是本地敏感恢复凭据，不要粘贴到 Git、日志或录屏中。本轮测试仅读取新建测试账户的 Mock 文件。

文件目录限制在本仓库 `.verification` 下，Git 忽略，生产配置禁止启用。Unix 使用私有目录/文件权限；Windows 只给新建的单次运行目录设置当前用户 ACL，不修改父目录权限。没有 HTTP 收件箱路由，Vite 文件访问拒绝 `.verification`、环境文件和数据库等敏感路径；实际 HTTP 文件读取测试返回 403。默认 CLI 不回显令牌，进程内邮件对象也不在 repr/日志中暴露令牌。

## 数据库结果

专用 PostgreSQL：`127.0.0.1:25433`，数据库/用户 `weibiye`，预先核验的集群标识 `7703042374370492450`；Redis：`127.0.0.1:26380/0`。

受保护脚本 `scripts/upgrade_recovery.py` 在事务内核对目标、版本、表集合及记录数，执行 `0002 → 0003`，并检查模型差异。只新增 `password_resets` 表、用户外键、唯一哈希、期限约束和两个索引。没有删除、清空或改写原 17 张表的数据，`0003` downgrade 显式禁止。

当前 **18 张业务/认证表 + Alembic 版本表，版本 `0003`**，模型一致。实际校验得到 28 个外键、16 个唯一约束、26 个独立索引、25 个 CHECK 约束，索引有效；FastAPI live/ready 200，Redis PING 成功。迁移证据：[migration.json](p25/migration.json)、[readiness.txt](p25/validation-output/readiness.txt)。

真实 PostgreSQL/Redis 测试在外层事务内执行注册、登录、隔离、找回和重置，并回滚测试写入；验收前后 18 张表均为空，见 [postgres-acceptance.json](p25/postgres-acceptance.json)。Redis 仅写入本项目带 TTL 的认证辅助键，没有清理其他键。

容器、网络、卷保持原样，工作目录标签仍指向历史目录；本轮没有为修改标签重建容器，也没有操作其他项目。

## 实际验收

| 项目 | 结果 |
| --- | --- |
| 完整 pytest，含真实 PostgreSQL/Redis 组 | **102 passed, 9 skipped**，90.61 秒 |
| 完整浏览器套件，已安装 Edge | **49 passed**，约 2.5 分钟 |
| TypeScript、ESLint | 通过，0 warnings |
| 前端构建 | 通过；JS 421.63 kB，CSS 45.59 kB |
| Ruff / 格式 | 通过；84 个 Python 文件 |
| 原 P2 测试用例集合 | 全部保留；JUnit 用例集合核对通过 |
| 新增源码依赖 | 无；前后端锁文件保持不变 |
| 本地 Git 候选检查 | 密钥与 Mock 恢复令牌检查；依赖、缓存、数据库和私有收件箱不纳入 Git |

新增 23 项后端用例与 7 项浏览器用例。覆盖重发/替换、用途隔离、过期/重放、弱密码、确认密码、CSRF、限流、禁用/未知账户通用提示、密码实际变化、其他用户不受影响、旧会话全部撤销、邮件异常、固定链接 origin、私有收件箱和移动流程。真实 PostgreSQL 测试沿用 P2 身份/资源隔离场景，并追加找回与重置校验。

9 项跳过的是旧 Docker 容器命令验收组，本轮不启用；真实 PostgreSQL 认证/恢复测试已经运行。浏览器使用真实本地 HTTP API 与每轮新建的 SQLite 数据库；真实 PostgreSQL 与 Redis 另行验收，不把 SQLite 结果冒充 PostgreSQL 结果。

测试发现并修复了同页打开新邮件链接时的旧表单状态问题；同时修正了测试 Cookie 复制丢失 domain/path 的问题，保留完整 Cookie 属性后重新运行全套通过。没有移除失败用例。桌面/移动截图已查看，截图只包含空白恢复令牌字段与虚构账户；移动为浏览器模拟，不代表实体设备或生产 TLS 验收。

证据：[后端 JUnit](p25/backend.xml)、[浏览器 JUnit](p25/browser.xml)、[结果 JSON](p25/results.json)、[桌面请求页面](p25/screenshots/forgot-desktop.png)、[移动恢复页面](p25/screenshots/reset-mobile.png)。

## 限制与下一阶段

仍未接入真实邮件提供商、可靠投递队列、MFA、生产 TLS/代理、实体手机或真实多进程并发压测。未宣称完成独立安全审计。私人 AI 多轮聊天、聊天持久化、长期记忆及支付均保持未接入。

可以进入 P3 的本地开发。建议先冻结聊天会话/消息/SSE 的 API 契约，再从本次 P2.5 提交创建不同分支与工作目录，分别承担后端和前端；不要让两个窗口同时修改认证、公共契约或迁移注册文件。本轮没有启动 P3、创建并行 Codex 任务或部署。完成后暂停，等待确认。

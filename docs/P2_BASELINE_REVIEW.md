# P2 本地 Git 基线复核

日期：2026-11-01。复核范围为 `D:\AIProjects\WeiBiYe`，未修改旧项目或 Docker 资源。

本轮重新阅读认证、会话、CSRF、限流、用户归属及前端身份切换代码，并重新执行测试，不只依据旧报告。未发现阻塞建立本地开发基线的问题。这是本地代码与工程检查，不是第三方渗透测试或生产上线批准。

## 本轮实际结果

- pytest：**79 passed, 9 skipped**，51.65 秒。真实 PostgreSQL/Redis 认证组已启用；旧 Docker 容器命令组未启用。
- Playwright：**42 passed**，约 1.7 分钟。包含此前最终回跳校验代码及全部历史话题覆盖。
- Ruff、格式、TypeScript、ESLint、构建均通过。
- 专用 PostgreSQL 的数据库/用户/集群指纹匹配；迁移版本 `0002`，17 张业务表为空。Redis PING 成功。
- 测试 PostgreSQL 写入通过外层事务回滚，未遗留测试账户；未执行 downgrade、drop 或 truncate。

JUnit 证据位于 `review/p2-baseline-backend.xml` 与 `review/p2-baseline-browser.xml`。

## 安全检查范围

- 密码以 Argon2id 保存；登录失败信息不区分未知邮箱、错误密码和不可用账户。
- 会话 Cookie 为 HttpOnly，服务端验证到期、撤销及用户状态；生产要求 Secure/HTTPS 配置。
- 登录前后 CSRF 校验和 Origin 白名单、Redis 计数限流、用户归属查询已复核。
- 私人资源跨用户访问统一 404，管理员不绕过 owner 检查。
- 前端未将认证 token 存入 Web Storage；账户切换和跨标签页通知清空旧预览。
- 仅将经检查的源码、文档、测试及锁文件纳入基线；不包含 `.env`、私钥、本地数据库、Mock 收件箱、缓存、依赖目录或构建产物。
- 待提交文件执行高置信度密钥签名扫描；公开的本地/CI 示例密码与虚构测试数据不是生产凭据。
- Git 没有远程、活动提交钩子或签名交互；使用已配置的 Git 作者身份，不修改全局配置，不推送。

提交前的空白检查识别到既有 CRLF 和原始控制台记录格式；通过 `.gitattributes` 明确区分。仅规范了 `workspace.tsx` 的文件末尾空行，未改变产品代码逻辑，原始测试日志保持原样。

P2 已有一次性邮箱验证令牌、消费 API 和本地 Mock 发送契约，但缺少重发、找回密码及完整页面。真实邮件投递、生产 TLS/代理验收和真实 AI 均未完成；后续由 P2.5/P3 分阶段处理。

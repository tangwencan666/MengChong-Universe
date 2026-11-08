# P3 前端验收报告

日期：2026-11-01（Asia/Shanghai）。负责窗口：Codex B，仅前端。

## 1. 工作区与交付状态

- Worktree：`D:\AIProjects\WeiBiYe-worktrees\p3-frontend`。
- 分支：`codex/p3-chat-frontend`。
- 共同基线：`e62d3864ee094404a995a79b1ea10429ac9966ff`。
- 契约：`p3-chat/1.0-draft`；私人 SSE 数据版本 `1`。
- 本报告与代码一起交付为一次本地前端提交，准确提交 SHA 见最终交付回复。未合并、未推送；共同契约和并行计划保持原样。
- 本报告是前端专属交付文档，按用户指定保存于本路径；没有编辑协调窗口独占的共同文档。

## 2. 修改文件

共 **24 个文件**（14 个修改、10 个新增，含本报告），仅前端路径及前端专属报告。没有新增运行时依赖，前端锁文件未改。

| 状态 | 文件 |
| --- | --- |
| 新增 | [docs/P3_FRONTEND_REPORT.md](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/docs/P3_FRONTEND_REPORT.md) |
| 修改 | [frontend/e2e/auth.spec.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/e2e/auth.spec.ts) |
| 新增 | [frontend/e2e/helpers/p3-chat-mock.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/e2e/helpers/p3-chat-mock.ts) |
| 新增 | [frontend/e2e/p3-chat.spec.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/e2e/p3-chat.spec.ts) |
| 修改 | [frontend/e2e/recovery.spec.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/e2e/recovery.spec.ts) |
| 修改 | [frontend/eslint.config.js](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/eslint.config.js) |
| 修改 | [frontend/package.json](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/package.json) |
| 修改 | [frontend/playwright.config.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/playwright.config.ts) |
| 修改 | [frontend/src/chat.css](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/chat.css) |
| 修改 | [frontend/src/components/layout.tsx](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/components/layout.tsx) |
| 修改 | [frontend/src/features/chat/ChatProvider.tsx](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/ChatProvider.tsx) |
| 新增 | [frontend/src/features/chat/PrivateChatProvider.tsx](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/PrivateChatProvider.tsx) |
| 修改 | [frontend/src/features/chat/RecentTopicCard.tsx](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/RecentTopicCard.tsx) |
| 新增 | [frontend/src/features/chat/api-types.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/api-types.ts) |
| 新增 | [frontend/src/features/chat/api.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/api.ts) |
| 新增 | [frontend/src/features/chat/commands.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/commands.ts) |
| 修改 | [frontend/src/features/chat/contracts.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/contracts.ts) |
| 新增 | [frontend/src/features/chat/private-stream.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/private-stream.ts) |
| 新增 | [frontend/src/features/chat/topic-validation.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/topic-validation.ts) |
| 修改 | [frontend/src/features/chat/types.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/features/chat/types.ts) |
| 修改 | [frontend/src/pages/companion.tsx](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/pages/companion.tsx) |
| 修改 | [frontend/src/pages/conversation-preferences.tsx](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/src/pages/conversation-preferences.tsx) |
| 新增 | [frontend/tests/private-chat.test.mjs](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/tests/private-chat.test.mjs) |
| 修改 | [frontend/vite.config.ts](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/vite.config.ts) |

## 3. 已实现功能

- 已登录用户使用私人 API 聊天；未登录用户仍为明确标注的内存演示。两者状态、历史、授权和生成完全分开，演示种子不进入私人 API。
- 保留首页主副标题、输入提示、三个快捷操作、折叠侧栏、移动抽屉、个人中心和未知 Token 余额占位；没有重设计页面。
- 会话首次发送时才创建；会话/消息分页、历史切换、重命名版本校验、删除和缓存清理已连接 API。
- 输入支持桌面 Enter、Shift+Enter、输入法 composition 保护、自动增高、Unicode 码点上限、发送等待、消息滚动和原有 VisualViewport 适配。移动端 Enter 保留换行，发送按钮明确发送，避免软键盘误发。
- 发送超时最多自动重试一次，之后由用户明确重试原请求；创建键、发送键和 client_message_id 保持不变。生成失败/取消后的“重新生成回复”使用新重试键，复用原用户消息。
- 明确的 4xx 拒绝（429 除外）清理待确认发送，允许用户修正请求；不会自动重发。429、5xx、超时和结果未知的中断保留原幂等标识。不同会话的生成重试键独立，互不阻塞。
- 最近话题默认关闭，读取账户偏好后才查询候选；开启确认前不展示推荐，关闭立即隐藏，失败说明未保存。继续只读取原会话；隐藏携带 summary_version，删除清理卡片缓存。
- 授权响应必须为真实布尔值，摘录必须具有契约来源、两条来源消息 ID、版本和有效日期；格式异常时停止展示，不把字符串 `"false"` 当作授权。
- Query key 带真实账户 ID 和 scopeVersion。会话切换取消旧读取/流；账户切换、退出和认证失效清理原身份请求、Query 缓存、消息、游标和待确认发送。
- 模型和用户内容以 React 文本显示；不使用不安全 HTML、不记录聊天正文、不写浏览器持久化认证令牌、不伪造余额或 token 使用量。

## 4. API 契约匹配

统一使用 `/api/v1/companion`，没有修改共同契约。15 个正式方法/路径均有客户端方法：

| 方法 | 相对路径 | 客户端用途 |
| --- | --- | --- |
| POST | `/sessions` | 幂等创建空会话 |
| GET | `/sessions` | 会话分页 |
| GET | `/sessions/{session_id}` | 详情与活跃任务 |
| PATCH | `/sessions/{session_id}` | title + expected_version |
| DELETE | `/sessions/{session_id}` | 删除 |
| POST | `/sessions/{session_id}/messages` | 同时接受消息和生成，带原 IK/client_message_id |
| GET | `/sessions/{session_id}/messages` | 最新页及更早消息 |
| GET | `/sessions/{session_id}/generations/{generation_id}` | 一致性快照 |
| GET | `/sessions/{session_id}/generations/{generation_id}/events` | 带 Cookie 和 Last-Event-ID 的 GET SSE |
| POST | `/sessions/{session_id}/generations/{generation_id}/cancel` | 空 JSON，等待服务器确认 |
| POST | `/sessions/{session_id}/generations` | 失败/取消后的显式重试 |
| GET | `/preferences` | 授权偏好 |
| PATCH | `/preferences` | recent_topic_enabled + expected_version |
| GET | `/recent-topic` | 单个 item 或 null |
| POST | `/sessions/{session_id}/topic-dismissals` | summary_version |

写命令使用现有 Axios Cookie/CSRF 拦截器；认证状态机和安全拦截器源码未修改。不会在发送用户消息后再额外 POST 一个初始生成任务。4000 字限制按 Unicode 码点计算，换行规范化与首尾空白处理保持一致。

## 5. SSE 实现

- 私人解析器独立于原公开 streamMock；处理 UTF-8 跨字节分块、CR/LF/CRLF、多行 data、注释心跳和半帧 EOF。
- 校验版本、scope、generation/session/assistant IDs、帧 ID 与 sequence；相同序号不重复应用，缺口停止追加并重新读取快照。
- queued 显示排队，streaming 显示生成中；start/delta/completed/error/cancelled 分别处理；completed 替换全文，失败/取消保留已保存部分，length 截断可见。Mock usage 必须为 null。
- 初次及恢复使用一致性快照替换助手消息，再从 resume_after_event_id 接流。快任务即使早于详情读取完成，也会按接受结果中的任务 ID 恢复。
- GET 断线采用 1/2/4/8 秒上限及抖动，连续最多五次，之后提供手动重新连接；429 遵守 Retry-After，410 走快照。401/403/404/422 停止自动重连，认证失效清理身份，404 清理资源。
- 连接无有效活动约 15 秒会中断并按原任务重连；正常 EOF 未收到终态不冒充完成。按 64 KiB 帧与 128 KiB 接收缓冲边界防护。
- 重连代码只有 GET；不会重新创建任务。离开会话仅中止读取，不等同服务器取消；停止按钮 POST cancel，区分请求中、cancel_requested 与服务器终态。
- 取消针对当前会话最新观察到的任务；202 确认后的等待状态按任务 ID 单独保持，迟到的既有 delta 不会重新启用停止按钮或撤销等待提示。
- AbortController、读取器、定时器、监听器和作用域校验负责生命周期清理；后台页面重新可见时先同步快照。

## 6. 单元及工程验证

| 检查 | 本轮实际结果 |
| --- | --- |
| TypeScript `npm.cmd run typecheck` | 通过 |
| ESLint `npm.cmd run lint` | 通过，0 warnings |
| 单元测试 `npm.cmd run test:unit` | **25 passed**，0 failed/cancelled/skipped |
| 前端构建 `npm.cmd run build` | 通过；JS 452.20 kB / CSS 46.38 kB |
| 最终完整浏览器套件 | **76 passed**，0 failed/error/skipped，231.07 秒；原有 49 项 + P3 27 项；retries=0 |
| CodeRabbit CLI 0.9.2 最终复审 | **0 issues**，退出码 0，23 个前端变更文件全部覆盖 |
| Git diff / 文件边界 | 检查通过；共同契约、后端和根配置无差异 |

以上为功能修复完成后的完整验收：类型、lint、25 项单元、构建及一次完整 76 项浏览器套件均在最后功能修复后运行。源码 SHA-256 在 CodeRabbit 最终复审和完整验收期间保持一致；暂存检查随后仅清除 `commands.ts` 末尾一个多余空行，并更新本报告，未再改动功能。浏览器分组：认证 9、布局 10、基础路由 5、P3 聊天 27、话题演示 18、恢复 7。

最终 JUnit：[p3-submit-final-browser.xml](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/.verification/p3-submit-final-browser.xml)，日志为同目录的 `p3-submit-final-browser.txt`。单元、构建、类型和 lint 日志分别为 `p3-submit-test-unit.txt`、`p3-submit-build.txt`、`p3-submit-typecheck.txt`、`p3-submit-lint.txt`，均为本地忽略产物。

保留失败记录：此前完整 72 项中 71 passed / 1 error；失败是 Mock 在真实身份检查期间收到请求取消后仍调用 `route.fulfill`，导致 `Route is already handled`。fixture 现在只忽略已确认取消请求的回复失败，其余异常继续抛出；修复后重新运行了上述完整 76 项，而非只重跑失败项。首次静态检查脚本还因将 `test:unit` 用作 Windows 日志文件名而停止；修正日志名后单元与构建已实际执行并通过。

新增用例覆盖：懒创建/发送/输入交互、安全文本、断线同任务重连、事件去重、取消 202/200 及失败、历史分页/重命名/删除、未知发送结果的幂等重试、最近话题授权/继续/隐藏/关闭、退出与 A/B 隔离、390/320px、认证过期、访客私人路由、410、缺口、显式生成重试、事件 404、Retry-After、排队展示、晚到删除回调、跨会话独立重试、取消确认后的迟到 delta，以及 403/409/422/503 的发送恢复。

既有安全断言未删除。两项账号切换测试的历史准备改为私人契约 fixture；恢复测试的错误断言限定到主内容区域，避免与侧栏独立聊天服务错误混淆，保留失效令牌、旧密码、跨标签页撤销及私人邮箱不可访问的断言。

已查看 [1440×900 桌面截图](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/.verification/p3/contract-mock-desktop.png) 和 [390×844 移动截图](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/.verification/p3/contract-mock-mobile.png)，布局保持原风格，HTML 测试输入按文本显示。截图和 XML 都是本地被忽略的测试产物。

## 7. 浏览器与 Mock 验证边界

P3 HTTP fixture 只在 Playwright 测试中安装，显式命名“P3 HTTP 契约 Mock”。正式客户端没有 fixture 或自动成功回退。

fixture 使用真实本地 P2.5 注册/登录 Cookie；每个私人请求用真实当前用户接口核验身份，每个写请求还核验现有 CSRF 和 Origin。没有万能测试身份头或认证绕过。账号数据按服务端核验出的用户 ID 隔离。

当前浏览器结果只证明前端与冻结契约的匹配、认证前端回归和公开演示回归，**不代表 P3 后端已经实现或真实前后端联调通过**。SSE 任意分块/缓冲/超时细节还由独立单元测试覆盖，静态 HTTP fixture 不冒充真实 TCP 分块。

测试使用已安装 Edge、本 Worktree 的独立前端依赖，以及 `frontend\.verification\backend-venv` 中独立安装的锁定 Python 依赖。既有 E2E 启动器仅初始化本 Worktree 下新建的 UUID SQLite 测试文件；没有连接现有 PostgreSQL/Redis，没有操作 Docker 或生产数据。

## 8. 未完成事项与主 Codex 配合

1. 后端 P3 尚未合入本分支；统一集成时关闭 HTTP fixture，使用真实 P3 API + 私人 Mock Provider + 明确隔离的测试数据库，重验持久化、幂等、事件持续鉴权、取消竞态、重启与 owner 隔离。
2. 现有后端 E2E 脚本固定 `25174/28101`，前端不能越界修改。本轮串行持有命名互斥量 `Local\WeiBiYe-P3-E2E-25174-28101`，启动前检测端口，拒绝复用或终止未知服务。主 Codex 需接收后端端口/Origin 参数化提交后统一连接前端计划端口；此之前两个窗口不得并发跑旧配置。
3. 物理移动设备/真实软键盘尚未验收；当前为桌面 Edge 视口与既有 VisualViewport 模拟检查。
4. 真实模型、长期记忆、钱包计费、支付和部署不在前端本轮范围。

## 9. 合并条件

**前端最终审查及测试通过，具备交由主 Codex 在本地集成分支合并的条件。** 按计划先集成后端、再集成前端，并运行关闭 fixture 的真实 API 联调；本窗口不自行合并。P3 总体验收尚未完成，不能用本报告的 Mock 结果替代真实 HTTP/数据库、持续鉴权或 PostgreSQL 并发证据。

## 10. 操作边界

没有修改 backend、现有迁移、Compose、环境示例、共同契约、其他 Worktree 或 AgentForge-AI。未对现有数据库执行迁移，未调用真实付费模型，未部署、推送或自行合并。验收后暂停，等待主 Codex 审阅及统一集成。

提交白名单为第 2 节 24 个文件。未发现密钥或认证令牌；`.verification`、`node_modules`、Python 虚拟环境、缓存、SQLite、截图、XML、CodeRabbit 二进制及构建产物全部排除，不提交测试生成的账户/邮件数据。共同契约及计划的 SHA-256 分别保持为 `9c599b12fb8690df863001f28e653dddfe3b355703df20e9e6985aab32f7bd36`、`1023e9a34dad467146175cc74d7d6eaa3075a69e86dc56a7e9f9255f72579fba`。

## 11. 最终审查与修复

| 来源 | 问题与影响 | 处理及验证 |
| --- | --- | --- |
| CodeRabbit 首轮：⚠️ Major | 明确 4xx 拒绝后仍保留 pending intent，后续不同输入或会话被阻塞 | 清理明确拒绝的 intent，并改为核对输入/历史提示；403、409、422 浏览器回归通过；503、429、超时仍保留原标识 |
| 本地审查 | 旧任务终态快照可能抢占当前新任务，停止按钮请求错误对象 | 统一选择当前会话最新任务；单元覆盖新任务观察和会话隔离 |
| 本地审查 | 某会话未知的生成重试阻止其他会话重试 | 按 session/generation 分配并保留各自键；单元及跨会话浏览器回归通过 |
| 本地审查 | 迟到的已提交 delta 可能覆盖 cancel_requested 等待提示 | 独立记录已受理的取消任务 ID，终态才清除；延迟 delta 浏览器回归通过 |
| 本地审查 | 非布尔授权值或无效摘录日期/来源可能误开推荐或使页面抛错 | 增加授权/摘录运行时校验及 PATCH 回执一致性校验；单元拒绝畸形数据 |
| 完整回归 | 被取消的 Mock 请求在收尾时仍收到回复，导致偶发路由异常 | 统一处理已取消请求的 fulfill 失败，保留其他异常；最终完整套件 76/76 |

CodeRabbit 首轮提出 **1 issue（major）**，已核实并修复；第二轮 **CodeRabbit raised 0 issues.** 两轮可核验的本地日志：[首轮](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/.verification/coderabbit-review-first.ndjson)、[最终复审](D:/AIProjects/WeiBiYe-worktrees/p3-frontend/frontend/.verification/coderabbit-review-final.ndjson)。使用了 [CodeRabbit 审查技能](D:/CodexData/plugins/cache/openai-curated-remote/coderabbit/1.1.4/skills/coderabbit-review/SKILL.md)，本地问题没有冒称为 CodeRabbit 发现。

范围核对：本会话显式使用 `--base-commit e62d3864ee094404a995a79b1ea10429ac9966ff --uncommitted --include-untracked --dir frontend`，共同两份 P3 文档作为只读上下文。最终日志的 23 个 reviewedFiles 与 Git 中全部 23 个前端修改/新增文件逐项一致，差集为零；唯一额外交付文件为本专属报告。用户提供的另一次“75 个文件 / No findings”未附本地日志或基线参数，因此不据此推断其覆盖版本，也不替代本会话的可核验差异审查。

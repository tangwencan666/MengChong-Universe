# P8.1 月芽 DeepSeek 桌面聊天验收

状态：**P81_OFFLINE_VERIFIED / REAL_E2E_APPROVED_PENDING_ORIGINAL_CMD**。本轮已完成定向开发及离线真实基础设施端到端验收。用户随后明确答复“批准这 2 次，提供原 CMD 命令”，仅批准本文约定的两次受限合成请求。当前 Codex 进程看不到原 CMD 密钥，尚未执行本轮额外真实模型请求，不宣称真实桌面链路已经通过。

日期：2026-11-02（Asia/Shanghai）。目录 D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot；分支 codex/consumer-desktop-pivot，HEAD 83c1b0943d694a26ab728af457c5e3dc4ddccad2；没有提交、推送或部署。

## 已核实的前置状态

- 保护本轮起点 156 个未提交文件，保存 SHA-256 和源码副本到 .verification/p81/pre-p81-source/；未覆盖原有 P6/P7/P8 成果。
- 上次真实 API 脱敏报告 deepseek-live-b0264ed64db345db97776c32ae52093c.json 确为 LIVE_TEST_COMPLETED、deepseek-flash、输入 14／输出 1 Token。它属于先前独立请求，不冒充本轮端到端结果，不重用其付费授权。
- Electron 没有强制 Mock；已登录聊天通过 Cookie/CSRF 走真实后端。访客演示才固定 Mock。P8 原局限是服务端全局选模及前端全局 runtime 查询。
- 共享 weibiye 为 0005／26 表；独立测试库 weibiye_p6_desktop_test_e0426321109c4f04959c7a86ecac2d95 为 0006／34 表，集群 7703042374370492450。测试前 active 生成任务 0。没有迁移或修改共享库。

## 最终实现

新增开发专用精确 owner UUID + pet UUID 配置；仅 development、全局 Mock、显式真实开关和后端密钥同时具备时，目标宠物选择 deepseek-flash。其他宠物及 legacy 仍为 Mock。没有按名字/角色匹配，也没有给前端开放 provider 选择；同名宠物不会得到权限。

新 GET /api/v1/pets/{pet_id}/runtime 在认证、数据库能力和 owner 检查后返回原 chat-runtime/1 六字段白名单。前端使用当前宠物路径，沿用已有账号/pet 缓存隔离、未知模式禁发与发送前配置变化中止逻辑。未知及其他用户宠物返回 404；未登录 401；写操作 Cookie/CSRF 不变。

生成任务冻结模型，worker 开始及最终派发前重验当前定向范围、model、owner/pet、人格、隐私 epoch 和租约。已接受的 Mock 任务继续本地完成，不自动升级付费；真实任务的授权/配置变化则拒绝派发。

月芽的真实模式不额外检索或注入长期记忆；其他 Mock 宠物保留原 P4 授权记忆能力。授权、来源、撤销、删除和用户/宠物隔离没有放宽。真实消息、会话历史和人格可能发给服务商，UI 明确披露，不能把“不额外注入记忆”宣传为所有历史内容均不外发。

真实密钥仅由后端进程读取。Node/Electron 环境先按名字剥离 WEIBIYE_/OPENAI_/DEEPSEEK_；没有密钥前端变量、IPC、客户端日志或数据库字段。没有新模型/迁移表变更。

## 实际测试结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 按宠物选模与现有模型快照测试 | 26 通过，0 失败，0 跳过（新 20＋旧 6） | backend-scoped-provider.log |
| SDK、宠物聊天/记忆竞态/SSE、运行时限制及安全回归 | 108 通过，0 失败，0 跳过 | backend-routing-regressions.log |
| 收费门禁、请求预算与凭据过滤工具测试 | 15 通过，0 失败，0 跳过 | guard-tests.log、guard-tests.xml |
| 真实联调控制器 Fake 子进程回归 | 23 通过，0 失败，0 跳过；不实际启动收费子进程 | live-controller-final.log |
| TypeScript、ESLint | 全部通过 | 实际命令退出 0 |
| 前端构建 | 通过；约 504 kB 主 JS 的体积提示仍在 | 实际构建输出 |
| 前端单元测试 | 43 通过，0 失败，0 跳过 | Node test 输出 |
| 完整 Chrome 浏览器回归 | 100 通过，0 失败，0 跳过，9.9 分钟 | browser.log |
| Electron 单元测试 | 88 通过，0 失败，0 跳过 | desktop-unit.log |
| Electron + FastAPI + PostgreSQL + Redis 离线模型 E2E | 15 组通过，0 失败，0 跳过 | electron-paced.log；下方完整结果 |
| Ruff、git diff --check | 通过 | 实际命令输出 |

本轮按受影响范围执行后端回归，没有重复运行约 20 分钟的全部后端套件；不把 P8 的完整 pytest 数字冒充 P8.1 新结果。所有自动化模型响应为 Mock 或 HTTPX MockTransport，未调用收费模型。

## 实际桌面与基础设施验收

完整通过结果：.verification/p81/electron-offline-cf0124dd-fd8f-4302-9749-4078d61087cf/results.json。

该轮使用真实 Windows Electron、React、FastAPI、PostgreSQL、Redis 和两个独立合成账号。三只宠物真实窗口各有独立身份；只让月芽走实际 DeepSeek SDK + LangGraph + runner，但模型 HTTP 被严格限定的内存 MockTransport 代替。回复明确标注“P8.1 离线模拟”，并非真实模型。

通过项目：

1. 原生三宠、Electron 内点击到各自聊天、Cookie/CSRF、逐宠 runtime 披露。
2. 豆包和小云保持 Mock，消息持久化/刷新正常，不增加 DeepSeek 传输请求。
3. 月芽可见流式增量、PostgreSQL 历史、刷新恢复、provider/model 和空记忆引用。
4. 同幂等键与消息标识重放原任务；Last-Event-ID 断线重放不重复生成。
5. 停止生成得到持久化 cancelled 终态，上游模拟流关闭。
6. 模拟上游 429 得到安全错误 SSE/failed 消息，刷新后仍为失败，不自动补发。
7. 同账号跨宠物以及跨账号会话/消息/SSE/取消均拒绝；第二账号仍为 Mock，默认记忆关闭。
8. 退出后私人请求 401，所有私人窗口清理；托盘退出释放本轮端口。

截图直接捕获已核验的 webContents 实际渲染，不使用全屏/窗口矩形 CopyFromScreen，不依赖系统鼠标位置：

- actual-electron-three-pet-controls.png
- actual-moon-pet-renderer.png
- actual-moon-offline-sdk-chat.png
- actual-moon-safe-upstream-error.png
- actual-second-account-mock-chat.png

这些截图证明应用实际渲染，不冒充 Windows 桌面合成或物理输入测试。

如实保留早期失败：第一轮 4 组通过后，三聊天窗口同时加载使默认 5 秒模式提示等待不足；明确等待配置读取后复验。第二轮 10 组通过后，高频测试轮询触发原有 owner 120 次读取/分钟限制，导致窗口安全失效；只读 SQL 确认错误任务实际已 failed。降低轮询频率并按窗口间隔安排测试后，最终 15 组通过。没有删除测试、跳过断言、清除限流键或提高安全阈值。

## 新真实调用计划与准入

最多两次新会话合成请求：一次真实完整 SSE＋持久化，一次出字后取消；同键重放/历史读取不新增调用。取消若输给完成，单独报告 completion_won_cancel_race，不宣称实际取消成功。上游错误注入只离线测试。

每次 64 输出 Token 上限、thinking 关闭、无自动重试、官方固定 HTTPS、无环境代理/重定向；进程共用最多两次准入尝试，失败/取消也消耗额度。输入正文 UTF-8 总量最多 4096 字节、消息最多 22 条；超限在网络前拒绝。

以每次约 5000 输入 Token 的保守参考量、峰值未命中输入 USD 0.30／百万、输出 USD 1.20／百万估算，两次约 USD 0.0032，预期低于 USD 0.01；这是估算，不是账户扣费硬上限。真实费用以账单为准，结果金额保持未知，不把 Token 估算当成实际扣费。[官方价格](https://api-docs.deepseek.com/quick_start/pricing/)

操作说明见 [P81_MOON_CHAT_RUNBOOK.md](P81_MOON_CHAT_RUNBOOK.md)。原 CMD 的临时密钥对当前 Codex 进程不可见；不会从其他进程提取。离线验收后已取得本轮两次请求的明确确认，等待原 CMD 启动受限控制器，正常退出本轮服务，不给整个后台无限启用真实模式。未取得实际运行结果前，实际联网、真实取消与账单均不当作已验收；失败后不可擅自重试这两次预算。

本轮新增真实请求：0；当前新增实际 API 费用：0。先前 14／1 Token 的独立请求另行记录，实际扣费未查询账单。

## 修改文件

- 后端：app/core/config.py；新 app/agent/provider_selection.py；app/agent/chat_runner.py；app/modules/companion/service.py；app/modules/pets/chat_router.py、memory_runtime.py。
- 后端回归：新 tests/test_pet_provider_selection.py；旧 tests/test_chat_runtime_review.py 只把不完整 SimpleNamespace fixture 换成正确 Settings，断言保留。
- 前端：src/features/chat/api.ts；新 e2e/pet-provider-disclosure.spec.ts。
- 联调工具：新 backend/scripts/p81_pet_server.py、p81_live_acceptance.py；新 backend/tests/test_p81_acceptance_guards.py、test_p81_live_controller.py；新 desktop/test/p81-e2e.cjs、p81-live-e2e.cjs。
- 文档：本报告与 P81_MOON_CHAT_RUNBOOK.md。

## 收尾

共享库最终只读快照仍为 0005／26 表，结构、逐表记录数与数据哈希和起点一致；没有原库数据写入、DDL 或迁移。独立测试库 active 任务为 0，Redis PING 和实例标识保持一致。独立 SQL 复核本轮 completed DeepSeek 任务已持久化模拟 usage={input_tokens:40,output_tokens:20}；该数字是离线固定用量，不冒充实际模型账单。

本轮测试 API 收到私有停止信号后日志显示 Application shutdown complete、Finished server process。Electron 托盘退出，38319／35319／38329／35329／28101／25174 本轮端口全部释放。没有停止其他服务或操作任何 Docker 资源。

156 个受保护原文件全部保留；只有本轮清单所需的既有文件修改，其余原字节不变。Git HEAD、全部分支/标签引用和 Worktree HEAD 列表与起点一致，暂存区为空。工作区保留 P6/P7/P8 和本轮 P8.1 的未提交成果，没有修改其他 Worktree、原始图片或历史报告。

证据：.verification/p81/before.json、pre-p81-source/、shared-before.json、shared-after.json、safety-after.json、guard-tests.xml 及上述测试日志。真实 P8.1 模型调用尚未开始；已单独批准两次，待在原 CMD 运行并核实脱敏结果。

# P8 DeepSeek 接入验收

状态：**P8_PROVIDER_OFFLINE_VERIFIED / DESKTOP_RECHECK_BLOCKED / LIVE_TEST_APPROVED_PENDING_ORIGINAL_CMD**。适配器与后端离线验收通过；桌面曾完整通过 13 组，最终追加原生点击复验仍受遮挡/焦点不稳定阻塞，不宣称桌面最终重复验收全部通过。用户已明确批准一次受限真实测试并要求提供原 CMD 命令；本代理尚未调用真实 API。

验收日期：2026-11-02（Asia/Shanghai）。工作目录为 D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot，分支 codex/consumer-desktop-pivot，HEAD 保持 83c1b0943d694a26ab728af457c5e3dc4ddccad2。未提交、未推送、未部署，未操作 Docker。

## 已实现与修复

1. 新 DeepSeekProvider，默认 deepseek-flash（用户明确同意替换退役型号）；Mock/OpenAI 保留，真实调用默认关闭。
2. 官方固定 HTTPS 兼容 API、流式增量、stop/length、超时、取消/早退关闭、错误脱敏、零 SDK 自动重试。Token 输入/输出统计兼容 P3；额外缓存/total 明细分开保存，缺失即未知。
3. 后端 SecretStr 配置排除密钥序列化；调用上下文抑制 SDK/HTTP DEBUG 敏感日志。Electron 启动器剥离后端模型环境变量，不把密钥传给渲染器。
4. 认证只读 runtime 公开六个白名单字段；前端展示实际模式及费用边界。配置读取失败时禁发，发送前配置变化时更新说明并中止，不默默把免费 Mock 操作变成真实调用。
5. 修复宠物 LangGraph 的旧 Mock-only 阻塞：真实模型关闭记忆注入时仍执行 owner/pet/人格/epoch/租约/首次派发检查，空记忆引用，不检索或外发长期记忆。原 Mock 记忆路径保留。
6. 宠物、记忆及欢迎页清除与真实模式冲突的固定 Mock 宣称。首页三句文案和 P7 目标角色预览保留。

没有实现真实模型长期记忆注入、用户/宠物级模型选择、真实支付或钱包计费。模型选择仍由服务端冻结到任务，响应和 SSE 契约不变；本轮没有数据库模型或迁移变更。

## 实际测试

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 完整后端 pytest | 662 通过，0 失败，52 条件跳过；1196.54 秒 | .verification/p8/pytest.xml、pytest.log |
| 新真实 Provider 宠物 runner 回归 | 11 通过，0 失败 | pet-provider-tests.log |
| 最终记忆运行时受影响回归 | 25 通过，0 失败 | pet-runtime-regressions.log |
| Provider + 既有安全测试 | 57 通过，0 失败（与完整 pytest 重叠，不相加） | provider-tests.log |
| TypeScript | 通过 | 实际命令退出 0 |
| ESLint | 通过 | 实际命令退出 0 |
| 前端构建 | 通过；约 504 kB 主 JS 的构建体积提示 | 实际命令退出 0 |
| 前端单元测试 | 43 通过，0 失败，0 跳过 | Node test 输出 |
| Electron 单元测试 | 88 通过，0 失败，0 跳过 | desktop-unit.log |
| Chrome 完整浏览器回归 | 96 项：95 通过，1 项旧文案断言失败；修订后该项定向复验通过。最终隐私提示更新后，受影响 4 项披露浏览器回归再通过 | browser-chrome.log、browser-copy-regression.log、browser-final-disclosure.log |
| 原生 Electron + 真实 PG/Redis + 离线 DeepSeek SDK 链路 | 一轮完整 13 组通过，0 失败，0 跳过；最终提示更新后的追加复验 4 组通过、1 组失败、8 组未执行，见下文，不覆盖旧失败记录 | electron-reverified.log；electron-current.log；各 electron-offline-* 结果 |
| 完整 Ruff | 通过 | ruff.log |

完整 pytest 启动后补充的宠物运行时修复，使用上述 11 项新测试与 25 项既有回归在最终代码上验证。最终 collect-only 为 725 项：完整运行 714 项（662 通过、52 跳过），补充 11 项新增测试通过，独立成功覆盖 673 项；25 项既有回归与主套件重叠，不重复相加。

52 条件跳过均为需专用显式连接的旧 opt-in 基础设施模块：auth PostgreSQL 1、chat PostgreSQL 10、local infrastructure 9、memory P4B PostgreSQL 13、memory PostgreSQL 10、memory races 2、memory Redis 1、P3 Redis pool 1、pet PostgreSQL 5。没有设置这些旧套件的连接变量，也没有让它们回退共享库。它们不能冒充本轮通过；本轮实际 PG/Redis 验证另由上述独立数据库原生/API 运行提供。

### 如实保留的失败过程

- 首次浏览器启动未配置已安装 Chrome，Playwright 内置 Chromium 不存在；在确认环境问题后中止。使用本机 C:\Program Files\Google\Chrome\Application\chrome.exe 重新运行，没有安装全局软件或删除测试。
- Chrome 完整回归唯一失败是旧断言“真实模型尚未开放”与已修订披露不一致；更新为“聊天模型由服务端配置”，同时保留 Live2D/公开发行未开放断言并断言旧误导文案消失，定向复验 1 通过。
- 首轮桌面验收 5 组通过后，在已完成流式、持久化和刷新断言之后，Chromium 截取被遮挡窗口超时；第二轮 4 组通过后，原生输入保护发现遮挡而拒绝点击。只调整本测试实例的窗口显示顺序，改用 PID/句柄核验的 Windows 截图；没有绕过遮挡保护或操作其他应用。最终 13 组全部通过，旧结果文件保留。
- 新增宠物测试曾有测试自身引用未映射字段的问题，修正为表列读取；最终 11 项通过。早期中止的批次不作为通过证据。
- 最后收窄隐私说明为“本次消息及当前会话历史将发往模型服务商”“本次不额外注入长期记忆”，对应单元/4 项浏览器回归已通过。追加桌面复验 ff79da7e 在第 5 组原生点击等待超时（4 通过、1 失败、8 未执行），07f8983b 在第 5 组被原生遮挡保护拒绝（4 通过、1 失败、8 未执行），均正常退出并释放端口。ff79 截屏已与预期三宠界面不一致；屏幕像素可能受其他窗口覆盖，不能仅凭 HWND 认定像素来源。现有证据不足以确定产品缺陷、系统焦点还是外部覆盖的原因，停止补点/重试，不绕过安全校验。下次需在可控桌面中记录逐宠可信指针事件、焦点和 IPC/窗口状态后复验。

## 真实基础设施与 Mock 的界限

使用已有独立测试库 weibiye_p6_desktop_test_e0426321109c4f04959c7a86ecac2d95（0006／34 表），PostgreSQL 127.0.0.1:25433，集群 7703042374370492450；Redis 127.0.0.1:26380/0 使用独立 P8 前缀。启动前活动生成任务为 0。

完整通过的 e0f99dec 轮实际启动 Electron、React、FastAPI、PostgreSQL、Redis，使用两个合成账号和三只真实窗口宠物，验证 Cookie/CSRF、UI 逐段输出、数据库历史与刷新、同键幂等、Last-Event-ID 断线重放、取消终态与流关闭、跨宠/跨账号 404、退出后 401、托盘退出与端口释放。另以只读 SQL 核对该轮 completed 生成任务 provider=deepseek、model=deepseek-flash、usage={input_tokens:40,output_tokens:20}，pet_generation_contexts.memory_refs 为空。

DeepSeek SDK/适配器/工厂/LangGraph/runner 确实执行，但唯一 HTTP 传输是内存 MockTransport，使用假密钥。固定回复明确带“DeepSeek 离线模拟”，并非真实 DeepSeek 回答。该测试为验证前端真实模式披露而显式模拟 real 配置；不能据此宣称已验证互联网 API 连通或真实账单。

本轮真实模型请求数：**0**。本轮实际 API 费用：**0**。真实密钥有效性、账号余额、服务可达性及实际扣费尚未验证。另一个 CMD 的临时密钥当前 Codex 进程不可见；不会提取其他进程凭据，不要求在聊天中粘贴密钥。

## 安全默认和下一次真实验证

默认 Mock 与 real_llm_enabled=false 保留；未给整个聊天后台启用真实付费模式。离线验收后用户明确答复“批准一次，提供原 CMD 命令”，仅授权下述一次独立测试，不包含持续聊天调用或自动重试。等待用户在已有临时密钥的原 CMD 中执行，当前代理不假定能读取那个窗口的环境。

准备好的受限 CLI 见 [P8_DEEPSEEK_LIVE_TEST.md](P8_DEEPSEEK_LIVE_TEST.md)：仅在原 CMD 的后端子进程读取临时环境密钥；一次固定合成 OK 请求，32 输出 Token，thinking 关闭，15 秒 Provider 超时及 18 秒整体超时，无自动重试、无聊天或记忆。默认命令已实际验证为 LIVE_TEST_NOT_CONFIRMED、provider_invocations=0。未来调用失败/取消也可能产生费用，实际金额以服务商账单为准，Token 参考估算不冒充实际扣费。

## 截图

完整通过轮目录：.verification/p8/electron-offline-e0f99dec-f075-4ac5-8158-c7523c0b4347/。这些画面早于最后一次隐私措辞收窄；展示的是明确本地模拟回复，不能当作真实 DeepSeek 截图，也不冒充最终失败轮的通过证据。

- windows-three-pets.png：实际三宠 Windows 运行画面（P7 目标角色仅本地预览）。
- deepseek-offline-chat-a.png：账号 A 真实桌面聊天、离线模拟回复与 DeepSeek 模式披露。
- deepseek-offline-chat-b.png：独立账号 B 的真实聊天与刷新。

## 数据和文件保护

启动前保护原有 133 个未提交文件：逐一核对 P7 交付 SHA-256，保存到 .verification/p8/pre-p8-source/；原图不修改。133 个原文件全部存在，其中 122 个保持原字节，11 个因 P8 接入必要变更已在本报告列明；受保护角色 PNG 哈希保持一致。

收尾只读快照确认共享 weibiye 仍为 0005／26 表，结构、逐表记录数与数据哈希和本轮起点完全一致。Redis PING 正常、实例 run_id 未变；独立测试库 active 生成任务为 0。本轮新建 API 服务已停止；38318、35318、25174、28101 均无本轮监听，Electron 试验实例全部退出。Git HEAD、全部分支/标签引用和 Worktree HEAD 列表未变，暂存区为空；工作区保留原有 P6/P7 及本轮 P8 未提交成果。没有向其他 Worktree 写文件，没有操作 Docker/数据库迁移/清理旧数据。

证据：.verification/p8/safety-after.json、shared-before.json、shared-after.json、change-scope.json。临时测试数据只写在明确隔离的测试库与 P8 Redis 前缀中，保留作为证据，不清空共享库或其他数据。

## P8 修改文件清单

- 后端适配与配置：app/agent/providers.py、state.py；app/core/config.py；app/modules/companion/router.py、schemas.py、service.py；app/modules/pets/memory_runtime.py。
- 后端工具与测试：scripts/deepseek_live_smoke.py、p8_offline_server.py；tests/test_deepseek_provider.py、test_deepseek_live_smoke.py、test_deepseek_pet_runtime.py、test_provider_selection.py。
- 前端运行模式及披露：src/features/chat/api.ts、types.ts、PrivateChatProvider.tsx、provider-presentation.ts；src/pages/companion.tsx、companions.tsx、memory.tsx、home.tsx。
- 前端回归：tests/provider-presentation.test.mjs；e2e/helpers/p3-chat-mock.ts、provider-disclosure.spec.ts、foundation.spec.ts、chat-layout.spec.ts。
- Electron：scripts/launch.cjs；src/launch-env.cjs、gateway.cjs；test/launch-env.test.cjs、p8-e2e.cjs。
- 文档：docs/P8_DEEPSEEK_INTEGRATION.md、P8_DEEPSEEK_LIVE_TEST.md、P8_VERIFICATION.md。

以上为相对各 backend/frontend/desktop 目录的本轮清单，不把早已存在的全部 P6/P7 未提交内容冒充 P8 新增代码。

详细接入配置与协议说明见 [P8_DEEPSEEK_INTEGRATION.md](P8_DEEPSEEK_INTEGRATION.md)。剩余事项为经确认的一次真实连通性测试、实际账单核对，以及未来单独设计的真实模型记忆授权、配额/预算和用户级切换；本轮不擅自扩展。

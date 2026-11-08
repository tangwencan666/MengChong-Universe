# P8.1 月芽定向 DeepSeek 联调

本轮工作目录：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot。数据库迁移不变；仅在已核验的独立 0006 测试库运行，不升级共享 0005 库。

## 哪一层决定模型

Electron 只打开受认证和 owner/pet 校验的 React 聊天路由，没有把已登录聊天强制替换为 Mock。访客演示仍固定 Mock。P8.1 后端新增按账号 UUID＋宠物 UUID 的开发定向选择，前端改读 `/api/v1/pets/{pet_id}/runtime`；旧版聊天仍读 `/api/v1/companion/runtime`。

定向条件必须同时成立：development、全局 provider=mock、real_llm_enabled=true、后端 DeepSeek 密钥，以及成对精确的配置：

- WEIBIYE_DEV_DEEPSEEK_PET_OWNER_ID
- WEIBIYE_DEV_DEEPSEEK_PET_ID

不按宠物名字、角色类型或客户端提交的 provider 来授权。把其他宠物改名为“月芽”不会获得真实模型权限。未知或其他账号宠物的 runtime 和私人资源返回 404，未登录返回 401。

仅被选中的宠物派生独立 DeepSeek 设置；其他宠物和旧版聊天保持 Mock，Mock 下原有逐条授权记忆注入能力不变。真实月芽本次不额外检索/注入长期记忆，但本次消息、当前会话历史和宠物人格会发送给模型服务商。

任务接受时冻结 provider/model，派发前再次检查账号、pet、配置、人格、授权 epoch、租约。已接受的 Mock 任务可以继续在本地完成，不升级为付费请求；真实任务的授权目标或模型改变后拒绝派发，不自动切换。

## 离线验收

后端工具 `backend/scripts/p81_pet_server.py` 默认为内存 HTTPX MockTransport，假密钥，真实 PostgreSQL/Redis。只让月芽走实际 DeepSeek SDK 适配器；豆包、小云及第二账号宠物走原有 PrivateMockLLM。明确标注的合成回复不等于真实 DeepSeek 回复。

`desktop/test/p81-e2e.cjs` 只接受 `httpx-mock-only` manifest；真实模型目标会被拒绝。以真实 Electron 渲染器点击触发 preload/受控 IPC/认证 API，不移动全局鼠标。截图由核对窗口和 URL 的 webContents.capturePage 取得，不把屏幕覆盖窗口的像素当作本应用截图。它验证应用渲染，不宣称物理鼠标或 Windows 桌面合成验收。

测试不清除限流键或提高生产安全阈值。三宠多窗口场景按现有 120 次 owner 读取/分钟安排节奏，状态查询约每秒一次，避免测试脚本自己触发限流。

## 下一次经确认的真实联调

上次独立 API 测试的本地脱敏报告已核实：deepseek-flash，14 输入 Token、1 输出 Token，LIVE_TEST_COMPLETED。它不等于月芽桌面链路已经真实验收，也不包含本轮额外付费授权。

本轮计划最多 **2 次**月芽上游请求：

1. 全新会话中的短合成问候，验证真实 SSE、历史、刷新、同键重放和 Last-Event-ID；后续重放只用已有任务，不另起模型请求。
2. 另一全新会话中的短合成输出，尝试在出字后停止。若模型先完成，明确记录 completion_won_cancel_race，不冒充真实取消成功。

其他宠物、账号隔离和错误故障注入先离线验证，不刻意向真实 API 发送错误请求。真实阶段的两只非目标宠仍 Mock，不增加 DeepSeek 请求。

每次最多 64 输出 Token，关闭 thinking/SDK 重试，官方固定 HTTPS 端点，不使用环境代理或重定向。后端按进程共用最多 2 次准入尝试；连接失败、取消也消耗预算，不自动补发。上游输入正文总 UTF-8 字节超过 4096、消息超过 22 条或请求格式不符时拒绝网络派发。

按每次约 5000 输入 Token 的保守参考量和 64 输出上限，以当前峰值未命中输入 USD 0.30／百万、输出 USD 1.20／百万估算，两次约 **USD 0.0032**，预期低于 USD 0.01。该估算不是精确 tokenizer 计数或账户扣费上限；实际金额以服务商账单为准，取消/失败也可能产生费用。[官方价格](https://api-docs.deepseek.com/quick_start/pricing/)

2026-11-02 完成离线验收后，用户已明确答复“批准这 2 次，提供原 CMD 命令”。这仅批准上文两次有界合成请求，不包含失败自动重试或持续付费预览。在**已设置 WEIBIYE_DEEPSEEK_API_KEY 的原 CMD 窗口**中，仅执行一次：

```cmd
cd /d "D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend"
.venv\Scripts\python.exe -B -m scripts.p81_live_acceptance --confirm-paid-requests 2
```

工具建立全新 `.verification/p81/live-<UUID>/`，仅启动本轮独立测试 API（38329）与 Electron（35329），使用同一已验证隔离数据库。仅后端继承 CMD 的密钥环境；传入 Node/Electron 前先过滤全部 WEIBIYE_/OPENAI_/DEEPSEEK_ 变量。不会写入前端、Git、`.env`、数据库或模型日志。

结束或中断时通过本轮私有停止信号让测试应用/API 正常退出；不停止其他服务、不强杀其他进程。不能确认退出时报告 CLEANUP_BLOCKED，不能当作成功。成功摘要严格区分实际取消与完成先于取消；模型用量可从生成任务和完整验收结果查证，金额保持未知，不捏造账单。

未确认时只运行下面的安全默认命令，会在启动进程、读取密钥或访问数据库前停止：

```cmd
.venv\Scripts\python.exe -B -m scripts.p81_live_acceptance
```

当前 Codex 进程看不到另一个 CMD 的临时变量，不能假定服务器有密钥。不读取其他进程、不要求粘贴密钥。执行结果若失败，保留脱敏 JSON 和证据，先不要重复命令。

本工具是两次预算的联调流程，不是无人值守持续付费聊天入口。持续手动体验需要另行明确费用和服务运行范围。

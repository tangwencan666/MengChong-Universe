# P8 单次真实 DeepSeek 测试

当前默认仍为 Mock；用户已确认 P8 默认型号使用 `deepseek-flash`。2026-11-02 离线验证后，用户明确答复“批准一次，提供原 CMD 命令”，授权以下一次受限请求。授权不等于执行成功；当前 Codex 进程看不到原 CMD 的临时密钥，尚未调用真实 API。不得依据这一次授权自动重试或开启整个后台持续付费调用。

## 测试边界

- 仅调用一次官方 `chat/completions`，关闭自动重试和 thinking，不查询余额或模型列表，不自动切换型号。
- 固定合成指令“Reply exactly OK.”，最多 32 个输出 Token，Provider 超时 15 秒；不读取数据库、聊天、人格或记忆。
- 密钥只由后端进程从 `WEIBIYE_DEEPSEEK_API_KEY` 环境变量读取，不读取 `.env`、注册表或其他进程，不创建密钥文件。
- 无确认参数或当前进程看不到密钥时，在创建 SDK 客户端前停止，产生零次模型请求。
- 不显示模型正文、请求内容、密钥或原始 SDK 错误。可选报告仅包含白名单状态、模型和用量，保存在当前 Worktree 的忽略目录 `.verification/p8/`，使用新文件名，不覆盖旧证据。

## 经用户单独确认后执行

在**已经设置密钥的原 CMD 窗口**运行以下命令。若 Codex 不是该窗口的子进程，其后端通常看不到这个临时变量；不要把密钥粘贴到聊天中，也不要为此写入前端或 Git。

```cmd
cd /d D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend
.venv\Scripts\python.exe -B -m scripts.deepseek_live_smoke --confirm-paid-request --report
```

仅检查安全默认行为、**不调用 API**：

```cmd
.venv\Scripts\python.exe -B -m scripts.deepseek_live_smoke
```

该命令不会启动 FastAPI、Electron 或数据库，不改变服务器的 Mock 配置。单次失败后必须先检查原因，不自动重试。`LIVE_TEST_COMPLETED` 表示收到预期的合成回复；其他状态均不能当作成功。

## 用量与费用

报告分别保存 `usage`、可用的缓存 Token 用量及 `response_model`。没有用量时记录未知，不伪造为零。取消、超时或失败请求也可能已经产生费用。

参考 2026-11-02 的官方 `deepseek-flash` 峰值价格：每百万 Token，缓存命中输入 USD 0.006、未命中输入 USD 0.30、输出 USD 1.20。CLI 使用 Decimal 计算参考估算；缓存明细缺失时按未命中输入估算。它不是账户实际扣费，实际金额字段保持未知，须核对 DeepSeek 账单；价格和时段政策也可能改变。此固定短输入、32 Token 上限适合经确认后的低成本连通性测试，不等于给真实聊天启用无限预算。

官方依据：[API 文档](https://api-docs.deepseek.com/)、[流式接口](https://api-docs.deepseek.com/api/create-chat-completion/)、[价格](https://api-docs.deepseek.com/quick_start/pricing/)。

## 独立离线回归

`backend/tests/test_deepseek_live_smoke.py` 全部替换为本地 Fake Provider，使用显式假密钥，不读取真实环境密钥、不请求网络。覆盖默认阻止、密钥不可见、唯一一次有界合成请求、继承环境隔离、取消/超时/错误脱敏、未知用量及新报告文件保护。

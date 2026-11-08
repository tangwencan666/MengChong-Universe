# P8.3 本地重验（零真实模型请求）

这些命令不部署、不发布、不迁移共享库。PostgreSQL 工具只使用本地已有的 `postgres:17-alpine` 镜像，不拉取镜像，为每次运行新建回环端口、带身份标签的专用容器和证据目录。停止时验证容器 ID、标签、挂载及端口；停止后保留容器和数据，绝不删除卷。

在**新开的临时 PowerShell 窗口**中运行。下面只按变量名清除该窗口的模型配置，不改变用户永久环境变量，也不输出任何值：

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend'
$names = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(WEIBIYE_|DEEPSEEK_|OPENAI_)' } | Select-Object -ExpandProperty Name)
foreach ($name in $names) { Remove-Item -LiteralPath ('Env:' + $name) }
$created = & .\.venv\Scripts\python.exe -B -m scripts.p83_offline_postgres --prepare-offline-postgres
if ($LASTEXITCODE -ne 0) { throw '新隔离夹具准备失败，停止测试。' }
$target = ($created | ConvertFrom-Json).evidence
try {
  $env:WEIBIYE_P83_POSTGRES_TARGET = $target
  & .\.venv\Scripts\python.exe -B -m pytest tests/test_beta_quota.py tests/test_beta_privacy.py tests/test_beta_quota_chat.py tests/test_p83_test_target.py tests/integration/test_beta_quota_postgres.py -q
  if ($LASTEXITCODE -ne 0) { throw '离线测试未通过，请保留输出。' }
} finally {
  Remove-Item Env:WEIBIYE_P83_POSTGRES_TARGET -ErrorAction SilentlyContinue
  & .\.venv\Scripts\python.exe -B -m scripts.p83_offline_postgres --stop-owned-target $target
  if ($LASTEXITCODE -ne 0) { throw '夹具未能安全停止，请检查报告，不要按进程名强制终止。' }
}
```

40 个额度/隐私/目标保护/SDK Mock/PostgreSQL 用例应通过。没有明确 P8.3 目标时，涉及真实 PostgreSQL 的 10 项会跳过，不能把跳过计为通过。`test_beta_quota_chat` 的 DeepSeek SDK 只使用 HTTPX MockTransport 及合成凭据，禁止移除该替身后运行。

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\frontend'
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:unit
npm.cmd run build

Set-Location '..\desktop'
node scripts/copy-ui.cjs
node --test test/*.test.cjs
node test/p83-https-e2e.cjs
```

HTTPS 验收工具创建新的本机 TLS 证书、SQLite、合成邮箱和独立 profile；信任 pin 仅存在于测试 bootstrap，没有关闭证书验证，也不写 Windows 根证书库。需要已有 OpenSSL（当前工具路径为 `D:/git/Git/usr/bin/openssl.exe`）和桌面依赖；尚未做工具跨机器路径自动发现。它使用保留测试域名映射到 127.0.0.1，不提供公开服务。正式 Redis readiness 和真实邮件投递不能由此替代。

安装器验证会**实际安装专用验证身份**的两个版本，并卸载该身份，命令必须明确指定执行边界：

```powershell
node test/p83-installer.cjs --execute-owned-validation
```

应从非提升令牌运行，保留专用证据/profile，不替换正式 appId、不写快捷方式、不自动启动安装完成的应用。正常升级验证时应用先退出，不等于已经验证“用户仍在聊天时覆盖升级”。`--reuse-build` 只用于核对既有验证产物哈希后重用，结果写入新目录，历史记录不改写。

本轮没有任何授权可执行 P8.1 付费命令、公开部署或发布。进入真实内测须先审查 `P83_HOSTED_ENVIRONMENT.md` 与设备矩阵，并确认独立环境、邮件、签名/分发策略和预算。

# P6 Windows 桌面预览启动说明

本轮是未签名的 Windows x64 本地开发预览，不是公开发行版或独立安装包。它复用现有真实认证、宠物作用域聊天与授权记忆 API，模型保持 Mock。Windows 10 尚未实机验证；Live2D、真实 GPT／DeepSeek、自动更新、签名与正式安装器尚未实现。

## 本机服务与数据边界

- 桌面本地入口：`http://127.0.0.1:35316`，由桌面主进程启动，用于 React 界面和受控本地代理。
- 后端 API：`http://127.0.0.1:38316`，需要单独启动。桌面 `npm start` 和 portable exe 都不会启动、安装或迁移后端。
- PostgreSQL／Redis 使用本轮已核验的 P6 隔离环境；宠物 API 需要隔离数据库的 Alembic `0006`。共享开发库 `weibiye` 保持 `0005`，不得为运行预览而执行迁移。
- 只使用测试账号。窗口从后端获取当前账号可访问的宠物，不加载其他用户的宠物。宠物小窗口不接收 Cookie、聊天正文或记忆内容；点击后在独立的受控聊天窗口打开对应 `pet_id`。

先检查已有服务和端口。已有正确的隔离后端就直接复用，避免重复启动。后端的 `/health/live`、`/health/ready` 应正常，实际配置必须确认数据库为 P6 隔离库，`WEIBIYE_LLM_PROVIDER=mock` 且 `WEIBIYE_REAL_LLM_ENABLED=false`。桌面来源 `http://127.0.0.1:35316` 必须在该测试服务现有可信来源与前端来源配置内。

不要在未配置数据库环境时直接启动普通后端入口：默认配置会指向共享开发库。本机已有验收清单位于被忽略的 .verification/p6/target.json。下面的专用启动器读取该清单、再次校验集群标识和新建测试库名称、检查0006，并强制Mock与独立Redis键前缀；它不创建数据库或执行迁移。清单缺失、目标不符或端口被占用时停止，不自行换库。

```powershell
Set-Location D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend
.venv\Scripts\python.exe -B scripts\desktop_mvp_server.py
```

## 从当前 Worktree 启动

工作目录：`D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot`。已有依赖和 UI 构建可直接使用；只有前端发生变化时才需重建和复制 UI。

```powershell
Set-Location D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot
# 仅在前端变更后执行：
$env:VITE_API_BASE_URL = ''
npm --prefix frontend run build
npm --prefix desktop run build:ui

# 先确认上述隔离 API 已启动；这一命令只启动桌面宿主。
npm --prefix desktop start -- --backend-origin=http://127.0.0.1:38316 --ui-port=35316
```

启动脚本仅运行已存在的本地 Electron，不自动下载安装运行时。界面登录后，在宠物管理页选择自己的宠物并“放到桌面”。当前最多同时放出三只。拖动可以移动宠物；短点击打开对应聊天；右键菜单支持聊天、隐藏、收回。系统托盘可重新打开主界面、管理宠物并安全退出。关闭主窗口会保留托盘运行，彻底结束请使用托盘“退出”。

## Portable 本地预览包

```powershell
npm --prefix desktop run package:portable
```

打包脚本不下载、不执行 npm 安装脚本、不连接数据库。它在 `desktop/out/WeiBiYe-win32-x64-<uuid>` 新建唯一目录，不覆盖旧包。保留全部 Electron 运行时及其许可证，加入受限应用文件、编译后的 React UI、原创宠物资源和实际前端依赖许可。没有后端、`.env`、数据库、登录 profile 或应用 `node_modules`。`PACKAGE_MANIFEST.json` 包含逐文件 SHA-256；摘要保存在被 Git 忽略的 `desktop/.runtime/packaging`。

选择最终验收报告指定的最新目录。可以显式指定新的独立 profile，避免在分发目录内写入运行资料：

```powershell
# 将下列路径换成最终报告中确认的完整 exe 路径；不要指向旧预览包。
$previewExe = 'D:\完整预览包路径\WeiBiYe.exe'
$previewProfile = Join-Path ([System.IO.Path]::GetTempPath()) ('WeiBiYe-preview-' + [guid]::NewGuid())
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& $previewExe --backend-origin=http://127.0.0.1:38316 --ui-port=35316 "--profile-dir=$previewProfile"
```

这里的环境变量移除只影响当前终端，防止开发工具把 Electron 当作 Node 运行。程序会创建此次专用 profile；不会读取旧浏览器或其他项目 profile。退出时原生宿主停止自己的计时器、窗口和本地代理。关闭此次测试后端时，只停止此次启动的进程，不停止 PostgreSQL、Redis 或其他项目服务。

## 预览限制与检查

预览应验证三只宠物独立窗口、拖动／点击区分、隐藏／收回、托盘退出、独立聊天及授权记忆。聊天回复来自 Mock Provider，不能称为真实模型测试。空闲／移动时的 CPU 与内存以本机验收报告为准，不能由包大小推断。若 API 不可用、端口冲突或数据目标不明确，保留现场并停止，不放宽 Cookie、CSRF、owner 或数据库版本校验，也不自行迁移共享数据库。

公开发布前仍需完成 Windows 10／11 兼容测试、安装器、代码签名、自动更新、运行时与第三方素材许可复核、后端交付方式和隐私说明；本预览不能作为这些能力已经完成的证明。

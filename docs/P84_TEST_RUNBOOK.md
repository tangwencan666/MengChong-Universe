# P8.4 本地动作验收操作

本轮使用既有未提交 P6～P8.3 工作树作为前置环境。新测试只连接新建的 SQLite/内存存储，模型固定为 Mock/Spy；不复用 PostgreSQL 验收目标，不调用真实 DeepSeek。历史 P8.1 上游在途取消仍未验证，P8.3 公开发行门槛不变。

## 使用五只宠物

从“我的宠物”顶部的“五种伙伴 · 选择宠物模板”进入目录。领养会创建新 UUID 和独立人格，不改变旧宠物；返回后逐只“放到桌面”，最多同时五只。点击桌面宠物触发自己的动作并打开自己的聊天窗口。

右键每只宠物，可以选择定义中的动作、关闭随机互动、开启/关闭低频自主移动、隐藏、收回或显示主界面。随机互动默认开启，自主移动默认关闭。托盘提供恢复与退出。隐藏/拖动优先于动作；AI 思考/说话优先于本地动作。只恢复位置、随机/移动开关与安全的小睡状态，不恢复已过期生成、拖动或其他账号状态。

耄耋与哈吉米在同账号、同显示器、可见、低优先级、允许随机互动且距离合适时，每 90 秒至多尝试一次本地互动。两只都允许移动时尝试 70/60 DIP 的靠近/躲避；否则只看向/转身。屏幕、其他宠物或鼠标交互挡住时安全停留。此规则不读取或交换聊天、记忆，也不请求模型。

## 离线与真实 Windows 测试

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop'
node --test test/*.test.cjs
# Windows 上实际启动 Electron、隔离 Mock 后端和自有前台探针；约 35 分钟。
node test/p84-e2e.cjs --minutes=30
```

测试期间会移动并恢复鼠标，向经过 PID/HWND 验证的本轮窗口发送点击/拖动，临时显示一个自有前台探针；请不要同时操作这些验收窗口。稳定性阶段只让测试窗口不激活地显示，并临时阻止系统休眠；不会禁用屏幕关闭，结束时释放阻止句柄。`--fast-interaction-smoke` 仅用于交互诊断，不产生性能或长期稳定性通过结论。

每次运行独立写入 `.verification/p84/windows-<UUID>/`，包括 `results.json`、Mock 后端日志、驱动副本、源文件哈希、单/三/五宠及动画/隐藏样本、截图；30 分钟通过时还有 `soak-samples.json`。不覆盖旧目录。需要停止本轮长期测试时，仅在该运行目录新建 `stop-soak` 文件，测试会报告中断并正常清理，不宣称通过。异常时先依据运行目录记录的 PID、创建时间、窗口和端口确认身份，禁止按进程名批量终止。

Python 验证必须从后端目录使用项目配置，使外部桌面 fixture 的导入分类与后端一致：

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend'
.\.venv\Scripts\python.exe -B -m ruff check --config pyproject.toml tests/test_p84_pet_catalog.py ../desktop/test/fixtures/p84_server.py
.\.venv\Scripts\python.exe -B -m ruff format --config pyproject.toml --check tests/test_p84_pet_catalog.py ../desktop/test/fixtures/p84_server.py
.\.venv\Scripts\python.exe -B -m pytest tests/test_p84_pet_catalog.py -q -W error
```

前端运行现有 `typecheck`、`lint`、`test:unit`、`build`，然后从桌面目录执行 `node scripts/copy-ui.cjs`。构建子进程应只传入按变量名过滤后的环境，移除 `WEIBIYE_*`、`DEEPSEEK_*`、`OPENAI_*`、`VITE_*`，不要输出原始环境。Windows 驱动本身会过滤模型配置，并拒绝 fixture 接收到这些配置名；本轮执行日志不记录真实密钥。

## 扩展契约与限制

`desktop/assets/pet-definitions.json` 是桌面/React 共用的公开模板目录。新增模板填写独立身份、人格、问候、三帧资源映射、随机/点击/靠近/菜单动作与移动动作。新宠物定义及其 SVG 即可复用宿主逻辑；特殊双宠规则单独放在协调器，不能访问会话/记忆。动作仍须是已注册的有界动作；增加全新动画类型需对应有限 CSS 表现及测试。

SVG 为原创占位图，不是授权网络素材；无音频。新图缓存预算 32 KiB，隐藏卸载图片，退出清缓存，CSS 动画按动作有限播放，尊重“减少动态效果”。Electron 的工作集求和会重复计算共享页；CPU 是 Electron 各进程计数之和，不等同于任务管理器整机百分比。短测与旧 P8.2 基线的主机负载、开关和场景不同，不能解释成严格的前后基准。

多显示器热插拔、其他实际 DPI、低配置机器、休眠恢复、数小时以上稳定性、签名/公开安装分发仍需专项实测。真实模型的人格表达与上游取消不由本轮 Mock 测试证明。

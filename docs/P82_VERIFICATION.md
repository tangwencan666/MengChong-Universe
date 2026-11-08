# P8.2 第一阶段验收（2026-11-02）

状态：**P82_WINDOWS_MVP_OFFLINE_VERIFIED**。第一阶段功能已实现，并在当前 Windows 主机完成实际窗口和物理鼠标输入测试。模型部分全部为本地 Mock 或离线 SDK MockTransport，不是新增真实 DeepSeek 验收，也不是消费者安装发行认证。

P8.1 已按 [阶段归档](P81_STAGE_CLOSEOUT.md) 保留“核心链路已验证、真实上游取消未验证”的结论，不标记全部真实验收通过。

## 修改与实现

复用 Electron manager、透明窗口、托盘、受限 preload、SVG 宠物和 React 聊天上下文。新增显示器几何、用户/宠物作用域位置存储、四种展示状态和本地问候。

- 窗口仍为透明、无边框、固定 DIP 大小；显示时不主动聚焦，透明外围保持原有鼠标穿透。
- 拖动结束原子保存位置；记录只含 owner+pet 的哈希键、坐标及显示器工作区，不保存凭据、对话或记忆。恢复先验证当前账号和宠物。
- 支持负坐标显示器、分离的工作区、拔屏和工作区/DPI 变化后的夹取；不把显示器并集中的空隙当作可见桌面，不重复乘 DPI。
- 默认安静停留；复用单一 50ms 调度器，不为各宠物新增高频计时器。不每帧写盘。位置条目最多128、同时宠物最多3、展示历史有界。
- idle/happy/thinking/speaking 与原运动状态分开。React 独立组件只订阅 ChatContext；IPC 只传 generation/session/本地展示修订号/状态和是否有正文，不传正文。修订号不是权威 SSE 序号。
- 宿主校验注册窗口、当前账号、宠物及当前会话路径；拒绝过期、退役任务和终态回退，不允许操作另一只宠物。
- 本地问候初次显示6秒、之后最多每30分钟一次；思考/说话期间不插入。它不创建消息、会话或模型请求。
- 关闭聊天只清空未被观察的展示状态，不向后端新增取消；重新打开仍由原聊天快照恢复。收回宠物只关闭窗口，不删数据。
- 托盘保留显示/隐藏/收回及退出；完整退出释放本次窗口、定时器、IPC 和本地网关。

具体归属与首次纳入 Git 的既有依赖见 [修改清单](P82_CHANGE_MANIFEST.md)。后端源码和 PrivateChatProvider.tsx 均与本轮起点逐字节相同。

## 测试结果

| 检查 | 结果 |
| --- | --- |
| 当前工作树桌面单元测试 | 115 passed，0 failed |
| 前端单元测试 | 45 passed，0 failed |
| P8.1/Provider/DeepSeek SDK/记忆隔离/SSE 后端离线回归 | 159 passed，133.96秒 |
| TypeScript、ESLint、React 构建 | 通过；约505kB主包的既有体积提示仍保留 |
| 新Python夹具 Ruff 与格式检查 | 通过 |
| Node语法、PowerShell解析、提交差异空白检查 | 通过 |
| 最终 Electron + React + FastAPI + SQLite + 本地 Mock + Windows 实测 | 10组通过，0失败 |

桌面测试比起点100项新增15项；前端比起点43项新增2项。没有把既往测试数字当成本轮重跑。

复现本轮离线测试：

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop'
node --test test/*.test.cjs
node test/p82-e2e.cjs
```

端到端入口明确创建新目录、新SQLite、两套合成账号及三宠物，使用内存认证/限流和本地Mock；过滤模型环境变量后才启动子进程。生产 `/health/ready` 的 Redis 要求不变；仅测试夹具通过单独接口核对自己的 Mock 设置和 SQLite 完整 schema。没有访问共享数据库，也不绕过 P8.1 PostgreSQL/Redis 身份校验。

Mock分块在夹具内加300ms间隔，以确定性观察真实产品的状态展示；固定正文明确标注Mock，不用于冒充真实模型响应。

前端命令为 `npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run build`。后端组合命令：

```powershell
.\.venv\Scripts\python.exe -B -m pytest tests/test_p81_acceptance_guards.py tests/test_p81_live_controller.py tests/test_p81_target_preparation.py tests/test_pet_provider_selection.py tests/test_deepseek_pet_runtime.py tests/test_pet_stream.py -q --tb=short -p no:cacheprovider
```

后端测试在无模型凭据的子进程环境运行，使用独立测试存储及模拟上游。

## 最终实际 Windows 证据

目录：`.verification/p82/desktop-6ed5ac8e-ffc2-4d45-a518-673e63c074a1/`，结果为 `results.json`。实际执行 UTC 13:08:00–13:08:51，北京时间21:08。

10组检查包括：

1. 实际 Electron、现有 React 登录真实 FastAPI 的新SQLite合成账号。
2. 月芽、豆包、小云三个独立窗口，显示可见、无焦点、捕获图像角点alpha=0。
3. Win32 检查 HWND 对应本次 Electron 实际主进程；无标题栏、layered、置顶。用 Windows 鼠标事件真实拖动，未误打开聊天；原生物理大小235×245像素稳定。
4. 正常退出并用同一profile重新启动；重新登录同一合成账号后，位置从DIP `(20,510)` 恢复为 `(20,510)`，没有恢复登录凭据。
5. 只读观察 Win32 前台窗口4次、约2.3秒，前台属于其他进程且保持不变；没有为了通过检查改变其他应用焦点。
6. 对宠物窗口真实鼠标点击，打开该宠物现有React聊天。
7. 本地Mock真实经过SSE和持久化；观察到 thinking→speaking→happy，刷新后正文保留，其他宠物不进入思考/说话。
8. 真实点击豆包打开自己的窗口；月芽/豆包/小云会话数分别1/0/0，没有显示月芽的会话。
9. 三宠物、主界面及两个聊天窗口的短时资源采样。
10. 收回月芽后另两只窗口保留；托盘正常退出，Electron与测试后端正常结束，两端口释放。

`windows-desktop-pet.png` 来自 Win32 CopyFromScreen，只截取已验证身份的宠物窗口矩形，包含真实桌面背景；不是将宠物贴在伪造桌面上的合成图。

`actual-react-offline-chat.png` 是实际 Electron webContents 截图，正文为本地Mock；它不是 Windows 桌面合成证据，二者明确区分。

实际仅有1台显示器，scaleFactor=1.25，工作区1536×816 DIP。多屏、负坐标、显示器间隙、拔屏和比例变化已有几何回归，但不能据此宣布真实多屏硬件测试通过。

## 资源与稳定性边界

最终约10秒、11个样本：Electron进程树 CPU 平均约2.86%；工作集汇总峰值约998.7MiB；私有提交内存汇总峰值约520.1MiB。工作集可能重复计入共享页，不等于独占物理内存。指标不包含Python测试后端，也不是全系统CPU占用。

这是三宠物、主界面和两个聊天窗口同时存在的开发构建短测。它用于确认没有明显失控，并不证明低配置机器、长期运行或最省资源。安装发行前仍需延长采样、明确消费者资源预算，并进一步评估隐藏聊天窗口的内存占用。

## 保护、历史与清理

- 本轮真实模型请求0；没有读取、复制、输出或保存真实模型API Key，没有自动重跑付费验收。
- 共享weibiye（0005/26表）与既有隔离库（0006/34表）的本轮只读前后快照，包括结构、数量及数据哈希完全一致。测试写入只发生在本轮新建的SQLite夹具中。
- 11个既有文件按清单修改；其他442个起点源码文件未变。440个P8.1历史证据文件全部保持原哈希。
- 之前的P8.2夹具准备失败和原生交互失败证据全部保留。原因包括合成邮箱校验、测试就绪接口误用了Redis要求、把RGB返回值当成alpha、启动器PID与实际主进程PID不同、退出后访问已关闭的Playwright通道，以及安全命中检查发现目标被遮挡。测试未通过时没有伪称产品成功或向覆盖窗口发送点击。
- 后续改为从运行中的Electron读取实际PID、检查真实图像alpha、退出前保留进程句柄、有界命中等待，以及只读观察现有前台窗口。所有身份检查仍在；没有强制调整其他应用或杀进程。
- 单元测试发现关闭聊天与收回宠物交错时的展示通知可能访问已移除记录，已加记录存活检查；最终115项和10组端到端通过。
- 最终正常退出码0；启动器/运行PID22740、10692、19396、21884复查均不存在。61550/61549无监听，相关Electron、Python、Node验收进程0。没有终止其他项目进程或操作Docker资源。

## 提交与剩余事项

- `f7fa4ec`：P8.1阶段归档及P8.2最小方案。
- `2ee6a3f`：P8.2第一阶段实现、单元与实际Electron/Windows验收工具。
- 本文另作验收记录提交。仅阶段提交，没有推送或部署，既有其他未提交成果保留。

未完成/未验证：真实多显示器热插拔及其他DPI组合、长时间睡眠唤醒/低配置压力、消费者安装与签名/更新、自启动、语音和复杂自主行为。本阶段不开发这些扩展。

P8.1真实在途取消、上游中断和取消费用继续保留未验证；P8.2没有补跑付费请求，也没有改变该结论。

# P8.4 最终报告：五宠与通用桌面动作系统

日期：2026-11-03T02:41:58+08:00。
状态：**P84_LOCAL_FIVE_PET_ACTIONS_VERIFIED**。本机实际 Windows/Electron 验收 13/13，通过真实 30 分钟五宠稳定性测试；本轮真实模型请求 **0**。这是本地开发验收，不代表跨设备、成品美术或公开发行通过。

代码提交：`c9f7b4591b752e6022dbcd6d630655b76d8584ee`。最终报告另作本地文档提交，其哈希保存在 `D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\p84\review-4674eaa5-bc8b-4f35-a074-342f6219bacf/commit-ledger.json`，不自动推送。开发、测试基于保留的既有未提交 P6～P8.3 前置成果；没有把这些成果夹带进 P8.4 提交，也没有验证仅从干净 HEAD 克隆可独立构建。

## 继承的阶段边界

- P8.1 真实 DeepSeek 对话核心链路已通过；真实在途取消、上游中断和取消费用仍未验证。本轮没有改变该结论或重跑付费验收。
- P8.2 桌面 MVP 与 P8.3 本地发行准备保留；不部署云服务器、不公开发布、不接入支付。
- 不改后端业务、迁移或共享数据库；不删除容器、数据卷、账号、宠物、记忆或旧证据。

## 五只宠物、人格与身份

| 定义 | 人格与本地问候 | 主要差异 |
| --- | --- | --- |
| 月芽 / moon | 平静、细腻、耐心 | 眨眼、呼吸、伸懒腰、小睡；旧宠物保留原有配置 |
| 豆包 / doubao | 热情、轻快、鼓励 | 跳跃、伸懒腰；不改变其既有 Mock 配置 |
| 小云 / xiaoyun | 安静、轻盈、尊重边界 | 低打扰的小睡、呼吸、伸懒腰；不改变其既有 Mock 配置 |
| 耄耋 / maodie | 调皮、抽象、搞怪，可善意吐槽，禁止羞辱或操控；“本猫刚刚什么也没干，真的。” | 炸毛、跳跃、小范围跑动、突然转身、装无辜、追鼠标 |
| 哈吉米 / hajimi | 软萌、温柔、安静陪伴，撒娇但不索取或制造依赖；“给你留了一个软软的位置。” | 伸懒腰、打滚、翻肚皮、蹭鼠标、撒娇 |

五种模板共用公开目录；每次领养通过原有 API 创建新宠物 UUID，保存独立人格及 appearance_config.asset_id。没有用模板 ID 替代数据授权中的 pet_id。已有宠物不重写人格或数据。离线真实认证/会话/持久化/记忆路径验证了五宠独立 prompt 和上下文，以及耄耋/哈吉米跨宠、跨用户 404 拒绝及重新登录后恢复；不是对真实模型表达风格的验收。

## 动作系统与资源

`pet-definitions.json` 提供模板、人格、问候、三帧资源映射、菜单、随机/点击/靠近/移动动作及全部动作优先级/期限/冷却；React 与 Electron 使用同一目录。扩展已有动作类型的宠物只需目录和本地 SVG，无须再分支修改核心桌面逻辑。新的特殊交互规则属于协调器；全新动画类型仍需有界表现和测试。

每个桌面实例有独立纯状态机、序号、冷却、随机源与开关；共用原有 50ms 几何/命中调度，不增加每宠常驻 JS 计时器。隐藏/退出/拖动优先级 110/120/100，AI 思考/说话 95，直接动作 90，普通动作 0～50。中断直接收敛，不排积压动画队列，不依赖 animationend 结束业务状态。退出清理状态和监听，异常恢复为安全状态。

已实现：待机、眨眼、呼吸、睡觉、醒来、看向、慢走、跟随、蹭鼠标、转身、炸毛、跳跃、小跑、伸懒腰、打滚、翻肚皮、装无辜、撒娇、躲避、开心、思考、说话，以及宿主驱动的拖动/隐藏/退出。多数新动作是原创简约 CSS 形变与 SVG 三帧占位表现，没有成品骨骼/逐帧动画，也没有音频。

随机动作约 35～75 秒尝试一次，动作单独冷却；移动约 90～150 秒尝试一次，默认关闭。鼠标靠近会触发各自反应并停止移动。移动复用原有同屏边界、防重叠与安全位置恢复，单步有界；高优先级动作、隐藏和拖动可以停止移动。随机/移动开关逐宠保存，可分别关闭。

位置继续按账号/宠物保存；新增行为文件只保存哈希索引与布尔开关/安全睡眠态，原文件损坏时不覆盖，正常写入采用临时文件替换。重启不恢复过期生成或拖动。渲染端拒绝其他宠物身份/旧序号，缺帧有限回退；隐藏卸载图片。新 SVG 按需读取、并发去重、32 KiB LRU 缓存，退出清空；宠物 CSP 保持 connect-src 'none'，公开目录通过受限本地静态脚本提供，没有放开网络权限。

12 份 `p84-*.svg` 均由项目几何绘制脚本原创生成；旧三宠变体复用项目原有原创 SVG。未下载网络表情包、音乐、角色素材或新软件。参见 `desktop/assets/P84_ASSET_NOTICE.md`。

## 多宠物互动与发现的修复

协调器只读取同一已登录账号、同一显示器的可见宠物几何与公开动作。低优先级且允许随机互动时，每 90 秒至多规划一次耄耋/哈吉米互动。双方允许移动则尝试朝对方靠近 70 DIP / 反向躲避 60 DIP，否则看向/转身。遇到边界、其他宠物或鼠标交互时可以不移动，不追求穿越桌面的持续追逐。睡眠附近的看向/靠近复用同一规则，没有模型调用、会话共享或窗口系统重构。

长测实际记录：动作转换 570，协调动作 35，协调移动 18，全部移动 25，异常恢复 0。具体目标方向/同账号同屏限制另由确定性单元测试覆盖。

本轮测试定位并修复：

1. 五宠逐只轮询与快速操作叠加会触达既有读取限制。改用每次新认证后的 owner-filtered 列表证明多宠身份；缺失/隐藏/分页宠物仍单独查验，过期账号、重复 ID、错误身份失败关闭。保留后端速率限制，交互继续实时授权。
2. 点击可能先于 dragEnd 到达主进程，聊天打开而点击动作被拖动优先级压住。预加载桥等待拖动结束确认后再派发聊天/菜单；失败授权不继续派发。
3. Windows 隐藏时单靠 visibilitychange 不足以可靠卸载图片。宿主先发送明确 hidden 状态，渲染器拒绝旧序号与隐藏期间 error 回退重新加载。
4. 将双宠跟随与鼠标跟随的方向分开，协调移动使用目标宠物几何；菜单/移动类型放进模板定义。

没有修改 DeepSeek、SSE、聊天生成或取消业务逻辑。

## 自动化与 Windows 实测

| 检查 | 实际结果 |
| --- | --- |
| 桌面 Node 单元回归 | 164 passed，0 failed，0 skipped，包含新增 21 项注册/状态/优先级/冷却/资源/隔离/预加载顺序等用例 |
| 前端 TypeScript / ESLint | 通过，ESLint 零警告 |
| 前端单元回归 | 49 passed，0 failed |
| 前端生产构建与本地 UI 复制 | 通过；单 JS 块 516.61 kB 的既有体量警告仍保留，未隐藏或降低检查 |
| 后端选定离线回归 | 191 passed，0 failed；涵盖既有认证/聊天/取消/宠物/记忆/额度与隔离保护及新增 P8.4 用例 |
| 最终 P8.4 后端专项复测 | 2 passed；与上述 191 中的 2 项重复，不另计唯一用例 |
| Python Ruff / format | 按 backend/pyproject.toml 检查新增测试和 fixture，均通过 |
| 修改 JS / CJS 语法 | 通过；新增 JS 使用已安装 TypeScript 打印器统一格式，没有批量格式化旧文件 |
| 实际 Windows/Electron | 13/13；不是浏览器模拟 Windows |

额外本地打包检查通过：`D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop\out\WeiBiYe-win32-x64-88710e5a-753f-4732-a857-6e9e64c70360`，168 个清单文件、约 357.63 MiB；注册目录、动作代码及 12 份新 SVG 均已包含，未包含数据库/用户 profile/密钥文件路径。没有启动该便携包或重跑 NSIS 安装升级；不把源码运行证据冒充安装版验收。打包仅本地创建新 UUID 输出，未覆盖旧包或发布。

本机 Ryzen 5 5600H、6 核 12 线程，物理内存总量约 15.36 GiB；Windows build 26200，Electron 45.2.1，实际单屏 workArea 1536×816 DIP、缩放 125%。

实际验收包括：真实 React 目录领养新身份、单/三/五宠独立窗口；Win32 验证 HWND/PID、无标题栏/分层窗口、物理拖动与点击；两只新宠共 14 次有界动作触发、鼠标靠近、物理右键菜单；真实 Mock 后端 SSE、AI 动作中断与消息刷新恢复，兄弟宠物会话计数 [0,0,0,1,0]；五宠同时动画；70 秒停泊后的隐藏图片/聊天/主界面资源释放；退出重启后位置/开关/睡眠恢复；自有外部前台探针焦点稳定；五宠两聊天长测；退出登录、普通退出及端口释放。

动作触发、设置开关和长期测试循环中一部分使用宿主测试检查接口，不冒充物理菜单逐项操作；物理点击、拖动、右键和鼠标靠近另有 Win32 证据。长测阶段用测试专用 showInactive/焦点抑制避免循环干扰桌面，焦点保护结论来自此前独立的真实前台探针。截图为实际 Electron 渲染窗口，未冒充其他设备或多屏实测。

## 性能结果

| 场景 | 平均 CPU | 工作集汇总峰值 | 私有提交汇总峰值 | 样本数 |
| --- | --- | --- | --- | --- |
| 1 宠 / 0 聊天 | 0.079% | 548.33 MiB | 342.69 MiB | 11 |
| 3 宠 / 2 聊天 | 0.327% | 1005.15 MiB | 523.87 MiB | 11 |
| 5 宠 / 2 聊天 | 0.312% | 1222.56 MiB | 557.30 MiB | 11 |
| 5 宠同时有限动画 / 2 聊天 | 1.926% | 1261.86 MiB | 591.71 MiB | 12 |
| 5 宠隐藏 / 聊天关闭 / 主界面停泊 | 1.097% | 886.26 MiB | 413.29 MiB | 11 |

短测每组至少 10 秒，CPU 为 Electron app.getAppMetrics() 各进程之和；工作集求和会重复计共享页，不代表独占 RAM。记录了每个主/渲染/GPU/辅助进程指标；长测还把 pet/chat renderer PID 与实例映射，用于区分窗口与内存。不是整机 CPU 百分比。

五宠/两聊天实际长测 30.12 分钟、180 个 10 秒样本，15 轮隐藏恢复与关闭重开聊天。平均 CPU 0.384%，工作集峰值 1221.00 MiB，私有提交峰值 591.32 MiB。末 5 分钟均值减预热后 5 分钟均值的私有提交差 47.32 MiB，未超 96 MiB 报警线；窗口/IPC 发送者始终不超过 8，新资源缓存不超过 32 KiB，无异常恢复。不能据此证明数小时/数天没有泄漏。

按长测期间实例对应的 renderer PID 归类如下。每行独立取峰值，因此不能把这些峰值再次相加当作同时峰值；辅助进程类别可能包含多个进程。

| 组件 | 工作集峰值 | 私有提交峰值 | 末段减预热段私有均值 |
| --- | --- | --- | --- |
| GPU | 143.89 MiB | 184.84 MiB | +3.07 MiB |
| doubao 宠物 | 104.21 MiB | 31.08 MiB | +3.51 MiB |
| hajimi 宠物 | 113.73 MiB | 41.27 MiB | +8.23 MiB |
| hajimi 聊天 | 121.11 MiB | 41.27 MiB | +0.39 MiB |
| maodie 宠物 | 109.70 MiB | 35.23 MiB | +6.95 MiB |
| maodie 聊天 | 121.91 MiB | 42.52 MiB | +0.87 MiB |
| moon 宠物 | 109.43 MiB | 36.58 MiB | +7.07 MiB |
| xiaoyun 宠物 | 110.27 MiB | 37.27 MiB | +7.85 MiB |
| 主界面/其他渲染器 | 122.05 MiB | 57.96 MiB | +0.43 MiB |
| 主进程 | 135.03 MiB | 93.92 MiB | +8.91 MiB |
| 辅助进程 | 52.29 MiB | 14.55 MiB | +0.05 MiB |

参考 P8.2 的三宠两聊天约 870 MiB 工作集 / 439 MiB 私有提交，本轮对应峰值约 1005 / 524 MiB，有增加；五宠进一步约 1223 / 557 MiB。旧基线的负载、构建、开关、预热和采样条件不同，未重跑修改前同条件版本，不归因为确定的代码回退或声称实现了同比优化。当前新增资源以小 SVG 与状态机为主，主要内存仍随 Chromium 窗口数量增长。后续应做同条件前后采样与更低配置设备专项，而不是缩减隔离。

## 证据、历史保护与清理

- 最终完整运行：`.verification/p84/windows-16c6e0da-bd59-4394-8bc2-2d249ee0170c/results.json`；同目录 `soak-samples.json`、`acceptance-driver.cjs`、backend.log、两张截图及源哈希保留。
- 审核/单元/静态/数据库保护证据：`D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\p84\review-4674eaa5-bc8b-4f35-a074-342f6219bacf`，含完整通过日志、XML、源清单与提交台账。
- 此前失败/中断运行全部保留，未改写其 results.json。包括 CSP 拒绝不适当目录 fetch、测试动作冷却/读取压力、拖动点击顺序、隐藏图片释放、辅助窗口显示时序，以及主动停止旧方向实现的预长测；它们不计入最终通过。旧 RUNNING 记录没有被补写为成功。
- 本轮前的 14347 份历史证据哈希全部相同。518 个未触及原源文件逐字节相同；本轮触及的 10 个文件保存了原始副本及仅 P8.4 的提交增量。没有 reset/clean/stash/恢复或覆盖旧文件。
- PostgreSQL 只读前后快照：共享 weibiye（0005 / 26 表）与旧隔离库（0006 / 34 表）均完全相同；fixture 写入仅限各自新建的 SQLite。Docker 容器和数据卷未更改。
- 对这两个数据库可观察到的其他活动会话 0，开放写事务 0；不据此推断其他项目或所有系统任务均可关机。
- Electron 正常退出码 0，Mock 后端退出码 0；本轮 UI 端口 57001 与后端端口 57002 已释放。焦点辅助进程正常关闭；没有按 Python/Node/Electron 名称批量终止或强杀其他项目。

## 未验证、已知限制与下一阶段

1. 真实多显示器热插拔、其他实际 DPI/Windows 版本、低配置设备、休眠恢复及数小时以上运行未在本轮实机验证；几何边界仅有本机实测和离线多屏回归支持。
2. 美术是明确标识的原创占位图/形变动作；没有音频、复杂路径追逐或完整成品角色动画。
3. 某些旧入口仍保留“三宠”的旧说明文字，本轮新增目录明确提示五宠，宿主真实上限已验证为五。既有未提交 UI 成果未扩大修改。
4. 真实 DeepSeek 人格表达/上游中断/取消费用不由 Mock 测试证明；不自动付费重试。
5. 仍是本地开发预览；P8.4 不是签名安装、升级兼容或公开内测发行的新结论。继续按 P8.3 受控发行门槛推进。
6. 保留的既有未提交前置成果须另行由其所有者审查归档，之后再做干净提交构建验证。本轮不混入这些文件。

下一阶段优先：原创美术与动作打磨、低配/多屏/DPI/休眠实机矩阵、同条件内存剖析与 2～4 小时稳定性，再进入经过确认的受控内测发行。保持服务端密钥、宠物/用户隔离和成本保护。

## 自动关机判定

**未安排关机。** 存在其他可见应用；仅凭进程元数据无法确认未保存工作、其他会话的重要任务均已安全结束。并且 /t 60 隐含强制关闭，与本轮禁止强制关闭的要求冲突。没有发送任何实际关机命令，也没有强制关闭其他应用。Windows 官方说明 `/t` 大于 0 会隐含 `/f`，因此用户给出的 `/s /t 60` 与“不得强制关闭”的要求不能在未知未保存工作时同时安全满足。参见 [Microsoft shutdown 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown)。

安全检查记录 10 个可见应用，用户会话查询可用性为 False；无法全面确认其他会话状态和未保存工作，按授权条件跳过关机。

## 本轮修改文件

- `backend/tests/test_p84_pet_catalog.py`
- `desktop/assets/P84_ASSET_NOTICE.md`
- `desktop/assets/p84-doubao-blink.svg`
- `desktop/assets/p84-doubao-sleep.svg`
- `desktop/assets/p84-hajimi-blink.svg`
- `desktop/assets/p84-hajimi-sleep.svg`
- `desktop/assets/p84-hajimi.svg`
- `desktop/assets/p84-maodie-blink.svg`
- `desktop/assets/p84-maodie-sleep.svg`
- `desktop/assets/p84-maodie.svg`
- `desktop/assets/p84-moon-blink.svg`
- `desktop/assets/p84-moon-sleep.svg`
- `desktop/assets/p84-xiaoyun-blink.svg`
- `desktop/assets/p84-xiaoyun-sleep.svg`
- `desktop/assets/pet-definitions.json`
- `desktop/renderer/pet-action-view.js`
- `desktop/renderer/pet-actions.css`
- `desktop/renderer/pet.html`
- `desktop/renderer/pet.js`
- `desktop/scripts/build-p84-art.cjs`
- `desktop/src/gateway.cjs`
- `desktop/src/manager.cjs`
- `desktop/src/motion.cjs`
- `desktop/src/pet-actions.cjs`
- `desktop/src/pet-asset-cache.cjs`
- `desktop/src/pet-coordinator.cjs`
- `desktop/src/pet-preferences.cjs`
- `desktop/src/pet-registry.cjs`
- `desktop/src/policy.cjs`
- `desktop/src/position-store.cjs`
- `desktop/src/preload.cjs`
- `desktop/test/fixtures/p84-focus-window.ps1`
- `desktop/test/fixtures/p84_server.py`
- `desktop/test/manager.test.cjs`
- `desktop/test/p84-actions.test.cjs`
- `desktop/test/p84-cursor.ps1`
- `desktop/test/p84-e2e.cjs`
- `desktop/test/p84-preload.test.cjs`
- `desktop/test/p84-renderer.test.cjs`
- `docs/P84_FINAL_REPORT.md`
- `docs/P84_IMPLEMENTATION_PLAN.md`
- `docs/P84_TEST_RUNBOOK.md`
- `frontend/src/App.tsx`
- `frontend/src/features/p84/catalog.ts`
- `frontend/src/pages/p84-catalog.css`
- `frontend/src/pages/p84-catalog.tsx`
- `frontend/tests/p84-catalog.test.mjs`

# WeiBiYe P6：开源研究与 Windows 三宠物 MVP 验收

最终状态：DESKTOP_PET_MVP_VERIFIED。

范围是本机 Windows 11 x64、125% 显示缩放、真实 FastAPI／PostgreSQL／Redis、Mock Provider 的桌面开发预览。不是消费者公开发行、真实模型效果、Windows 10 兼容或长期性能验收。

## 1. 基线与保护

- Worktree：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot；分支 codex/consumer-desktop-pivot。
- HEAD 始终为 83c1b0943d694a26ab728af457c5e3dc4ddccad2；没有切换分支、提交、合并或推送。
- 接续前75个未提交文件均与上一阶段交付SHA一致，并完整复制至 .verification/p6/pre-p6-source；保留原patch、状态、refs和逐文件hash。P6没有用第三方项目覆盖这些成果。
- 其中仅6个原有成果文件继续作预期修订：README、产品范围、桌面路线、App.tsx、companions.tsx及chat-layout.spec.ts。原有后端业务、0006迁移、P3/P4契约和历史验收文件保持原hash。
- 原开发库 weibiye 仍为0005／26表；旧宠物验收库仍为0006／34表。两者结构、逐表数量和数据hash均未变化。
- 仅新建 weibiye_p6_desktop_test_e0426321109c4f04959c7a86ecac2d95，向前迁移至0006／34表。两个明确合成测试账号、A三宠／B一宠；未额外追加性能账号或宠物。

最终安全证据：.verification/p6/final-safety.json。专用PG／Redis容器ID、启动时间、重启次数、端口和挂载未变；原0004备份SHA仍为054e4c21e8c71c03860ddd4b3ff0fed21a714877c847d9bb2c573079448371f9。没有操作其他容器、其他项目或其他Worktree。

## 2. 六仓库研究与选型

六仓库均实际访问，读取固定提交源码、依赖和许可；没有运行其代码或安装脚本。

| 仓库 | 固定提交 | 主要判断 |
| --- | --- | --- |
| nucket/NekoAI | 7462b824 | Tauri2／React／Rust；MIT代码。固定窗口和全局聊天／事实表，不能直接证明多宠独立历史 |
| lmy375/ai-pet | f4721f95 | Tauri2／React／Rust／Live2D；未找到代码许可证，历史仍全局 |
| LGaben/Desktop-Pets | 83ae6ffa | PyQt5；MIT项目代码但PyQt另有许可义务；多窗口成立，无LLM聊天 |
| c-dom/deepseek-pet | eb2ef68f | PyQt6／WebEngine；单ChatService、整包HTTP而非SSE；代码许可明确排除媒体 |
| sleepingjhy/Aemeath-Desktop-Pet-on-Windows | f8d13020 | PySide6；多窗口共用聊天对象；未找到代码及角色商用许可 |
| Litrudy/DesktopPet | f3067755 | PySide6；单窗口切换资源包、本地随机文案；未找到代码及素材许可证 |

固定源码、行号、维护日期、发布附件和各未知项见：[NekoAI／ai-pet](p6/RESEARCH_NEKO_AIPET.md)、[Desktop-Pets／deepseek-pet](p6/RESEARCH_DESKTOP_DEEPSEEK.md)、[Aemeath／DesktopPet](p6/RESEARCH_AEMEATH_LITRUDY.md)。没有测量参考项目CPU／内存，不能依据README、下载大小或窗口数量推算性能。

选择方案C：Electron 45.2.1＋现有React。它能复用已验Cookie／CSRF、SSE和记忆界面，本机已有Node环境；Tauri缺Rust／MSVC工具链，PySide需额外维护Qt／WebEngine与React桥接。没有预设PySide最佳，也没有声称Electron资源最省。完整八维比较、官方依据及权衡见[选型](p6/TECHNOLOGY_DECISION.md)。

只借鉴通用架构思路，没有复制六参考仓库的代码或美术。三种几何角色和托盘图标由本项目独立绘制。保留Electron／Chromium及38项前端依赖实际许可文本；无许可证仓库不视为可商用。Live2D SDK与模型的发行授权仍需分别审查，本轮未下载或集成。见[许可与可复用模块清单](p6/LICENSE_AND_REUSE.md)。

## 3. 实际实现

- 三只独立透明、无边框、置顶窗口，各自pet_id、坐标、动画状态和聊天窗口；集中调度、边界限制及宠物间避让。
- 原创猫／狗／云朵2D外观，待机、移动、休息与拖拽动画；状态气泡为本地文案，AI正文显示在聊天窗口。
- 真实鼠标拖动、短点击聊天、右键菜单、分别隐藏／显示／收回、托盘与安全退出；关闭主界面保留托盘。
- 沿用真实私人API、Cookie、CSRF、owner＋pet校验；历史消息保存在新隔离PostgreSQL，支持SSE取消、重试、Last-Event-ID重放。
- 用户＋宠物记忆授权、逐条确认及检索屏障保持原实现。Spy检查证明A1授权记忆确实进入Mock Provider，A2没有收到；B对A的宠物、消息、记忆偏好、列表与具体ID均返回404。
- UI与宠物使用不同的内存Cookie分区，宠物renderer不能访问API、凭据或聊天正文；sandbox／contextIsolation开启、Node集成关闭。拒绝任意站点／新窗口／webview／权限。保留严格限制的P4 JSON导出。
- Cookie更换、认证失败或网络失败时销毁旧私人窗口，并同步清除React私人缓存；主进程中间事件也按owner过滤。没有把长期Token放入localStorage。

窗口与桥接契约见[NATIVE_BRIDGE](p6/NATIVE_BRIDGE.md)。React新增桌面操作只在Native bridge存在时显示，普通Web行为保持正常。首页三句文案完整保留。

## 4. 修复与真实测试结果

修复了旧账号延迟桌面列表回灌、Native失效未同步清React缓存、owner切换中间事件携带旧宠物、鉴权等待时仍运动、125%DPI下setPosition累计放大窗口等问题。均有对应回归；DPI采用thickFrame:false、固定尺寸setBounds及有界1DIP舍入容差，未等待或冒称上游Draft修复已经发布。见[Windows DPI说明](p6/WINDOWS_DPI_WORKAROUND.md)。

| 检查 | 本轮实际结果 |
| --- | --- |
| 完整pytest | 598通过／0失败／52条件跳过，1249.60秒 |
| Ruff | app、tests、scripts、migrations全部通过；P6新增Python脚本格式检查通过 |
| TypeScript／ESLint／构建 | 最终均退出0；Vite保留主chunk约501.5kB的体积提示，没有提高阈值掩盖提示 |
| 前端单元 | 39通过／0失败／0跳过 |
| Desktop Node单元 | 63通过／0失败／0跳过：manager41、motion9、renderer4、gateway9 |
| Web浏览器全量 | 首轮90通过／2失败／0跳过；失败为旧文案和错误登录返回页预期；精确修正后两项定点复验2通过／0失败。92项唯一场景均有通过证据，未重复整轮 |
| Windows原生＋真实API | 分阶段覆盖28项必要唯一验收，未覆盖0；没有把重复setup／引用当新测试累计 |
| 最终portable EXE | 5项实际执行全部通过：启动、真实登录Cookie／CSRF、本人pet放出、真实托盘退出及端口释放等流程 |
| 新隔离PostgreSQL | 0006／34表；SQLAlchemy autogenerate差异0、无无效索引，约束清单完整保存 |
| FastAPI／Redis | /health/live与/health/ready均200；实际Redis PING、独立TTL键、命名空间认证／限流与撤销路径参与真实联调 |

52条pytest跳过是显式opt-in：43项需各自旧版本命名隔离库，9项属于另行授权的共享基础设施专项。没有把它们改指共享库或P6库强行运行，也没有记为通过。准确拆分见许可／复用文档第6节。与上一阶段603相比，本轮5条旧宠物PG用例未启用；P6真实PG／Redis及原生浏览器验收单独列出，不能混算。

Web回归部分聊天HTTP契约使用Mock，后端为独立SQLite；它不是92项真实PG测试。Windows联调则是真实FastAPI＋新隔离PG＋Redis，只有AI生成使用Mock，不调用GPT或DeepSeek。

原生开发保留18次分段记录和15次历史失败，包括测试器Inspector、PowerShell、locator、焦点／导航、采样时序、网络仿真及真实窗口问题。没有删失败文件或省略断言；最后的通过来源逐项记录并验证hash，不宣称一次完整全绿执行。A账号曾触发真实429；没有清键、调低保护或换账号绕过，按现有900秒时间分桶自然切换后，原A三宠完成性能与打包验收。

总账：.verification/p6/native-acceptance-ledger.json，SHA-256 fa1de3ff7f5bdcd8ffb81357c298c5cc423e3675c980b8e6bcfc7416ce23204a。28项原生和5项成品检查有4个名称重合，总计29个唯一check名称；不可相加声称33项。

## 5. 性能范围与资源风险

仅本机、主界面＋三宠物、无聊天子窗口、受控待机／移动各11个样本。pytest、构建和Web回归均已退出后采样；原始每进程指标、坐标和状态均保留。

| 模式 | 实测跨度 | 平均CPU | 聚合工作集均值／峰值 |
| --- | ---: | ---: | ---: |
| 三宠待机 | 10.165秒 | 2.3203% | 747.44／756.47 MiB |
| 三宠移动 | 10.211秒 | 3.3540% | 752.11／752.73 MiB |

数据来自Electron app.getAppMetrics进程树，不是整机利用率，也不含外部FastAPI／数据库。工作集可能重复计算共享页；PrivateBytes私有提交量均值约405／398MiB，也不等于物理驻留内存。短时结果不证明长期无泄漏、低配置可用或优于Qt／Tauri，当前资源成本明显，公开发行前需要长稳与资源优化。

125%DPI真实运动超过10秒，三窗口逻辑188／189×196／197DIP，变化范围不超过1DIP且无累积增长；同时保留物理尺寸、DPR、坐标和isTrusted鼠标事件。真实移动点击、拖后不开聊天、单宠renderer崩溃清理和重新放出均有通过记录。skipTaskbar有构造及单元证据，未把WS_EX_TOOLWINDOW等同任务栏隐藏，也未声称完成Windows任务栏UI自动化枚举。

## 6. 成品与截图

最终包：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop\out\WeiBiYe-win32-x64-59286964-a4da-43d3-96ce-28cade7a415c\WeiBiYe.exe。

包含132个文件，清单统计374,876,113字节（约357.51MiB，不含清单自身）；全部文件复制SHA校验通过。最终包运行文件与当前源码匹配，保留完整许可；没有后端、.env、数据库、登录profile或应用node_modules。旧包保留未覆盖。

- PACKAGE_MANIFEST.json SHA-256：b05dcd51aa6abbca806b20bce8451b25b274fd89a8d04ba7fdbf1388760ed613。
- WeiBiYe.exe SHA-256：32e357fc856feadd1e51531f47811d2621483e5a58815eb4999154d7c9baea3b。
- Electron官方下载ZIP SHA-256：7c342aee45d5b4ccafe5dfe9037028796b082735a576e21e2b4e2d8422ebb727；本地npm依赖禁用安装脚本，运行时经固定包SRI和官方校验后仅安装到本Worktree。

真实Windows屏幕截图（非HTML合成／非参考项目图片，均已实际查看）：

- 三宠：[windows-three-pets.png](../.verification/p6/desktop-e0426321109c4f04959c7a86ecac2d95-d2ab81ba-2166-4493-9ac1-e78bbf3e97db/windows-three-pets.png)。
- 持久化Mock聊天＋三宠：[windows-pet-chat.png](../.verification/p6/desktop-e0426321109c4f04959c7a86ecac2d95-6835a158-662b-47ef-9f68-9ef02496cbd0/windows-pet-chat.png)。

截图产生于真实分段测试中；同阶段后续测试器失败仍保留，图片本身不当作整阶段通过证明，最终通过来源以总账为准。

## 7. 启动与安全收尾

完整命令见[本机Windows启动说明](P6_WINDOWS_START.md)。当前依赖已存在，两个终端分别运行：

    cd D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend
    .venv\Scripts\python.exe -B scripts\desktop_mvp_server.py

    cd D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop
    npm start -- --backend-origin=http://127.0.0.1:38316 --ui-port=35316

启动前检查端口；专用后端启动器只读取既有P6隔离清单并强制Mock，不创建库或迁移。测试账号清单位于本机被忽略的 .verification/p6/target.json，仅含合成fixture，不将其分发进客户端。也可以按启动说明使用上述最终exe和新profile；客户端自身不需要安装Node，但仍依赖单独运行的测试API。

验收后所有本轮Electron实例正常退出；四个测试端口25174、28101、35316、38316均已释放。专用API以中断停止，进程已退出；该Windows工具会话返回1，未把它计为业务测试失败或声称后端优雅退出钩子已验证。数据库无活跃生成任务；原库、旧库、容器、备份和Git引用的复核通过。保留必要测试库、原始日志、profile及所有截图，不清理其他项目资源。

没有执行关机、全局软件安装、共享库0006升级、破坏性操作、真实模型调用、支付、部署或推送。

## 8. 尚未实现与下一步

1. 正式安装器、签名、自动更新、干净Windows标准用户验证和无需开发环境的托管服务交付。当前portable是开发预览，不是普通消费者发行版。
2. Win10、多显示器／跨屏DPI、睡眠唤醒、主窗口崩溃自动恢复、坐标持久化、长时间内存和多聊天并发性能验收。首选先优化三宠资源成本，再决定是否做Tauri对照原型。
3. Live2D只有资源能力槽，没有可用SDK／模型／渲染适配器；需要分别取得许可、资产白名单和性能预算。
4. GPT／DeepSeek真实适配及付费联调没有在本轮启用；未来明确选择、密钥安全存储／托管、隐私发送与成本授权后单独验收。
5. 编辑宠物名称／角色／外观后，已放出的本地快照需收回再放出同步；不宣称实时资源热更新。完整AI气泡对话、语音和高级互动也未实现。
6. 共享开发库0006仍需另行备份、恢复演练和明确迁移授权；不能因运行本MVP擅自升级。
7. 审阅当前分支全部接续成果与P6差异后再建立本地提交。本轮没有提交或合并main；不能把测试通过误报为Git工作区干净。

逐文件清单、最终源hash、进程检查及原生每阶段真实通过／失败／跳过数量，随本报告记录在 .verification/p6 下；没有删除失败测试或隐藏历史结果。

## 9. P6实际文件清单与最终核对

以下相对于本轮开始的75路径快照，不把接续前的后端宠物作用域成果冒充P6新增。

已存在成果中的6个预期修订：

- README.md
- docs/DESKTOP_PET_ROADMAP.md
- docs/PRODUCT_SCOPE.md
- frontend/e2e/chat-layout.spec.ts
- frontend/src/App.tsx
- frontend/src/pages/companions.tsx

本轮首次触及路径（含修改已有.gitignore及新增文件）：

- .gitignore
- backend/scripts/desktop_mvp_database.py
- backend/scripts/desktop_mvp_server.py
- desktop/THIRD_PARTY_NOTICES.md
- desktop/assets/ASSET_NOTICE.md
- desktop/assets/cat.svg
- desktop/assets/cloud.svg
- desktop/assets/dog.svg
- desktop/assets/manifest.json
- desktop/assets/tray.png
- desktop/package-lock.json
- desktop/package.json
- desktop/renderer/pet.css
- desktop/renderer/pet.html
- desktop/renderer/pet.js
- desktop/scripts/copy-ui.cjs
- desktop/scripts/generate-art.cjs
- desktop/scripts/install-runtime.py
- desktop/scripts/launch.cjs
- desktop/scripts/package-portable.cjs
- desktop/src/gateway.cjs
- desktop/src/main.cjs
- desktop/src/manager.cjs
- desktop/src/motion.cjs
- desktop/src/policy.cjs
- desktop/src/preload.cjs
- desktop/test/capture.ps1
- desktop/test/e2e.cjs
- desktop/test/gateway.test.cjs
- desktop/test/manager.test.cjs
- desktop/test/motion.test.cjs
- desktop/test/native-interaction.ps1
- desktop/test/native-observe.ps1
- desktop/test/performance.cjs
- desktop/test/renderer.test.cjs
- docs/P6_DESKTOP_VERIFICATION.md
- docs/P6_WINDOWS_START.md
- docs/p6/LICENSE_AND_REUSE.md
- docs/p6/NATIVE_BRIDGE.md
- docs/p6/RESEARCH_AEMEATH_LITRUDY.md
- docs/p6/RESEARCH_DESKTOP_DEEPSEEK.md
- docs/p6/RESEARCH_NEKO_AIPET.md
- docs/p6/TECHNOLOGY_DECISION.md
- docs/p6/WINDOWS_DPI_WORKAROUND.md
- frontend/e2e/desktop-bridge.spec.ts
- frontend/src/features/desktop/DesktopIdentitySync.tsx
- frontend/src/features/desktop/DesktopPetControls.tsx
- frontend/src/features/desktop/bridge.ts

当前共有123个Git未提交路径；暂存区为空、无新提交。完整源hash在.verification/p6/delivered-source-sha256.json。

完成时间（UTC）：2026-11-02T06:25:23.629597+00:00。最终132个包文件SHA全部复核，源码／渲染／资产15个文件与最终包完全一致；28个原生必要通过来源逐个核对原始执行记录和SHA，零未覆盖。

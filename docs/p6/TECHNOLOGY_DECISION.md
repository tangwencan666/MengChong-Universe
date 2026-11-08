# P6 Windows多宠物宿主选型

日期：2026-11-02。结论：本轮使用方案C：Electron 45.2.1＋现有React；这不是对三种框架资源占用的实测排名。仓库研究均已实际读取默认分支、固定提交和许可文件；不运行第三方代码或安装脚本，不采用其美术素材。

## 六仓库结论与复用范围

详细代码证据见[两个Tauri项目](RESEARCH_NEKO_AIPET.md)、[Desktop-Pets与deepseek-pet](RESEARCH_DESKTOP_DEEPSEEK.md)、[两个PySide项目](RESEARCH_AEMEATH_LITRUDY.md)。

| 仓库 | 栈／维护提交 | 已核对的实现与关键缺口 | 代码／素材 |
| --- | --- | --- | --- |
| nucket/NekoAI | Tauri2/React/Rust；7462b824，2026-10-26 | 透明、托盘、PNG动作和资源包；固定main与全局聊天／事实表，不是三宠物隔离；AI整包响应不是SSE | MIT代码；角色原始许可链未完整核实，不用素材 |
| lmy375/ai-pet | Tauri2/React/Rust；f4721f95，2026-10-21 | Live2D渲染、每agent记忆目录、流适配；聊天历史仍全局、固定窗口；GUI release当前仅macOS | 未找到根代码许可；不复制代码／素材 |
| LGaben/Desktop-Pets | PyQt5；83ae6ffa，2026-06-03 | 真实多窗口、托盘、随机动作；无LLM聊天，单行状态存储不适用 | MIT代码，PyQt另有GPL/商业许可义务；素材链未明，不用 |
| c-dom/deepseek-pet | PyQt6/WebEngine；eb2ef68f，2026-08-23 | 透明、精灵和气泡、DPAPI；单ChatService/deque，整包HTTP非SSE，无pet_id | MIT样式代码＋明确媒体排除；PyQt许可另审，不用素材 |
| sleepingjhy/Aemeath-Desktop-Pet-on-Windows | PySide6；f8d13020，2026-03-28 | 实例管理、GIF、托盘；所有实例共享一个聊天对象，stream=False | 未找到代码／角色商用许可，不复制 |
| Litrudy/DesktopPet | PySide6；f3067755，2026-06-29 | 帧动画、状态机、气泡；单窗口换包，本地JSON文案而非模型 | 未找到代码／素材许可，不复制 |

六者CPU/RAM均未运行测量，标为未知。Release下载字节数不等于安装体积或内存；透明不等于操作系统级鼠标穿透。所有“最新”指研究时实际提交，不用pushed_at代替代码日期。

复用已有WeiBiYe认证、Cookie/CSRF、owner＋pet校验、持久消息、SSE重放／取消、记忆授权与预算；仅借鉴集中窗口管理、拖动阈值、状态机／资源分离、低频待机与统一退出等通用设计。新增代码独立编写，不移植六仓库的聊天、存储或任意工具执行能力。

## 对比

| 维度 | A PySide6 | B Tauri2＋React＋Rust | C Electron＋React |
| --- | --- | --- | --- |
| React复用 | 嵌QtWebEngine可复用；纯Widgets重写聊天成本高 | 高 | 高，现有前端直接构建装入 |
| 三宠物资源 | 轻量QWidget可能节省，但嵌WebEngine需额外进程；未实测 | WebView2窗口资源需测，Rust核心不代表整体低内存 | Chromium多进程成本较高，需要实际预算；本轮测进程树 |
| 透明／置顶／穿透 | Qt flags＋Win32支持设计；透明不保证穿透 | 官方窗口API及权限；Windows需验证命中区域 | 官方BrowserWindow／setIgnoreMouseEvents可用；本轮真实验证 |
| Live2D | WebEngine/原生适配均需桥接和单独许可 | WebGL适配直接但SDK／模型另审 | WebGL适配直接但SDK／模型另审 |
| Windows10/11 | 依赖所选Qt版本支持矩阵，未在两系统实测 | WebView2＋MSVC/Rust开发工具链 | 官方Windows支持范围另核对；本机仅Win11实测，不宣称Win10已验收 |
| 分发 | Qt/Python/WebEngine打包；不能从ZIP宣传推算成本 | 原生MSI/NSIS选项；WebView2前置依赖仍需处理 | 运行时较大；可独立运行目录，正式安装器/签名另验收 |
| 维护 | Python易用，但需维护Qt与React桥接／运行时 | Rust技能及构建链，权限配置较细 | 与既有TypeScript一致；需持续升级Chromium并严格隔离IPC |
| 许可 | PySide与Qt模块需按LGPL/GPL或商业条款合规；不等同PyQt | Tauri MIT/Apache及WebView2分发条件 | Electron MIT＋Chromium第三方声明；依赖与资源仍单独核对 |

依据：[Tauri前置环境](https://v2.tauri.app/start/prerequisites/)、[Windows安装器](https://v2.tauri.app/distribute/windows-installer/)、[Qt部署](https://doc.qt.io/qtforpython-6/deployment/index.html)、[Qt WebEngine许可](https://doc.qt.io/qt-6/qtwebengine-licensing.html)、[Electron窗口](https://www.electronjs.org/docs/latest/api/browser-window)、[透明窗口](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)、[Electron安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[打包](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)。

## 本机事实与决策

Windows11 10.0.26200，Node24.14.1。已有React/后端环境可用；未发现Rust/cargo/MSVC或PySide6。WebView2运行时存在，但仅有它不能构建Tauri。官方npm registry核得Electron45.2.1，要求Node>=22.12.0，许可证MIT。

选择C的理由是本轮可在不安装全局工具、不重写P3/P4、不放宽Cookie/CSRF的情况下完成实际Windows验证。不能由此断言Electron比Qt/Tauri更省资源。若实测超出预算，本轮应阻塞并记录，而非伪造性能优势；Tauri仍可在明确授权安装工具链后做对照验证。

## 宿主边界

- Electron主进程集中管理以owner＋pet_id为键的窗口；每个操作重新核验当前Cookie身份与宠物归属，窗口数字ID不成为权限凭据。
- Renderer启用sandbox、contextIsolation，关闭Node集成和任意导航／新窗口；预加载仅提供列举的宠物动作，不提供shell、文件系统或通用脚本执行。
- 内置loopback网关只绑定127.0.0.1，提供已构建React和固定本地API转发；不改变Origin、Cookie或CSRF，不成为开放代理。启动不迁移数据库。
- 宠物窗口只呈现本地原创2D资源。聊天窗口复用明确pet路由与原有SSE；不在IPC传递私人聊天正文或模型密钥。
- 桌面隐藏／收回是本地窗口状态，不等同后端归档／删除。退出只释放本应用窗口、托盘、计时器及网关，不结束外部后端或其他项目。
- 共享库0005不满足宠物API，联调用全新隔离0006；真实模型始终关闭。

## 许可与发布准入

公开仓库无LICENSE不等于可复制分发，见[GitHub官方许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。MIT源代码声明不能授予角色商标／美术权利。PyQt的GPL/商业选择见[Riverbank](https://www.riverbankcomputing.com/software/pyqt/intro)。Live2D SDK发行条款与模型美术授权是两层，未来需分别核对[SDK发行许可](https://www.live2d.com/en/sdk/license/)；本轮不下载SDK、样例模型或Core脚本。

保留Electron/Chromium及打包前端依赖声明。新增几何角色为本项目独立绘制、可替换资源，不复制其他品牌。当前本地Mock MVP不等于已经完成消费者安装、自动更新、签名或托管API发布；这些需要独立验收。

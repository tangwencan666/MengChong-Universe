# P6 代码级参考研究：Desktop-Pets 与 deepseek-pet

核查日期：2026-11-02。通过 GitHub 连接器实际读取公开仓库元数据、完整文件树、固定提交源码和 Release 附件元数据。没有运行第三方代码、安装脚本、模型请求或发布二进制，没有复制第三方代码和美术素材。

这里的“源码已实现”只表示找到了相应实现，不等于已经在本机验证其 Windows 行为、稳定性或性能。下面的固定提交链接可以复核结论。

## 1. 仓库身份与维护情况

| 项目 | LGaben/Desktop-Pets | c-dom/deepseek-pet |
| --- | --- | --- |
| 仓库 | https://github.com/LGaben/Desktop-Pets | https://github.com/c-dom/deepseek-pet |
| 可访问性 | GitHub连接器可读取，公开，未归档 | GitHub连接器可读取，公开，未归档 |
| 默认分支 | main | main |
| HEAD | 83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec | eb2ef68fa648df3f1b5246fff861655a780e6daf |
| HEAD时间（UTC） | 2026-06-03 08:24:32 | 2026-08-23 03:21:08 |
| 核心源码最后修改 | pet_window.py对应HEAD提交 | main.py最后修改为eb022a5d385baf0cf972af18903d532aace0fd1a，2026-08-23 03:14:16 |
| 实际技术栈 | Python、PyQt5、PNG精灵、SQLite、Windows Registry | Python、PyQt6、QtWebEngine、HTML/CSS/JS、QWebChannel、本地WebSocket |
| 本次是否运行 | 否 | 否 |
| CPU／应用内存实测 | 未知 | 未知 |
| Windows 10／11实际兼容性 | 未验证 | 未验证 |

维护判断使用代码提交日期，不把仓库 updated_at、README 的持续更新承诺或 Release 附件时间当作持续维护证据。两仓未归档不代表当前仍在积极维护。

元数据来源：[Desktop-Pets提交](https://github.com/LGaben/Desktop-Pets/commit/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec)、[deepseek-pet许可证提交](https://github.com/c-dom/deepseek-pet/commit/eb2ef68fa648df3f1b5246fff861655a780e6daf)、[deepseek-pet核心源码提交](https://github.com/c-dom/deepseek-pet/commit/eb022a5d385baf0cf972af18903d532aace0fd1a)。

## 2. LGaben/Desktop-Pets

### 2.1 源码已实现

| 能力 | 代码证据与边界 |
| --- | --- |
| 透明、无边框、置顶 | 使用FramelessWindowHint、WindowStaysOnTopHint、Qt.Tool及WA_TranslucentBackground；没有据此宣称已验证所有Windows版本的任务栏表现。[pet_window.py L84–124](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/ui/pet_window.py#L84-L124) |
| 多宠物窗口 | 主窗口持有卫星窗口列表，创建不同PetWindow，各有坐标与对象；主控隐藏全部，卫星可移除。[L168–216](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/ui/pet_window.py#L168-L216) |
| 拖动与右键菜单 | 左键记录偏移并移动，释放结束拖动；右键调用菜单。[L219–263](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/ui/pet_window.py#L219-L263)、[菜单L294–365](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/ui/pet_window.py#L294-L365) |
| 托盘 | 主窗口拥有单一QSystemTrayIcon，提供添加宠物、单只／全部隐藏及退出。[tray_manager.py L112–145](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/ui/tray_manager.py#L112-L145) |
| 自由移动与休息 | SimplePet随机选择走动／休息，可跟随鼠标、追球；这里的AI是行为选择，并非语言模型。[simple_pet.py L73–110](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/pet/simple_pet.py#L73-L110) |
| 2D动画 | 按宠物类型、动作目录读取PNG帧，缓存并在资源缺失时回退占位图。[sprite_loader.py L33–81](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/utils/sprite_loader.py#L33-L81) |
| 清理路径 | 移除宠物会停止四个定时器，退出时遍历卫星并清理。未实际压力测试，不能据此认定没有泄漏。[pet_window.py L173–187](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/ui/pet_window.py#L173-L187)、[L396–415](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/ui/pet_window.py#L396-L415) |

每只宠物使用33毫秒动画、1秒状态、3秒行为、200毫秒鼠标检查定时器。资源按每个SpriteLoader实例缓存，不能假定同类型多宠物共享所有解码帧。以上是源码配置，不是CPU、内存或帧率实测。

### 2.2 未确认或不满足WeiBiYe需求

- 未找到LLM请求、GPT／DeepSeek适配、聊天气泡、聊天SSE或Live2D。
- 多窗口的名字和类型不等于独立人格、账户、聊天历史或授权记忆。没有pet_id及owner边界。
- 未找到宠物整窗的操作系统级鼠标穿透。settings.py中给子组件设置WA_TransparentForMouseEvents，不能当作整个透明窗口允许点击桌面下层。
- 未找到WorkerW／Progman等桌面层嵌入；置顶工具窗与真正嵌入桌面不是同一行为。
- 初始窗口按序号偏移，不等于运行中具有碰撞避免或多显示器正确性。
- FullPet含饥饿、能量、经验与等级；这些不属于WeiBiYe产品范围。可参考SimplePet的状态职责拆分，不能复制养成系统。
- 数据库不能复用为WeiBiYe的多宠物存储：save_pet会先清空pet_state，load_pet只取一行。[database.py L58–85](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/utils/database.py#L58-L85)。这既没有用户／宠物隔离，也不适合保护既有P3/P4数据。

### 2.3 打包证据

README提及DesktopPet.spec和PyInstaller步骤，但完整HEAD文件树未见该spec、安装器工程或构建流水线；不能把README步骤记为已验证的可复现构建。

[Release DesktopPet](https://github.com/LGaben/Desktop-Pets/releases/tag/DesktopPet)有DesktopPet.v1.0.exe附件，2026-06-03发布，GitHub元数据大小22,072,433字节。只读取了附件元数据，未下载、校验签名或运行；这是下载文件大小，不是安装后体积、内存占用或安全认证。

### 2.4 许可证与素材

[根LICENSE](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/LICENSE)为MIT，版权LGaben，复用相应源码需保留版权和许可声明。

[README素材说明](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/README.md#L269-L280)称素材来自Anthony Shaw的vscode-pets并采用MIT。目标树没有完整的逐素材授权链；角色中包含Totoro、Clippy等名称，也不能因根LICENSE为MIT就推断已取得所有角色版权、商标或商业使用权。

本轮结论：不复制其美术素材，使用WeiBiYe自绘临时角色。若未来复用素材，须逐项追溯原作者、许可证、版权通知和角色权利。

## 3. c-dom/deepseek-pet

### 3.1 源码已实现

| 能力 | 代码证据与边界 |
| --- | --- |
| 原生窗口 | PyQt6的无边框、置顶、Qt.Tool、透明背景和不主动抢焦点；QtWebEngine背景也设为透明。[main.py L843–887](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L843-L887) |
| 原生网页桥 | QWebChannel注册petShell，通过明确方法处理拖动、设置和聊天；不是React。[L855–872](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L855-L872) |
| 点击／拖动区分 | 指针捕获，超过3像素后抑制后续click，右键显示网页菜单。[web/main.js L848–913](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/web/main.js#L848-L913) |
| 漫步 | 原生50毫秒定时器在闲置时选择目标、限制屏幕范围并移动窗口。[main.py L1274–1317](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L1274-L1317) |
| 精灵状态 | 2D图集描述动作行、帧数和帧率；有待机、左右跑动、挥手、跳跃、等待等动作。[web/main.js L57–79](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/web/main.js#L57-L79) |
| 气泡 | 使用textContent展示内容并控制显示时长，可借鉴安全文本渲染方式。[L129–143](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/web/main.js#L129-L143) |
| GPT／DeepSeek通路 | 后台线程POST兼容Chat Completions请求，配置provider/baseUrl/model，调用urlopen并读取完整JSON。[main.py L471–562](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L471-L562) |
| Windows密钥保护 | 使用CryptProtectData／CryptUnprotectData和LocalFree的DPAPI路径。[L395–439](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L395-L439) |
| 安全退出入口 | 网页菜单请求QApplication退出；关闭及aboutToQuit停止本地WebSocket后台。[L902–907](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L902-L907)、[L1319–1340](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L1319-L1340) |

模型代码未实际调用验证。它是兼容Chat Completions的请求通路，不能由此认定所有当前GPT／DeepSeek模型、参数或服务都可用。

### 3.2 与WeiBiYe的关键差异

- main只建立一个ChatService和一个TransparentDesktopShell，未实现多宠物窗口管理。[main.py L1324–1346](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L1324-L1346)。
- 聊天仅保留单个内存deque，maxlen为12；没有owner＋pet_id、持久会话、授权记忆、幂等生成任务、SSE重放或取消协议。重启后的历史持久化不能从该实现得到。
- 回复整包读取后经QWebChannel送回，不是SSE流式回复。[main.py L503–562](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L503-L562)、[web/main.js L620–662](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/web/main.js#L620-L662)。
- 未找到系统托盘、操作系统级整窗点击穿透、WorkerW桌面嵌入或Live2D实现。网页CSS的pointer-events不等于原生透明区域穿透。
- 设置／聊天在单一窗口中切换，不能当作按pet_id打开对应独立聊天窗。
- 代码允许本地网页读取文件URL，并有文件投喂到send2trash、Token喂食及快捷方式写入等功能；这些不属于WeiBiYe本轮需求，不复制其广泛系统访问面。
- WebSocket广播约30毫秒一次，网页持续requestAnimationFrame；不能据此声称低资源。
- 指标采样为psutil.cpu_percent及virtual_memory().percent，是整机指标，不是该应用的进程CPU／RSS。[main.py L1202–1208](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/main.py#L1202-L1208)。本次应用资源实测仍为未知。

### 3.3 打包证据

[build_app.py L120–180](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/build_app.py#L120-L180)确实实现PyInstaller onefile/noconsole构建，收集PyQt6／QtWebEngine并复制网页资源。该脚本还会准备／安装依赖，本次未执行。

[Release v0.1.0](https://github.com/c-dom/deepseek-pet/releases/tag/v0.1.0)的DesktopPet.exe附件元数据为381,804,828字节。没有下载、运行或验证签名，不能把它当作已核验安装器、兼容性或运行内存数据。

### 3.4 许可证与素材

[LICENSE L1–21](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/LICENSE#L1-L21)提供MIT样式的源码许可，版权c-dom；GitHub SPDX元数据为NOASSERTION，须依据实际文本审查，不能只写“GitHub识别MIT”。

[附加素材通知L23–28](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/LICENSE#L23-L28)明确把web/下角色美术、精灵及其他媒体排除在MIT之外，除非某个文件另有明确许可。未经相关权利人授权，不可复用、再分发或制作这些素材的衍生作品。这个排除不等于web目录的全部JS／HTML源码都被排除。

WeiBiYe不使用这些角色、图集、品牌或商标形象。

## 4. 共同依赖许可不能被根MIT覆盖

PyQt5／6采用GPLv3或Riverbank商业许可，不是LGPL。若最终应用分发许可与GPL不兼容，需要相应商业许可；不能把“商业化”本身误写成禁止，也不能因参考仓库MIT就忽略绑定库及Qt的分发义务。

依据：[Riverbank官方介绍](https://www.riverbankcomputing.com/software/pyqt/intro)、[许可FAQ](https://riverbankcomputing.com/commercial/license-faq)。

PySide6与PyQt是不同绑定，不能把PyQt项目的许可、资源开销或运行结论直接移植为PySide6结论。Tauri／Electron的比较也必须单独核对框架、依赖及资源许可证。

## 5. WeiBiYe可参考与禁止照搬的范围

| 范围 | 建议 |
| --- | --- |
| 主控与窗口生命周期 | 可独立实现一个主控持有pet_id到窗口的映射、单一托盘、显式停止动画和关闭窗口 |
| 点击与拖动 | 可独立实现拖动阈值、指针释放和抑制误触点击，不直接复制现有角色交互 |
| 动画资源 | 可借鉴资源描述／动作状态／缓存职责；采用自绘或许可明确的原创素材 |
| 聊天与记忆 | 继续复用WeiBiYe已验收P3/P4及PET_DESKTOP_API，不采用单行SQLite或全局deque替代 |
| 密钥与系统调用 | DPAPI仅作未来BYOK设计参考，本轮Mock无需密钥；不加入文件投喂、回收站操作或任意脚本IPC |
| 运行指标 | 用WeiBiYe自身进程树的CPU时间与工作集实测，不能抄参考项目整机指标或README数字 |
| 打包 | 参考职责划分，独立审查自己的构建配置；不执行第三方安装／构建脚本，不下载运行其Release |

本研究支持复用经过源码核对的通用设计思路。若未来确需复制MIT源码，须保留对应版权及许可证并重新核对依赖义务；本轮没有进行代码复制，也没有由这些仓库获得任何第三方角色素材的商业授权。

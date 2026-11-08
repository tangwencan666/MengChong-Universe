# P6 代码研究：Aemeath 与 Litrudy/DesktopPet

本报告仅包含本轮实际读取的仓库元数据、固定提交源码及发布元数据。所有资源均经 GitHub connector 只读取得；没有克隆运行、安装依赖、执行打包脚本或调用模型。README 的声明、静态代码实现和真实运行结果分别记录。

## 可访问性与维护状态

| 核查 | sleepingjhy/Aemeath-Desktop-Pet-on-Windows | Litrudy/DesktopPet |
| --- | --- | --- |
| 仓库可访问 | 是，公开仓库 | 是，公开仓库 |
| 本轮固定HEAD | f8d130201a7807e7867fa8e22ebc5dc2eb81a920 | f3067755833ba13859a6d3a9fa904177c684c1ac |
| 最新代码提交时间（UTC） | 2026-03-28 15:11:05 | 2026-06-29 09:12:53 |
| 归档状态 | 未归档 | 未归档 |
| metadata updated_at | 2026-09-20 01:36:08 UTC | 2026-10-27 11:46:30 UTC |
| metadata license | null | null |
| LICENSE/COPYING文件 | 递归树未见，README未见许可声明 | 同左 |
| 系统兼容证据 | README称Windows10/11，源码使用Qt和Win32 API；未做真机兼容矩阵 | README称Windows10/11，源码使用Qt；未做真机兼容矩阵 |
| CPU、内存实测 | 未运行，未知 | 未运行，未知 |

updated_at不是最近代码提交日期，不能以它证明持续维护。

元数据来源：

- [Aemeath仓库](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows)、[固定提交](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/commit/f8d130201a7807e7867fa8e22ebc5dc2eb81a920)、[完整树](https://api.github.com/repos/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/git/trees/f8d130201a7807e7867fa8e22ebc5dc2eb81a920?recursive=1)。
- [DesktopPet仓库](https://github.com/Litrudy/DesktopPet)、[固定提交](https://github.com/Litrudy/DesktopPet/commit/f3067755833ba13859a6d3a9fa904177c684c1ac)、[完整树](https://api.github.com/repos/Litrudy/DesktopPet/git/trees/f3067755833ba13859a6d3a9fa904177c684c1ac?recursive=1)。

## Aemeath：实际代码能力

| 关注项 | 代码核对结果 | 固定源码证据 |
| --- | --- | --- |
| 技术栈 | Python、PySide6及Addons/Essentials、OpenAI SDK、PyInstaller；不是React或Tauri项目 | [requirements.txt](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/requirements.txt) |
| 透明无边框 | QWidget同时设置无边框、置顶、工具窗口与透明背景属性 | [pet/window.py:64](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/window.py#L64) |
| 任务栏与置顶 | Qt工具窗口和置顶标志；另有动态切换置顶与多实例临时置顶 | [pet/window.py:472](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/window.py#L472) |
| 多宠物窗口 | 管理器保存实例列表、注册、spawn、调整数量及初始位置避让；是多窗口，但属于同一角色资源的多个实例 | [pet/instance_manager.py:78](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/instance_manager.py#L78)、[实例创建:407](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/instance_manager.py#L407) |
| 拖动与点击 | 左键进入拖拽、按全局鼠标偏移移动并限制屏幕边界；右键打开菜单；左键双击打开聊天 | [pet/input.py:7](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/input.py#L7)、[双击:702](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/window.py#L702) |
| 鼠标穿透 | 在已审阅的窗口与管理器代码中未找到显式输入透明、mask或Win32 hit-test策略；不能用透明背景推断穿透已实现或已验收 | 同上窗口及实例管理源码 |
| 自由移动 | MovementController处理自主移动、鼠标跟随、方向与边界；主移动节拍16ms | [pet/movement.py:168](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/movement.py#L168)、[config.py:73](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/config.py#L73) |
| 状态机 | dataclass保存拖拽、跟随、移动、休息状态，按优先级切换 | [pet/state_machine.py:7](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/state_machine.py#L7) |
| 动画 | QMovie播放move、drag、rest GIF，采用按需解码缓存；未发现Live2D运行时 | [pet/animation.py:136](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/animation.py#L136)、[资源映射](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/config.py#L34) |
| 聊天气泡 | 确认存在独立聊天窗口；未确认桌宠上方的AI流式气泡 | [main.py:97](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/main.py#L97) |
| 独立人格与历史 | 不符合WeiBiYe要求：主程序只创建一个全局ChatSession和ChatWindow，所有实例共用打开聊天回调 | [main.py:89](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/main.py#L89)、[create_pet:110](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/main.py#L110) |
| GPT/DeepSeek | Provider注册及OpenAI兼容SDK调用存在；实际服务可用性未知，未调用验证 | [pet/llm_providers.py:49](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/llm_providers.py#L49)、[DeepSeek:162](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/llm_providers.py#L162) |
| 流式协议 | 所见API明确使用stream=False，不是WeiBiYe所需的持久SSE／重放实现 | [pet/chat/api.py:350](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/chat/api.py#L350) |
| 托盘及退出 | 主程序统一退出并处理聊天、托盘和音乐；管理器停止显示／碰撞定时器并关闭释放实例 | [main.py:130](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/main.py#L130)、[manager shutdown:519](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/pet/instance_manager.py#L519) |
| Windows打包 | PyInstaller onedir/windowed流程；不是经过本轮验证的安装器 | [exe/build_exe.ps1:35](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/blob/f8d130201a7807e7867fa8e22ebc5dc2eb81a920/exe/build_exe.ps1#L35) |

已读取Release元数据：v1.4.0发布于2026-03-19，附件AemeathDesktopPet.zip为83,862,835字节。它只是发布ZIP大小；安装占用、压缩后实际程序组成、启动性能及三宠物CPU/RAM均未验证。[Release](https://github.com/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/releases/tag/v1.4.0)

静态性能观察：每实例移动16ms，管理器显示轮询50ms、碰撞轮询45ms，多实例会增加计时器及动画解码工作；配置中的50实例上限不等于性能合格结论。没有以这些频率推算或虚构CPU、内存数值。

## Litrudy/DesktopPet：实际代码能力

| 关注项 | 代码核对结果 | 固定源码证据 |
| --- | --- | --- |
| 技术栈 | Python、PySide6、Pillow、PyInstaller；不是React/Tauri应用 | [requirements.txt](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/requirements.txt) |
| 透明无边框／任务栏 | 透明背景、无边框工具窗、可选置顶 | [app/pet/pet_window.py:93](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/pet/pet_window.py#L93) |
| 多角色与多窗口 | 有三个资源包及切换；Controller始终只创建一个self.window，通过active_pet_id重新加载资产，不是三只同时运行 | [pet_controller.py:31](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/pet/pet_controller.py#L31)、[切换:287](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/pet/pet_controller.py#L287) |
| pet_id含义 | 是shark等资源包标识，不是用户宠物唯一UUID；不能替换WeiBiYe的pet_id权限作用域 | [PetPack及catalog](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/services/pet_catalog_service.py#L18) |
| 拖动／点击／右键 | 移动超过4像素区分拖拽与点击，点击发出信号，右键打开菜单 | [pet_window.py:217](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/pet/pet_window.py#L217) |
| 穿透 | 在审阅代码中未确认显式输入穿透策略，透明背景不作为验收证据 | 同上窗口源码 |
| 移动与屏幕 | 移动控制器、底边及屏幕区域约束，设置方向并翻转精灵 | [movement_controller.py:92](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/pet/movement_controller.py#L92) |
| 状态机 | 显式转换检查，idle/walk/sleep/happy/talk/dragged/returning | [state_machine.py:30](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/pet/state_machine.py#L30) |
| 2D动画 | PNG/QPixmap帧数组与按fps设置的QTimer；不是Live2D | [animation_player.py:21](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/pet/animation_player.py#L21) |
| 气泡 | 独立透明置顶SpeechBubble，按宠物位置与屏幕范围定位 | [speech_bubble.py:10](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/ui/speech_bubble.py#L10) |
| AI聊天与人格 | 所见DialogueService读取本地JSON，根据时间、状态和随机规则选择文案；不能把talk状态当GPT/DeepSeek聊天，也不构成用户授权记忆 | [dialogue_service.py:41](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/services/dialogue_service.py#L41) |
| 托盘与退出 | 有show/hide/pause/settings/quit托盘动作及Controller退出路径；未执行泄漏或异常退出实测 | [tray_icon.py:14](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/ui/tray_icon.py#L14)、[shutdown:382](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/app/pet/pet_controller.py#L382) |
| 打包 | PyInstaller无console的单EXE spec；本轮Release API为空，没有可核对的发布资产大小 | [shark_pet.spec:24](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/shark_pet.spec#L24) |

静态性能观察：动画按资源fps推进，只有帧实际变化才发出更新；切资源会替换帧数组。仍没有真实CPU/RAM、GPU占用或三宠物运行数据，因此不能宣称比其他方案更轻。

## 代码和素材许可

两者都没有核实到授予复制、修改与分发权的仓库许可证。GitHub公开可访问、允许查看或fork，不等于可以直接移植进WeiBiYe商业产品。GitHub对无许可证情况的说明见[官方文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。

- Aemeath包含特定角色名称、设定、GIF与表情图片，未找到独立美术商业授权。即使后续代码补许可证，也不能据此推定角色资源可商用。
- Litrudy的三个pet.json仅有名字、比例、行为配置，没有author/license。生成脚本使用临时剪贴板图及参考图片，不足以证明最终图像的权利链。参考[英短元数据](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/assets/pets/british_shorthair/pet.json)、[图像输入路径](https://github.com/Litrudy/DesktopPet/blob/f3067755833ba13859a6d3a9fa904177c684c1ac/tools/generate_british_shorthair_sprites.py#L32)。
- Aemeath打包脚本含删除与覆盖步骤。本轮只读审阅，未执行；Litrudy启动／打包脚本也未执行。
- 本轮不复制两个仓库的任何代码、图片、动画、图标、角色设定或品牌。需要代码级复用时，必须先取得明确许可并单独审查兼容性与声明要求。

## 对WeiBiYe的可参考设计

可以独立实现的通用思路：

1. 集中管理宠物窗口、托盘与退出生命周期，每个宠物维持独立坐标、状态机和任务句柄。
2. 区分资源包asset_id与服务端pet_id；同一外观可以属于不同宠物，身份不能由资源名推导。
3. 将动画播放、行为状态与窗口输入分离；拖动和点击使用移动阈值区分。
4. 使用屏幕可用区域约束坐标，并在创建多个窗口时避免完全重叠。
5. 集中处理计时器停止、请求取消、窗口关闭和资源释放。

不能借用的“功能证明”：

- Aemeath的共享聊天实例不能替代WeiBiYe的用户＋宠物隔离。
- Litrudy的多资源包切换不能替代三宠物同时运行。
- 透明背景不能替代穿透实测。
- Provider配置、模型名称列表与打包脚本不能替代真实模型服务、安装器或运行性能验收。

WeiBiYe继续复用自己的认证、宠物API、持久化SSE、重放与授权记忆；桌面实现及临时角色由本项目独立编写，性能与交互结果另由Windows验收记录提供。

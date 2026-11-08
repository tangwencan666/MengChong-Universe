# P6 公开源码研究：NekoAI 与 ai-pet

核查日期：2026-11-02。范围：公开 GitHub 元数据、固定提交的源码、许可证文件及发布资产清单。使用 GitHub 连接器只读获取仓库、提交、递归文件树和源文件；没有安装、运行或复制第三方实现，没有调用任何模型，没有下载发布安装包。README 宣传不作为功能已实现的唯一证据。

本文“已实现”仅表示固定提交中存在可追溯实现路径，不代表已经在本机 Windows 成功运行。CPU、内存、首次安装总大小、Windows 兼容性及资源泄漏情况没有经过运行测量。

## 1. 仓库身份与维护情况

| 项目 | nucket/NekoAI | lmy375/ai-pet |
| --- | --- | --- |
| 可访问性 | 公开，GitHub 连接器读取成功 | 公开，GitHub 连接器读取成功 |
| 默认分支 | main | main |
| 核查 HEAD | `7462b824a1428f8004ef671a53f31fd2f43ff723` | `f4721f95732bc68ae37672480e59221cb1ee12c8` |
| HEAD 提交时间（UTC） | 2026-10-26 19:15:10 | 2026-10-21 09:12:39 |
| 仓库 pushed_at（UTC） | 2026-11-01 13:15:34 | 2026-10-21 09:12:49 |
| 归档 / 禁用 | 均为 false | 均为 false |
| 许可证核查 | 根 LICENSE 为 MIT，版权 2026 Naudy Castellanos | API license 为 null，递归文件树未找到 LICENSE / COPYING / NOTICE / CREDITS |
| 实际技术栈 | Tauri 2 + Rust + React + TypeScript + Vite + Zustand + SQLite | Tauri 2 + Rust workspace + React + TypeScript + Vite + PIXI + Live2D |

仓库推送时间不是默认分支最后提交时间，发布包日期也不等于 HEAD 日期。公开仓库不等于授权复制或商业再分发。

元数据来源：[NekoAI 仓库 API](https://api.github.com/repos/nucket/NekoAI)、[NekoAI 提交 API](https://api.github.com/repos/nucket/NekoAI/commits/7462b824a1428f8004ef671a53f31fd2f43ff723)、[ai-pet 仓库 API](https://api.github.com/repos/lmy375/ai-pet)、[ai-pet 提交 API](https://api.github.com/repos/lmy375/ai-pet/commits/f4721f95732bc68ae37672480e59221cb1ee12c8)。以下源码链接均固定到核查提交。

## 2. NekoAI：代码级证据

### 2.1 桌面窗口和交互

| 能力 | 源码证据 | 判定及边界 |
| --- | --- | --- |
| 透明、无边框、置顶、隐藏任务栏 | [tauri.conf.json L14–42](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/tauri.conf.json#L14-L42) | 固定 main 32×32、house 64×64 窗口；透明不等于已经验证 Windows 鼠标穿透 |
| 面板窗口 | [lib.rs L237–266](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/src/lib.rs#L237-L266) | 复用或创建固定 panel 标签，无每只宠物动态窗口登记表的证据 |
| 托盘与退出 | [lib.rs L729–761](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/src/lib.rs#L729-L761) | 托盘显示/隐藏、设置、选择宠物、退出 |
| 后台任务退出信号 | [lib.rs L799–809](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/src/lib.rs#L799-L809) | Exit 时通知后台监测线程；没有运行验证全部资源释放 |
| 点击、鼠标按下、右键 | [App.tsx L224–226](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src/App.tsx#L224-L226) | 宠物精灵实际绑定事件 |
| 原生窗口拖动 | [useBubbleWindow.ts L67–85](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src/hooks/useBubbleWindow.ts#L67-L85) | 气泡展开时调用 startDragging，并保存精灵位置 |
| 边界与 DPI | [useBubbleWindow.ts L31–53](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src/hooks/useBubbleWindow.ts#L31-L53) | 展开窗口考虑显示器比例和工作区 |
| Windows 鼠标穿透 | 已检查配置和上述窗口代码，未确认 Windows 穿透调用 | 未知；不能用 Linux 形状遮罩替代 Windows 证据 |

### 2.2 动画与移动

- [usePetMovement.ts L9](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src/hooks/usePetMovement.ts#L9) 定义 IDLE / WALKING / NEAR_CURSOR / SLEEPING 状态；[L78–116](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src/hooks/usePetMovement.ts#L78-L116) 选择八方向移动动画。
- [usePetMovement.ts L343–362](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src/hooks/usePetMovement.ts#L343-L362) 只在 WALKING 使用动画帧循环，闲置状态降低轮询频率；文件中实际通过原生窗口 setPosition 移动。可参考调度思路，不能据此断言低 CPU。
- [PetRenderer.tsx L112–152](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src/pets/PetRenderer.tsx#L112-L152) 实现 Canvas PNG 帧绘制、fps 调度、单帧/结束停止调度与定时器清理；其中 Linux GTK alpha 形状遮罩不证明 Windows 穿透已实现。
- [classic-neko/pet.json](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/pets/classic-neko/pet.json)、[PetRenderer.tsx](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src/pets/PetRenderer.tsx) 支持由角色清单声明精灵帧、fps、循环、触发与人格提示词。未发现可确认的 Live2D 渲染实现。

### 2.3 多角色、聊天与存储

- [storage.rs L39](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/src/storage.rs#L39) 的 active_pet_id 与固定 main 渲染路径表明可切换宠物；这不是至少三只独立桌面宠物同时活动的实现证据。
- [storage.rs L483–498](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/src/storage.rs#L483-L498) 的 conversations 和 user_facts 没有 pet_id，不能作为 WeiBiYe 按用户及宠物隔离聊天和长期记忆的替代。
- [ai.rs L31–46](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/src/ai.rs#L31-L46) 实现 Anthropic、OpenAI、Gemini、Nvidia、Ollama 提供商枚举；[L223–275](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/src/ai.rs#L223-L275) 定义具体端点。
- [ai.rs L421–461](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/src/ai.rs#L421-L461) POST 后读取完整 JSON 并返回 String，不能描述成网络层 SSE 流式回复。未确认专用 DeepSeek 适配器。
- [App.tsx](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src/App.tsx) 存在 SpeechBubble；气泡 UI 不等于断线重放、任务幂等或流式协议已经具备。
- [storage.rs L306–330](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/src-tauri/src/storage.rs#L306-L330) 虽优先使用系统 keyring，但写入失败时仍可能把 API key 留在 config.toml 明文配置。该降级策略不适合直接用于 WeiBiYe。

### 2.4 打包与运行证据边界

[release.yml L23–39](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/.github/workflows/release.yml#L23-L39) 有 Windows/macOS/Linux 构建矩阵；[L89–109](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/.github/workflows/release.yml#L89-L109) 制作 Windows portable 压缩包。核查时最新发布 [v0.3.8](https://github.com/nucket/NekoAI/releases/tag/v0.3.8) 发布于 2026-06-03 19:56:32 UTC，资产清单含：

| 发布资产 | GitHub 报告大小 |
| --- | ---: |
| nekoai_0.3.8_x64_en-US.msi | 4,595,712 bytes |
| nekoai_0.3.8_x64-setup.exe | 3,181,485 bytes |
| nekoai-v0.3.8-portable-windows-x64.zip | 4,274,967 bytes |

没有下载或启动上述产物。签名、WebView2 首次安装条件、Windows 10/11 实际兼容性未知。安装包大小不能当作首次安装总量或运行内存。

### 2.5 许可证与美术素材

- [LICENSE](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/LICENSE) 为 MIT；若复用受其覆盖的源码，需保留版权与许可证。WeiBiYe 本轮不复制其代码。
- 递归文件树只找到根 LICENSE，没有每个宠物资源包的独立许可证明。[README L420](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/README.md#L420) 声称 Kenji Gotoh 原始 Neko 精灵为 public-domain，但此次没有独立核实完整权利来源。
- [bsd-daemon/pet.json](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/pets/bsd-daemon/pet.json) 标注其他作者/社区；根 MIT 不能自动解决角色商标及各美术资源授权。
- 核查 HEAD 的提交说明涉及移除 Pac-Man、TIE Fighter 角色，进一步提示不得把资源目录等同于可商业使用的素材库。
- 结论：可学习清单驱动渲染、低频闲置调度、托盘生命周期、DPI/工作区约束；不直接使用其角色、图标、品牌、美术，也不移植全局共享私人记忆或桌面监测行为。

## 3. ai-pet：代码级证据

### 3.1 桌面窗口与动画

| 能力 | 源码证据 | 判定及边界 |
| --- | --- | --- |
| 透明、无边框、置顶 | [tauri.conf.json](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/src-tauri/tauri.conf.json) | 固定 main 320×560，skipTaskbar；不是多宠物窗口登记表 |
| 窗口拖动 | [App.tsx L161–173](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/src/App.tsx#L161-L173) | 排除输入/按钮后调用原生 startDragging |
| 球形、面板、恢复 | [window.rs L221–347](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/src-tauri/src/commands/window.rs#L221-L347) | 固定 main / ball / panel / debug，切换时隐藏或恢复，不能证明三只宠物同时活动 |
| 基础动画 | [AnimatedPet.tsx L1–27](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/src/components/AnimatedPet.tsx#L1-L27) | idle/thinking/happy 三张 PNG 和 CSS 呼吸/偏头/跳动；不是走动精灵状态机 |
| Live2D | [Live2DCharacter.tsx](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/src/components/Live2DCharacter.tsx) | 实际创建透明 PIXI.Application、加载 Live2DModel、加入 stage；不只是 README 声明 |
| Live2D 清理 | 同上文件 | 有 renderer/ticker/automator 清理及 WebGL context lost/restored 处理；本轮未运行，不能保证无泄漏 |
| Windows 任务栏/穿透/托盘/自主移动 | 已核查窗口配置、App 和 Cargo 依赖 | 未确认原生鼠标穿透、Windows 系统托盘或自主走动实现；macOS 菜单不等于 Windows 托盘 |

### 3.2 人格、历史与模型调用

- [settings.rs L145–165](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/settings.rs#L145-L165) 定义 AgentConfig 的稳定 id 和模型配置；[memory.rs L1–36](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/memory.rs#L1-L36) 使用 memory/<agent_id>/SOUL.md、USER.md、MEMORY.md。
- 但 [session.rs L6–17](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/session.rs#L6-L17) 使用全局 sessions 路径，[L44–53](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/session.rs#L44-L53) Session 字段没有 agent_id；[settings.rs L581–590](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/settings.rs#L581-L590) 明确说明历史全局共享，切换角色改变下一次回应者。因此不能称为每个角色拥有独立聊天历史。
- [chat.rs L150–154](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/chat.rs#L150-L154) 根据当前 agent_id 重建人格/记忆 system prompt。其本地 Markdown 记忆不是 WeiBiYe 的显式逐条确认、撤销及来源审计授权体系。
- [provider.rs L16–44](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/provider.rs#L16-L44) 映射 OpenAI / OpenAIResp / DeepSeek 等适配类型；[llm.rs L55–62](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/llm.rs#L55-L62) 构造提供商、端点和授权。
- [llm.rs L139–199](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/llm.rs#L139-L199) 有 exec_chat_stream、流事件处理及取消 token。这证明存在流式实现路径；此次没有请求真实模型，也没有验证服务端事件重放/幂等兼容 WeiBiYe P3 SSE。

### 3.3 安全边界与素材风险

- [tauri.conf.json](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/src-tauri/tauri.conf.json) 的 CSP 为 null，assetProtocol scope 包含 `$HOME/**` 与 `/**`。不应照搬宽泛资源访问权限。
- [Live2DCharacter.tsx](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/src/components/Live2DCharacter.tsx) 支持从配置位置动态注入 Cubism core JavaScript，并接受本地或远程模型地址。WeiBiYe 需要限制资源清单与脚本来源，不应直接开放任意远程脚本。
- [settings.rs L70–91](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/settings.rs#L70-L91) ModelConfig 含 api_key 字符串；[L563–577](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/crates/pet-core/src/settings.rs#L563-L577) 序列化并写入 YAML 配置。未发现可确认的系统凭据库保护，应视为明文凭据风险。
- [commands/settings.rs L165–202](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/src-tauri/src/commands/settings.rs#L165-L202) 声明 Cubism runtime 和 Wanko 样例素材有版权、被 gitignore 排除，并提供 CDN 下载路径。可下载不代表可商用、可打包或可再分发。
- 根及递归文件树未找到项目许可证。即使依赖各自开源，也不能据此复制整个项目源码、美术或再分发。WeiBiYe 仅学习通用思路，所有实现独立编写，素材自行绘制。
- Bash、文件工具、MCP、Telegram、swarm 等通用 Agent 能力不属于当前桌宠 MVP，不建议引入。

### 3.4 打包、维护与性能边界

[release.yml L139–147](https://github.com/lmy375/ai-pet/blob/f4721f95732bc68ae37672480e59221cb1ee12c8/.github/workflows/release.yml#L139-L147) 的 GUI 任务只运行在 macOS，目标为 arm64/x64 macOS。核查 [v1.0.0](https://github.com/lmy375/ai-pet/releases/tag/v1.0.0)（2026-08-19 03:35:23 UTC）发布清单包含：

| 发布资产 | GitHub 报告大小 |
| --- | ---: |
| macOS arm64 DMG | 10,209,208 bytes |
| macOS x64 DMG | 10,520,418 bytes |
| 其他 | macOS/Linux CLI tar.gz 与 SHA256SUMS |

未发现 Windows 安装包。虽然 Tauri 支持 Windows，不能据此断言该仓库已完成 Windows GUI 打包或实际兼容验收。CPU、内存、Live2D 多实例负载均为未知，没有测量。

## 4. 对 WeiBiYe 的适用结论

| 可学习的设计 | 不应移植的实现或未经证明的能力 |
| --- | --- |
| 数据清单驱动角色和动画状态 | 第三方角色、美术、商标或许可未知资源 |
| 闲置时降低动画和移动调度频率 | 把源码调度策略当作性能测量结果 |
| 托盘控制与显式后台任务退出 | 未验证的三宠物同时运行、Windows 穿透、无泄漏保证 |
| 显示器工作区与 DPI 约束 | 固定 main 窗口直接充当多宠物管理器 |
| 角色 ID 与本地状态的清晰映射 | 全局共享会话/记忆替代用户＋pet_id 隔离 |
| 可替换渲染层及 Live2D 预留接口 | 任意脚本加载、全磁盘资源权限、明文密钥降级 |

两仓可佐证 Tauri + React 是真实存在的桌宠实现路线，但不能证明在当前开发机具备 Rust/MSVC 工具链、三宠物性能或 WeiBiYe 隔离语义。最终技术选型需同时考量本机工具链和所有参考项目，不能只凭上述仓库的 README 或包体积作结论。

WeiBiYe 应保留 FastAPI、Cookie/CSRF、P3 SSE 任务/重放、P4 授权与撤销，以及 PET_DESKTOP_API 的用户＋宠物隔离。桌面宿主只负责窗口、坐标、交互、生命周期和受限桥接，不重新实现另一套弱化的聊天和记忆后端。

## 5. 核查限制

1. 只读源码研究，没有第三方安装或运行，因此没有 Windows 实测截图和 CPU/RAM 数据。
2. “未找到”表示此次核查的固定提交/文件树中未确认，不能扩大为对未来版本的断言。
3. 许可证和素材权利来源不足的资源不进入 WeiBiYe；实际商业发布仍须逐项审查发行依赖和资产。
4. GitHub 源码和元数据可随时间变化；固定 commit 链接用于保留此次证据范围。

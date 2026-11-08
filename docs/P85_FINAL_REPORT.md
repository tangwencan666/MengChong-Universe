# P8.5 最终报告：八角色、自由领养、多实例与实际三视图

日期：2026-11-03T13:16:09+08:00。

状态：**P85_EIGHT_LOCAL_VERIFIED_WITH_LEGACY_ASSET_PATH_BLOCKED**。

八角色与多实例的当前本机 Windows/Electron 完整验收 16/16 通过，包含真实 30 分钟五只同种长测。完整桌面单元回归仍有 **1 项既有 P7 外部图片旧文件名检查失败**，不能宣称全量回归全绿。早期一次安全收回的客户端原因未得到完整证据，后续完整测试未复现，作为耐久观察项保留；没有为了通过测试放宽身份、限流或数据隔离检查。

本轮真实模型请求 **0**；未部署、发布、推送、执行支付或安排关机。全部后端测试使用全新临时 SQLite；PostgreSQL 只读快照一致，没有数据库迁移。

代码本地提交：`6c1c4c4f1be5dc0d9a56fc5c695b0aa8100093bc`。本报告独立文档提交，两个完整哈希与报告 SHA256 写入 `D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\p85\eight-debe8fb4-b2a9-408e-9fe9-7ecd43f1680b/commit-ledger.json`，避免自引用提交哈希。保留本轮开始时的 **193 条原有未提交路径**，未整体提交先前未跟踪模块。该提交为当前工作树增量，不宣称可脱离原有前置成果独立发行。

## 八角色实际接入

| 角色 | species_id / 默认外观 | 人格及本地动作 | 实际素材与限制 |
| --- | --- | --- | --- |
| 月芽 | moon / moon-base-v1 | 原有配置、动作与门控保留 | 既有 SVG 不替换 |
| 豆包 | doubao / doubao-base-v1 | 原有配置保留，继续 Mock | 既有 SVG 不替换 |
| 小云 | xiaoyun / xiaoyun-base-v1 | 原有配置保留，继续 Mock | 既有 SVG 不替换 |
| 耄耋 | maodie / maodie-base-v1 | 搞怪型既有配置保留 | 原有 SVG；指定照片不是三视图，不换成写实猫 |
| 哈吉米 | hajimi / hajimi-base-v1 | 治愈型既有配置保留 | 原有 SVG；两张指定照片不是三视图 |
| 奶娃 | niwa / niwa-source-v1 | 活泼、好奇；摇摆、跳跃、观察、转身 | 原图裁切的正、左侧、背面；静态整体变换 |
| 刀盾 | daodun / daodun-source-v1 | 勇敢、认真、有反差萌；巡视、守护姿态轻摆 | 正、左侧；背面受水印遮挡仅参考；武器不镜像 |
| 鲸鱼娘 | whale / whale-source-v1 | 温柔、安静、略俏皮；挥手姿态轻摆、思考、说话 | 清晰正面；三视图界面叠层覆盖角色，仅作参考 |

公共注册表前五项及全部原动作定义与本轮基线 JSON 深比较完全一致；未更新旧数据、位置、授权或记忆。三种新人格是领养时复制到独立实例配置的本地模板，本轮没有验证真实 DeepSeek 的新角色表达。

## 原始素材清单与处理

仅检查用户指定图片库，未扫描其他私人目录；9 张原图及 10 张处理副本均核对 SHA256。原图不移动、不重命名、不覆盖。外部素材商业/再分发授权未确认，**仅限本地验证**，不进入默认安装包或 Vite UI 构建。局部处理不代表取得授权。

| 文件 | 扩展名 | 尺寸 | 字节 | Alpha通道 / 实际范围 | 实际内容、背景、边框、水印与降级 |
| --- | --- | --- | --- | --- | --- |
| 哈吉米.jpg | .jpg | 1206×2622 | 99423 | 无 / 255～255 | 单只写实风小猫；手机界面与白底；不是三视图，原五宠继续使用既有素材 |
| 哈吉米二.jpg | .jpg | 1206×2622 | 167553 | 无 / 255～255 | 单猫近景、桌面、手机界面；不是三视图，原五宠继续使用既有素材 |
| 奶娃.jpg | .jpg | 1206×2622 | 111424 | 无 / 255～255 | 单角色，黄色卡通；白底、手机状态栏与播放器边框；无清晰作者水印 |
| 奶娃三视图.jpg | .jpg | 1206×2622 | 110055 | 无 / 255～255 | 放大正面加全身正、侧、背四图；白底、手机界面；运行仅裁取右侧三个完整全身视角 |
| 我的刀盾.jpg | .jpg | 1290×1011 | 63683 | 无 / 255～255 | 单角色刀盾圆团；白底，底部抖音作者水印，右侧盾边已有轻微原始裁切；不改装备 |
| 我的刀盾三视图.jpg | .jpg | 828×460 | 49148 | 无 / 255～255 | 正、侧、背及脸/手/脚/盾局部特写；白底、分格标签；背面被作者水印覆盖，仅存参考，运行背面回退正面 |
| 耄耋.jpg | .jpg | 1206×2622 | 182216 | 无 / 255～255 | 单猫正面、白底、手机边框、AI生成标识及顶部文字；不是三视图，原五宠继续使用既有素材 |
| 鲸鱼娘.png | .png | 835×805 | 531963 | 有 / 255～255 | 单角色蓝发Q版正面；白灰背景，原Alpha通道不代表实际透明；无明确作者水印 |
| 鲸鱼娘三视图.png | .png | 1665×786 | 1308099 | 有 / 255～255 | 正、侧、背确实存在；搜索框、左右导航与播放按钮遮挡角色；三图仅作带叠层参考，不补画；运行侧背回退清晰正面 |

PNG 有 Alpha 通道不等于背景透明；两张原始 PNG 的实际 Alpha 均为 255。保留原图所有身份、装备与配色。奶娃和刀盾的运行视图来自原始三视图全尺寸文件中的角色区域，鲸鱼娘正面来自原始单角色 PNG。遮挡参考图不抹除水印或按钮，不被标为干净运行视角。原有哈吉米、耄耋继续使用既有素材和动作，未替换为这些照片。


| 原始文件 | SHA256 |
| --- | --- |
| 奶娃.jpg | `38b8276399c808415de711bd59e01a9110aa6813388377cc060e4ba5ee6c42c9` |
| 奶娃三视图.jpg | `31a149546cf8de1a7de0bbb3d8197074c88c250520ce70883581eab6c3dd2137` |
| 我的刀盾.jpg | `17f32abfd7a76a8661e4eaf3b19248a43e1152cee6767e8661535981eb843dcb` |
| 我的刀盾三视图.jpg | `542ea80fd7bbd0e9aeba22fe282fbaefc86801d80a9d80fdeea87bd70edab661` |
| 鲸鱼娘.png | `6bdd7463d8da8c092d32cb4aeb57eff84267c5e7c0186666b0e2ead6e2a5245f` |
| 鲸鱼娘三视图.png | `e670278b4153a6c14c5833cc266687e8f3eaf60fc99ec336e797cde96dc27268` |
| 哈吉米.jpg | `907b4571b73c4604825fe4c898c3ab2ae3623577812daf875349dabf867e1680` |
| 哈吉米二.jpg | `253c5c54d6511c36283e371d053c579e3c6cea1d07d00fc1550e90ec88431b8b` |
| 耄耋.jpg | `d8504c28eaf9a95c6204df9ed2990e5ab4e817ae35e4050c6f62ac8c7456e979` |

| 外观 | 运行视角来源 | 运行映射及降级 |
| --- | --- | --- |
| niwa-source-v1 | 奶娃三视图.jpg 的三个完整全身小图 | p85-niwa-front/side/back-v1.png；反方向移动使用正面，不伪造右侧 |
| daodun-source-v1 | 我的刀盾三视图.jpg 的正、左侧 | p85-daodun-front/side-v1.png；背面留带水印 reference 副本，运行回退正面 |
| whale-source-v1 | 鲸鱼娘.png 的单角色正面 | p85-whale-front-v1.png；三视图正/侧/背带叠层 reference 副本仅参考，运行缺角回退正面 |

处理使用 Windows 自带 System.Drawing：原像素裁切、明确非角色的边缘区域/分格文字清理、边缘连通的中性背景透明化、同角色统一比例和落脚点、256×256 RGBA 导出。没生成五官/身体/装备/不存在视角，受遮挡的水印和按钮不抹除。透明边缘仍可能有原始抗锯齿或底色残留，不能宣称手工精修完成。

可复现脚本 `desktop/scripts/prepare-p85-local-assets.ps1` 拒绝覆盖输出、拒绝符号链接，按原图内容哈希匹配指定目录。裁切坐标和处理理由见 `desktop/assets/p85-source-plan.json`；运行角度、版本、SHA256、字节与限制见 `desktop/assets/p85-appearances.json`；本地处理副本在 `desktop/local-preview/p85-eight-v1`，附去除绝对私人目录的 ASSET_PROVENANCE.json 和 ASSET_NOTICE.md。原始 processing.json 留本地，不进 Git。

脚本另外在新的 reproduction 目录完整重跑，10 个 PNG 与运行副本 SHA256 逐一相同，来源记录与本地限制文件生成成功。首次混合模块环境下直接调用 Windows PowerShell 5 缺少 Get-FileHash，改用 PowerShell 7 则缺少 System.Drawing.Primitives 编译引用；两份失败日志保留。独立模块环境的 Windows PowerShell 5 成功复现全部 10 张。新增 `desktop/scripts/prepare-p85-local-assets.cjs` 入口，仅为本次子进程移除 PSModulePath 与模型密钥变量，固定调用系统自带 Windows PowerShell，原 PS 像素算法不变；经同样 10/10 哈希验证。记录见 asset-reproduction*.log、asset-reproduction.json、asset-launcher-reproduction.json；不改系统环境、不安装软件、不覆盖原图或运行副本。该工具入口修复与已验证的 Electron 运行逻辑独立。

## 领养、身份与数据生命周期

- “我的宠物”展示八种角色及可用外观/限制，支持分页、重复领养、独立命名、重命名、人格编辑、资料、召唤、隐藏、收回、恢复上次组合、二次确认归档和重启恢复。真实 UI 连续领养五只同名鲸鱼娘，各有不同 UUID 与操作幂等键；本轮账号拥有 13 只，桌面最多 5 只，第六次召唤拒绝但拥有记录保留。
- owner_user_id 始终来自认证；pet_instance_id 始终为原 Pet UUID；species_id 为明确资产/种类映射；appearance_id 表示共享外观。旧五种默认 asset_id 仍保留原形式，新三种写版本化外观 ID；未知旧外观按角色映射并标 legacy_role，不用名字识别。未新增 SQL 列或迁移。
- personality_snapshot 为实例**当前已持久化人格配置的独立副本**，版本取 Pet.version；模板变化不改已有实例。它不是新增的不可变出生历史。重命名不改实例/owner/appearance；版本变更沿用乐观锁。客户端不能指定 owner 或实例 UUID。
- PetService、聊天绑定及记忆复合边界继续使用 owner + pet UUID。离线实际检索/注入验证同种 whale/whale 与异种 niwa 各只读自己的长期记忆；跨宠会话、跨宠记忆、跨账号读取返回 404。原五宠人格与历史隔离回归通过。Windows 另通过同种双实例记忆 API 和真实 Mock 会话路由隔离。
- 收回/隐藏不删除聊天或记忆；每实例独立位置、动作、偏好及隐藏标记，账号哈希命名空间保存有界组合；重启后重新认证逐实例校验，聊天不自动展开。草稿编辑期间禁止主界面停泊，重命名输入按需展开。
- 删除沿用**不可逆归档**：实例退出活跃显示和生成，聊天只读保留，长期记忆按原规则可管理/删除/撤销授权。两步确认含数据说明、复选框及 UUID 校验，提交前取消无变化；没有虚构撤销归档/物理擦除功能。另一个同种实例不受影响。

## 动作、互动与资源管理

复用 P8.4 优先级、冷却、独立 actor、拖动保存、边界及本地多实例协调器。共有待机、呼吸/轻摆、左右移动、转向、点击反应、跳跃、睡觉/休息、思考和说话；新增 sway、wave、guard、patrol 的有限变换。PNG 的“挥手/举盾”当前是**整张姿态轻摆**，没有分离肢体，也不称完整逐帧动画；没有改眼睛伪造眨眼。最高退出/隐藏/拖动，AI 高优先级可打断低优先级动作，用户可关闭随机和自动移动。

本地协调器按不同实例 UUID 配对，不以种类或名称当私有身份；同种与异种可低频观察/接近、避让，90 秒冷却，范围受工作区和碰撞约束，不读取聊天记忆。收回关闭 actor/窗口任务，隐藏卸载图像并暂停动画，再召唤可恢复。托盘隐藏保留有限窗口槽位，收回释放窗口。

新增 PNG 按需验证签名/尺寸/大小/SHA256，去重读、LRU **256KiB**；原 SVG **32KiB** 缓存保留。缺图或不符哈希则有限尝试清晰正面再回退原 SVG，UI 明示占位；不打开任意本地路径、不放宽 CSP、不把私有状态送进桌宠渲染器。每实例最多一桌宠、一复用聊天窗口；显示硬上限可在 1～5 内配置，未经新性能验证不能提高。既有私有提交 1GiB 高水位保护、850MiB 恢复、总窗口分配硬限 **12** 仍有效；本轮两聊天基准场景另检查不超过 **8**，两者不能混淆。

## 自动化与实际 Windows 结果

| 检查 | 当前结果 |
| --- | --- |
| 后端相关离线回归 | 272 unique passed，0 failed，0 skipped；215 + 57 无重叠，新增八角色专项 10，既有 P8.5 领养专项 13 |
| 前端单元 | 56 passed，0 failed，0 skipped；新增八角色专项 3 |
| TypeScript / ESLint | 通过，零 ESLint 警告 |
| 前端构建 / Electron UI 复制 | 通过，JS 535.38kB；500kB 块体积提示保留，未抬高告警阈值 |
| 桌面完整单元 | 184：183 passed，1 failed，0 skipped；新增八角色专项 8 全通过 |
| 既有 P7 失败 | 外部原图旧文件名不存在 ENOENT；不修改原先未跟踪测试，不创建图片库别名冒充通过；9 张当前原图另行哈希核对成功 |
| Ruff / 格式 / JS 语法 | 涉及 Python、fixture、工作树及减去原有 WIP 的提交候选均通过 |
| 实际 Windows/Electron 完整验收 | 16 passed，0 failed；含真实 30 分钟五同种长测，实际 Win32 拖动、点击、右键、焦点和外围鼠标穿透 |
| 未验证专项 | 多物理显示器、其他 DPI、低配设备、P8.5 新安装包、真实模型新人格/在途上游取消/费用，不列为跳过的自动用例通过 |

本机 Windows 11 build 26200、Ryzen 5 5600H / 6 核12线程、约 15.36GiB 内存，Electron 45.2.1。实际显示配置：`[{"id": 2642599607, "scaleFactor": 1.25, "workArea": {"x": 0, "y": 0, "width": 1536, "height": 816}}]`。

Windows 原始证据：`D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\p85\eight-windows-fec82ffb-4e6f-4498-9f0c-f71c811f194e`。实际宠物截图 actual-niwa-front.png、actual-daodun-front.png、actual-whale-front.png；管理界面 actual-pet-management.png，重命名实例 actual-renamed-whale.png。这些是正在运行的真实 Electron 窗口截图；聊天后端明确 Mock，不代表真实 DeepSeek 新验收。

- real UI repeats adoption of five same-name whale with distinct UUIDs and operation keys：passed。
- mixed 1 pets use independent bounded real desktop windows：passed。
- mixed 3 pets use independent bounded real desktop windows：passed。
- mixed 5 pets use independent bounded real desktop windows：passed。
- eight original species rotate real desktop windows; source views, overlays and PNG lifetime stay bounded：passed。
- double confirmation cancels safely, archives one instance and keeps chat/memory lifecycle explicit：passed。
- five same-species instances reuse one asset family; sixth summon is denied without losing ownership：passed。
- renaming an active instance updates only its native label, identity and independent persona：passed。
- same-species memory and session URLs stay separate through real authenticated local APIs：passed。
- real Windows drag/click during Mock SSE and recall during a held Mock generation keep independent state：passed。
- five simultaneous finite animations remain independent with bounded cached resources：passed。
- hidden sprites unload images, chat windows close and a draft-free dashboard parks：passed。
- restart automatically restores authenticated same-species selection, hidden flags and native positions：passed。
- ordinary native background activity does not steal an independent foreground window：passed。
- thirty-minute five-same-species stability bounds windows, memory growth, motion and lifecycle reuse：passed。
- account switching rejects other-owner instances/memories and normal exit releases every owned window：passed。

原生辅助工具在发送输入前校验 HWND/PID 与命中目标，只操作本次窗口。焦点测试使用自己创建的独立 Windows Form，临时置顶供安全点击后恢复普通层级再观察；其他程序不移动、不关闭。外围穿透在窗口内 DIP(6,6) 移动鼠标、不点击，确认不会拦截该点或改变焦点；**未声明逐像素 Alpha 热区全部通过**。拖动后位置和重新启动的隐藏/组合恢复通过。

30 分钟阶段为了避免干扰用户，测试层临时将本次窗口显示改为 showInactive 并抑制 focus，正常产品焦点在此前独立验证；防休眠请求结束即停止。用于诊断的请求状态/路由、Cookie 名/原因元数据环在长测前卸载，不含正文、Cookie 值或密钥。聊天在途收回用显式本地 Mock 门控，验证完成和恢复，**不证明真实上游中断**。

## 性能实测

全部数据来自单一 5 秒 Electron 全进程采样时钟，CPU 按采样间隔加权；工作集为各进程加总，可能重复计算共享页，不等同机器独占物理内存。不包含测试驱动 Node 与隔离 Python 后端。每个短场景约 21 秒，仅作为短样本，不替代长测。

| 场景 | CPU 平均 | 工作集峰值 MiB | 私有提交峰值 MiB | 样本 |
| --- | --- | --- | --- | --- |
| 1 宠 / 0 聊天 | 0.297% | 633.38 | 406.60 | 5 |
| 3 种宠物 / 2 聊天 | 0.280% | 1051.21 | 500.07 | 5 |
| 5 种宠物 / 2 聊天 | 0.410% | 1264.31 | 568.74 | 5 |
| 5 只鲸鱼娘 / 0 聊天 | 0.340% | 1051.29 | 515.29 | 5 |
| 5 只鲸鱼娘并行动画 / 2 聊天 | 1.500% | 1304.58 | 563.61 | 5 |
| 5 只隐藏 / 聊天关闭 / 主界面停泊 | 1.354% | 899.94 | 396.30 | 4 |
| 五只同种鲸鱼娘 + 两聊天 / 30分钟 | 0.453% | 1296.04 | 573.34 | 357 |

长测实际 30.07 分钟，14 次隐藏/显示及聊天关闭重开；末段相对暖机后的前段私有提交均值 **+37.48MiB**。357 份窗口快照均为五独立实例/五独立桌宠渲染 PID，无越界或超过 2DIP 原生舍入容差的重叠；最多 8 窗口，PNG 缓存最大 203069 字节，未超 256KiB、未出现哈希拒绝，动作异常恢复为 0。原始 soak-samples.json 全部保留。

| 长测进程角色 | 角色工作集峰值 MiB | 角色私有提交峰值 MiB |
| --- | --- | --- |
| GPU | 248.76 | 172.14 |
| 主界面渲染器 | 132.04 | 66.95 |
| 主进程 | 139.48 | 96.64 |
| 聊天 / 69dd3c2c | 123.30 | 42.82 |
| 聊天 / 910e3f16 | 125.32 | 45.87 |
| 辅助进程 | 52.18 | 14.44 |
| 鲸鱼娘实例 1 / 910e3f16 | 104.60 | 30.49 |
| 鲸鱼娘实例 2 / 69dd3c2c | 104.04 | 30.40 |
| 鲸鱼娘实例 3 / bf2f91c6 | 105.61 | 30.95 |
| 鲸鱼娘实例 4 / ec6d9774 | 108.57 | 35.21 |
| 鲸鱼娘实例 5 / 217b2f4c | 107.28 | 32.91 |

各角色峰值发生时刻可不同，不应直接相加当同一时刻总峰值。大量基础开销来自 Electron/GPU/每实例隔离渲染器与聊天视图，图像本身有界；本轮没有为追求数字去共享私有身份或不断创建窗口。

| 基线 | 平均CPU | 工作集峰值MiB | 私有提交峰值MiB | 30分钟均值增长MiB |
| --- | --- | --- | --- | --- |
| 用户提供 P8.4 五宠两聊天 | 0.38% | 1221 | 591 | +47 |
| 上轮 P8.5 五只哈吉米两聊天 | 0.470% | 1280.45 | 577.49 | +40.47 |
| 本轮五只鲸鱼娘两聊天 | 0.453% | 1296.04 | 573.34 | +37.48 |

不同素材、预热与运行时点不是严格 A/B，不能据此宣布整体性能改善或绝无泄漏。当前增长通过既有 <96MiB、私有峰值 <1GiB、工作集峰值 <1800MiB 的长测约束，阈值未抬高；更长时间和低配设备仍需后续验证。

隐藏场景的 CPU **1.354%** 高于静置混合五宠的 0.410%，不能把图片卸载等同于持续 CPU 降频已验证。上轮五只哈吉米同样的隐藏短测为 **1.339% / 910.75MiB 工作集 / 398.37MiB 私有提交**，本轮 **1.354% / 899.94 / 396.30**，未见明显新增退化。当前 4 份隐藏样本中 GPU 约 0.38～0.53%，多个保留桌宠渲染器仍有约 0.10～0.19% 占用；主界面已停泊、图片源已卸载、聊天已关闭，后台节流配置为 true。根因尚未独立定位，不把调试器影响等假设当成结论。后续应进行不附着 Playwright 调试器的独立隐藏长采样，再评估是否需要产品优化；本轮不为一个既有短测现象大幅改动已验证业务逻辑。

## 失败记录、数据与进程保护

- 早期 eight-windows-a08685af… 在轮换后安全收回，服务端无 429、没有完整客户端原因；保留未解释项，后续完整流程未复现，不据猜测改产品认证逻辑。
- eight-windows-fed3a863… 安全输入工具发现焦点探针被遮挡，拒绝点击；仅调整本次探针窗口供测试定位，未操作其他应用。
- eight-windows-9fded31c… 前 13 组通过，测试误传 3000ms 超过辅助工具 2000ms 参数上限；修正后独立探针预检通过。属于测试配置错误，原日志不改。
- eight-windows-e4f56149… 多个密集检查累计触发 pet-read 120/min，日志有两次 429，客户端按原规则安全收回。生成状态查询已有 1.5 秒间隔；在密集组间增加 65 秒等待后完成最终验收，未调高产品限流或延长身份请求超时。
- eight-windows-a726e49d… 长测约 2 分钟发现 10 个窗口，超过既定 8 窗口基准场景，但不表示突破产品 12 窗口分配硬限；中止且端口正常释放。该轮缺少窗口角色/输入来源记录，不能单凭计数认定泄漏，也不能宣称根因已修复。后来增加有界创建/关闭和本次桌宠鼠标事件元数据。独立 six-cycle 复用实测始终 5 宠+2 聊天+1 主界面，最终完整长测见本报告，不将失败记录改写为通过。
- eight-windows-36195562… / 372691a1… 外围探针检测鼠标位置改变，安全中止。先统一 125% DPI 的物理像素坐标；后一次仍出现 (6,-15) 像素偏移，不能再当作单像素舍入。用户随后明确提供安静时段，最终完整测试在该时段执行。没有屏蔽安全检查或把输入干扰当成产品取消缺陷。
- 独立窗口复用第一轮 5 次保持 8 窗口，第六次读限流中止；增加间隔后 eight-windows-84f25369… 的 6 次关闭/重开/重复打开全部保持 8 窗口、8 sender，正常清理。它是生命周期专项，不代替 30 分钟性能数据。
- 早期后端测试将 8 只宠物放进同一命令限额场景触发 429；仅拆分为原五种和新三种+旧 Moon 的独立 fixture 参数组，最终 272 用例通过。原失败日志保留。

只读快照：共享 weibiye 仍为 **0005 / 26 表**，旧隔离测试库仍为 **0006 / 34 表**，集群 7703042374370492450。两库逐表行数/内容哈希及结构前后一致；不是只比较迁移号。本轮全部写入只在新 SQLite，未删除任何原宠物、账号、长期记忆、容器或卷。

所有本轮 eight-windows 运行均正常退出，后端退出码 0，所属端口再次探测全部释放。PID + 创建时间 + 父子关系检查无本次残留或身份不明进程，强制终止为 false。未按 Python/Node/Electron 名称批量结束进程，没有安排关机。

本轮基线源文件 585 个，历史证据 **15,602 个**逐文件不变；原五角色配置未改，9 张原图不变。涉及既有 WIP 的 4 个跟踪文件采用三方减法，仅提交新变化，原有增删行集合完全保留；另外 560 个原有源文件在代码阶段未变。以前的最终报告原样归档到 `D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\p85\eight-debe8fb4-b2a9-408e-9fe9-7ecd43f1680b/prior-final-report.md`，旧 .verification 不改。

## 修改清单

代码 52 个路径 + 最终报告 1 个。包含 10 个本地处理 PNG 与 2 个来源/限制文件；不含原始图片、绝对路径 processing.json、旧 P7 素材、原有未跟踪前置模块或任何密钥。

- `backend/app/modules/pet_instances/catalog.py`
- `backend/app/modules/pet_instances/router.py`
- `backend/tests/test_p84_pet_catalog.py`
- `backend/tests/test_p85_eight.py`
- `backend/tests/test_p85_instances.py`
- `desktop/assets/p85-appearances.json`
- `desktop/assets/p85-source-plan.json`
- `desktop/assets/pet-definitions.json`
- `desktop/local-preview/p85-eight-v1/ASSET_NOTICE.md`
- `desktop/local-preview/p85-eight-v1/ASSET_PROVENANCE.json`
- `desktop/local-preview/p85-eight-v1/p85-daodun-back-reference-v1.png`
- `desktop/local-preview/p85-eight-v1/p85-daodun-front-v1.png`
- `desktop/local-preview/p85-eight-v1/p85-daodun-side-v1.png`
- `desktop/local-preview/p85-eight-v1/p85-niwa-back-v1.png`
- `desktop/local-preview/p85-eight-v1/p85-niwa-front-v1.png`
- `desktop/local-preview/p85-eight-v1/p85-niwa-side-v1.png`
- `desktop/local-preview/p85-eight-v1/p85-whale-back-reference-v1.png`
- `desktop/local-preview/p85-eight-v1/p85-whale-front-reference-v1.png`
- `desktop/local-preview/p85-eight-v1/p85-whale-front-v1.png`
- `desktop/local-preview/p85-eight-v1/p85-whale-side-reference-v1.png`
- `desktop/renderer/pet-action-view.js`
- `desktop/renderer/pet-actions.css`
- `desktop/renderer/pet-appearance.js`
- `desktop/renderer/pet.html`
- `desktop/scripts/prepare-p85-local-assets.cjs`
- `desktop/scripts/prepare-p85-local-assets.ps1`
- `desktop/src/gateway.cjs`
- `desktop/src/manager.cjs`
- `desktop/src/p85-appearance-assets.cjs`
- `desktop/src/pet-actions.cjs`
- `desktop/src/pet-registry.cjs`
- `desktop/src/policy.cjs`
- `desktop/test/fixtures/p85-focus-window.ps1`
- `desktop/test/manager.test.cjs`
- `desktop/test/p84-actions.test.cjs`
- `desktop/test/p84-e2e.cjs`
- `desktop/test/p85-e2e.cjs`
- `desktop/test/p85-eight.test.cjs`
- `desktop/test/p85-passthrough.ps1`
- `docs/P85_ASSET_INVENTORY.md`
- `docs/P85_EIGHT_ROLE_PLAN.md`
- `docs/P85_EIGHT_ROLE_RUNBOOK.md`
- `docs/P85_FINAL_REPORT.md`
- `frontend/src/features/p85/AdoptionPanel.tsx`
- `frontend/src/features/p85/AppearancePreview.tsx`
- `frontend/src/features/p85/appearances.ts`
- `frontend/src/features/p85/instances.ts`
- `frontend/src/pages/p84-catalog.tsx`
- `frontend/src/pages/p85-pets.css`
- `frontend/src/pages/p85-pets.tsx`
- `frontend/tests/p84-catalog.test.mjs`
- `frontend/tests/p85-eight.test.mjs`
- `frontend/tests/p85-instances.test.mjs`

## 未完成事项与下一阶段

1. 取得外部角色再分发/商业授权；准备无水印、无 UI 叠层的刀盾背面和鲸鱼娘侧/背；未授权前继续仅本地验证，默认安装包缺少这些本地 PNG 时明确降级。
2. 若需要肢体挥手/真正举盾/逐帧眨眼，提供合法分层或帧素材；目前有限整体变换不冒充完整动画。
3. 跟进一次早期未完整定位的安全收回，以及既有隐藏短测 CPU 偏高现象；进行无调试器隐藏长采样、2～8 小时压力、低配设备、多物理屏、其他 DPI、休眠/恢复专项，不推断未测试硬件通过。
4. 与原有 P7 测试成果负责人统一外部素材改名策略，当前保留 1 项失败；未来经授权修订引用再做全量绿色回归。
5. P8.5 新安装包、独立后端注册发行、真实模型新角色表现及真实在途上游取消/费用仍未验证。P8.1 不能标全部真实验收通过，P8.3 仍不具备公开发行条件。

复现命令与操作说明见 `docs/P85_EIGHT_ROLE_RUNBOOK.md`。可继续本地体验八角色和多实例，不公开发行、不推送、不自动关机。

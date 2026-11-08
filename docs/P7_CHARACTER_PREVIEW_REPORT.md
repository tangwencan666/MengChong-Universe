# WeiBiYe P7 第一阶段：DeepSeek 娘本地角色预览

结论：本地角色替换及当前Windows 125%原生功能验收通过，仍有明确未完成项。**不宣称已完成真实系统100%／150%验收、独立摇尾巴或商业发行授权。** 原生测试状态为PASSED_WITH_EXPLICIT_LIMITATIONS。

## 范围与素材

- Worktree：D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot，分支codex/consumer-desktop-pivot，HEAD保持83c1b0943d694a26ab728af457c5e3dc4ddccad2。
- 开始时123个未提交路径与P6最终逐文件SHA完全一致；完整保留于.verification/p7/pre-p7-source。没有覆盖未知改动，所有后续变化在本报告列明，没有提交、暂存、推送或修改main。
- 原目录C:\Users\20982\Desktop\图片库只有两张PNG：141150为完整Q版角色图，143245为带播放器UI的正面／侧面／背面参考。已实际查看；原图字节数、SHA均保持不变，没有删除、覆盖或转换原文件。
- 通过内置imagegen制作透明睁眼和闭眼派生PNG，保存在desktop/local-preview。保留蓝色渐变长发、蓝眼、女仆装、鲸鱼尾巴、头饰和蝴蝶结；没有把播放按钮／文字截图直接作为桌宠。
- 这是生成式派生，不是原图像素级无损抠图；存在重绘和细节差异。两图均1277×1231 RGBA，约48.8%完全透明，没有白底／黑底／棋盘格背景。完整提示词见[IMAGE_PROMPTS](p7/IMAGE_PROMPTS.md)，路径、版权边界和SHA见[素材来源](p7/ASSET_PROVENANCE.md)。

## 单宠替换与功能

目标仅为测试账号A的“月芽”。本地主进程要求完整的角色类型、owner_id、pet_id三参数，先通过真实Cookie和后端归属校验，再给唯一目标增加受控asset_id。没有改数据库外观字段、名字、角色类型、人格、授权或记忆。

豆包仍为dog.svg，小云仍为cloud.svg；cat.svg也原样保留。不把角色映射全局改成DeepSeek娘，另一个同类型cat或其他用户宠物不会被替换。默认不开本地预览时，新增PNG路径返回404。

已实现并实测：

- 透明待机、约4.8秒一轮的短暂眨眼、轻微呼吸、点击按下时的亮度／柔光反馈。
- 闭眼帧只叠加眼部矩形，睁眼图主体不切换；避免生成式闭眼帧的眼外纹理变化影响头发、衣服和尾巴。
- 保留桌面移动、真实鼠标拖拽、短点击聊天、右键菜单、分别隐藏／显示／收回、系统托盘和退出。
- 真实Mock SSE和PostgreSQL历史保存／刷新恢复，pet_id保持原值。DeepSeek娘仅是外观预览，不代表已接入DeepSeek模型。

**独立摇尾巴未实现。** 参考图没有可靠的独立尾巴图层；全身呼吸／移动不是尾巴骨骼或局部摇摆，不计为已完成。当前也没有逐帧走路、Live2D或新增语音能力。

## 原生与缩放结果

唯一一轮p7-e2e --phase=all：**26通过／0失败／0跳过，退出码0**。一次真实登录，Cookie仅在验收进程内存中复用；四个Electron实例正常托盘退出，没有反复重建账号或重跑整轮。

| 比例 | 实际验证范围 | 结果 |
| --- | --- | --- |
| 125% | 本机真实Windows系统缩放，未加force参数；Win32物理尺寸、renderer DPR、透明显示、动画、真实鼠标与聊天 | 通过 |
| 100% | Electron独立进程force-device-scale-factor=1，真实窗口和屏幕捕获 | 进程倍率检查通过；真实系统100%未验 |
| 150% | Electron独立进程force-device-scale-factor=1.5，真实窗口和屏幕捕获 | 进程倍率检查通过；真实系统150%未验 |

没有切换Windows全局显示设置，以免影响其他窗口、项目和任务。现有thickFrame:false、188×196DIP固定窗口、显式setBounds及±1DIP舍入保护均保留。动画与反馈通过实际computed style／opacity／transform变化及isTrusted鼠标动作检查，不只根据class名判定。

原始结果：.verification/p7/native-82278f73-dab3-4e67-8171-1e7f57a9da5a/results.json，SHA-256为9d150625afb2098ba7a01277aae1422f198b6b6c2885b0bbf6b97d8531a39cec。analysis-summary.json保留缩放边界和所有每进程原始性能样本。

## 性能对比

顺序测量，主窗口可见、无聊天子窗口、相同暖机和调试方式；每组11个样本、超过10秒。baseline是同轮当前代码关闭角色预览、使用原SVG，不是回退旧P6二进制。数值为Electron进程树CPU百分比与聚合工作集均值。

| 场景 | 同轮原SVG CPU／MiB | DeepSeek预览 CPU／MiB |
| --- | ---: | ---: |
| 单宠待机 | 1.2165%／521.74 | 0.7572%／519.11 |
| 单宠移动 | 1.6099%／522.28 | 2.1531%／528.43 |
| 三宠待机 | 2.1716%／733.45 | 3.1251%／746.71 |
| 三宠移动 | 3.2371%／732.34 | 3.1826%／750.26 |

P6历史三宠待机为2.3203%／747.44MiB、移动3.3540%／752.11MiB；P6没有单宠基线，不能拿三宠直接推断单宠增减。历史来源和SHA随本次结果记录。

工作集可能重复计算共享页，PrivateBytes是私有提交量而非物理驻留量；不含外部FastAPI／数据库，也不是整机利用率。三宠预览对同轮SVG的工作集多约13.3／17.9MiB，待机CPU本次更高；单次短测存在采样、缓存及进程差异，不能宣称性能改善或长期无泄漏。当前整体内存成本仍较高，后续需纹理尺寸／动画与长时间测量优化。

## 自动化与实际运行截图

| 检查 | 本轮结果 |
| --- | --- |
| Desktop Node全量（含P6原有回归） | 最终85通过／0失败／0跳过 |
| PNG只读QA子集 | 3通过；CRC、RGBA、alpha、可见留白、帧尺寸／眼区变化和原图hash |
| TypeScript、ESLint、前端构建 | 均退出0；保留约501.5kB chunk体积提示 |
| 前端单元 | 39通过／0失败／0跳过 |
| P7新增Python启动器Ruff | 通过 |
| Windows真实原生与API | 26通过／0失败／0跳过，限于上述明确范围 |

首次Node运行83通过／2失败，发生于素材QA仍在分析raw alpha判据时。检测到睁眼图边框35个alpha=1/255噪点；最终保留原始数据和图片，采用可见alpha≥8/255包围盒、边框最大alpha≤1、可见留白等明确判据。未允许可见裁切、未删测试或改图片。原始unit-first.log和最终unit-final.log都保留。

本轮未修改后端业务／迁移，未重跑20分钟的全量pytest；不把P6历史598项当作P7新结果。真实联调在现有专用隔离0006库完成一条可识别P7用户消息和一条Mock回复，相关认证／会话／生成／事件／绑定记录正常追加，宠物与长期记忆数据hash不变。

以下均为Windows CopyFromScreen实际捕获，非HTML合成或生成图片；已逐一实际查看：

- [125%真实系统：一只DeepSeek娘＋两只原宠物](../.verification/p7/native-82278f73-dab3-4e67-8171-1e7f57a9da5a/deepseek-unforced-current-Windows.png)
- [真实Mock聊天与三宠](../.verification/p7/native-82278f73-dab3-4e67-8171-1e7f57a9da5a/deepseek-mock-chat-real-Windows.png)
- [100%进程倍率](../.verification/p7/native-82278f73-dab3-4e67-8171-1e7f57a9da5a/deepseek-process-only-1.png)
- [150%进程倍率](../.verification/p7/native-82278f73-dab3-4e67-8171-1e7f57a9da5a/deepseek-process-only-1.5.png)

## 数据、授权与安全收尾

原图库两文件及原cat／dog／cloud SVG的SHA不变。123文件接续快照完整，仅明确的10个原路径作预期修改；其余原有源码和P6报告保持原hash。Git refs、Worktree登记HEAD、当前分支／HEAD与开始时一致，暂存区为空，未在其他Worktree执行写操作。

共享weibiye开发库仍0005／26表，结构、数量和数据hash均与开始时及P6基线相同。专用测试库仍0006／34表，没有迁移、删表、删数据或改授权；pets与所有宠物记忆表hash不变，生成任务均已终态。P7使用单独Redis键前缀及P7证据目录，没有清理旧键或追加P6日志。本轮没有执行Docker命令、操作其他项目、公开部署或调用真实聊天模型。

四个客户端实例正常退出，专用API以中断停止；Windows工具会话返回1，不作为业务测试失败，也不声称后端优雅退出钩子已验。最终核对35316／38316无监听、本任务API与Electron进程无遗留。保留图片、报告、隔离测试数据及原始失败日志，没有执行关机。

原作者、图片、角色和商标授权仍未确认。派生PNG放在被忽略且不进入默认打包的local-preview目录，只允许显式参数本地加载。没有生成P7可分发安装包或宣称官方合作；旧P6包保持不变。完整版权边界见素材来源文档。

## 启动与剩余事项

按[本地启动说明](p7/START_LOCAL_PREVIEW.md)先运行现有P7隔离API，再带唯一owner＋pet参数启动Electron。素材及原图路径、两次完整imagegen提示词均在上述文档中记录。

下一步优先确认素材权利并取得透明／分层源文件，再制作可靠尾巴动画与更完整眨眼。安排不影响其他任务的真实系统100%／150%测试；随后做更长的性能／睡眠唤醒／多屏回归。正式安装器、签名、真实GPT／DeepSeek接入和共享库0006升级均不在本轮完成范围。

本轮逐文件修改清单及源hash随报告保存在.verification/p7/changed-files.json与delivered-source-sha256.json。未确认的系统缩放和尾巴能力不计作通过。

## 本轮实际修改文件清单

相对于P6结束的123路径快照，修改以下10个原文件：

- .gitignore
- desktop/renderer/pet.css
- desktop/renderer/pet.html
- desktop/renderer/pet.js
- desktop/src/gateway.cjs
- desktop/src/main.cjs
- desktop/src/manager.cjs
- desktop/test/gateway.test.cjs
- desktop/test/manager.test.cjs
- desktop/test/renderer.test.cjs

新增源文件／文档：

- backend/scripts/p7_character_server.py
- desktop/src/local-character.cjs
- desktop/test/local-character.test.cjs
- desktop/test/p7-assets.test.cjs
- desktop/test/p7-e2e.cjs
- desktop/test/png-inspection.cjs
- docs/P7_CHARACTER_PREVIEW_REPORT.md
- docs/p7/ASSET_PROVENANCE.md
- docs/p7/IMAGE_PROMPTS.md
- docs/p7/START_LOCAL_PREVIEW.md

本地专用派生素材（被Git忽略）：

- desktop/local-preview/deepseek-blink.png
- desktop/local-preview/deepseek-open.png

当前Git未提交路径共133个，包含原有123项；暂存区为空、无新提交。完成时间（UTC）：2026-11-02T07:07:37.368109+00:00。

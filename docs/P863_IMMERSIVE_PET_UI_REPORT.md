# 萌宠溜达 P8.6.3：桌面直选与宠物聊天报告

状态：`P863_LOCAL_IMMERSIVE_UI_OFFLINE_VERIFIED`。本轮本地 UI 与离线 Mock 路径通过；真实模型的共同事件注入未启用，不代表新增真实 DeepSeek 验收通过。结构化共同事件查询不是语义 RAG。

## 交付与使用

- “我的宠物”直接展示所有已加载的活跃领养实例。点击卡片按 UUID 召唤，再点收回，不跳转、不打开管理弹窗；超过一页可继续加载。名字、图片和实例标记来自实际数据。
- 蓝框与勾选来自 Electron 已确认状态，不做假成功的乐观勾选。五只上限只计算显示中的实例；隐藏缓存窗口不占名额。满额提示、失败后同步、一键收回及恢复组合保留。
- 同名同品种可以重复领养，独立选择。资料、重命名、人格、记忆及删除说明保留在折叠区域；四个显眼社会管理入口移到“设置 → 宠物互动、事件与隐私”，底层功能与数据均保留。
- 宠物实际情绪驱动低优先级姿态：开心轻跳、好奇观察、生气轻抖、委屈/难过低头、害羞侧移、困倦低伏、平静待机。采用有限 CSS 变换；不改五官、不伪造逐帧素材，不覆盖拖动、AI 思考/说话、隐藏或活跃动作。
- 打开某只宠物的聊天后，可点“最近和伙伴怎么样？”听一条真实桌面经历。用户不点不会主动刷屏，不占用输入框、不阻止其他话题、不写入 AI 聊天或长期记忆。无事件时明确说明没有共同经历。
- 聊天小记与欢迎/历史内容采用纵向布局；宽窄窗口的卡片、按钮与聊天区已检查实际截图。保持蓝白主题和原有八角色素材。

## 事件与隐私边界

P8.6 的权威共同事件目前在 Electron 本机社会引擎中。聊天后端没有可独立核验的服务端事件源，因此本轮采用两层路径：

1. **实际可用的本地小记**：主进程通过受限 IPC 核验发起窗口、当前用户、宠物实例、可选会话及最新人格快照。只读取该实例参与、最近七天、已经结束且可见范围为参与者的事件；最多输出三条结构化事实，一次明确请求只分享一件事。伙伴名称逐一经当前账号后端权限核验。拒绝未结束、未来、过期、未知或中断事件。不接收渲染层提交的事件正文。用户参与仅按实际记录陈述。
2. **后端离线 Mock 组装原型**：`app/agent/p863_context.py` 组装当前身份/人格版本、当前会话历史、授权记忆与受信事件源；历史最多十二条/8000 字符、授权记忆最多三条各500字符、共同事件最多一条，带隐私版本复核。非 Mock provider 一律拒绝。该模块未挂载公开 HTTP，也未接入生产 ChatRunner/DeepSeek；没有新增数据库迁移。

本地分享标记按 owner + pet instance + event ID 保存，重命名不重置；每只宠物45秒间隔，近七天最多512条标记，只存 ID 和时间，不存正文。事件失效通知仅含当前实例的事件 ID 与实际心情，更新时不启动 API 轮询。删除事件后后续组装不再读取它；私聊、长期记忆仍由原服务端权限和授权机制管理。不会读取其他宠物的私人聊天来组织小记。

## 自动化结果

| 检查 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| React 前端单元 | 66 | 0 | 0 |
| Electron 桌面单元 | 233 | 0 | 0 |
| 后端相关回归（含本轮24个上下文用例） | 89 | 0 | 0 |
| 从历史成果中分离的提交候选 manager/policy 回归 | 76 | 0 | 0 |
| 最终 Windows/Electron 实机验收 | 11 | 0 | 0 |

TypeScript、ESLint（零警告）、前端构建及 Electron UI 复制通过。提交候选前端文件在现有工作树依赖上另做 TypeScript 检查，诊断数为0。Ruff 检查与格式检查通过（新增后端模块、测试和隔离快照脚本），相关 JavaScript 语法检查通过。Vite 保留超过500kB的单包体积提示，本轮未作无关拆包或性能改善宣称。

后端回归覆盖同品种实例聊天/长期记忆隔离、跨用户访问、人格快照、SSE 重放和终结事件、取消后无迟到写入、授权撤销与记忆删除竞态。全部使用固定 Mock 或临时数据库。

## Windows/Electron 实测

最终证据：`.verification/p86/p863-immersive-4d2d09f9-9429-440c-b7d8-28e631ee8010`；原始结果为 `results.json`，含运行文件哈希、PID、进程身份、窗口尺寸、实际 OS 缩放和截图。真实 Windows 11/Electron 45.2.1，不是浏览器模拟截图。实际 OS scaleFactor 为 1.25，另测125%/150%应用缩放；应用缩放不等于切换操作系统 DPI。

| 序号 | 实测场景 | 结果 |
| --- | --- | --- |
| 1 | eight adopted, zero visible: seventh Daodun and eighth Whale selected directly with no navigation or modal | 通过 |
| 2 | click toggles recall, fifth cap is a lightweight notice and a recalled slot is reusable | 通过 |
| 3 | a hidden cached window does not reserve a visible slot; a controlled summon failure leaves UI unselected | 通过 |
| 4 | selection and restart preserve every existing pet, chat and memory row byte-for-byte | 通过 |
| 5 | main management entries are absent while private settings retain full social and memory controls | 通过 |
| 6 | live Windows blue layout, narrow windows and application scaling retain readable nonoverlapping cards | 通过 |
| 7 | actual local shared event yields an explicitly local story only for participating pet instances | 通过 |
| 8 | completed conflict drives actual mood and idle posture, with no invented theft or user intervention | 通过 |
| 9 | same event is not repeated after reopening a chat or restarting; ordinary Mock SSE chat persists normally | 通过 |
| 10 | same-species same-name siblings remain independent and arbitrary late instances are clickable | 通过 |
| 11 | cross-account context and pet access are denied; no prior owner story or desktop survives login switch | 通过 |

第7/8只按新测试库的领养种子顺序定位刀盾和鲸鱼娘，界面仍遵循原有接口排序；测试点击绑定 UUID 的真实卡片，不重排或删除宠物。另经实际界面重复领养两只同名哈吉米，以相反顺序召唤并只收回其中一只。所有测试均在新建 SQLite/Profile 内。

正常聊天用本地固定 Mock 接收真实 SSE 流，并验证持久化与刷新恢复；不代表真实模型回复验证。共同事件由实际 P8.6 引擎产生，受控触发器仅供主进程验收，未暴露为用户默认行为。聊天截图明确标注本地事件/Mock。

截图：

- [Windows 原生窗口捕获](D:/AIProjects/WeiBiYe-worktrees/consumer-desktop-pivot/.verification/p86/p863-immersive-4d2d09f9-9429-440c-b7d8-28e631ee8010/windows-native-main.png)（核验本轮 PID/HWND 后 PrintWindow，仅本应用窗口）。
- [桌面直选](D:/AIProjects/WeiBiYe-worktrees/consumer-desktop-pivot/.verification/p86/p863-immersive-4d2d09f9-9429-440c-b7d8-28e631ee8010/windows-main-wide.png)、[窄窗口](D:/AIProjects/WeiBiYe-worktrees/consumer-desktop-pivot/.verification/p86/p863-immersive-4d2d09f9-9429-440c-b7d8-28e631ee8010/width-420.png)。
- [真实共同事件小记](D:/AIProjects/WeiBiYe-worktrees/consumer-desktop-pivot/.verification/p86/p863-immersive-4d2d09f9-9429-440c-b7d8-28e631ee8010/local-shared-event-chat.png)、[真实冲突与聊天布局](D:/AIProjects/WeiBiYe-worktrees/consumer-desktop-pivot/.verification/p86/p863-immersive-4d2d09f9-9429-440c-b7d8-28e631ee8010/actual-conflict-recount.png)。
- [实际委屈宠物](D:/AIProjects/WeiBiYe-worktrees/consumer-desktop-pivot/.verification/p86/p863-immersive-4d2d09f9-9429-440c-b7d8-28e631ee8010/actual-upset-pet.png)、[同品种独立选择](D:/AIProjects/WeiBiYe-worktrees/consumer-desktop-pivot/.verification/p86/p863-immersive-4d2d09f9-9429-440c-b7d8-28e631ee8010/same-species-independent-selection.png)。

## 中间失败与修复记录

全部中间证据保留，不用后一次成功覆盖前一次失败。

- 设置页测试最初用了不匹配嵌套说明的精确文本选择器；实际截图中功能存在，改为检查真实区域和说明，未放宽业务断言。
- 新情绪脚本首次被原有宠物资源白名单拦截。仅增加该随应用提供的具体文件，并新增 HTML 脚本资源、浏览器导出及外域/API拒绝回归。
- 一次退出出现 Electron 原生 `0xC000041D` / Windows应用错误。证据保留在 `p863-immersive-04bb7e32-d383-4f25-8b39-a24969428d89` 及归档日志。测试原先关闭页面后立即重启；现改用项目已有 `closeWindowAndWait` 等待真正 `closed`，未使用强制销毁或把非零退出码当成功。此后完整复测正常退出，最终端口释放。**没有定位该原生异常的底层原因，不能宣称永久修复；仍作为后续稳定性观察项。**
- 另一次测试启动目录有误，已通过本轮专属停止文件正常停止，未终止其他应用。
- 截图复核发现聊天小记与欢迎区横排挤压，改为上下布局，并增加上下位置、宽度与溢出断言。最终截图重新复核。

## 数据、工作区与清理

- 基线分支 `codex/consumer-desktop-pivot`，基线提交 `0e5ae016145f8271f54b569181278ebd0799a896`。实际历史未提交路径191处。
- 对641份原有源文件建立原始字节与哈希基线；628份未触及。对四个重叠文件按三方差异分离，仅提交本轮增量，原有差异逐行计数核对保留。未提交原来的P6/P8聊天、服务配置等成果。
- 18032份历史验收文件 SHA256 全部一致。已在运行的旧演示目录按基线排除动态文件，本轮没有操作该演示的数据/进程。
- PostgreSQL 集群 `7703042374370492450`；共享库版本0005/26表，旧独立库0006/34表，前后只读快照一致，无迁移或写入共享库。无Docker容器/卷操作。
- 真实模型请求0，无部署、发布、推送、关机，无原始宠物素材修改。
- 本轮所有验收与诊断的进程身份和随机端口逐项检查，无本轮残留。旧演示 PID8644/19636/12636及60130/60131端口按原状态保留，不能把它们误当测试残留终止。

## 修改文件与本地提交

代码提交：`8ad1ea98011e781f9dbbbdcd9e956aa6f3f6d089`，29个相关文件；报告另作本地文档提交。最终两项哈希保存在新证据目录 `git-commits.json`，没有推送。

- `backend/app/agent/p863_context.py`
- `backend/tests/test_p863_context.py`
- `desktop/renderer/pet-actions.css`
- `desktop/renderer/pet-mood.js`
- `desktop/renderer/pet.html`
- `desktop/renderer/pet.js`
- `desktop/src/manager.cjs`
- `desktop/src/p863-context.cjs`
- `desktop/src/p863-recount-store.cjs`
- `desktop/src/policy.cjs`
- `desktop/src/preload.cjs`
- `desktop/test/fixtures/p863-capture.ps1`
- `desktop/test/fixtures/p863_snapshot.py`
- `desktop/test/manager.test.cjs`
- `desktop/test/p863-context.test.cjs`
- `desktop/test/p863-immersive-e2e.cjs`
- `docs/P863_IMMERSIVE_PET_UI_REPORT.md`
- `frontend/src/features/desktop/bridge.ts`
- `frontend/src/features/p86/SocietyPanel.tsx`
- `frontend/src/features/p862/navigation.ts`
- `frontend/src/features/p863/CompanionRecount.tsx`
- `frontend/src/features/p863/DesktopChooser.tsx`
- `frontend/src/features/p863/PetSocialSettings.tsx`
- `frontend/src/features/p863/context.ts`
- `frontend/src/features/p863/immersive.css`
- `frontend/src/features/p863/selection.ts`
- `frontend/src/pages/companion.tsx`
- `frontend/src/pages/p85-pets.tsx`
- `frontend/src/pages/workspace.tsx`
- `frontend/tests/p863-immersive.test.mjs`

注意：本仓库仍有191处历史成果未提交，完整项目验证基于现有工作树；本轮不声称从干净克隆即可重建全部此前阶段。

## 未验证与下一步

- 未调用真实 DeepSeek，本轮未新增真实模型验收；现有真实上游在途取消仍保持原先未验证状态。
- 共同事件未注入真实模型，后端仅离线 Mock 原型。后续应先建立服务端可信事件源、参与者权限及删除/撤销版本栅栏，再另行授权有限真实模型验收。
- 没有语义向量检索/RAG；没有把本地小记自动写入私聊记忆。
- 未新增30分钟性能长测、其他物理屏幕/OS DPI/低配置设备测试；本轮没有增加动画轮询、模型后台对聊或额外常驻窗口，性能变化不作推断。
- 继续观察上述Electron原生退出异常，建议后续专门做重复聊天开关、休眠恢复与退出稳定性测试。

完整离线日志、快照、哈希、提交差异和清理核对归档：`.verification/p86/p863-review-d76505ca-0007-48ec-a169-fede55e10e38`。

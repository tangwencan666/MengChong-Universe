# AI 聊天首页：最近话题与情感化体验验收

日期：2026-11-01（Asia/Shanghai）。本轮只修改前端。没有提交、推送、部署或执行 Docker 管理命令。

## 首页文案

- 主标题保持：**今天还顺利吗？**
- 副标题保持：**不管发生了什么，都可以和我聊聊。**
- 输入框占位文案改为：**愿意和我聊聊吗？**
- 保留原有米白、柔绿、深灰布局和底部输入框；授权后增加轻量卡片，不自动弹窗询问。

## 修改的文件清单

原有前端源码和配置均先备份，保留在本目录 `recent-topics-before/`。以下为 10 个修改文件和 6 个新增文件，不包括构建、日志、截图等生成产物。

| 文件 | 类型 | 作用 |
| --- | --- | --- |
| [src/App.tsx](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/App.tsx) | 修改 | 增加话题续聊设置路由 |
| [src/chat.css](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/chat.css) | 修改 | 轻量卡片、设置页、删除按钮和小屏样式 |
| [src/components/layout.tsx](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/components/layout.tsx) | 修改 | 空历史、删除本页会话、设置入口和演示访客标记 |
| [src/pages/companion.tsx](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/pages/companion.tsx) | 修改 | 新占位文案、授权卡片和设置链接；空白欢迎页不自动滚到底部 |
| [src/features/chat/types.ts](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/features/chat/types.ts) | 修改 | 最近话题、来源追溯、时间和访客作用域类型 |
| [src/features/chat/ChatProvider.tsx](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/features/chat/ChatProvider.tsx) | 修改 | 默认关闭、授权/关闭、隐藏、删除、隔离及取消迟到回复 |
| [src/data/chat-demo.ts](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/data/chat-demo.ts) | 修改 | 显式加载的虚构会话、演示时间与可追溯摘要 |
| [eslint.config.js](D:/AIProjects/AgentForge-AI/weibiye/frontend/eslint.config.js) | 修改 | 排除备份和测试产物，避免重复检查生成文件 |
| [e2e/chat-layout.spec.ts](D:/AIProjects/AgentForge-AI/weibiye/frontend/e2e/chat-layout.spec.ts) | 修改 | 用显式 UI 加载样例；等待新会话路由完成后输入 |
| [e2e/foundation.spec.ts](D:/AIProjects/AgentForge-AI/weibiye/frontend/e2e/foundation.spec.ts) | 修改 | 覆盖新文案、设置路由和首次空历史截图 |
| [src/features/chat/contracts.ts](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/features/chat/contracts.ts) | 新增 | 最近话题/会话存取与独立长期记忆接口契约，无真实实现 |
| [src/features/chat/recent-topics.ts](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/features/chat/recent-topics.ts) | 新增 | 真实存在的会话与消息来源校验、最近话题选择 |
| [src/features/chat/RecentTopicCard.tsx](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/features/chat/RecentTopicCard.tsx) | 新增 | 时间、摘要、延续问候与继续/隐藏操作 |
| [src/pages/conversation-preferences.tsx](D:/AIProjects/AgentForge-AI/weibiye/frontend/src/pages/conversation-preferences.tsx) | 新增 | 非弹窗授权、Mock 样例和访客 A/B 演示工具 |
| [e2e/helpers/preview.ts](D:/AIProjects/AgentForge-AI/weibiye/frontend/e2e/helpers/preview.ts) | 新增 | 通过实际 UI 操作准备演示历史，不偷偷植入身份或缓存 |
| [e2e/recent-topics.spec.ts](D:/AIProjects/AgentForge-AI/weibiye/frontend/e2e/recent-topics.spec.ts) | 新增 | 18 项新体验与隐私边界测试 |

机器可读清单：`recent-topics-changes.json`。删除文件数量为 **0**。

## 卡片与隐私行为

首次访问没有自动加载的历史，推荐默认关闭。可在首页的“话题续聊设置”或头像菜单进入设置页；没有强制弹窗。

- 勾选授权后，才会为当前作用域仍存在的会话生成前端话题视图。没有会话时仍不显示卡片。
- 卡片展示最后聊天时间、短摘要和“接着上次的话题聊聊？”，同时标注 Mock 或本页消息摘录。
- 虚构历史使用人工编写、对应特定原始消息的样例摘要。新输入使用最近用户消息的原文摘录，规范空白并限制长度；不进行模型摘要或情绪推断。
- “继续聊聊”只导航到对应 `conversationId` 的原会话，不创建会话、不添加消息、不发送模型请求。
- “暂时不看”标记当前话题 dismissed，本页不再推荐，也不会马上替换成更早话题。原会话仍可从侧栏打开。
- 关闭推荐立即隐藏卡片，后续新对话也不会重新开启；关闭不会删除历史。
- 删除仅移除当前页内存中的会话及摘要，并记录删除标记，防止样例静默重新加入。删除最新会话后，可以推荐仍存在的更早会话；没有历史时不显示卡片。
- 演示访客 A/B 切换会取消生成并清空前一作用域的会话、摘要和授权，回到默认关闭状态。旧会话路由不可读取；迟到的回复不会写入新作用域。
- 刷新后清空记录和授权，不自动加载样例，不使用 localStorage/sessionStorage，不宣称跨天恢复或授权持久化成功。

`RecentConversationSummary` 包含 conversationId、title、summary、lastMessageAt、followUpText、dismissed，并补充 ownerScopeId、source、sourceMessageIds。显示前确认原会话存在、作用域匹配、时间版本一致且来源消息仍存在。

长期记忆采用单独的 `AuthorizedLongTermMemory` 和 `LongTermMemoryPort` 契约，授权目的与最近话题分开。接口没有 HTTP、数据库、摘要或检索实现，也没有调用长期记忆授权接口。

## 真实边界与尚未实现的功能

本轮支持的是前端内存预览。演示访客不是登录身份，前端分区不是生产鉴权机制。没有使用其他真实用户的聊天，也没有读取真实账户历史。

仍未实现：真实登录、服务端用户归属校验、持久化会话、第二天自动恢复、推荐偏好/隐藏/删除的服务端保存、真实摘要生成，以及长期记忆授权、保存、撤销、检索和删除。真实接入时，服务端必须从认证主体确定 owner，不能信任演示访客选择器或客户端传入的用户 ID。

后端、数据库、Docker、钱包/计费、真实模型配置及原项目相关文件共 **82 个受保护文件**的 SHA-256 校验值与执行前一致。钱包页面、API 和 SSE 适配器也纳入保护。没有删除或修改这些文件。

## 实际验证结果

| 检查 | 最终结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过，0 warnings |
| `npm run build` | 通过，Vite 7.3.7；JS 410.85 kB、CSS 45.09 kB |
| `npm run test:e2e -- --reporter=dot` | **33 passed in 55.4s**，15 项原有覆盖 + 18 项新增覆盖 |
| 桌面布局 | 1440×1050；另检查 1280×720 欢迎语可见与输入框位置 |
| 移动布局 | 390×844，卡片不覆盖输入框，抽屉可继续与删除会话 |
| 小屏/键盘 | 320×640；模拟 VisualViewport 缩至 390px 后输入框仍可用 |
| 保护范围与删除检查 | 82 个受保护文件未变化，源码文件删除数量 0 |

重点覆盖：首次无历史、无授权、授权但无历史、显示最近话题、继续原会话且不重复、暂时隐藏、全局关闭后新对话不再推荐、删除与防止重载、较早会话切换、访客 A/B 隔离、真实本页文本清理、迟到回复隔离、刷新重置、手机交互及短桌面布局。

浏览器使用本机已有 Edge 的独立测试上下文。测试服务仅使用独立回环端口 25174/28101，复用现有 Mock API 测试进程；不连接项目 PostgreSQL/Redis、不调用真实模型。测试结束后自有进程已回收；原先 15174 的进程未停止或替换。

原有测试没有删除。为适应默认无历史，样例通过实际 UI 显式加载；会话数量限定到可见导航，避免将隐藏移动抽屉重复计数。浏览器测试的导航等待已明确处理。最终 33 项无跳过、无失败。

移动端是桌面浏览器的尺寸与 VisualViewport 模拟验收，尚未完成实体手机和系统软键盘实测。没有运行真实多用户服务端安全验收或跨天持久化验收。

## 截图与证据

- 桌面授权卡片：[recent-topic-card-desktop.png](D:/AIProjects/AgentForge-AI/weibiye/frontend/.verification/recent-topic-card-desktop.png)
- 手机授权卡片：[recent-topic-card-mobile.png](D:/AIProjects/AgentForge-AI/weibiye/frontend/.verification/recent-topic-card-mobile.png)
- 桌面首次无历史：[recent-topic-empty-desktop.png](D:/AIProjects/AgentForge-AI/weibiye/frontend/.verification/recent-topic-empty-desktop.png)
- 手机首次无历史：[recent-topic-empty-mobile.png](D:/AIProjects/AgentForge-AI/weibiye/frontend/.verification/recent-topic-empty-mobile.png)
- 小屏键盘模拟：[recent-topic-small-keyboard.png](D:/AIProjects/AgentForge-AI/weibiye/frontend/.verification/recent-topic-small-keyboard.png)
- 最终浏览器日志：`recent-topics-browser-check.log`
- 执行前保护校验：`recent-topics-protected-baseline.json`
- 文件变更清单：`recent-topics-changes.json`

## 下一阶段建议

先建立真实认证、归属过滤的会话接口和可撤销的推荐授权，再接入跨天持久化。服务端摘要应保留来源消息与版本，删除会话或撤销授权后使缓存及推荐失效。长期记忆保持独立授权与生命周期，在用户另行确认后再开发。

本轮工作结束，暂停等待确认。

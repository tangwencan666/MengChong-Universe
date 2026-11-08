# P8.2 修改归属与提交边界

本轮开始时 HEAD 为 `83c1b09`，desktop 整个目录和前端 desktop 桥接目录尚未被 Git 跟踪，后端及其他前端功能也有大量既有未提交成果。不能把首次纳入 Git 的文件全部算作 P8.2 新开发。

## 本轮实际修改的既有文件

- `desktop/src/main.cjs`：接入本地位置存储。
- `desktop/src/manager.cjs`：已认证位置恢复、多屏事件处理、四状态展示、问候、受限活动 IPC 和退出保存。
- `desktop/src/motion.cjs`：多屏 DIP 几何及默认安静停留；保留原运动能力。
- `desktop/src/preload.cjs`：新增仅接收活动元数据的窄接口。
- `desktop/renderer/pet.js`、`pet.css`：四状态文字和动画，本地问候气泡。
- `desktop/test/manager.test.cjs`、`renderer.test.cjs`：增加作用域、保存、终态与展示回归。
- `desktop/test/native-interaction.ps1`：可选有界命中等待；仍只向已验证属于本次 Electron 的窗口发送输入，遮挡时拒绝点击。
- `frontend/src/features/desktop/bridge.ts`：新增活动元数据类型与可选接口。
- `frontend/src/features/chat/ChatProvider.tsx`：在原聊天上下文中挂载独立展示订阅器；提交只包含本轮两处展示接入，不纳入此前的 petId 改动。

## 本轮新增

- `desktop/src/display-layout.cjs`、`position-store.cjs`、`pet-activity.cjs`。
- `desktop/test/p82-foundation.test.cjs`、`p82-e2e.cjs`、`p82-focus-observe.ps1`、`fixtures/p82_server.py`。
- `frontend/src/features/desktop/DesktopChatActivity.tsx`、`activity.ts`、`frontend/tests/desktop-activity.test.mjs`。
- P8.1 阶段归档、P8.2 方案、修改清单和验收文档。

## 首次纳入 Git 的既有依赖

为让新宿主和测试可审查，桌面 package/lock、src/renderer 的运行依赖、原有 SVG/托盘资源及声明、启动/复制 UI/打包脚本、被新测试复用的单元测试、performance/capture 工具一并首次跟踪。它们大部分字节来自本轮之前的 P6/P7/P8 基线，不声称由 P8.2 新增。

不纳入 node_modules、ui-dist、out、.runtime、local-preview、密钥、账号配置、SQLite 文件或任何历史验收证据。P7 本地未授权形象不纳入发布资源。

不提交无关后端、其他前端与旧文档改动。保留的 P6/P8/P8.1 未提交功能仍是当前工作树运行基线的一部分；本轮阶段提交不表示已经将全部历史成果整理成干净、可独立发布的分支。

## 保护核对

本轮实际改动 11 个既有文件，其余 442 个起点源码文件哈希不变。后端源码、`PrivateChatProvider.tsx`、模型/取消业务状态机没有改动。440 个 P8.1 原始证据文件全部保持原哈希。数据保护与实际运行结果见 P82_VERIFICATION.md。

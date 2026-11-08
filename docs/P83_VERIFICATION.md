# P8.3 受控内测发行准备验收

状态：**P83_LOCAL_PREPARATION_VERIFIED_RELEASE_BLOCKED**。

已完成可在本机安全验证的安装生命周期、HTTPS 客户端接入、服务端免费额度硬限制、最小统计与反馈准备；**尚不具备让 10～30 人在各自电脑独立内测的条件**。本轮真实模型请求 0，没有公开部署、发布安装包、GitHub 推送、支付、共享库迁移或数据卷删除。

完整汇总：[summary-final.json](../.verification/p83/review-694eafb32ab24d05a288edbc5cf76a66/summary-final.json)。原始失败尝试与历史证据全部保留；P8.1 真实在途取消、上游中断和取消费用仍未验证。

## 修改内容

- 后端：独立额度/统计迁移 q0001/q0002，邀请码一次性领取，账号终身/每日/并发限制，全局 UTC 日请求和保守预算上界，派发前复核、终态结算、幂等审计。生产真实调用必须启用额度保护；生产内测必须显式提供真实邮件实现。
- 桌面：打包固定 HTTPS 服务来源、保留 TLS 验证、hosted 模式关闭本机 API 代理；本地帮助不需登录且禁止脚本/网络/IPC；恢复事件去抖，重新验证各宠物权限及窗口范围；反馈导出限于已授权主窗口和 16KiB JSON。
- 前端：内测额度领取/查询、明确统计告知与关闭删除、最小本地反馈单；仅经同意的可信前台交互记录活跃；Mock/真实互动分开。注册说明根据后端能力显示，不再固定宣称 Mock 邮件。

逐文件见 [P83_CHANGE_MANIFEST.md](P83_CHANGE_MANIFEST.md)。已检查相对本轮开始时的副本，仅 18 个原文件受到局部补丁；其他既有未提交源文件保持原样，没有恢复或覆盖旧成果。

## 测试结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 原有 P8.1/DeepSeek SDK/聊天/宠物/记忆相关后端回归 | 159 通过，严格 warning 策略保留 | 汇总目录 backend-regression-2.xml |
| 新增额度、隐私、目标保护、SDK Mock 和 PostgreSQL 竞态 | 40 通过，分组运行 32 + 3 + 5 个不重复用例 | beta-final.xml、production-guards-2.xml、target-guards.xml |
| 可复用专用 PostgreSQL 准备/多进程 smoke/身份核验停止 | 1 通过；两个本轮专用容器均已停止并保留数据 | fixture-tool-smoke.xml、fixture-tool-stop.log、postgres-stop.json |
| 桌面单元 | 143 通过 | desktop-final.log |
| 前端单元 | 47 通过 | frontend-release.log |
| 前端类型、ESLint、构建 | 通过；仍有约 510.8kB bundle 的既有大小提示，未放宽阈值 | frontend-release.log |
| Ruff 与格式 | 26 个本轮相关 Python 文件通过 | ruff-release.log |
| 本地 TLS + 实际 Electron/React/API/SSE | 9 组通过，含同意后真实 Mock 完成统计及退出删除 | [HTTPS results](../.verification/p83/https-383200fd-7833-46d1-a0d7-b202d96c7543/results.json) |
| NSIS 专用验证身份安装/启动/升级/正常卸载 | 4 组通过 | [安装 results](../.verification/p83/install-28bf77c1-8206-4b30-808d-be0f763fcb82/results.json) |
| 当前源码 Windows/Electron 物理交互回归 | 10 组通过 | [源码 results](../.verification/p82/desktop-8546d5a0-2a19-469d-a835-797efa27d250/results.json) |
| 最终打包程序 Windows/Electron 和本地诊断回归 | 11 组通过 | [打包 results](../.verification/p82/desktop-fdb03426-f17c-4b95-b692-7c18d924057f/results.json) |
| 安装包内容、图标、资源哈希与发行策略 | 通过；不含后端、测试证书/私钥、环境文件、数据库、profile 或测试工具 | [包检查](../.verification/p82-phase2/package-review-6079b860-b620-42ec-b7a7-0d03423812a2/inspection.json) |

PostgreSQL 测试在真实独立进程中执行。100 个合成账号、8 个进程争抢保守预算：准入 5、拒绝 95，预算保留 500（上限 550，单次 100，单位为合成微美元），没有超支。另覆盖同账号并发、同邀请码竞争、同请求重复派发/重启、失败/取消不退未知费用和跨日拒绝。这不等于真实 100 人容量测试或真实供应商账单验证。

首轮旧回归出现一次 SQLite 连接回收 ResourceWarning；开启分配追踪重验后 159 项通过，未降低 warning 策略，也未据此修改正常产品逻辑。新 SDK Mock 集成起初被“非测试环境必须 PostgreSQL”的新保护拒绝，已改为真实专用 PostgreSQL 夹具，没有绕过保护。HTTPS 夹具曾因 Windows `.js` 文件关联返回 text/plain 导致空白，修正仅发生在测试静态文件服务。安装验证工具的 PowerShell 模块路径、中文编码及登录后的页面断言已修正，所有失败证据保留。

## 安装与卸载

真实安装使用单独 appId/GUID、中文带空格目录、独立 profile 和 WeiBiYeP83.exe。先退出应用再覆盖 0.1.0→0.1.1，实际安装程序和应用正常退出，版本读取正确，升级保留外部 profile 标记。正常卸载移除程序、卸载器和注册项，同时保留 profile；没有用手工删除目录制造清理成功。测试不替换正式应用、不创建快捷方式、不自动提权。

当前包未签名；本地文件不是经过互联网来源标记的下载样本，**没有验证真实 SmartScreen/杀毒提示**。当前 token 非提升权限不等于干净标准用户账号已验证。正式 appId、打开聊天时升级及多 Windows 版本仍需补测。卸载不会删除服务端账号、聊天或记忆，彻底删除本地数据需要单独明确选择，策略见 [隐私和设备说明](P83_PRIVACY_AND_DEVICES.md)。

最终本地构建产物：`desktop/out/installer-cfece59c-fdd6-49d6-b9fe-5b39b8f8f686/WeiBiYe-0.1.0-x64-setup.exe`，121,489,553 字节，SHA-256 `328c1b07d5709522959d09427a220ef5d3ba37c51c320a9e6436e6b08d419060`。它仍是 **local 模式、未签名、未发布的开发构建，不供普通用户内测分发**。NSIS 生命周期测试使用独立验证身份产物；最终正式身份产物只完成内容检查及 win-unpacked 运行回归，没有安装正式身份。

## HTTPS、额度和数据安全边界

TLS 实测注册→Mock 邮箱验证→Secure/Host-only Cookie 登录→三宠独立聊天→Mock SSE→刷新恢复；兄弟宠物会话数量为 1/0/0。实际 UI 领取、统计开关、同意后的可信交互及关闭删除均通过。另一张同域名测试证书被 Chromium 拒绝，后端不可用时离线帮助可显示并正常退出。测试 pin/域名映射不进入发行包，未关闭 TLS 验证或写系统根证书。

正式 readiness 需要 Redis；本地 TLS 夹具采用内存认证/限流，使用单独夹具就绪检查，**不冒充生产 readiness/真实邮件/真实 DeepSeek 验收**。客户端没有加入模型密钥，构建和测试子进程按名称过滤模型环境变量；本轮未读取、输出或保存真实 API Key。

请求、并发、账本预算硬限制已实现并离线验证。金额为保守预算占用，不是实际费用；允许模型、价格版本及费用上界尚未确认，真实调用不能开启。账号只能领取一次；受控邀请名单仍需人工管理，不能声称邮箱验证阻止所有自然人多账号。

共享库 `weibiye`（0005/26 表）与旧隔离库（0006/34 表）前后结构、行数和内容哈希完全一致。已有 5,074 份历史证据哈希不变。测试新建数据库与数据目录均保留，本轮专用 PostgreSQL 两个容器已验证身份后正常停止，未删除任何容器或卷。最终无项目 Electron 进程，已知验收端口均释放、专用安装注册项均不存在；后端/浏览器记录正常退出。见汇总目录 `final-processes.json`、`database-after-check.log`。

## 发行前尚需完成与确认

1. 批准独立主机、域名/有效证书、数据库/Redis、备份恢复与费用边界；本轮只设计，未部署。固定 hosted 地址需经审查后重新打包。
2. 选择邮件服务并实现真实 MailSender、组织邀请发放流程；实际投递与外部注册尚未验证。
3. 确认签名/受控分发方式，在干净标准用户 Windows 上验证正式身份安装、升级、卸载与下载安全提示。
4. 确认模型与价格、输入/输出上限、初始账号额度及每日全局预算；再单独授权真实模型验证，不能从本轮推定费用许可。
5. 真实休眠恢复、多屏热插拔/混合 DPI、低配置设备；本轮实际硬件为单屏、125% 缩放，只将模拟边界列为单元测试。
6. 确认反馈渠道、统计告知与 30 天清理任务；安装尝试采集尚未接通，成功率未知。D1/D7 只有算法和合成队列测试，没有真实用户留存数据。

满足这些门槛后先邀请 10 人，依据实际故障、任务收敛、资源和预算逐步放至 30 人。50～100 人仍需独立环境容量、邮件和恢复测试。[独立环境方案](P83_HOSTED_ENVIRONMENT.md)、[本地重验命令](P83_LOCAL_RUNBOOK.md)。本轮停在本地验证完成状态，等待上述外部事项确认。

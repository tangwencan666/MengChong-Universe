# P6 许可、复用与安全复核

复核日期：2026-11-02。本文汇总已保存的六仓固定提交研究、当前桌面源码和打包许可清单。本轮只读审查产品代码，不运行第三方程序、数据库测试或 Docker 命令。Windows 原生输入与 125% DPI 验收仍在进行；本文不作桌面 MVP 最终验收结论。

## 1. 六个参考仓库的代码与素材边界

| 仓库及固定提交 | 实际代码许可证据 | 美术／角色风险 | 本轮复用决定 |
| --- | --- | --- | --- |
| nucket/NekoAI，7462b824a1428f8004ef671a53f31fd2f43ff723 | [实际 MIT LICENSE](https://github.com/nucket/NekoAI/blob/7462b824a1428f8004ef671a53f31fd2f43ff723/LICENSE)；源码若复制须保留版权与许可 | README 对原始 Neko 的 public-domain 声明未独立完成权利链核验；其他角色作者与商标也需分别核查 | 只参考清单、调度、工作区和托盘设计；不复制源码或角色 |
| lmy375/ai-pet，f4721f95732bc68ae37672480e59221cb1ee12c8 | [固定提交完整树](https://api.github.com/repos/lmy375/ai-pet/git/trees/f4721f95732bc68ae37672480e59221cb1ee12c8?recursive=1)未找到 LICENSE／COPYING／NOTICE／CREDITS，不能推定复制授权 | Cubism Core／SDK、Wanko 样例及其他模型需分别核对运行时发行条款和角色美术权利；提供下载入口不等于商业再分发授权 | 只研究渲染层和流适配结构；不复制代码、SDK、Core 或模型 |
| LGaben/Desktop-Pets，83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec | [实际 MIT LICENSE](https://github.com/LGaben/Desktop-Pets/blob/83ae6ffa63fdac7a3c3143b296aa8a1d153db2ec/LICENSE)；PyQt5 依赖义务独立存在 | README 声称来自 vscode-pets，但目标树没有完整逐素材权利链；Totoro、Clippy 等角色名称提示须额外核对版权和商标 | 只参考集中多窗口、动作与退出管理；不复制代码或素材 |
| c-dom/deepseek-pet，eb2ef68fa648df3f1b5246fff861655a780e6daf | [LICENSE L1–21](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/LICENSE#L1-L21)是 MIT 样式源码授权；GitHub 元数据为 NOASSERTION，依据文本判断 | [L23–28](https://github.com/c-dom/deepseek-pet/blob/eb2ef68fa648df3f1b5246fff861655a780e6daf/LICENSE#L23-L28)明确排除 web 下角色、美术、精灵与媒体，除非单文件另有许可；不等于排除全部 HTML／JS 源码 | 只参考窗口／动画／输入职责分离；不复制代码、素材、品牌 |
| sleepingjhy/Aemeath-Desktop-Pet-on-Windows，f8d130201a7807e7867fa8e22ebc5dc2eb81a920 | [固定提交完整树](https://api.github.com/repos/sleepingjhy/Aemeath-Desktop-Pet-on-Windows/git/trees/f8d130201a7807e7867fa8e22ebc5dc2eb81a920?recursive=1)未见授予代码复制与分发权的许可 | 特定角色设定、GIF、表情图未取得独立商业授权；后续代码许可证也不能自动补齐角色授权 | 只参考实例、任务与窗口生命周期；不复制代码或角色 |
| Litrudy/DesktopPet，f3067755833ba13859a6d3a9fa904177c684c1ac | [固定提交完整树](https://api.github.com/repos/Litrudy/DesktopPet/git/trees/f3067755833ba13859a6d3a9fa904177c684c1ac?recursive=1)未见 LICENSE／COPYING 或明确分发许可 | pet.json 缺少 author／license；生成脚本的参考图与临时剪贴板来源不能证明最终素材可商业使用 | 只参考状态、动画与输入分离；不复制代码、图片、图标 |

详细源码路径、行号、维护日期、README 与实际实现区别分别保存在 [NekoAI／ai-pet](RESEARCH_NEKO_AIPET.md)、[Desktop-Pets／deepseek-pet](RESEARCH_DESKTOP_DEEPSEEK.md)、[Aemeath／Litrudy](RESEARCH_AEMEATH_LITRUDY.md)。六仓均可读取，但没有运行其程序，CPU、应用内存、泄漏、真实安装条件和 Windows 兼容矩阵均为未知。发布附件大小不能替代这些实测。

公开可访问不代表允许复制和分发，参见 [GitHub 官方许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。PyQt5／6 的 GPLv3／商业双许可独立于参考仓库 MIT；不能因仓库 MIT 而省略绑定库义务，也不能把商业使用本身误写成禁止，依据 [Riverbank 官方说明](https://www.riverbankcomputing.com/software/pyqt/intro)。本轮未采用 PyQt、PySide、Tauri 或上述仓库的代码。

## 2. 本轮实际使用的代码和素材

没有将六个研究仓库的实现文件、代码片段、图片、精灵、角色设定、商标或安装脚本复制进 WeiBiYe。通用架构思路由本项目独立实现。这里的“不复制参考仓库”不等于程序没有第三方组件：Electron、Chromium 和已存在的 React 依赖确实进入预览包，并按其实际许可保留声明。

cat.svg、dog.svg、cloud.svg 和 tray.png 是本轮以几何路径和自绘像素脚本制作的临时原创外观，没有外部角色或图片。来源记录见 [ASSET_NOTICE.md](../../desktop/assets/ASSET_NOTICE.md)，清单见 [manifest.json](../../desktop/assets/manifest.json)。asset_id 与服务端 pet_id 分离；外观不能产生私人资源访问权。

整体项目的公开开源／分发许可尚未由所有者选择。本报告与资源来源声明不代替该决定。Live2D 明确为 NOT_IMPLEMENTED，没有下载或打包 SDK、Core、样例模型；未来需分别核对 [SDK 发行许可](https://www.live2d.com/en/sdk/license/) 和每个模型／美术资源的权利。

## 3. Electron、Chromium 与前端许可

本轮使用本地确切版本 Electron 45.2.1。portable 包原样保留运行时根目录 LICENSE 和 LICENSES.chromium.html；Chromium 及内置组件有各自条款，不能统称全部 MIT。打包不执行安装脚本、不下载依赖、不包含 Python 后端／数据库／认证 profile。应用 package.json 仅保留 name、version、main。

[THIRD_PARTY_NOTICES.md](../../desktop/THIRD_PARTY_NOTICES.md)随包分发。打包器读取实际安装的前端依赖许可文件，复制到 resources/app/licenses，生成 DEPENDENCIES.json，并对全部产物记录 SHA-256。当前清单共 38 项；package.json 声明为 37 项 MIT、1 项 ISC，实际保留的全文和附加声明优先于摘要标签。部分 Axios Node 侧依赖不会进入浏览器运行路径，仍保守保留其许可，不据此宣称这些包都在桌面运行时执行。

| 包 | 实际版本 | 元数据许可 |
| --- | --- | --- |
| react | 19.3.1 | MIT |
| react-dom | 19.3.1 | MIT |
| react-router | 7.18.5 | MIT |
| @tanstack/react-query | 5.105.0 | MIT |
| @tanstack/query-core | 5.105.0 | MIT |
| axios | 1.21.0 | MIT |
| lucide-react | 0.468.0 | ISC，全文含 Feather 部分来源声明 |
| tailwindcss | 4.3.3 | MIT |
| vite | 7.3.7 | MIT，保留 LICENSE.md 内附加声明 |
| scheduler | 0.28.0 | MIT |
| cookie | 1.1.1 | MIT |
| set-cookie-parser | 2.7.3 | MIT |
| follow-redirects | 1.16.2 | MIT |
| form-data | 4.0.6 | MIT |
| https-proxy-agent | 5.0.1 | MIT，完整文本位于实际 README.md |
| proxy-from-env | 2.1.0 | MIT |
| asynckit | 0.4.0 | MIT |
| combined-stream | 1.0.8 | MIT |
| es-set-tostringtag | 2.1.0 | MIT |
| hasown | 2.0.4 | MIT |
| mime-types | 2.1.35 | MIT |
| agent-base | 6.0.2 | MIT，完整文本位于实际 README.md |
| debug | 4.4.3 | MIT |
| delayed-stream | 1.0.0 | MIT |
| es-errors | 1.3.0 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| has-tostringtag | 1.0.2 | MIT |
| function-bind | 1.1.2 | MIT |
| mime-db | 1.52.0 | MIT |
| ms | 2.1.3 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| get-proto | 1.0.1 | MIT |
| gopd | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| dunder-proto | 1.0.1 | MIT |

https-proxy-agent 和 agent-base 没有单独 LICENSE 文件，但本地 README 确实包含完整 MIT 版权、授权和免责声明；打包保留整份原始 README，没有自行重建许可或仅凭元数据放行。每次最终重打包都重新生成实际清单；本表不是对未来依赖升级的自动授权。

## 4. 已有 WeiBiYe 模块的复用

| 既有模块 | 桌面客户端中的职责 |
| --- | --- |
| FastAPI auth／users、Cookie 服务端会话 | 注册登录、当前用户、退出、过期与撤销；不在 localStorage 保存长期认证 Token |
| Cookie／CSRF／CORS／统一错误及脱敏 | 保留服务端安全校验；本地代理不伪造 Cookie、Origin 或 CSRF |
| PET_DESKTOP_API、pets 模块 | 唯一 pet_id、人格和外观、owner＋pet 过滤、隐藏／归档的后端语义 |
| P3 聊天与生成任务 | 持久消息、SSE start／delta／completed／error／cancelled、幂等、取消和事件重放 |
| P4 与宠物记忆模块 | 默认关闭授权、候选逐条确认、CRUD／导出／来源、删除与撤销屏障、Token 预算 |
| LangGraph、Provider 适配和 Mock | 受控人格与记忆上下文；本轮不启用真实付费模型 |
| 既有 React 聊天、记忆、账号和宠物界面 | 在同源本地页面复用会话状态、API 客户端、SSE 解析与跨账号／跨宠物缓存防护 |
| SQLAlchemy／Alembic／PostgreSQL／Redis | 继续使用现有数据与版本保护；桌面进程不执行迁移、不直接连数据库 |
| pytest／前端与浏览器测试 | 作为后端和私人数据边界回归；原生窗口测试另外验证 Windows 输入、DPI、进程和资源 |

不引入参考仓库的全局共享历史、未授权自动记忆、任意脚本／文件执行、桌面监测、喂食／等级／金币、社区或求职业务。

## 5. 当前桌面代码的只读安全复核

核对 main.cjs、manager.cjs、policy.cjs、preload.cjs、gateway.cjs 与 renderer/pet.js 后，当前实现存在以下明确边界：

- 所有窗口启用 sandbox、contextIsolation、webSecurity，关闭 Node／子框架 Node／webview；预加载只暴露列举动作，不暴露 ipcRenderer、shell、任意文件路径、URL 或执行脚本。
- IPC 根据登记的 BrowserWindow、主 frame、角色、同源路由及绑定宠物检查调用者；当前账号与宠物读取经后端重新验证。Cookie 改变触发 epoch 失效、关闭旧宠物／聊天窗口并撤销在途请求；迟到回复不能重新建立旧账号窗口。
- UI 与宠物使用不同的非持久 session partition；小宠物没有认证 Cookie。宠物只允许访问固定 HTML／JS／CSS 和受控原创资源，CSP connect-src none；姓名用 textContent，图片地址来自固定白名单。
- 本地代理绑定 127.0.0.1，严格检查 Host／Origin，写操作需要匹配来源；Cookie／CSRF／幂等键／Last-Event-ID 原样转发，只允许显式 loopback HTTP 后端。不是开放代理，不关闭现有认证或版本保护。
- 网络、JSON 大小、请求体、坐标和拖动租约均有界。高频拖动不构建无界授权队列；未完成身份校验时只保留一个待处理坐标，不移动未验证宠物。
- 阻止外部导航、新窗口和 webview，权限默认拒绝；记忆导出仅允许显式 JSON blob、大小和文件名白名单及原生保存对话框，并重新验证账号／宠物。
- 正常退出移除本次计时器、显示器／Cookie／IPC 监听、窗口、托盘及本地代理；不结束外部后端和其他项目。日志为通用错误，不输出聊天正文、记忆正文、Cookie 或模型密钥。

这是当前源码快照的审查，不替代实际 Windows 输入／高 DPI／崩溃恢复验收。跨屏缩放与 125% DPI 修复尚未冻结，最终 portable 包必须在所有必要回归结束后重建并真实启动。当前 loopback HTTP／开发 Cookie 配置也不能直接作为生产 HTTPS 与安装更新方案。

## 6. 52 项条件跳过的准确含义

已有完整 pytest 日志记录 598 passed、52 skipped。本次没有重跑测试；通过阅读模块级 skipif、参数化和 fixture，52 项可准确分解如下：

| 专项 | 数量 | 触发条件与目标保护 |
| --- | ---: | --- |
| auth PostgreSQL／Redis | 1 | WEIBIYE_AUTH_PG_TESTS=1，另外必须显式提供独立 P3 命名测试库／Redis URL、run_id、集群及 Redis 所有权租约；无开发库回退 |
| P3 PostgreSQL 并发／任务 | 10 | 显式 WEIBIYE_CHAT_TEST_DATABASE_URL，严格独立 P3 测试库名、25433／用户／集群、版本0004 |
| 共享本地基础设施专项 | 9 | WEIBIYE_LOCAL_INFRA_TESTS=1；有意目标 weibiye／Redis0，PostgreSQL 只读查询与 health，Redis 仅唯一 UUID 的30秒TTL验证键；含只读 docker inspect／exec SELECT 或 INFO |
| P4-A PostgreSQL | 10 | 显式 P4A URL，严格独立 P4-A 命名／集群／0005／26表 |
| P4-B PostgreSQL 与 Spy／竞态 | 13 | 显式 P4B URL，严格独立 P4-B 命名／集群／0005／26表；包括参数化删除、撤销、过期与来源删除 |
| P4-A 在途隐私竞态 | 2 | 复用严格隔离 P4-A fixture，参数化 flush／finish |
| P4-A Redis／认证 | 1 | 必须同时提供独立 P4A PostgreSQL 和 Redis URL，目标与集群校验、独立 TTL namespace |
| P3 Redis pool | 1 | 显式独立 Redis URL、P3命名库、run_id、Redis所有权租约／namespace |
| 宠物 PostgreSQL | 5 | 显式 PET URL，严格独立宠物测试库名／集群／PostgreSQL17／0006／34表 |
| 合计 | 52 | 都是显式 opt-in；其中43项要求隔离测试库，9项属于另行授权的共享基础设施只读专项 |

因此不能把52项说成全部隔离库测试，更不能记作52项通过。它们不是未实现功能的占位，而是仍存在的真实数据库／Redis专项测试；P6专用真实 API、浏览器和隔离数据库验收应单独报告。重跑旧版本0004／0005并发矩阵需要各自新隔离环境，不应把它们指向当前共享库或P6的0006库强行运行。保持这些条件跳过保护了本轮数据库边界，但不能用跳过代替覆盖证明。

## 7. 公开发行前仍需完成

最终原生交互／125% DPI修复与包体重建、Windows10／11兼容矩阵、真实进程树性能与异常恢复、代码签名／安装更新、后端交付方式、项目自身发行许可与完整依赖／素材复核。若未来引入真实模型或 Live2D，分别补充密钥存储、隐私、付费授权与运行时／模型许可验收。本轮不替用户选择整体开源许可，也不宣称公开发行条件已满足。

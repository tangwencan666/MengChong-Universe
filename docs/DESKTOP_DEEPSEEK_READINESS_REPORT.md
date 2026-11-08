# 萌宠溜达：桌面聊天与 DeepSeek 日常接入准备

日期：2026-11-08。用户本轮明确优先“先把桌面宠物聊天完整跑通”。

状态：**桌面离线链路与真实本地数据库启动已验证；本轮真实 DeepSeek 请求仍为0，真实试聊尚待新的次数预算确认。** 不将SDK离线协议响应当成真实模型回复，不沿用旧P8.1的付费授权，也不宣布真实长期记忆或真实上游取消已通过。

## 1. 检查结论及本轮范围

现有 FastAPI、DeepSeek SDK适配、SSE、Electron聊天、独立宠物人格与权限栅栏均保留。此前的主要问题是日常配置仍以Mock为默认，标准 `DEEPSEEK_API_KEY` 只在P8.1特定脚本被识别，持续本地体验缺少多实例授权及共用的有限请求预算。

本轮修改服务端配置和聊天派发保护，新增本地预检入口与离线Windows验收。不改乱斗游戏、QQ模块、桌面宠物动作或社会业务，不新增支付、云服务、角色、向量检索或后台模型互聊。

执行前：分支 `codex/consumer-desktop-pivot`，HEAD `eafe8bd95e7d6267e31f8d9ca5d0b7bfed914183`；758个源文件哈希、245条既有未提交路径，暂存区为空。原有成果按本轮清单保护，不自动暂存、提交或推送。

## 2. 实现内容

### 密钥安全与启用条件

- 普通后端兼容两个进程环境变量：`WEIBIYE_DEEPSEEK_API_KEY` 优先，其次 `DEEPSEEK_API_KEY`；构造函数显式值优先。显式设为None会关闭该设置；规范变量存在但为空时不会偷偷改用另一把密钥。
- 密钥保持SecretStr、禁止普通序列化、repr隐藏。没有读取永久注册表密钥、写入源码、报告、Git、前端或安装包，也没有打印密钥内容。当前进程实际配置预检只输出 `key_visible=true`。
- 有密钥不代表启用：默认仍为Mock、真实调用关闭；保持P8.1单宠定向兼容，不能与新本地模式混用。

### 本地宠物实例授权

新增服务端配置：

| 环境变量 | 含义 |
| --- | --- |
| `WEIBIYE_LOCAL_DEEPSEEK_PETS` | JSON数组，每项仅允许UUID字段 `owner_id`、`pet_id`，最多32项 |
| `WEIBIYE_LOCAL_DEEPSEEK_MAX_REQUESTS` | 单次本地服务启动共用的请求上限，默认0，启用时1–100 |
| `WEIBIYE_LOCAL_DEEPSEEK_MAX_INPUT_BYTES` | 完整组装消息的JSON UTF-8上限，默认8192字节，可配置256–32768 |

新模式只允许development、全局基础provider为Mock、显式真实开关、有效后端密钥、非重复的账号/实例组合、正数次数上限，以及最多512输出Token。匹配只使用账号UUID＋宠物UUID；同名、同品种、重命名、列表顺序均不授予权限。其他宠物和旧聊天保持其原先模式。

每个任务继续冻结provider/model，派发前重新检查所有权、宠物状态、人格、记忆epoch和数据库租约。真实宠物派生独立配置，不修改其他Mock宠物的设置。本轮真实模式不注入长期记忆，已有Mock记忆及隐私管理保持原有行为。

### 本次启动共用预算

`LocalDeepSeekBudget` 由单个ChatRunner持有，在最终隐私/数据库派发栅栏提交后、任何模型迭代器之前，校验已组装输入并原子预留次数；多宠物、多会话共用，不随每条回复、前端刷新或Electron重启补充。

超过次数、输入过大或配置改变时返回固定脱敏错误，用户能看到明确提示。派发后的取消、网络失败、供应商429等仍消耗一次；SDK自动重试继续为0，幂等重放不再次派发。

这是**单进程本地开发的一次启动预算**，不是跨进程、永久或人民币余额。重启后端会重新开始预算，必须由操作者重新确认；禁止将它当成公开服务的全局额度。已有P8.3持久化beta额度、并发、日预算检查仍先执行，并未被本地预算替代或绕过。

## 3. 安全启动与依赖预检

新增 `backend/scripts/desktop_chat.py`：

- `--check-config`：只报告脱敏配置及密钥是否可见，不连接数据库、Redis或模型。
- `--prepare-target`：只读验证显式选择的隔离PostgreSQL和Redis，生成全新目标，不覆盖历史文件。
- `--target <文件> --check`：核验目标身份，不启动应用、不发送模型请求。
- `--target <文件> --serve`：核验后单进程仅监听127.0.0.1。真实模式还必须让 `--confirm-paid-requests N` 与服务端配置次数完全相同。

只允许显式的127.0.0.1 PostgreSQL连接，数据库名须符合独立测试/本地库的完整UUID命名规则；共享 `weibiye`、隐式默认连接、SQLite日常目标和远程地址被拒绝。执行READ ONLY事务，检查0006完整数据库能力、PostgreSQL集群身份和所选宠物真实所有权，再绑定Redis的run_id、端口和db。

新目标24小时有效；Redis重启、数据库集群变化、端口/库名变化或过期时停止，必须重新通过安全准备流程，不手改身份字段。应用启动再次检查。认证、限流和流槽位的Redis键均加上本目标前缀并要求TTL，不清除其他项目的键。

本轮只启动已安装的 `D:\Docker\DockerDesktop\Docker Desktop.exe` 及已存在且端口核验通过的 `weibiye-postgres-1`、`weibiye-redis-1`；没有创建、删除、重建容器或数据卷。PostgreSQL实际集群为 `7703042374370492450`，既有隔离库版本0006、4只原有宠物。Redis当前run_id `89bfa8bf50c08f8300e00b9a0aba33fa05e675e4`。

新目标：

```text
.verification/desktop-chat/prepared-0312156c3c404c2f8eac4454fca1c6f2/target.json
```

在该目标下完成两种只读检查：全Mock配置；以及现有隔离月芽的明确UUID授权、2次上限、64输出Token配置。后者返回 `DESKTOP_CHAT_PREFLIGHT_OK`、密钥可见，但未启动真实模式服务或请求模型。原P6/P8.1目标和历史证据均未修改。

## 4. 本轮实际测试

| 项目 | 实际结果 |
| --- | --- |
| 新旧DeepSeek配置/SDK/宠物执行专项 | 100通过 |
| 更新配置契约后P8.1保护＋新启动器 | 61通过 |
| 前端单元 | 66通过，0失败/跳过 |
| 桌面单元 | 233通过，0失败/跳过 |
| TypeScript、ESLint | 通过 |
| 前端构建 | 通过，主JS约560.71kB；存在既有大包提示，未通过提高阈值消除 |
| Ruff与格式检查 | 全库Ruff check通过；本轮11个Python文件格式通过；全库format有2处历史差异，详见下文 |
| 实际Windows/Electron离线SDK验收 | 9组通过，0失败 |
| 实际PostgreSQL/Redis应用启动、鉴权与退出 | ready/live HTTP200，未登录宠物接口401，端口释放 |
| 最终后端完整离线复核 | 1123通过、0未闭环失败、4条件跳过；共1127项，分组及路径问题复核汇总 |

专项与全量中存在重复用例，不能把表中数字简单相加当成独立覆盖率。

“后端完整离线”指 `backend/tests` 中不含 `tests/integration` 的62个测试文件。真实基础设施集成目录未运行，不计为通过。最终覆盖通过JUnit逐用例核对：四个互不重叠文件分组，加上受临时路径影响用例的原样复核，合计1127项；节点名称中两项运行时生成的UUID仅在清单比较时归一化，保留用例数量，测试本身未变。

首轮完整后端为1121通过、1失败、4条件跳过。失败是旧P8.1契约要求标准密钥变量只能由旧验收脚本识别，与本轮新增的日常后端兼容行为相冲突；已更新契约，并保留前缀优先、显式值优先、显式None关闭，以及默认Mock/真实调用关闭断言。不是删除测试、改变业务结果或绕过保护。

4个条件跳过均为P8.3专用新建PostgreSQL额度集成目标缺失。没有拿共享库或旧验收库代跑这些写入型测试，不将跳过列为通过。

最终分组期间，一次并行取消回归出现长时间等待并停止；带线程诊断单独重跑该组后，相关取消用例及252项通过，没有修改产品取消逻辑。该等待的精确时序根因尚未确认，不能据此宣布并发或长负载下绝无问题。该组另有6个既有QQ沙箱用例因临时目录过长无法创建SQLite日志文件：实际数据库路径255字符，追加日志后263字符；换到更短且全新的临时目录后，原文件7项全部通过，断言及QQ产品源码未改。失败与中断原始记录均保留，不计作通过；最终汇总仅用完整复核结果。

全库format的两处历史差异位于 `backend/scripts/deepseek_live_smoke.py` 和 `backend/tests/test_deepseek_live_smoke.py`。哈希与执行前完全一致；为保护历史未提交成果没有顺手格式化，不将全库format标记为通过。

### Windows实机内容

安装版Electron真实渲染、受限IPC、真实本地FastAPI与全新SQLite，使用实际DeepSeek SDK解析，但网络层固定HTTPX MockTransport、合成密钥，回复显式带有“离线协议测试，非真实模型”。测试覆盖：

1. 登录后八种角色及第九只同品种实例，初始桌面0只。
2. 直接召唤第7只刀盾、第8只鲸鱼娘，收回正常。
3. 两只同名哈吉米按不同实例ID打开独立聊天窗口，读取服务端DeepSeek模式说明。
4. SDK增量经SSE在Electron显示，回复完成并保存，输入/输出用量由离线API专项核验。
5. 同名实例私人历史不串扰，刷新恢复不增加派发。
6. 只在本次新回复实际出字后点击停止，确定性假上游被关闭，任务收敛cancelled。
7. 假上游429不自动重试；第5次发送被本次4次共用预算阻止，没有第5次上游请求。
8. 外账号宠物请求404；未选中宠物runtime仍为Mock。
9. 正常退出、重启并登录后恢复相同实例及位置，不增加派发。

结果：4次**假上游**尝试、3个响应流关闭、真实请求0。测试浏览器无页面异常或外部请求，Electron及测试后端正常退出，测试端口全部释放。只宣称实际应用窗口渲染验收，不代替多屏、物理鼠标、真实休眠或互联网发行验证。

密集自动化起初误读上一条回复进度、空输入发送按钮状态，且额外查询触及现有读取限流；已修正测试观察方式并在重启前尊重原有分钟配额，没有提高限流、清缓存、改机器时间或更改产品取消逻辑。所有中间失败证据保留。

## 5. 数据与证据

主证据：`.verification/desktop-chat/run-62cb72bb73db4d228a41488558e6d39e/`。

- 首轮及最终完整后端JUnit、原始日志、分组清单。
- `provider-tests.xml`、`launcher-final.xml`、`contract-final.xml`。
- `preflight-prepare.json`、`preflight-check.json`、`preflight-deepseek.json`。
- `postgres-startup.json`：真实PostgreSQL/Redis、强制Mock的启动和退出。
- `shared-before.json` / `shared-after.json`、`isolated-before.json` / `isolated-after.json`：数据库内对各行计算MD5后再汇总，用于前后一致性检查，不返回或保存聊天正文。只读准备检查前后完全相同。
- `preservation.json`：最终源文件、原有未提交状态及Git核对。
- `final-summary.json`：1127项覆盖清单核对、前后端结果、依赖、已知边界及源码保护汇总。
- `database-final.json`：实际应用启动/退出及真实配置只读预检后再次核对，共享库和隔离库均与准备前相同。

Windows最终证据：`.verification/desktop-chat/electron-a398a00b-0221-48e1-84b3-9da4cce637a8/`。

实际截图：`01-pet-selection.png`、`02-offline-SDK-chat.png`、`03-SSE-completed.png`、`04-instance-isolation.png`、`05-cancelled.png`、`06-budget-stop.png`、`07-restarted.png`。已查看实际聊天与预算提示截图；聊天明确显示离线响应及真实模式费用/记忆说明。截图为实际Electron窗口，不是设计图或拼图。

## 6. 启动方式与真实试聊边界

先在**仅后端**的进程环境选择已核验隔离库及Redis，保留现有密钥变量；不要把Key复制进命令、截图、报告或前端。配置当前允许的账号UUID/宠物UUID数组、输出上限及本次次数上限。未授权宠物继续Mock。

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend'
.\.venv\Scripts\python.exe -B -m scripts.desktop_chat --check-config
.\.venv\Scripts\python.exe -B -m scripts.desktop_chat --prepare-target
# 使用上一步实际返回的新target路径；Redis重启或24小时后重新准备。
.\.venv\Scripts\python.exe -B -m scripts.desktop_chat --target '<新target.json完整路径>' --check
```

仅在本次真实费用与请求次数另获明确确认后，再启动真实聊天服务：

```powershell
# 以本次确认恰好2次、每次最多64输出Token为例；本轮未执行此命令。
.\.venv\Scripts\python.exe -B -m scripts.desktop_chat `
  --target '<已通过检查的新target.json完整路径>' --serve --confirm-paid-requests 2
```

另一终端打开桌面端：

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop'
npm.cmd start -- --backend-origin http://127.0.0.1:38336 --ui-port 35336
```

默认Mock配置可用 `--serve` 启动，不带付费确认；如果配置次数与命令确认不一致，启动停止。后端Ctrl+C、桌面托盘“退出萌宠溜达”正常关闭，各自不强杀其他项目进程。命令假设前述后端环境已正确设置，不隐式读取.env、不自动迁移或覆盖数据库。

本轮已核查[DeepSeek官方接入说明](https://api-docs.deepseek.com/)及[价格文档](https://api-docs.deepseek.com/quick_start/pricing/)：继续使用 `deepseek-flash`、官方HTTPS端点和关闭thinking的聊天流。以高峰未命中输入0.30美元/百万Token、输出1.20美元/百万Token作示例，每次约10000输入Token加64输出Token、两次约0.0062美元。这个输入量是保守估算，不是实际tokenizer证明、账单或严格金额熔断；本地代码硬限制的是请求数、输入字节和输出Token。价格会变化，真实费用只依据服务商可靠用量/账单。

建议下一次真实验证只做两次短合成消息：确认正常回复及同一会话上下文；失败立即停止，不自动重试，不再次付费追逐取消竞态。仍需单独确认次数后执行。

## 7. 修改文件

已有文件的最小修改：

- `backend/app/core/config.py`
- `backend/app/agent/provider_selection.py`
- `backend/app/agent/chat_runner.py`
- `backend/app/agent/chat_protocol.py`
- `backend/app/modules/pets/memory_runtime.py`
- `backend/tests/test_p81_acceptance_guards.py`

新增：

- `backend/app/agent/local_deepseek_budget.py`
- `backend/scripts/desktop_chat.py`
- `backend/tests/test_local_deepseek.py`
- `backend/tests/test_desktop_chat_launcher.py`
- `desktop/test/fixtures/desktop_deepseek_server.py`
- `desktop/test/desktop-deepseek-e2e.cjs`
- 本报告。

## 8. 未完成与下一步

- **尚未执行本轮真实付费试聊**，新接入模式不能因此声称真实模型验收通过。
- 真实长期记忆注入、事件进入真实模型、真实上游取消及取消费用仍未验证。本轮没有新增Embedding、pgvector或语义RAG。
- 本次预算为单个本地后端启动的保护，不是公开平台的跨进程财务系统；QQ真实接入、收费、普通用户独立后端、签名发行仍属后续阶段。
- 未进行新的长时间CPU/内存、多物理显示器/DPI、真实系统休眠或公开网络验收；旧阶段结果不计入本轮。
- 后续优先完成有界真实短聊验证，再完善授权长期记忆的真实输入预算及撤销/删除栅栏；不继续新增与聊天无关的功能。

本轮不推送、不部署、不发布、不关机。Docker及两个既有基础服务为后续本地使用保持运行；验收专用API和Electron均已关闭。

最终源码核对：仅上述6个既有文件修改，新增7个文件；原245条未提交路径全部保留，当前252条；其余既有文件哈希未变，未发现缺失或意外新增。乱斗源码、原有宠物素材及两个历史格式文件未变；HEAD不变，暂存区为空。仅作本地开发准备，不声称公开发行条件已满足。

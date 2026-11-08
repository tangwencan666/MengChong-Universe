# P8.7.2 QQ 官方 WebSocket 本地接入

核查日期：2026-11-03（UTC）。阶段状态：**P872_WEBSOCKET_OFFLINE_VERIFIED**，仅第一阶段完成。没有读取真实AppSecret，没有真实QQ连接、Token请求、消息外发或DeepSeek调用；第二阶段等待用户明确授权。本轮未部署公网服务。

## 1. 官方协议与权限结论

| 项目 | 实现及依据 |
| --- | --- |
| 网关发现 | 服务端鉴权GET `/gateway/bot`，检查官方WSS URL、建议分片数、Session启动剩余量与并发限制；本地原型只支持1个分片。[通用网关](https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html)、[分片网关](https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/shard_url_get.html) |
| 鉴权 | Hello op=10后发送Identify op=2，token格式`QQBot {AccessToken}`，收到READY后才接受首次业务消息。[事件与网关协议](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html) |
| 心跳 | 按Hello下发周期调度op=1，携带已处理序号；处理op=11 ACK及服务器心跳请求；ACK缺失、Hello/READY超时触发受限重连 |
| 恢复 | 已有RAM Session时发送Resume op=6。官方说明先补发遗漏事件再发RESUMED，代码允许这个顺序；仅成功处理/拒绝处理或完成元数据预留后推进游标 |
| 重新鉴权 | Invalid Session op=9清除旧Session，后续重新Identify；参考官方Python SDK对9001/9005的处理。4004鉴权失败停止，不重置平台AppSecret；其他4xxx按保守策略停止，尚未逐码真实验证。[官方SDK网关代码](https://github.com/tencent-connect/botpy/blob/master/botpy/gateway.py) |
| 令牌 | 复用P8.7.1 Access Token获取、缓存和单飞刷新；不新增另一套凭证存储，不因重连更换Key。[访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html) |
| 单聊 | 仅将`C2C_MESSAGE_CREATE`纯文本交给既有owner/pet绑定、人格、记忆和Mock候选链路。[C2C事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html) |

**订阅粒度限制必须说明：** 官方将C2C、群@及好友事件放在同一个`GROUP_AND_C2C_EVENT = 1 << 25`订阅位，不能声称网络层只订阅一个C2C事件。本原型仅请求该最小位，应用只消费获授权的C2C；其他类型在协议分派处丢弃，不读取其业务字段、不进入模型/记忆、不持久化或回复。网络层可能收到这个官方事件包中的其他通知。测试bot不应加入无关群或参与其他服务；若要求连通知都绝对不能到达，需先向QQ官方确认更细粒度权限，本原型不承诺这一点。

`--confirm-c2c-approved`只是操作人对已获批权限的声明，不代表已通过真实平台鉴权。创建机器人「一号」并拿到AppID/AppSecret不能代替C2C权限、测试成员和服务范围确认。拒绝时不自动增加intents、不切换非官方QQ协议。

## 2. 代码结构与复用

- `qq_p872/state.py`：纯状态机、心跳/鉴权期限、处理游标、Identify/Resume决策，支持确定性测试。
- `transport.py`：受控WSS客户端，固定`wss://api.bot.qq.com/websocket[/]`，拒绝其他主机、用户信息、查询参数、非TLS和重定向；TLS保持验证，禁环境代理、压缩及库自动重连，关闭原始帧日志。[websockets客户端接口](https://websockets.readthedocs.io/en/stable/reference/asyncio/client.html)
- `protocol.py`：只接受当前已鉴权网关Session产生的内部证明。复用P8.7.1 C2C规范化，不伪造Webhook签名、不对外提供可注入证明的HTTP入口。
- `channel.py`：复用已有绑定、owner/pet UUID、人格快照、授权记忆查询、幂等和Mock预算；HTTP回复目标固定为入站OpenID；额外限制本次最多2次消息外发尝试。
- `runner.py`：事件驱动接收与心跳，断线退避、恢复和任务清理；模型等待不会阻塞心跳；最多接受一条新的已授权聊天。
- `app.py`与`scripts/p872_qq_websocket.py`：复用P8.7.1隔离SQLite、认证、CSRF、领养和绑定管理，只开放本机管理端口，**不挂载Webhook接收地址**，不需要公网回调。

原P8.7 Mock构造保护及P8.7.1 Webhook均保留。共用C2C规范化函数在两条路径验证；默认FastAPI/React/Electron入口未改动，现有桌面演示不停止或重载。宠物身份始终使用实例UUID，不依赖昵称、品种或列表顺序。

本轮所有候选仍只允许Mock，回复明确带`【AI宠物·测试Mock】`。真实DeepSeek Provider及跨通道生产额度没有接通；P8.7账本属于隔离模拟保护，不向原用户额外发放生产额度，不把字节计数或示例价格当成真实账单。

## 3. 重试、游标和消息安全

同一进程最多3次连接尝试，重试间隔从5秒开始指数增加并带抖动；不使用库的无限重连迭代器。单分片Identify受本地剩余Session预算约束，断线不会退回已经消耗的名额。名额耗尽、建议多分片、鉴权/权限拒绝、未知危险地址等情况停止。整个测试窗口最多10分钟；超时停止外发。

Session和网关游标只在RAM中跨断线恢复，结束清理。进程重启重新Identify，不宣称跨进程持久化Resume。消息去重仍依据bot/发送者域/msg_id/msg_idx的HMAC和持久元数据，不能因新Session或不同分派事件ID重复生成、扣额或发送。

发送超时、审核中、重复码或回执不明不自动重发，也不重新生成模型回复。只有确认未发出的情况才允许原有显式重投保护，仍受本次总外发上限约束。模型不能决定收件人或发送WS操作码，无文件/系统命令/任意QQ工具。

正文与候选不写QQ账本或平台聊天历史，只有已有授权记忆可读；跨用户、同账号同品种实例继续隔离。故障重启的未完成任务按原策略abandoned，不恢复正文、不自动重跑。因此仍可能丢失一次回复，不保证生产exactly-once或至少一次投递。

## 4. 本地离线结果

| 范围 | 通过 | 失败/跳过 |
| --- | ---: | --- |
| P8.7.2状态机、网关、传输与本地应用 | 56 | 0 / 0 |
| P8.7.1与P8.7相关回归 | 143 | 0 / 0 |
| 既有聊天、SSE、额度与隐私回归 | 42 | 0 / 0 |
| React前端单元 | 66 | 0 / 0 |
| Electron桌面单元 | 233 | 0 / 0 |
| Ruff、格式 | 本轮18个Python文件通过 | 0 |

共540个不同用例通过。WS测试使用队列假网关，REST使用`httpx.MockTransport`；相关协议测试禁止真实网络，模型全部Mock。覆盖Hello/Identify/READY、ACK超时、服务器重连、Invalid Session、9001/9005、重放在RESUMED之前、已预留消息不重跑、失败事务不推进游标、鉴权失败不重置凭证、有限退避、退出清理、固定域名/无代理/日志脱敏、错误命令不回显凭证、真实既有本地认证与领养/绑定API、跨实例记忆隔离及硬预算。

这不是QQ真实连接成功，也不是新的Windows视觉验收。真实网络代理兼容性、服务器回放/限频、真实掉线恢复及机器人「一号」实际权限仍待第二阶段或后续专项。现有P8.1真实上游取消仍未验证。

依赖将已有`websockets 17.4`明确加入`qq`可选组；离线更新锁文件，没有安装或升级任何已有依赖包版本。

证据：

- 官方资料：`.verification/p872/research-ae30457a-88df-4bcc-ab6f-fa557e1cca54`。
- 测试/源文件/保护核验：`.verification/p872/validation-63981746-f3ac-4667-8898-5d8e4a9a3a02`。
- 本轮新建的可变运行目标见下节。P8.1～P8.7.1旧证据及旧沙箱目标不修改。

## 5. 现在可以运行的安全命令

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend'
.\.venv\Scripts\python.exe -B -m scripts.p872_qq_websocket
```

无参数默认只检查离线依赖，返回`P872_OFFLINE_READY`，不读取任何QQ凭证，即使环境中已设置真实Key也不会连接。新机器缺依赖时可用`uv sync --locked --extra qq --inexact`按锁安装可选组。

已经为下一轮生成一个全新空SQLite目标，实际迁移到`0006`、验证运行身份；复用P8.7.1安全准备器，未使用旧目标：

```text
D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\p871\sandbox-23a8781f-79a8-4865-91c2-b1e46bc12f7b\target.json
```

目录仍在`p871`是因为复用其隔离格式，这是本轮新建的可变运行数据，不是修改上一阶段目标或报告。需要其他新目标时运行`-m scripts.p872_qq_websocket --prepare-local`；不能手动改身份或重置旧数据。

## 6. 官方测试权限要求

真实测试前由用户在官方后台核实：

1. AppID确实属于机器人「一号」，机器人状态正常，允许官方WebSocket接入。
2. 获得C2C所需事件权限，并允许本次测试成员/测试QQ身份使用；仅申请所需最小范围。
3. 测试身份已经通过官方允许的方式添加/使用该机器人；不登录个人QQ密码，不用非官方协议。
4. 同一个bot只运行这一份测试客户端，避免其他插件或进程争用连接和去重域。
5. 直连官方HTTPS/WSS 443端口可用，管理端口38712空闲；代码不会自动启用代理、放宽TLS或换网关域名。

本轮没有登录控制台或查询真实网关，因此这些不是已验证事项。服务主体、公开运营、商业托管等P8.7待确认权限仍然保留。

## 7. 凭证安全配置及授权后的启动命令

凭证仅使用进程环境变量：`WEIBIYE_QQ_APP_ID`、`WEIBIYE_QQ_APP_SECRET`；模式为`official-websocket`。真实网络与回复还必须同时设置两个环境开关及三个显式启动确认。也可由用户新开的PowerShell继承已配置的Windows用户环境，不要打印其值；没有实现明文配置文件回退。

**以下仅供第二阶段得到明确授权后手动执行，本轮没有执行。** 首次绑定会有1条控制确认回复，随后1条测试聊天产生1条Mock回复，总外发尝试上限2；已绑定时只需1条聊天回复。网关鉴权、心跳和恢复协议包不计作聊天消息，但连接尝试最多3次。建议授权时明确这一预算。

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend'
$qqTarget = 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\p871\sandbox-23a8781f-79a8-4865-91c2-b1e46bc12f7b\target.json'
$env:WEIBIYE_QQ_MODE = 'official-websocket'
$env:WEIBIYE_QQ_APP_ID = Read-Host '输入一号的官方 AppID'
$qqSecret = Read-Host '输入机器人 AppSecret（不是个人QQ密码）' -AsSecureString
try {
  $env:WEIBIYE_QQ_APP_SECRET = [Net.NetworkCredential]::new('', $qqSecret).Password
  $env:WEIBIYE_QQ_ALLOW_NETWORK = '1'
  $env:WEIBIYE_QQ_ALLOW_SEND = '1'
  .\.venv\Scripts\python.exe -B -m scripts.p872_qq_websocket `
    --serve --target $qqTarget --port 38712 `
    --confirm-qq-network --confirm-qq-send --confirm-c2c-approved
} finally {
  Remove-Item Env:WEIBIYE_QQ_APP_SECRET, Env:WEIBIYE_QQ_APP_ID, Env:WEIBIYE_QQ_MODE, Env:WEIBIYE_QQ_ALLOW_NETWORK, Env:WEIBIYE_QQ_ALLOW_SEND -ErrorAction SilentlyContinue
  $qqSecret.Dispose()
  Remove-Variable qqSecret -ErrorAction SilentlyContinue
}
```

命令先验证确认参数、端口和隔离目标，再读取凭证。QQ凭证仅保存在后端内存；子进程移除继承的模型/QQ环境项，实际模型强制Mock。AppSecret不放参数、源码、.env、Git、日志、浏览器或前端；不自动重置平台凭证。不要把真实Secret发送给Codex。

服务只监听`127.0.0.1:38712`用于本地管理，没有Webhook接收路由、隧道或公网监听。停止用Ctrl+C；自动测试窗口/一条回复完成会停WS和外发，管理服务仍在，最后仍需Ctrl+C关闭。重新尝试真实连接必须再次得到授权，不因失败自动启动另一轮。

## 8. 下一次真实QQ测试的准确操作

1. 先获得用户明确授权，并检查上节实际权限及预算。当前仍按未知年龄保护账号处理，正常聊天须在北京时间08:00～22:00允许窗口，不能调机器时间绕过保护。
2. 使用本轮新目标运行获准命令；在另一个本机终端GET`http://127.0.0.1:38712/api/v1/qq/ws-status`，只有收到真实READY后才会显示connected。不要把`/sandbox-ready`或离线依赖通过当作QQ已连接。
3. 在这个空测试库建立/登录平台测试账号（不是QQ账号密码）。沿用`/api/v1/auth/csrf`、`/api/v1/auth/register`、`/api/v1/auth/login`，保留Cookie，并携带Origin=`http://127.0.0.1:38712`及CSRF头。该运行使用独立Cookie名称，不覆盖原桌面应用登录。
4. GET`/api/v1/pet-instances/species`查看八角色，POST`/api/v1/pet-instances`领养，例如`{"species_id":"hajimi","name":"QQ测试哈吉米"}`。领养命令带唯一`Idempotency-Key`，使用返回的`pet_instance_id`，不能按名字认领。
5. POST`/api/v1/qq/bindings/challenges`，正文`{"pet_instance_id":"返回的UUID"}`。在获批QQ测试身份向「一号」发送`/bind 一次性token`，收到绑定确认码后，由同一平台账号POST`/api/v1/qq/bindings/confirm`，传原token、confirmation及`allow_memory:false`。
6. 在QQ只发一条“你好”。应收到且仅收到一条带`【AI宠物·测试Mock】`的回复。查看ws-status应为test_complete，chat_attempts=1、last_chat_status=sent；初次绑定加聊天的outbound_attempts不超过2。
7. 若失败，停止本轮，保留脱敏状态与消息/模型计数；不改intents、序号、身份或预算，不自动重试另一轮。真实掉线恢复、更多用户/宠物和授权长期记忆需另行安排专项，不由这一条消息推断通过。
8. 可通过GET`/api/v1/qq/bindings`及POST`/api/v1/qq/bindings/revoke`撤销本账号绑定，最后Ctrl+C关闭，确认38712释放。原桌面服务及共享数据库不操作。

每个本地测试账号仍只有一次性5个模拟请求名额，未知年龄每日/夜间保护不变。没有把这些名额与生产免费额度合并，也没有真实支付。完整普通用户连接UI尚未开发，本阶段为开发沙箱。

## 9. 修改、保留与提交

新增`backend/app/modules/qq_p872/{__init__,state,transport,protocol,channel,runner,app}.py`、`backend/scripts/p872_qq_websocket.py`、`backend/tests/qq_p872_helpers.py`及三个`test_p872_*.py`、本报告。

最小修改`qq_p87/store.py`通道标识、`qq_p871/{config,http,protocol,routes,sandbox}.py`的共用接口和组合点，以及`backend/pyproject.toml`、`backend/uv.lock`。共21个本轮文件。不修改原产品全局入口/配置、Provider、迁移、React、Electron、素材或历史报告。

基线分支`codex/consumer-desktop-pivot`、HEAD`8986db95576ee50a61bb8ffa95b2dec6d432d928`；开始时191处历史未提交状态、692个原有源文件和18,781份历史证据纳入保护，运行中的旧桌面演示动态目录独立排除。历史未跟踪宠物/额度模块继续保留，不代为提交，因此本地集成依赖该完整工作树，不能宣称单独检出本次提交即可公开发行。

本地代码提交：`56e97420358a15dadc2f30ccec21f6a3e8723ef4`（20个文件），本报告单独作本地文档提交。完整提交和最终核验记录在validation目录的`commits.json`、`final-preservation.json`。提交前核验191处历史未提交状态、18,781份历史证据均不变，仅8个原本干净的基础文件发生本轮预期修改；无本轮残留Python服务，38712无监听，已有桌面演示保留。不推送、不部署、不发布、不关机。最终仅第一阶段通过，真实QQ连接及Mock回复保持未验证。

# P4-B 长期记忆检索与 Mock LangGraph 注入验收

状态：**P4B_VERIFIED，最终审查与复验通过**，最终结果见第11节。2026-11-01（Asia/Shanghai），仅针对本地后端和隔离依赖；不代表共享开发库升级、前端记忆功能完成、真实模型或生产发布。本报告随实现一并纳入当前功能分支的本地提交，完整哈希以本分支Git历史及最终交付为准。

## 1. 基线与范围

- 实际工作目录 `D:/AIProjects/WeiBiYe`，分支 `codex/p4a-memory-foundation`；开始时工作区及暂存区干净，没有切换分支。
- P4-A 三个本地提交均存在：`538f45f26f630978529e3854e0570e5f3fcad025`、`07393bdd05f6ce5f7a65fa8e474c925f38cabbe9`、`329f6ec35030e4f91fdab056017017bf202fa267`，开始时 HEAD 为最后一个提交。
- 已读五份 P4 设计文档、P4-A 范围及验收报告。实施仍基于 `p4-memory/1.0-draft`，补充说明见 [P4B_IMPLEMENTATION_SCOPE.md](D:/AIProjects/WeiBiYe/docs/P4B_IMPLEMENTATION_SCOPE.md)。没有修改共同设计文档。
- 检查了 Worktree、Git 锁和进程；本轮实现由当前工作区内分工明确的协作代理完成，最终复核阶段只读，没有操作其他 Worktree 或 AgentForge-AI。
- 前端、认证实现、Docker、钱包、旧迁移及0005迁移均未修改。没有远程推送、合并 main、部署、真实邮件、支付或付费模型调用。

## 2. 修改文件

| 文件（相对本项目根目录） | 内容 |
| --- | --- |
| `backend/app/agent/chat_protocol.py` | 记忆预算不可用的安全错误码 |
| `backend/app/agent/chat_runner.py` | 可提交失效检查、私人图接入及原 lease/epoch 屏障 |
| `backend/app/agent/graph.py` | 可选私人授权/检索/预算/装配节点与最终发送 guard |
| `backend/app/agent/providers.py` | 私人 Mock 文案与显式保存能力一致 |
| `backend/app/agent/state.py` | 仅本次调用有效的记忆状态 |
| `backend/app/core/config.py` | 默认关闭的注入开关校验与有界 Mock 预算配置 |
| `backend/app/modules/companion/router.py` | 本人生成任务的 memory-refs 路由 |
| `backend/app/modules/companion/service.py` | refs 投影及来源会话删除的统一锁/失效事务 |
| `backend/app/modules/memory/ports.py` | 带版本和来源的结构化检索接口 |
| `backend/app/modules/memory/router.py` | 接通预览/检索 API、收紧旧桥接资格 |
| `backend/app/modules/memory/schemas.py` | 检索请求及同来源重新确认 DTO |
| `backend/app/modules/memory/service.py` | 显式预览、聊天来源确认、检索解释和来源状态 |
| `backend/app/modules/memory/budget.py`（新） | Mock 计数、完整记忆装入及历史对裁剪 |
| `backend/app/modules/memory/injection.py`（新） | 实际生成授权、来源重验及引用落盘 |
| `backend/app/modules/memory/policy.py`（新） | 统一资格与到期/来源失效物化 |
| `backend/app/modules/memory/previews.py`（新） | 无持久化候选和签名来源回执 |
| `backend/app/modules/memory/retrieval.py`（新） | 有界词法检索与稳定排序 |
| `backend/tests/test_chat_runtime_review.py` | 校验更新后的私人 Mock 文案 |
| `backend/tests/test_chat_stream.py` | 提交后取消与提交前取消的确定性回归 |
| `backend/tests/test_memory_security.py` | 原未实现501断言升级为真实接口/零事实写入断言 |
| `backend/tests/test_memory_budget.py`（新） | 包装开销、边界、完整条目及历史裁剪 |
| `backend/tests/test_memory_graph.py`（新） | 图节点顺序、Provider guard、取消及演示隔离 |
| `backend/tests/test_memory_injection.py`（新） | 实际 API/Runner/LangGraph/SpyProvider |
| `backend/tests/test_memory_preview_api.py`（新） | 预览/确认、授权、CSRF、IDOR与回执生命周期 |
| `backend/tests/test_memory_previews.py`（新） | 提取、签名回执及隔离SQLite测试 |
| `backend/tests/test_memory_retrieval.py`（新） | 合成相关性金标与资格防御 |
| `backend/tests/integration/test_memory_p4b_postgres.py`（新） | 严格守卫的13项真实 PostgreSQL 验收 |
| `docs/P4B_IMPLEMENTATION_SCOPE.md`（新） | 实施边界、配置及接口补充 |
| `docs/P4B_VERIFICATION.md`（新） | 本报告 |

`.verification/` 内的运行脚本、JSON、日志和 JUnit 是被忽略的本地证据，不属于业务源码或待提交产物。

## 3. 已实现的接口与数据边界

沿用 P4-A 的 Cookie/CSRF/Origin、owner、输入白名单、32KiB请求上限、no-store 和限流机制：

| 接口 | 结果与边界 |
| --- | --- |
| `POST /api/v1/memory/previews` | 仅显式选择的本人 user 消息；1–5来源、至多3个原文摘录候选，persisted=false |
| `POST /api/v1/memory/items` | 逐条明确确认后，才同事务保存记忆/来源/确认事件/幂等记录 |
| `POST /api/v1/memory/items/{id}/confirm` | 聊天来源重确认必须新回执、原来源集合不变；manual旧指纹兼容 |
| `POST /api/v1/memory/retrieval-preview` | 当前授权下的匹配解释与预算；无模型调用、无查询正文保存 |
| `GET /api/v1/companion/sessions/{sid}/generations/{gid}/memory-refs` | 实际授权发送的引用元数据，删除/失效只显示 unavailable，不恢复正文 |

回执有效5分钟，绑定 owner、认证 session、偏好版本、隐私 epoch、完整来源集及内容HMAC，不含可读正文。确认可选择签名集合内的非空子集，但重新验证完整签名来源，不能扩展来源。保存一条会推进 epoch，同批其他候选需重新预览；前端不能复用旧批次 token。

预览、开启、SSE连接及 completed 都不自动保存长期记忆。聊天图没有提取/保存节点。授权默认关闭；最近话题使用独立 ChatPreferences，不能替代 MemoryPreferences。

## 4. 检索、预算与实际 Provider 输入

最多扫描本人200条 active 候选，先检查全局授权、归属、状态、撤销/删除/过期、合法当前版本 grant 以及全部来源，再做词法相关性排序。最多5条，至多1条明确交流偏好作为独立回退；无向量库或语义模型。

合成词法金标包括40正例、10不相关反例、10交流偏好。当前固定数据集上的主题 precision/recall 为1.0，交流偏好单独评估；这不代表真实用户场景的语义准确率。

私人图采用 prepare → authorize_memory → retrieve_memory → budget_context → assemble_context → respond。正文以低信任 user JSON 数据块传入，系统只加入固定安全说明。SpyProvider直接断言最终 messages 和 system_prompt，证明实际输入中出现了当前授权内容及来源，且没有其他账号、旧版本、已删除、已撤销或过期记忆。

`mock-token-v1` 是 UTF-8 字节与固定封装开销的测试单位，不是真实模型 tokenizer。默认 C=32768、O=512、G=256；M≤min(1024,floor(0.15×(C−O−G)),剩余空间)，最多5条。JSON包装计入预算，按完整条目装入；只移除最旧完整历史对，不能截断事实。实际 refs 的 used_tokens 合计与 SpyProvider 数据块计数相等。

Mock 固定回复不理解输入；未声称实现真实个性化回答、真实模型安全或真实 tokenizer。公共演示图没有私人运行时和记忆存储。

## 5. 撤销、删除与竞态

- 共用 User → Preferences → Session → Generation → Message → Memory 锁序；来源会话删除先取得 User/Preferences，并同事务撤销引用该来源的 active 记忆。
- 到期/来源失效在独立可提交边界推进 epoch/revision/context floor，避免随后 FenceLost 使失效状态回滚。旧派生历史不再自动进入后续输入。
- before_provider 在 Provider 迭代器创建之前短事务重验 owner、状态、lease、epoch、grant/version、到期及来源，记录实际引用和 memory_snapshot_at；提交后才调用 Provider。
- 真实 PostgreSQL 竞态通过 pg_blocking_pids 证明：删除记忆或来源会话持有 owner 锁时，发送 guard 确实被阻塞；删除先提交后 Provider调用数0、refs0、助手正文空、唯一 cancelled(memory_policy_changed)终态。
- 撤销授权、单条撤销、纠正和过期的实际 Runner/Spy 回归保证后续输入不再引用旧内容；delta/finish/renew保留 lease/epoch屏障。SSE重放不重复检索、保存、记录引用或调用 Provider。
- 授权发送事务先提交的输入属于在途，不能保证召回；后续输出仍受屏障限制。备份、已下载副本及已返回字节无法由普通删除 API 清除，不宣称生产级物理删除。

审查发现并修复来源会话删除未遵循 owner 级串行化的问题，增加真实PG阻塞回归。其他只读复核未发现新增必须修复的安全问题。

## 6. 隔离数据库与兼容性

共享开发库只读身份为 `127.0.0.1:25433/weibiye`，用户weibiye，集群 `7703042374370492450`，开始时0004、21业务/认证表。没有在共享库注册账号、创建记忆或执行迁移。

本轮新建并保留独立库：

`weibiye_p4b_test_3229a21ad5f9426ba0b43c8e75fe3d5b`

写入守卫要求精确本机端口/用户/集群、`weibiye_p4b_test_`加32位随机hex，拒绝共享weibiye；真实测试还要求0005、26业务表。所有账号和记录是明确的合成测试数据，不清库、不drop、不truncate、不downgrade。

验证顺序：

1. 仅隔离库精确向前迁移至0004，当前代码注册/登录、Mock SSE与消息持久化通过；新应用实例携带原Cookie恢复相同消息ID，真实Redis参与readiness。
2. 写入一条合成旧记忆，并保存21张旧表各原列的行数与SHA-256摘要。
3. 仅隔离库精确向前迁移0005，26业务/认证表（另有Alembic版本表）、模型差异0；旧表原列行数和摘要全部一致，旧记忆保持legacy_unconfirmed且没有伪造授权。
4. 隔离0005启用管理/注入时，Alembic current为0005(head)，check无新操作；/health/live与/health/ready均200，真实Redis PING正常。

P4-B没有新增schema或迁移；0004/0005明确能力白名单、未知版本拒绝、结构manifest以及P3版本感知ORM均保留。

## 7. 实际测试结果

| 验证 | 实际结果 |
| --- | --- |
| 预览辅助函数及隔离SQLite专项 | 27通过，23.74秒 |
| 词法检索与预算纯测试 | 修复一项中文常见话术误匹配后92通过，0.63秒 |
| 纯LangGraph顺序/隔离测试 | 8通过，0.24秒 |
| 实际SQLite/API/Runner/LangGraph/Spy | 15通过，53.98秒 |
| 预览API及既有安全回归 | 53通过，127.77秒 |
| 首次完整pytest | 461通过、1失败、0错误、44条件跳过，526.85秒 |
| 取消时序定向回归 | 4通过、0失败、19未选用，10.19秒 |
| 初步验收的最终完整pytest | **464通过、0失败、0错误、44条件跳过；520.49秒，退出码0** |
| 初步P4-B真实PostgreSQL专项 | 10通过、0失败、0跳过，38.62秒 |
| 真实Redis+隔离PG双账号独立冒烟脚本 | 通过，退出码0；不混入pytest数量 |
| Ruff check / format --check | 通过，131个Python文件格式符合要求 |
| 0004→0005非空迁移/模型/旧数据摘要 | 通过；26业务表、模型差异0 |
| 0005 Alembic current/check及真实DB/Redis readiness | 通过；head0005、无新操作、live/ready200 |

首轮唯一完整套件失败发生在旧“运行中取消保留已提交片段”测试：Provider等待信号只表示LangGraph队列已写入，不保证消费者的DB提交完成。取消先提交时正文为空符合安全语义。修复测试同步，显式等待真实_flush提交后再取消，保留原断言；另增“提交前取消/删除”两个回归，断言空正文、无delta、Provider关闭及唯一终态。没有删除测试、跳过断言或弱化权限。

完整默认套件44项条件skip来源：P4-B PG10、P4-A PG10、P4-A隐私竞态2、P4-A Redis1、旧auth PG1、P3 PG10、local infrastructure9、P3 Redis pool1。P4-B十项已在上述精确隔离环境单独全部执行；其余34项沿用各自专用守卫，本轮不冒称重新通过。真实依赖证据另见0004/0005冒烟与新的Redis脚本。重复专项运行不累加为独立总数。

最终完整套件收集508项；新增的提交前取消两个用例包含在464通过之内。没有把定向重复运行、10项单独PG运行或独立脚本加到完整套件通过数中。

P4-B十项PG pytest使用内存认证/限流后端，仅其数据库是真实PG；新的独立Redis脚本才使用实际Redis认证、限流、撤销和双账号记忆注入：实测get66、set3、eval47、revocation_set1。透明测试前缀只隔离AuthStore键，命令仍转发真实Redis；SSE使用独立chat_scope。全部测试键有TTL自然过期，没有FLUSH、全局扫描或删除既有键。

## 8. 收尾与安全检查

20:29 +08:00收尾检查通过：共享开发库仍0004、21张业务/认证表；全部原表及版本表的行数和完整行SHA-256与本轮开始时一致，schema快照一致。没有对共享库升级或写入业务数据。

`weibiye-postgres-1`、`weibiye-redis-1`的容器ID、running/healthy、启动时间、重启次数、端口绑定和挂载均与before.json一致；Redis run_id未变，PING仍正常。没有启动/停止/重建容器、网络、卷，也没有操作其他项目资源。本轮新增的隔离测试数据库及合成数据保留供审查，不自动清理。

pytest、Alembic和本轮冒烟进程已全部退出；检查到的本项目测试进程0，38304/35304/38204/35204测试端口监听0，Git锁0。API由TestClient执行，本轮没有启动常驻HTTP服务器或浏览器服务。

其他三个Worktree的分支、HEAD及干净状态未变；main和p3-chat-verified解引用的commit仍为ae6fd446。Git收尾脚本首轮把附注标签对象哈希与commit哈希直接比较，产生误报；已用`p3-chat-verified^{commit}`复核通过，分支/标签没有发生变化。

源码敏感模式扫描找到一处既有、明确标记synthetic-not-a-real-key的测试向量；已人工确认是拒绝敏感记忆的合成样本，不是真实凭据。新HMAC测试常量只用于隔离测试，实际运行配置/日志/缓存/证据不进入Git。应用日志保持模板路由、状态、耗时和固定错误码，SQL echo及图tracing关闭；日志回归检查正文、Cookie、CSRF不出现。

## 9. 初步验收的Git及证据

初步验收结束时P4-B共29个修改或新增文件，尚未暂存、未提交；分支为`codex/p4a-memory-foundation`，HEAD为P4-A的 `329f6ec35030e4f91fdab056017017bf202fa267`。这是初步验收的历史快照，本次最终审查与本地提交状态见第11节。

本轮证据目录：

`D:/AIProjects/WeiBiYe/.verification/p4b-3229a21ad5f9426ba0b43c8e75fe3d5b/`

包含before.json、两版隔离schema、v4-api-smoke.json、v4-nonempty-before.json、nonempty-migration-preservation.json、pytest-full/final与postgres JUnit/log、cancel-regressions、readiness、redis-smoke、after.json、final-git-processes.json及文件SHA审查。早期失败日志保留，不用最终成功覆盖首轮失败记录。

实际通用命令（在`D:/AIProjects/WeiBiYe/backend`）为：

```powershell
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m ruff check .
.venv\Scripts\python.exe -m ruff format --check .
```

真实PG专项显式设置`WEIBIYE_P4B_TEST_DATABASE_URL`为第6节隔离库，再运行`-m pytest tests/integration/test_memory_p4b_postgres.py -q`；没有共享开发库回退。URL中的本地凭据不写入报告。迁移、Redis、readiness和收尾守卫脚本保留在上述忽略的证据目录中。

## 10. 遗留边界与下一阶段

- 共享开发库仍0004，默认管理/注入关闭；升级共享库需要另行备份/恢复演练及精确0005升级授权。
- 没有前端记忆预览/确认/管理联调；前端应处理每次确认导致旧回执失效，按服务端版本重新预览。
- 未实现真实模型、真实tokenizer、语义检索、自动提取/摘要、后台记忆保存、多端客户端或备份删除清单。敏感筛查仅本地规则，不保证识别所有敏感信息或心理健康风险。
- 当前安全检查保守重复扫描最多200条active记忆；多个活跃任务会增加DB往返。未来可按owner合并检查，但不得移除最终发送/写回屏障。
- Mock/Spy证明授权与实际装配，不证明真实模型遵守低信任数据规则或提供智能建议。

下一阶段可准备前端记忆交互与独立联调；进入条件以第11节最终审查及本地提交为准，真实模型继续关闭。

## 11. 最终代码审查与本地提交（本次）

初始路径、分支和HEAD与初步验收一致；29文件逐一SHA-256对比，没有验收后的外来修改，暂存区为空。五份设计文档、实施范围、P4-A/P4-B报告与实现已重新对照；未修改共同契约。

### 审查问题与修复

1. **关闭注入时的发送竞态。** 普通历史上下文加载完后，另一应用实例先提交删除/单条撤销/关闭授权，旧实现仍可能构造Provider并发送旧历史，直到输出写回才被屏障拦截。新回归在旧实现实际复现`Spy constructed 2 != 1`。修复为所有私人普通聊天在构造Provider迭代器前执行`_authorize_dispatch`，按既有User→Prefs→Session→Generation→Message锁序复核owner/status/session/state/lease/epoch。注入开启时沿用原runtime guard，不重复检查；公共演示默认不安装私人guard；0004仅访问V4字段。新增跨应用三类隐私操作、图层顺序/拒绝/去重，以及真实PG对应三类回归。
2. **英文别名子串误匹配。** `curiosity`中的ios、`disregard`中的sre可能误命中职业记忆。ASCII别名改为完整词/词组边界，保留中英邻接、连字符和多词别名；新增12个正负回归。只改变匹配，不改写用户记忆正文。
3. **限流桶与契约不一致。** 预览与检索预览原共用10次额度；已拆成各10次/分钟/owner。新增真实API回归验证各自第11次429及Retry-After60、账号隔离、偏好和记忆事实无写入。

未发现未经逐条确认保存记忆的路径、跨账号读取路径或日志回显正文/Cookie/密钥路径。完整记忆装入/跳过、JSON封装计数、完整历史对裁剪和Mock专属计数规则保留，未知Provider/模型仍拒绝。默认管理/注入及用户授权继续关闭。新普通聊天guard是P3路径唯一新增安全边界，P3响应DTO、SSE事件格式、幂等和持久化规则没有改变。

### 本次实际复验

| 项目 | 结果 |
| --- | --- |
| ASCII别名模块（含12个新增回归） | 80通过，1.71秒 |
| 新增独立限流API回归 | 1通过，3.49秒 |
| 普通历史发送竞态及cap定向 | 4通过，12.39秒；旧实现失败证据保留 |
| 图/注入/P3 runtime/迁移四模块 | 52通过、0失败/跳过，74.30秒 |
| 本次完整pytest | **483通过、0失败、0错误、47条件跳过；541.06秒，退出码0** |
| 真实隔离PostgreSQL | 13通过、0失败/跳过，47.29秒 |
| 真实Redis+隔离PG双账号冒烟脚本 | 通过，退出码0；Cookie/CSRF、确认/输入/引用、SSE重放、撤销、退出与隔离 |
| 新普通guard的真实0004兼容冒烟 | 通过；Mock SSE、2条消息落盘、新应用恢复相同消息ID；记忆管理503 |
| 0005 Alembic current/check/readiness | head0005、模型差异0、无新操作、live/ready200、实际Redis PING正常 |
| Ruff check/format check | 通过，131文件；警告/权限断言未削弱 |

当前13项PG测试复用精确隔离库`weibiye_p4b_test_3229a21ad5f9426ba0b43c8e75fe3d5b`，每项创建新的随机合成账号；没有在共享开发库测试。为验证新guard的0004真实SQL兼容，另建确认不存在的`weibiye_p4b_test_ab9779342d8f4193b822c745656626eb`，仅对这个空测试库精确向前迁移至0004，数据保留，不执行任何downgrade或清理。没有重复迁移已验收的0005库。

完整套件收集530项；47项条件skip中，本阶段PG13项已用明确隔离配置单独全部执行通过，其余34项历史专项未重跑（第7节已列明）。本次新增19项通用回归及3项PG条件回归；不把专项重复运行、脚本或历史464通过累加到483之中。

本次Redis使用新的`p4b:test:cf682ac637c34622b7e394f9db51767e:`命名空间及TTL，实测get66/set3/eval47/revocation_set1；没有FLUSH或扫描清理。SQLite/PG的测试认证后端与真正Redis脚本证据继续分别报告。

新证据目录：`D:/AIProjects/WeiBiYe/.verification/p4b-final-f85c507c03db4895861e5f11c184fe9c/`。另有`.verification/p4b-final-plain-dispatch-before.log`、`p4b-final-plain-dispatch-after.xml/log`和`p4b-final-runtime-targeted.xml/log`；旧失败及初步验收证据均保留。

### 收尾、暂存与提交

20:50 +08:00收尾核对通过：共享开发库仍0004、21业务表，schema、行数及所有原表完整行SHA-256与本次before快照相同；专用容器ID/运行健康/启动时间/重启次数/绑定/挂载及Redis run_id未变。main、原标签、全部分支引用和Worktree元数据在提交前均与本次开始时一致。没有访问其他Worktree文件或改变它们的内容。

全部pytest、数据库及冒烟脚本均已退出，项目测试进程0、38304/35304/38204/35204测试监听0、Git锁0。本轮未启动常驻HTTP或浏览器服务，未清理任何数据库或Docker资源。已测试业务源码与审查时SHA-256一致，后续只更新本报告。

待提交范围严格为第2节29文件；仅在`codex/p4a-memory-foundation`以P4-A的329f6ec为父提交建立一个P4-B本地提交。提交前按精确路径白名单、Git暂存blob及敏感模式审查，不包含.verification、缓存、密钥或运行产物；唯一密钥样式命中为已人工确认的synthetic拒绝测试样本。未配置额外提交钩子或签名操作。main与原标签不前进，不合并、不推送、不部署；提交后的完整hash和工作区状态由最终Git检查记录。

**具备从本次本地提交进入P4-C前端记忆管理/逐条确认及独立环境真实API联调的代码基线条件。** 下一阶段应基于本次提交，避免从仍为P3的main漏掉P4-A/B实现。共享开发库仍0004，默认功能仍关闭；共享库0005升级、真实模型和生产发布分别需要后续授权。候选回执刷新、跨账号缓存、双端失效、桌面/移动浏览器验收和备份恢复后的防复活仍属后续工作，不冒充已完成。

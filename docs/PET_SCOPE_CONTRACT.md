# Pet scope foundation / 1.0

本轮新增契约；保留 P3/P4 v1 的 legacy 使用方式。共享开发库保持0005；只有独立测试库升级0006。未知版本继续拒绝，0005的既有聊天/记忆不因新增模型失效。

## 身份、兼容与数据

- owner来自Cookie认证，pet_id由服务端生成UUID且不可修改。创建负载禁止owner_id/user_id/pet_id/id。
- 新增 pets，及显式的 pet_chat_bindings、pet_generation_contexts。每个宠物使用新建的内部AICompanion；不把已有companion_id当作已授权pet。
- 旧会话没有pet_chat_binding，继续位于legacy；0006不回填归属、不重写旧消息/记忆/授权。没有自动归属或复制API。
- pet_id省略只表示legacy，绝不表示所有宠物。旧v1聊天入口不能用宠物的内部companion_id创建或访问宠物会话。
- 为保持P3/P4旧客户端兼容，旧v1接口仍允许创建未归属的legacy会话与账户记忆；它们不会进入任何宠物的列表或模型上下文。新宠物客户端必须始终走显式pet路径。是否关闭旧版新建并将旧入口改为只读，属于后续客户端切换及契约退役决策，本轮不强制切断。
- 宠物记忆使用独立的pet_memory_preferences、pet_memories、pet_memory_consents、pet_memory_sources、pet_memory_operations，不读取旧memories作为默认输入。旧P4授权状态和数据保持不变。
- 新表使用统一Base；不向原P3/P4 ORM映射增加会导致0005 SELECT失败的列。迁移只创建新表/索引/约束，禁止数据回填、drop、downgrade。

## 宠物配置

pet响应含pet_id、name、role_type、persona_config、appearance_config、status、version、created_at、updated_at。personality/appearance必须有界、字段白名单；外观只接受受控asset_id/颜色/比例等数据，不接受任意URL、磁盘路径或可执行脚本。

- active正常使用；hidden只影响默认展示，指定ID仍可访问；archived保留读取、禁止新会话/新生成/配置及记忆新增、编辑、重确认和开启授权，并取消该宠物在途任务。为保留隐私控制，归档后仍可关闭授权、撤销、删除和清空记忆；这些命令仍校验Cookie、CSRF、owner＋pet、版本及幂等，并保持原写锁与隐私屏障，绝不以只读事务绕过锁。
- 编辑/隐藏/归档使用expected_version，冲突409；不存在或跨owner/跨pet资源统一404；未登录401；写操作继续Cookie、Origin和CSRF。归档不是删除或撤销授权，不得让归档永久封死用户的记忆删除控制。
- 人格编辑不改变已接受生成任务。接受任务时存人格版本和快照；Provider必须实际收到快照，即使记忆关闭。

## REST接口

所有路径以/api/v1/pets开头，复用现有错误信封、Cookie及CSRF。创建操作使用Idempotency-Key，服务端按owner、pet、操作域隔离；同key不同负载409。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | / | 创建，201；重放返回原宠物 |
| GET | / | 仅本人列表；默认active，可显式选hidden/archived |
| GET | /{pet_id} | 详情 |
| PATCH | /{pet_id} | 编辑name/role/persona/appearance，expected_version |
| POST | /{pet_id}/visibility | hidden布尔与expected_version |
| POST | /{pet_id}/archive | expected_version；归档保留数据 |
| POST/GET | /{pet_id}/sessions | 会话创建/按宠物分页 |
| GET/PATCH/DELETE | /{pet_id}/sessions/{session_id} | 详情/重命名/逻辑删除 |
| GET/POST | /{pet_id}/sessions/{session_id}/messages | 历史分页/发送 |
| POST | /{pet_id}/sessions/{session_id}/generations | 重试 |
| GET | /{pet_id}/sessions/{session_id}/generations/{generation_id} | 状态 |
| POST | 同上/cancel | 取消 |
| GET | 同上/events | SSE |
| GET | 同上/memory-refs | 本宠物生成的记忆引用 |
| GET/PATCH | /{pet_id}/memory/preferences | 独立授权默认关闭；开启需要明确确认 |
| GET/POST | /{pet_id}/memory/items | 列表/逐条确认后创建 |
| GET/PATCH/DELETE | /{pet_id}/memory/items/{memory_id} | 详情/纠正/擦除正文 |
| POST | /{pet_id}/memory/items/{memory_id}/revocations | 撤销单条 |
| GET | /{pet_id}/memory/items/{memory_id}/sources | 来源 |
| POST | /{pet_id}/memory/clear | 明确确认清空本宠物记忆 |
| POST | /{pet_id}/memory/export | 仅本宠物导出 |
| POST | /{pet_id}/memory/previews | 选中本宠物消息的候选预览；不保存 |

分页游标、预览回执、幂等操作域必须绑定owner+pet；不接受跨宠物/legacy回执。宠物聊天与记忆复用 P3/P4 DTO 并添加 pet_id；部分路由当前未声明独立 OpenAPI response_model，消费端以本文明确的响应字段和已有 P3/P4 字段为准，不依赖空的生成响应类型。

### 请求、响应与版本

- POST /api/v1/pets 不带末尾斜杠。负载为 name（1–60字）、role_type（cat/dog/custom，默认custom）、persona_config（description最多600字、tone为warm/playful/calm）、appearance_config（asset_id安全短名最多64字符、tint为#RRGGBB、scale为0.5–2）。嵌套对象禁止额外字段。响应201直接为Pet对象，不包装在pet字段中；同幂等键同负载重放仍返回201及原pet_id。
- PATCH /{pet_id} 为上述至少一个可编辑字段加 expected_version；不允许null改写。visibility为 {hidden:boolean,expected_version:number}；archive为 {expected_version:number}。成功200直接返回Pet对象。不存在/跨用户404；版本或归档写冲突409；非法输入422；未知或缺少宠物schema503。
- GET /pets?status=active&limit=30&cursor=... 返回 {items:Pet[],has_more:boolean,next_cursor:string|null}；limit为1–100，默认只列active。hidden不改变归属权限，archived只读。pet_id始终为服务端生成UUID，version从1开始；配置变更增加版本。
- 宠物会话创建负载仅 {title?:string}，不接受companion_id；成功201 {session:StoredSession,idempotent_replay:boolean,pet_id}。会话、消息、生成DTO保留P3全部字段并增加pet_id，接受发送/重试返回202及 generation、user_message、assistant_message、events_url、idempotent_replay、pet_id。客户端必须校验这些实体的pet_id，不能只看URL。
- 列表与消息历史保持P3游标分页。重命名 {title,expected_version}；消息 {content,client_message_id}；重试 {retry_of_generation_id}；取消POST空对象，响应{generation,pet_id}：排队取消或已终态200，运行中请求取消202。删除会话204，保留逻辑删除与事件留存语义，不删除原数据库对象。
- 记忆preferences、items、sources、changes、previews、retrieval-preview、export顶层均有pet_id，item本身也有pet_id。preferences保持P4版本、privacy_epoch、context_epoch_floor、context_not_before、revision、sync_cursor、policy_version与notice_version；BigInt标识继续用十进制字符串。
- GET /{pet_id}/memory/changes?cursor=...&limit=100 保留P4增量事件分页、high_watermark与reset_required；游标绑定owner+pet。GET列表同时支持 snapshot_revision 以校验跨页一致性。
- 开启授权 PATCH preferences 为 {long_term_memory_enabled:true,expected_version,consent:{confirmed:true,policy_version:"memory-policy/1",notice_version:"memory-notice/1"}}；关闭为false及expected_version。默认关闭，关闭不自动删除聊天或其他宠物的记忆，不改变旧版最近话题授权。
- 手动POST items为 {title,content,category,expires_at?,expected_preferences_version,consent,source:{kind:"manual"}}；成功201 {item,idempotent_replay,pet_id}。编辑PATCH增加expected_version。删除DELETE携带 {expected_version} 返回204；撤销POST revocations携带同样版本；清空POST clear携带 {expected_revision,confirmed:true} 返回204。写命令带独立Idempotency-Key。
- POST previews沿用P4选中消息协议：{session_id,message_ids,expected_preferences_version,consent:{confirmed:true,notice_version:"memory-preview/1"}}。仅本宠物的1–5条本人消息；返回候选、preview_token、expires_at、extractor_version、persisted:false、pet_id。预览不保存。逐条确认POST items使用source:{kind:"chat_message",session_id,message_ids,preview_token}及显式consent。
- POST items/{memory_id}/confirm 保留P4显式重新确认协议；不会由开关、恢复、导出或SSE重放自动调用。POST retrieval-preview仅预览授权检索，使用P4 query/limit契约，不保存。
- 导出POST {format:"json",include_inactive:true}；新域schema_version为pet-memory/1，包含pet_id、exported_at、snapshot_revision与仅本宠物items。旧域继续p4-memory/1.0-draft。普通API不返回已擦除的记忆正文。

类别暂保留P4兼容枚举：career_goal、communication_preference、experience、open_topic、explicit_note。它不重新引入求职业务；历史值不可因文案调整擅自改写。来源中的session_id/message_id须同时属于owner及pet。

## SSE与运行时

- 复用P3持久化事件协议、gid:sequence事件ID、Last-Event-ID排他重放和唯一终态。新宠物流的所有事件额外带pet_id；events_url必须为对应pet路径。
- session/generation/message及pet不匹配时，发出SSE头之前404；每轮重放/实时推送继续鉴权和作用域复核。
- 生成身份和persona快照写入pet_generation_contexts；拒绝把取消/重试/恢复重新绑定另一宠物。重放不重新调用Provider。
- 保留User大锁作为安全串行化基础，顺序统一为User→Pet→PetMemoryPreferences→Session→Generation→Message→Memory；无请求绕过既有认证/owner验证。
- 新宠物生成只检索本pet授权的有效记忆，默认不读legacy或另一宠物的记忆。删除/撤销/归档更新本pet隐私屏障，阻止下一次Provider发送、flush及完成写回；不波及其他pet。
- 删除/撤销后不通过旧会话上下文重新注入旧事实；采用本pet的context_not_before/epoch过滤历史。保留聊天原文，不清理历史。
- 记忆和personality均受token预算约束，personality不以记忆开关为前提。只使用Mock/Spy验证，不调用付费模型。

## 桌面客户端与前端

- Windows客户端未来调用同一API，可信来源/Cookie/CSRF不放宽；fetch流带credentials和Last-Event-ID。IPC仅传递允许的宠物操作，不接受模型的任意系统命令。
- 前端按认证scopeVersion+pet_id建立不可变数据作用域，换宠物中止旧请求/流并丢弃迟到响应，不把私人正文持久化到localStorage。
- legacy入口保留；宠物页使用明确pet路由，不把旧记录自动合并进新宠物。共享0005上的新接口明确503，不假造成功。
- 本轮不实现桌面窗口/动画/安装包，也不引入养成或支付。

## 验收

验证旧0005兼容、隔离库0005→0006旧表/数据哈希不变、新表/复合FK、默认无归属/无授权；两用户×两宠物、隐藏/归档、人格Spy、跨pet会话/消息/游标/记忆/来源/回执、SSE取消/重放、删除撤销竞态及前端换宠物缓存隔离。保留社区清理基线83c1b094。

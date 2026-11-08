# Windows 客户端接入准备

契约版本：pet-scope/1.0。本轮交付是服务端与Web调用基础，不包含Windows程序、桌面窗口、动画、多屏拖动或安装包。

## 作用域与登录

客户端先使用既有认证API登录。服务端根据HttpOnly Cookie确定owner，不接收客户端声明的user_id作为权限依据。所有宠物操作必须显式指定pet_id。选择宠物后保留不可变的scope对象；切换宠物或账号时中止旧请求、关闭旧流、清理旧缓存，并拒绝旧scope的迟到响应。

桌面可信Origin、HTTPS与Cookie运行方式需要后续宿主选型后单独验收。当前仅接受既有CORS白名单与Origin，不能为了file://、自定义协议或本地窗口关闭CSRF/Cookie安全检查。没有本地长期Token或绕过认证的IPC入口。

## 调用顺序

1. GET /api/v1/auth/me确认身份；未登录使用既有注册/登录流程。
2. GET /api/v1/auth/csrf取得CSRF值，写请求带X-CSRF-Token及可信Origin，Cookie自动随请求发送。不把Cookie或长期认证Token存入localStorage。
3. GET /api/v1/pets列举active宠物，需要时分别查询hidden和archived。创建请求使用新的幂等键，重试原请求复用原键与原负载。
4. 选中pet_id，使用 /api/v1/pets/{pet_id}/sessions 创建和读取会话，不使用旧版companion_id替代宠物身份。
5. POST sessions/{session_id}/messages接受用户消息与生成任务，校验返回的generation、user_message和assistant_message的pet_id一致。
6. GET generations/{generation_id}同步已保存状态，再读取同一路径/events。流请求带credentials:include；重连带Last-Event-ID；只重连GET，不重新发送POST。
7. 取消使用同一pet、session、generation的/cancel；取消与完成竞争时以持久化终态为准。用户另一次明确“重新生成”使用新幂等键；同一命令因网络结果不确定而重试时，复用原键和原负载。
8. 授权记忆只使用当前 /pets/{pet_id}/memory 路径。先查preferences，再明确开启；候选预览后逐条确认，不能依据人格配置、聊天内容或全局开关自动保存。

所有generation级SSE事件保持P3 version=1，额外有pet_id。客户端在去重之前验证pet_id/session_id/generation_id/message_id，再处理gid:sequence；不能把跨宠物事件当作重复忽略。网络断开不等于取消，SSE重放不触发新生成或新记忆保存。

## 本地窗口与外观

pet_id是窗口和UI状态索引，不能成为访问授权凭据。外观配置仅为受控asset_id、颜色和比例；当前asset_id不保证存在可渲染动画，Web使用占位图标。未来宿主应维护内置资源清单，禁止把配置解释为URL、任意文件路径、脚本或系统命令。

未来IPC可定义 pet.open、pet.move、pet.interact、pet.recall 等白名单操作，操作参数须有边界；这轮没有实现这些IPC。模型输出不能直接调用系统或控制其他宠物窗口。

## 兼容边界

数据库0004保持P3聊天，0005保持P3/P4旧功能，0006新增宠物功能；未知版本拒绝。共享开发库本轮停留0005，宠物功能会明确503，需后续单独授权升级后使用。没有自动迁移、自动回填或把旧记忆复制给宠物的启动步骤。

旧会话与旧记忆继续通过旧版入口管理；当前无旧数据归属变更API。归档宠物保留读取并停止在途生成，禁止新会话、生成、配置修改、记忆新增编辑和重新开启授权；仍允许关闭授权、撤销、删除和清空记忆，保留用户隐私控制。没有取消归档和物理删宠物接口。需要永久删除宠物全部数据时必须单独设计并获得授权，不以本轮归档替代数据删除承诺。

# P6 桌面桥接与可复用模块

契约版本：desktop-pet/0.1。仅用于当前Windows本地开发预览；它补充PET_DESKTOP_API，不修改后端认证、聊天或记忆契约。

## 职责与身份

React沿用现有Cookie、CSRF、AuthProvider、Query缓存、pet路由、SSE解析／重放／取消和记忆授权界面。Node主进程的loopback网关提供同源React静态构建和固定API目标转发，既不合成Cookie／CSRF，也不接收用户可控的远程目标URL。

UI与聊天窗口共享随机、非持久session分区。桌宠小窗口使用另一空Cookie分区，不能请求API；只接收宠物ID、名字、类型、颜色及动画状态。聊天／记忆正文不经过IPC。认证Cookie改变时立即销毁旧宠物与聊天窗口，清空Chromium私有缓存，并通知React清除活跃私人缓存；不会删除PostgreSQL历史。

每个窗口与当前owner和pet_id绑定。主进程校验调用方为登记的主frame、来源和窗口角色，随后通过真实API校验当前Cookie用户与宠物归属；不能传user_id自证身份。所有中间状态通知按owner过滤。聊天窗口仅能操作本宠物，不能导航到另一个宠物的聊天页。

## UI预加载白名单

| 方法 | 行为 |
| --- | --- |
| list() | 重新核验身份与归属，返回当前用户已放出的宠物窗口快照 |
| release(pet_id) | 放到桌面，重复调用复用同一窗口；最多三只 |
| hide(pet_id) / show(pet_id) | 本地隐藏／显示，不修改后端status或历史数据 |
| recall(pet_id) | 关闭对应桌宠与聊天窗口，不删除后端记录 |
| openChat(pet_id) | 打开对应pet路由，复用当前窗口并记住内存内历史路由 |
| syncSession() | 以服务端Cookie重新确认身份，无凭据输入输出 |
| onChange(callback) | 订阅owner_id、authenticated及当前宠物快照；返回取消订阅函数 |

快照只含pet_id、name、role_type、tint、state、direction、hidden、chat_open。没有聊天正文、路径、凭据或任意脚本参数。

## 桌宠预加载白名单

identity()、onState(callback)、chat()、menu()，以及dragStart({x,y})、dragMove({x,y})、dragEnd()。窗口身份由主进程登记，桌宠不能传另一个pet_id替换目标。

按下时只暂停调用方自己的动画位移；真实鉴权成功才授予最长10秒的本地拖动租约。高频dragMove不重复访问私有API，只允许有限坐标和已授权租约，拒绝过期、旧Cookie代次、其他sender和非有限数值；Cookie改变或5秒归属巡检失败立即撤销。拖动阈值6px，拖后不打开聊天。

## 本地权限与资源

关闭Node集成，开启sandbox/contextIsolation/webSecurity；拒绝任意新窗口、外站导航、webview与系统权限。唯一保留的下载是已认证记忆页用户明确发起的同源Blob JSON导出，受文件名／MIME／大小／Cookie代次限制，仍使用系统保存对话框。没有通用文件、命令执行、键盘钩子或远程调试IPC。

动画由集中运动调度和本地原创SVG组成。manifest包含固定资产白名单和Live2D能力槽（NOT_IMPLEMENTED）；当前没有Live2D SDK、Core、模型加载器或可用Live2D渲染适配器。未来需先审查SDK与模型许可，再在相同窗口／身份边界下增加渲染实现，不能接受任意脚本或资源路径。

## 生命周期和后续边界

窗口位置仅存内存，限定主显示器工作区；不宣称多显示器、睡眠唤醒或坐标持久化已经验收。主界面关闭后留在托盘，托盘退出销毁本应用窗口、动画、请求、Cookie分区和网关，不结束外部FastAPI、Docker或其他应用。

开发预览的本机API依赖已有隔离0006数据库；安装后直接面向普通消费者使用仍需托管API／客户端分工、HTTPS、正式安装器、签名、更新及干净Windows验证。GPT／DeepSeek和付费调用保持关闭。

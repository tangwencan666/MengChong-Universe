# P7 本地角色预览启动

仅限当前Worktree、明确的本机测试账号和隔离0006测试库。原开发库weibiye仍为0005；这些命令不创建数据库、不迁移，也不启用真实聊天模型。DeepSeek娘图片授权未确认，只能本地预览，不进入默认portable分发。

本次目标是测试账号A的“月芽”，按owner_id＋pet_id精确匹配，其他宠物和后端名称、人格、聊天、记忆不改。不开启三个显式预览参数时仍显示P6默认外观。旧P6便携包没有被覆盖，P7从当前Worktree运行。

先检查127.0.0.1的38316／35316是否空闲；发现已有服务时先确认归属，不结束其他进程。

在一个终端启动已有的专用测试API：

```powershell
Set-Location D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend
.venv\Scripts\python.exe -B scripts\p7_character_server.py
```

该脚本读取本机.verification/p7/target.json，重新核对P6隔离数据库、集群、0006／34表与Redis实例，使用新的P7 Redis键前缀和P7证据目录。清单缺失或目标不符时停止，禁止回退默认开发库。测试账号是本机合成fixture，不在报告或命令行输出密码。

另一个PowerShell终端启动角色预览：

```powershell
Set-Location D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot
$p7PreviewTarget = Get-Content -Raw -LiteralPath '.verification/p7/target.json' | ConvertFrom-Json
npm --prefix desktop start -- --backend-origin=http://127.0.0.1:38316 --ui-port=35316 --local-character-preview=deepseek "--preview-owner-id=$($p7PreviewTarget.accounts.a.user_id)" "--preview-pet-id=$($p7PreviewTarget.accounts.a.pets[0].pet_id)"
```

使用对应测试账号登录后，在“我的宠物”页放出月芽、豆包和小云。仅月芽使用透明DeepSeek娘素材；豆包／小云仍为原SVG。短点击打开对应聊天，拖动移动，右键和托盘管理显示／收回。关闭主界面保留托盘，退出请使用托盘“退出未毕业”。外部测试API由其终端单独中断停止，不停止PostgreSQL或Redis。

素材文件必须恰好为desktop/local-preview/deepseek-open.png与deepseek-blink.png；不能把说明、原图或其他文件放进这个受限目录。授权、来源、SHA及生成提示词位于同级docs/p7文档。不能在缺图时自动改用截图或把所有cat角色一起替换。

本次原生26项检查及8组性能已完成，测试服务已停止，需要预览时才按以上步骤启动。实际系统125%已验证；100%／150%仅做过Electron进程内倍率检查，没有修改系统显示设置。独立摇尾巴没有实现。

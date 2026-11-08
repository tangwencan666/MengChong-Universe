# P8.5 本地多实例验收操作

仅限当前已保留前置成果的工作树。所有测试使用临时 SQLite、合成账号和明确的 Mock，不使用共享数据库或真实模型。不要运行 P8.1 付费验收，也不要把 Mock 结果计作真实 DeepSeek 结果。

## 后端专项与静态检查

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\backend'
.\.venv\Scripts\python.exe -B -m pytest tests/test_p85_instances.py tests/test_pets.py tests/test_pet_chat.py tests/test_pet_memory.py tests/test_pet_memory_races.py -q -W error
.\.venv\Scripts\python.exe -B -m ruff check app/modules/pet_instances tests/test_p85_instances.py app/api/router.py
.\.venv\Scripts\python.exe -B -m ruff format --check app/modules/pet_instances tests/test_p85_instances.py app/api/router.py
.\.venv\Scripts\python.exe -B -m ruff check --config pyproject.toml ../desktop/test/fixtures/p85_server.py
.\.venv\Scripts\python.exe -B -m ruff format --check --config pyproject.toml ../desktop/test/fixtures/p85_server.py
```

这些测试自行配置测试服务，不需要将共享库迁移到 0006。服务端新实例接口依赖工作树已有的 PetService、会话及记忆边界；不要为了执行测试而更改共享连接。

## 前端和桌面单元检查

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\frontend'
node node_modules/typescript/bin/tsc -b --pretty false
node node_modules/eslint/bin/eslint.js . --max-warnings 0
node --experimental-strip-types --test tests/*.test.mjs
node node_modules/vite/bin/vite.js build

Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop'
node scripts/copy-ui.cjs
node --test test/*.test.cjs
```

旧 `p7-assets.test.cjs` 读取 P7 历史清单中的桌面图片原路径。若用户已改名，原路径检查会如实失败；不能删除历史清单或把该项改成通过。本轮另有原始哈希与当前文件的只读比对，详见最终报告。上述命令不自动修复或重命名个人图片。

## 真实 Windows / Electron

关闭自己的旧验收实例后依次执行，避免并行桌面验收争夺焦点。驱动清理子进程环境时先检查变量名，不读取模型密钥值。每轮新建 `.verification/p85/windows-<UUID>`、SQLite、账号和 Electron profile，不复用旧证据。

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop'
node test/p85-e2e.cjs --smoke
# 上一轮正常结束后，完整性能与真实 30 分钟长测：
node test/p85-e2e.cjs --minutes=30
```

`--smoke` 验证交互但不测量性能，不得拿它代替长测。完整模式采集 1/3/5 混合宠、五同种、五宠同时动画和隐藏释放的实际指标，再进行五只哈吉米及两个聊天窗口的长测。CPU 使用同一个 5 秒采样历史，按实际间隔加权；工作集求和包含共享页，不能当作独占物理内存。

生成途中收回使用明确的文件门控 Mock：首个增量后暂停，收回宠物与聊天窗口，确认任务仍在途，再继续合成回复并检查持久化。不伪造真实上游中断；产品取消业务逻辑未修改。SQLite WAL 只设置在本轮新建的测试文件，避免默认回滚日志下的并发读写阻塞。原有 3 秒桌面健康检查及读取速率限制不放宽。

长测为避免周期性重开聊天干扰其他应用，测试阶段改用 showInactive 并抑制测试窗口 focus，使用可撤销的 prevent-app-suspension。普通运行焦点结论来自长测前的独立 Win32 前台探针。自动化动作与物理拖动/点击/右键分别记录，不能混为手工验收。

退出走正常托盘退出、后端 stop-requested 和有界等待；清理失败、端口残留会将整轮状态设为 P85_WINDOWS_CLEANUP_BLOCKED。禁止按 Python/Node/Electron 名称批量杀进程。需要提前中止长测时，只在当前 evidence 目录新建 `stop-soak` 文件，驱动会保存失败证据并正常收尾；不要改写 results.json。

## 数据生命周期

- 种类 `species_id` 是现有 asset_id 的明确领域映射，不是新增 SQL 列；实例始终使用原 Pet UUID，所属账号来自认证。
- 同名、同种不合并；重复操作重试复用幂等键，下一次主动领养使用新键。
- 收回关闭窗口，保留后端数据；未发送草稿应先保存或发送，界面已有说明。
- 删除两次确认后复用现有不可逆归档：停止实例、聊天只读、长期记忆仍可独立撤销授权和删除。确认前取消保留实例；归档提交后不支持撤销，不提供虚假的恢复或物理擦除承诺。
- 五宠是桌面窗口上限；隐藏宠物仍占一个已分配槽位，收回才释放。每次登录仅恢复当前账号，归档/不可访问实例跳过并提示，不能绕过服务端授权。

本轮不关机、不推送、不部署，不代表新安装包、跨设备性能或真实上游取消验收通过。

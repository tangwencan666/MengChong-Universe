# P8.5 八角色本地验证

仅本地 Mock，不调用真实 DeepSeek。全部自动化后端用临时 SQLite；不迁移、不写共享 PostgreSQL。默认桌面上限 5，已拥有数量可超过 5。未授权素材只在本地使用，不公开发行、不推送。

## 素材

原始文件及可用方向见 [实际素材清单](P85_ASSET_INVENTORY.md)。公共映射为 `desktop/assets/p85-appearances.json`，原图 SHA256 与裁切方案为 `desktop/assets/p85-source-plan.json`。本地处理后的副本位于 `desktop/local-preview/p85-eight-v1`，附来源记录和使用限制。默认安装包不包含该目录。

如需复现，选用**不存在的新输出目录**；脚本拒绝覆盖任何既有输出。使用下列 Node 入口，它为 Windows PowerShell 设置独立的模块环境，并过滤模型密钥环境变量；不修改系统设置或安装软件：

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot'
node .\desktop\scripts\prepare-p85-local-assets.cjs `
  --output 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop\local-preview\p85-eight-reproduction'
```

不抹除叠在角色上的水印或按钮，不对缺失视角补画。PNG 静态图片使用有限 CSS 整体变换，不是完整逐帧动画。刀盾不会左右镜像武器。

## 离线回归

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop'
node --test test/p85-eight.test.cjs test/p85-system.test.cjs test/p84-actions.test.cjs
Set-Location '..\frontend'
npm test
npm run lint
npx tsc --noEmit
npm run build
Set-Location '..\backend'
.\.venv\Scripts\python.exe -B -m pytest tests/test_p85_eight.py tests/test_p85_instances.py tests/test_p84_pet_catalog.py -q
.\.venv\Scripts\python.exe -B -m ruff check app/modules/pet_instances tests/test_p85_eight.py tests/test_p85_instances.py tests/test_p84_pet_catalog.py
.\.venv\Scripts\python.exe -B -m ruff format --check app/modules/pet_instances tests/test_p85_eight.py tests/test_p85_instances.py tests/test_p84_pet_catalog.py
```

Windows 完整实测（至少 30 分钟，创建全新证据和独立 SQLite，不使用付费服务）：

```powershell
Set-Location 'D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\desktop'
node test/p85-e2e.cjs --eight-role --minutes=30
```

轻量交互复查可用 `node test/p85-e2e.cjs --eight-role --smoke`，不包含长测，不能代替完整结果。实测会在桌面创建已验证身份的窗口并临时移动鼠标进行拖动/点击，期间避免手动遮挡测试窗口。焦点探针先暂时置顶供安全点击，再恢复普通层级验证其他应用焦点；安全命中检查失败会停止，不会点击其他程序。透明边缘穿透探针只移动鼠标、不点击，不等同逐像素 Alpha 热区验证。

仅复查窗口复用可用 `node test/p85-e2e.cjs --eight-role --lifecycle-only`：新建 5 个同种实例，重复关闭、重开和再打开已有聊天，6 轮保持 5 宠+2 聊天+1 主界面；含限流间隔，不能代替完整验收。密集检查组之间等待 65 秒，不修改服务端 120/min 读取限制。长测记录窗口角色、创建/关闭来源及仅本次桌宠收到的鼠标按下/抬起元数据，不记录聊天正文、键盘输入或凭据值；中止时保留已有性能采样。

30 分钟测试的后台阶段仅为避免干扰用户，将本次窗口显示改为 `showInactive` 并抑制主动聚焦；正常产品的焦点行为在该阶段前独立验证。采样由单一 5 秒时钟记录所有 Electron 进程 CPU、工作集和私有提交，测试结束停止防休眠请求。保存原始采样，不以模拟结果代替桌面实测。

删除的现有规则是**归档实例**：桌面和领养列表隐藏，现有聊天/长期记忆按原有生命周期保留，普通界面不提供撤销或重新激活接口；取消二次确认不产生归档。收回/隐藏仅改变桌面组合。人格快照是实例当前持久化配置的独立副本及版本号，不宣称新增了不可变出生历史。

原 P7 非跟踪测试依赖用户已改名的外部图片文件名，可能报告 `ENOENT`；必须保留这一失败并单独核对内容哈希，不能改写历史测试冒充全通过。最终验收状态与实际限制以 `P85_FINAL_REPORT.md` 为准。

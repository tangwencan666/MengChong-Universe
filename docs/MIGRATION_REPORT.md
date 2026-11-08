# 未毕业 WeiBiYe 独立化迁移验收

状态：**MIGRATION_VERIFIED**。验收日期：2026-11-01（Asia/Shanghai）。

项目文件、Git 和 CI 已完成独立化；现有 PostgreSQL / Redis 保持原容器管理状态。采用复制方式，旧目录没有移动、删除或改写。可以在新目录进入用户认证开发阶段，本轮没有实现注册登录。

## 目录与验收结论

| 项目 | 实际结果 |
| --- | --- |
| 源目录 | `D:\AIProjects\AgentForge-AI\weibiye`，执行前后均保留 |
| 目标目录 | `D:\AIProjects\WeiBiYe`，执行前再次确认不存在 |
| 项目完整性 | 113 个必要项目文件 + 1 个父仓库中的专属 CI + 1 份上轮前端验收文档，复制时全部通过 SHA-256 校验 |
| 最新前端体验 | 全部 `frontend/src` 和 `frontend/e2e` 文件与源目录一致；“愿意和我聊聊吗？”、历史话题卡片、授权开关、继续原会话、删除过滤和访客隔离均保留 |
| 独立 Git | 仓库根目录为目标目录，Git 目录为目标 `.git`，分支 `main`；0 次提交、0 个暂存文件、0 个远程 |
| 独立 CI | 本仓库 `.github/workflows/weibiye-ci.yml`；工作目录和依赖锁路径从仓库根解析，不依赖 AgentForge-AI |
| 原项目保护 | 源目录 113 个受保护文件、父仓库 307 个受跟踪文件、专属旧 CI 的哈希及父仓库工作区状态均未变化 |
| 现有容器保护 | 两个容器的 ID、启动时间、重启次数、健康状态、端口、内存限制、网络及挂载与迁移前一致 |
| 认证开发条件 | 已具备。真实认证仍是明确的 501 骨架，下一阶段在目标目录开发 |

## 复制范围与完整性证据

复制了前后端源码、9 个后端领域模块、测试、初始数据库迁移、`uv.lock`、`package-lock.json`、Dockerfile、Compose 文件、示例配置和项目文档。

没有复制 `.git`、`.venv`、`node_modules`、构建目录、Python/pytest/Ruff 缓存、`.verification` 备份、浏览器测试临时目录、tsbuildinfo、本地数据库、实际 `.env*`、私钥或凭据文件。`.env.example` 仅包含原有公开本地开发示例，保留并修正端口。对复制候选文件检查了高置信度私钥与访问令牌签名，匹配数为 0；这不是对任意格式秘密的完整证明。

上轮前端验收说明原本位于被排除的临时目录，单独作为文档保留于 `migration/PREVIOUS_FRONTEND_VERIFICATION.md`；没有复制其缓存和备份。

| 证据 | 内容 |
| --- | --- |
| [source-manifest.json](migration/source-manifest.json) | 迁移前 113 个项目文件的路径、大小、SHA-256，以及 28 个排除条目 |
| [copy-checksums.json](migration/copy-checksums.json) | 115 个复制文件的复制前后哈希；不匹配数 0 |
| [authorized-target-changes.json](migration/authorized-target-changes.json) | 复制后仅在目标目录修复的 11 个文件及其前后哈希 |
| [source-preservation.json](migration/source-preservation.json) | 源项目和父仓库的最终保护校验 |
| [parent-before.json](migration/parent-before.json) | 父仓库执行前工作区状态及受跟踪文件哈希 |
| [final-manifest.json](migration/final-manifest.json) | 目标仓库最终可版本化文件清单及哈希；排除自身以避免自引用 |
| [git-state.json](migration/git-state.json) | 新仓库最终 Git 边界、分支、提交/暂存/远程及文件状态 |

复制校验在任何目标文件修复之前执行。最终目标哈希允许因以下已授权修复而变化，不能将配置修复误判为复制损坏。锁文件、业务模型、原始迁移、钱包模块及前端产品源码没有变化。

## 仅在目标目录进行的修复

- `.gitignore`：增加实际环境文件和常见私钥/凭据忽略规则；保留示例配置和锁文件。
- `.github/workflows/weibiye-ci.yml`：复制未毕业专属工作流；工作目录改为 `frontend` / `backend`，npm 锁文件路径改为 `frontend/package-lock.json`，Compose 验证从仓库根执行。触发事件属于本独立仓库，无部署或推送步骤。
- `backend/tests/test_engineering.py`：从本仓库根读取 CI，检查各步骤路径均在本仓库内。
- `.env.example`、`backend/app/core/config.py`：默认连接现有 `127.0.0.1:25433` / `127.0.0.1:26380`，不读取父目录 `.env`；CORS 匹配新前端端口。
- `frontend/package.json`、`frontend/vite.config.ts`、`backend/tests/test_api.py`：独立开发端口与代理/CORS 断言同步调整。
- `compose.yaml`：目标文件中的 PostgreSQL / Redis 端口与现有绑定保持一致，应用端口预留为 `38101/38081`。覆盖文件原样保留，未据此启动或重建容器。
- `README.md`：改为目标目录的启动说明，注明容器接管尚未完成；`docs/VERIFICATION.md` 增加历史记录提示。
- 新增 `backend/scripts/migration_check.py`：只读检查数据库身份、模型结构、迁移版本、Redis PING 和 FastAPI readiness；不调用 Docker、迁移命令或 Redis 写入。

活动配置、源码和测试中未发现旧目录的绝对路径、`ROOT.parent` CI 依赖、旧 `weibiye/frontend` / `weibiye/backend` 前缀或 `15433/16380` 端口。历史文档及迁移清单中的旧路径作为审计信息保留。

## 数据库与容器的过渡状态

**现有 Docker Compose 容器的工作目录标签仍指向旧目录。没有为了修正标签重新创建容器。** 新目录通过宿主机端口连接现有专用数据库；文件/Git 独立化不等于 Docker 管理权接管。

| 服务 | 实际状态 | 宿主机绑定 | 内存限制 |
| --- | --- | --- | --- |
| `weibiye-postgres-1` | running / healthy；0 次重启；无 OOM | `127.0.0.1:25433` | 512 MiB |
| `weibiye-redis-1` | running / healthy；0 次重启；无 OOM | `127.0.0.1:26380` | 128 MiB |

项目名仍为 `weibiye`，网络仍为 `weibiye_default`；原卷仍为 `weibiye_weibiye_pgdata` 和 `weibiye_weibiye_redisdata`。迁移前后完整受检字段相同，见 [docker-before.json](migration/docker-before.json) 和 [docker-after.json](migration/docker-after.json)。

PostgreSQL 只读连接确认：数据库/用户均为 `weibiye`，版本 **17.11**，集群标识与预先验证值 `7703042374370492450` 相同。实际事务为只读，迁移版本 **0001** 与目标目录 Alembic head 一致。15 张业务表及 Alembic 版本表齐全；逐表核对列、主键、外键、唯一约束、索引和 CHECK 名称与模型一致：**25 个外键、13 个唯一约束、20 个独立索引、22 个 CHECK 约束**，无未就绪或无效索引。

Redis **7.4.11** 的 PING 成功。本轮真实 Redis 仅执行 PING / INFO，没有写入验证键。进程内 FastAPI `/health/live` 和 `/health/ready` 均返回 200。详见 [infrastructure-readonly.json](migration/infrastructure-readonly.json)。

未对现有 PostgreSQL 执行 upgrade、downgrade、drop、truncate 或业务写入。后端模型测试只在本次新建、位于目标目录 `.verification` 下的临时 SQLite 数据库运行 upgrade 和约束校验；包含 downgrade 的测试未执行。没有任何容器、镜像、网络或数据卷管理操作，也没有执行 `docker system prune`。

**接管现有容器前，不要从新目录运行 Compose up/down/restart、重建或清理命令。** 这一过渡状态需要后续单独授权处理；当前不妨碍宿主机认证开发。

## 实际执行结果

环境：Windows、Python 3.13.5、Node 24.14.1、npm 11.11.0、uv 0.11.4。依赖按原锁文件重新安装到目标目录：后端 69 个包，前端 227 个包。未安装全局软件或新 Python，未复用旧 `.venv` / `node_modules`。

| 检查 | 实际结果 |
| --- | --- |
| 后端 `uv sync --frozen` | 通过，editable 包指向目标目录 |
| 前端 `npm ci --no-audit --no-fund` | 通过 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过，0 warnings |
| `npm run build` | 通过；JS 410.85 kB、CSS 45.09 kB |
| `ruff check .` | 通过 |
| `ruff format --check .` | 通过，64 个 Python 文件 |
| 后端非破坏性 pytest | **44 passed, 9 skipped, 1 deselected**，6.25s |
| Playwright / 已安装 Edge | **33 passed**，约 1.1 分钟，无跳过或失败 |
| PostgreSQL / Redis 只读验收 | 通过；结构和版本一致，readiness 200 |
| 新目录真实进程启动 | 通过；Vite `35174`、FastAPI `38101`，均仅回环绑定 |
| 前端代理与 CORS | `/health/ready` 代理返回 ready；允许新前端 Origin；私人接口匿名请求返回 401 |
| Compose 配置解析 | 通过，端口、内存、卷名与隔离方案一致；未启动 Compose 服务 |
| CI 结构与路径检查 | 通过现有工程测试；尚未在 GitHub 执行 |

9 个跳过项属于 `tests/integration/test_local_infrastructure.py` 的显式启用组，其 fixture 会执行容器内命令，且包含 Redis 写入。为保持本轮边界，未开启该组；改用新增只读验收脚本验证真实基础设施。1 个排除项为 `test_migration_roundtrip_and_metadata_drift`，保留原测试，依据本轮禁止 downgrade 的要求没有执行。没有删除或弱化认证、归属、角色、安全头、输入校验、模型或 Mock 边界测试。

后端测试涵盖未认证访问、伪造 Bearer、RBAC、用户归属边界、输入校验、异常处理、CORS、安全头、敏感日志脱敏、限流、Mock/真实模型开关和数据库约束。浏览器测试涵盖首页文案、旧页面导航、Mock SSE、历史会话继续/切换/删除、隐藏/关闭推荐、访客隔离、刷新重置和移动抽屉。

桌面及移动端截图已人工查看；移动端使用浏览器尺寸与 VisualViewport 模拟，不等于实体手机软键盘验收。所有新增启动验收进程均已回收，原 `15174` 前端的监听 PID `11560` 保持不变。

首轮 npm 安装因两个空配置文件参数误指向同一文件而提前退出，改为两个独立空文件后安装成功；未更改全局 npm 配置。Compose JSON 中的内存值为字符串，校验时转为整数后与实际字节数一致；不存在实际资源异常。

原始测试记录：[后端 JUnit](migration/backend-pytest.xml)、[前端 JUnit](migration/frontend-e2e.xml)、[结果汇总](migration/verification-results.json)、[启动验收](migration/local-startup.json)、[Compose 验证](migration/compose-validation.json)。控制台记录保存在 `migration/validation-output/`，可随文档纳入版本管理。

截图：[桌面历史话题卡片](migration/screenshots/recent-topic-card-desktop.png)、[移动端历史话题卡片](migration/screenshots/recent-topic-card-mobile.png)。

## 新目录的本地命令

以后从新目录启动，现有数据库容器继续保留。以下命令没有任何容器管理或数据库迁移步骤：

```powershell
cd D:\AIProjects\WeiBiYe\backend
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 38101 --loop app.core.event_loop:new_event_loop --no-access-log --no-proxy-headers
```

另一个终端：

```powershell
cd D:\AIProjects\WeiBiYe\frontend
npm ci --no-audit --no-fund
npm run dev
```

前端：`http://127.0.0.1:35174`。FastAPI readiness：`http://127.0.0.1:38101/health/ready`。本地示例数据库配置已经指向 `25433/26380`，真实模型保持关闭。

复核只读基础设施：

```powershell
cd D:\AIProjects\WeiBiYe\backend
.\.venv\Scripts\python.exe -B scripts\migration_check.py --expected-cluster-id 7703042374370492450
```

非破坏性测试使用的核心命令：

```powershell
# backend；WEIBIYE_LOCAL_INFRA_TESTS 未开启
.\.venv\Scripts\python.exe -B -m pytest -q -k "not test_migration_roundtrip_and_metadata_drift"
# frontend
npm run typecheck
npm run lint
npm run build
$env:WEIBIYE_BROWSER_PATH='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm run test:e2e -- --reporter=dot
```

实际 pytest 另指定了本次新建的目标目录内 `--basetemp` 和 JUnit 输出；浏览器测试使用独立的 `25174/28101`，拒绝复用未知服务。前后端启动验收还将 PostgreSQL 连接设置为默认只读事务。

## 下一阶段

可以在 `D:\AIProjects\WeiBiYe` 开发认证模块，先完成密码哈希、注册与重复邮箱处理、登录凭据验证、会话失效和用户资源归属测试，再将前端演示访客替换为真实认证主体。真实会话持久化和推荐授权的服务端保存仍未实现；长期记忆、钱包扣费、真实 AI、支付和公网部署均保持未接入。

原目录暂作只读回退参考，避免双目录同时开发；本轮不删除原目录。独立仓库尚未提交或配置远程，远端 CI 也尚未运行。本轮工作已停止，等待下一步确认。

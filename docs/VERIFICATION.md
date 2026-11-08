> 本文件保留旧目录阶段的历史验证记录；其中旧绝对路径和当时状态不是新目录的启动配置。独立迁移后的当前状态、命令和测试以 [MIGRATION_REPORT.md](MIGRATION_REPORT.md) 为准。

# 实际验证记录

日期：2026-11-01（Asia/Shanghai）。仅针对 `weibiye/` 新框架；不将父项目的历史结果计入本次验收。

## 最新本地基础设施联调：已通过

用户已明确授权启动未毕业专用 PostgreSQL/Redis，并在确认连接目标后执行 Alembic upgrade。Docker Desktop 由用户启动，本轮没有启动、停止或重启 Docker Engine。

### 启动前检查与实际隔离

- Engine 29.7.2，context 明确为 `desktop-linux`。重新检查全部运行/停止容器的端口映射、宿主机监听、Windows 排除端口、Compose 项目名、网络、卷和本地镜像。
- 启动前没有 `weibiye` 同名项目、容器、网络或卷；`25433`、`26380` 未占用。`10.253.77.0/28` 与已有 Docker 子网和宿主机非默认路由均不重叠。
- 使用现有缓存 `postgres:17-alpine`、`redis:7-alpine`，没有拉取或构建镜像。所有生命周期操作限定项目 `weibiye` 的 `postgres redis`，没有启动 migrate、backend、frontend、worker 或 runner。
- 将上轮已校验的覆盖配置保存为 `compose.local-infra.yaml`，显式使用 `!override` 替换旧端口映射。基础 `compose.yaml` 保留原样；今后操作本地这两个容器必须同时指定该覆盖文件。

| 服务 | 实际容器 ID / 名称 | 实际绑定 | 内存限制 | CPU 上限 | 最终状态 |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL | `62b27f33f5d6` / `weibiye-postgres-1` | `127.0.0.1:25433 → 5432/tcp` | 512 MiB | 1 核 | running / healthy |
| Redis | `50a4a890c190` / `weibiye-redis-1` | `127.0.0.1:26380 → 6379/tcp` | 128 MiB | 0.5 核 | running / healthy |

两者最终 `RestartCount=0`、`OOMKilled=false`，仅连接 `weibiye_default` 网络，子网 `10.253.77.0/28`。独立卷及挂载为：

- `weibiye_weibiye_pgdata` → `/var/lib/postgresql/data`
- `weibiye_weibiye_redisdata` → `/data`

容器、网络、卷的 Compose project 标签均为 `weibiye`，网络内只有这两个容器。末次采样内存约 PostgreSQL 39.75 MiB、Redis 6.81 MiB；宿主机剩余物理内存约 2.58 GiB。数值为当时采样，不代表长期容量保证。

### 数据库身份确认与真实迁移

迁移前先通过容器内 psql 查询，再通过宿主机 `127.0.0.1:25433` 独立建立连接比对：

- PostgreSQL 实际版本 **17.11**；数据库、登录用户和数据库 owner 均为 `weibiye`。
- 宿主机与容器返回的数据库集群 `system_identifier` 均为 `7703042374370492450`。
- 专用卷、端口和容器归属检查通过；迁移前 public schema 业务表数量为 **0**。
- Redis 容器内与宿主机 `26380` 返回相同实例 `run_id`，两条路径均 PING 成功。

确认这些事实后才执行 `alembic upgrade head`，实际成功；`alembic current` 为 **0001 (head)**，`alembic check` 返回 **No new upgrade operations detected**。

实际 PostgreSQL public schema 包含 **15 张业务表 + 1 张 alembic_version 表**：

`users`、`posts`、`comments`、`post_likes`、`reports`、`ai_companions`、`chat_sessions`、`chat_messages`、`memories`、`wallets`、`wallet_transactions`、`wallet_reservations`、`usage_records`、`job_applications`、`moderation_actions`。

| 实际结构检查 | 结果 |
| --- | --- |
| 业务表及列集合 | 与 ORM 元数据精确匹配 |
| 主键 | 15 个，均为 id |
| 外键 | 25 个，字段顺序、引用表与引用列均匹配模型 |
| 唯一约束 | 13 个，与模型匹配 |
| CHECK 约束 | 22 个，与模型匹配；没有未验证约束 |
| 独立索引 | 20 个，与模型匹配 |
| 全部业务表索引，包含主键和唯一约束索引 | 48 个；全部 valid / ready |
| 迁移版本 | 0001 |
| 业务记录 | 15 张业务表均为 0 行；没有创建演示用户或其他业务数据 |

### Windows readiness 问题、修正与复验

第一次运行原 `scripts/integration_check.py`，存活检查返回 200，readiness 返回 503。本轮保留该失败事实，没有将首轮检查记为成功。

停止后续写入，只读定位发现：Windows TestClient 默认的 `ProactorEventLoop` 使 Psycopg 抛出 `InterfaceError`，无法建立异步数据库连接；同一进程 Redis PING 成功。此时容器均健康、无 OOM/重启，数据库同步连接和迁移正常，目标集群身份明确。故障属于本项目 Windows 事件循环兼容性，未触发资源异常、迁移失败或目标不明的暂停条件。

实施的必要基础设施修正：

- 新增 `app/core/event_loop.py` 局部 loop factory，Windows 显式使用 SelectorEventLoop，不修改全局事件循环策略。
- 集成检查脚本和 TestClient 测试夹具使用该 factory；README 的原生 Uvicorn 命令增加 `--loop app.core.event_loop:new_event_loop`。
- Uvicorn 最低版本声明从 0.34 提高到支持自定义 loop 的 0.36；锁文件离线更新，没有安装新依赖。
- 新增显式 opt-in 的 `tests/integration/test_local_infrastructure.py`，限制目标为本地 `25433/weibiye` 和 `26380/0`，先核验容器归属、健康、集群 ID 与 Redis 实例 ID，再进行验收。

依据：[Psycopg 的 Windows 异步限制](https://www.psycopg.org/psycopg3/docs/advanced/async.html)、[Starlette TestClient 后端选项](https://starlette.dev/testclient/)。

修正后原集成脚本通过：**PostgreSQL table registry, live health, and real DB/Redis readiness passed**。新集成测试中连续三次 readiness 均为 200；异步会话依赖返回 `weibiye` 数据库/用户，未残留 idle in transaction 会话。

### 本轮真实测试结果

| 验证项 | 实际结果 |
| --- | --- |
| 两容器启动与健康检查 | 通过，未重建已有容器 |
| 实际端口、内存、网络、卷与归属 | 通过 |
| PostgreSQL 容器内与宿主机连接、版本和集群身份 | 通过 |
| Alembic upgrade / current / check | 通过，0001，无 drift |
| 15 张表、主键、外键、唯一约束、CHECK、索引 | 通过真实 PostgreSQL 检查 |
| Redis 容器内与宿主机 PING | 通过，PONG |
| Redis SET NX / GET / TTL、应用 Lua 限流 | 通过，仅使用随机命名且 30 秒过期的验证键 |
| FastAPI 存活 / readiness | 兼容性修正后均为 200 |
| 数据库异步会话释放 | 通过，没有 idle in transaction 残留 |
| 数据库或 Redis 依赖不可达时的错误处理 | 通过，readiness 503、存活 200、错误脱敏且包含请求 ID |
| 相关 pytest | **46 passed in 11.45s**：9 项新真实基础设施验收 + 37 项现有 API/安全/工程检查 |
| Ruff check / format | 通过，63 个 Python 文件格式检查 |
| 锁文件与依赖一致性 | `uv lock --check --offline`、`uv pip check` 通过 |
| 本地 Compose 合并配置 | 校验通过 |

依赖失败测试在本机临时绑定一个不监听的回环端口，确保不会连接其他项目；没有停止、重启或修改数据库/Redis 容器。Redis 验证键自然过期，不执行 flush 或删除已有键。PostgreSQL 验收查询采用只读事务，不写业务数据。

**本轮没有运行** `tests/test_database.py`，因为其迁移往返测试会执行 downgrade；原测试保留，没有删除或改成跳过来制造通过。前端构建、浏览器、云端 CI 与应用容器未在本轮运行，本轮 46 项结果不能表述为原始全部测试套件再次通过。

补充工具诊断：uv 创建的虚拟环境不含 pip 模块，`python -m pip --version` 返回缺少模块；未额外安装 pip，依赖检查使用 `uv pip check` 并已通过。这不影响本轮迁移和测试执行。

### 可复现命令与结束状态

本次实际启动命令使用以下显式参数；再次操作前应先核对现有容器归属和端口，不能以本记录替代新的预检查：

```powershell
$weibiyeCompose = @(
  '--context', 'desktop-linux', 'compose',
  '--project-name', 'weibiye',
  '--file', 'D:\AIProjects\AgentForge-AI\weibiye\compose.yaml',
  '--file', 'D:\AIProjects\AgentForge-AI\weibiye\compose.local-infra.yaml',
  '--env-file', 'D:\AIProjects\AgentForge-AI\weibiye\.env.example'
)
docker @weibiyeCompose config --quiet
docker @weibiyeCompose up -d --no-deps --no-build --pull never --no-recreate --wait --wait-timeout 120 postgres redis
docker @weibiyeCompose ps
```

本轮迁移已完成，无需为重跑测试再次执行迁移。测试命令：

```powershell
cd D:\AIProjects\AgentForge-AI\weibiye\backend
$env:WEIBIYE_DATABASE_URL='postgresql+psycopg://weibiye:local-development-only@127.0.0.1:25433/weibiye'
$env:WEIBIYE_REDIS_URL='redis://127.0.0.1:26380/0'
$env:WEIBIYE_ENVIRONMENT='test'
$env:WEIBIYE_LLM_PROVIDER='mock'
$env:WEIBIYE_REAL_LLM_ENABLED='false'
$env:WEIBIYE_LOCAL_INFRA_TESTS='1'
.\.venv\Scripts\python.exe -B scripts\integration_check.py
.\.venv\Scripts\python.exe -B -m pytest tests\integration\test_local_infrastructure.py tests\test_api.py tests\test_agent_security.py tests\test_engineering.py -q --maxfail=1 --tb=short -p no:cacheprovider
```

使用公开本地示例凭据，没有读取父项目 .env 或使用生产凭据。安全证据（不含凭据）保存在被 Git 忽略的 `.verification/infra-*.json`：启动前容器清单、目标身份、实际表结构和最终容器状态。

启动前原有 **418 个容器 ID 全部仍存在**，最终仅新增上述两个未毕业容器，总数 420；本地镜像数量仍为 59。未对其他容器执行 start/stop/restart/recreate，未清理镜像、网络或卷，未执行 downgrade/drop/truncate，未接入真实模型或支付，未迁移目录、提交、推送或部署。

本轮范围内两个容器继续运行并保持 healthy，应用 readiness 通过进程内 TestClient 验证，没有启动额外 API 服务。基础设施联调已完成，暂停等待下一步指令。

## 历史记录：基础设施联调预检曾按安全条件暂停

本节为用户再次要求基础设施联调后的实际结果。下方原有 45 项 pytest、5 项浏览器测试等数字属于上一轮基础框架验收，本轮尚未重跑，不能视为本轮 PostgreSQL/Redis 联调证据。

### Git 边界与未来迁移评估（只读）

- `git rev-parse --show-toplevel` 返回 `D:/AIProjects/AgentForge-AI`；在 `weibiye` 内执行 `git rev-parse --show-prefix` 返回 `weibiye/`。
- `weibiye/.git` 不存在，未毕业目前是父仓库内的未跟踪子目录，并非独立 Git 仓库；其 CI 文件也仍未跟踪，没有可以独立迁移的已提交项目历史。
- `git diff --name-only` 为空。父仓库原有未跟踪 CSV、`PTA-Homework/`、`diagnostics/` 均保留；未修改父项目源码或 CI。
- 目标 `D:\AIProjects\WeiBiYe` 当前不存在。本轮未创建目标、初始化新仓库、移动或复制项目。
- **未来迁移在源码层面可行，但不能直接移动后宣称可用。** Compose 的 `./backend`、`./frontend`，Alembic 的 `%(here)s`，前端的 `../backend` 与截图的 `../.verification` 都属于本项目内部相对路径，整体移动并保留结构即可维持。
- 必须调整的父目录耦合：`backend/tests/test_engineering.py` 从 `ROOT.parent/.github/workflows/weibiye-ci.yml` 读取工作流，并断言工作目录带 `weibiye/` 前缀。工作流本身位于父仓库 `.github/workflows/`，路径触发、缓存路径和 working-directory 也带此前缀。未来独立仓库需要同步调整这些文件与断言，不能只移动源码目录。
- README 有当前绝对路径，需要更新。`uv.lock` 的本项目引用为 `editable = "."`，未发现本地 AgentForge 绝对路径依赖；Python `.venv` 属于路径相关的生成环境，迁移后应在新目录重新创建，前端依赖也应依据锁文件重新安装。以上仅评估，本轮未执行。
- Compose 项目名、卷名和端口可继续作为独立资源边界；实际资源归属、现有容器工作目录标签与后续数据承接仍需 Engine 可用后检查，不能根据源文件断言卷不存在或可重建。

### CI 隔离结论（只读）

- `.github/workflows/weibiye-ci.yml` 的 push/pull_request 有 `weibiye/**` 与自身文件路径过滤；任务工作目录、缓存和测试目标都指向未毕业，没有部署命令。手动 `workflow_dispatch` 不受路径过滤限制，但工作内容仍限定未毕业。
- **整个父仓库尚未实现双向 CI 隔离。** 已有 `.github/workflows/core-ci.yml` 只过滤 main 分支，没有路径过滤。未来向 main 提交未毕业改动，或创建指向 main 的 PR，仍可能触发原 AgentForge Core CI。
- 本轮没有修改任何 CI、提交、推送或触发 GitHub Actions。未来可在单独授权后调整原工作流边界，或通过独立仓库解决；当前仅记录问题。

### Docker 状态与暂停依据

- Docker CLI 29.7.2、Compose CLI v5.4.0；当前 context 为 `desktop-linux`。
- 未发现 `Docker Desktop`、`com.docker.backend`、`dockerd` 进程；`com.docker.service` 为 Stopped、手动启动类型。`D:\Docker\DockerDesktop\Docker Desktop.exe` 存在。
- `docker version` 返回客户端信息但 Server 为 null，连接 `dockerDesktopLinuxEngine` 命名管道失败。`docker desktop status` 无法取得运行状态，提示 Desktop 可能未启动。
- 检查时 `15433`、`16380`、`15174`、`18101` 没有 TCP Listen；这只说明当时无端口监听，不证明 Docker 资源名/卷名无冲突。
- 只读检查发现父项目 `compose.yaml` 第 22、40、105、154 行为 PostgreSQL、Redis、worker 和 sandbox runner 设置了 `restart: unless-stopped`；runner 第 165 行挂载 `/var/run/docker.sock`。
- Docker 重启策略可能在 Engine 恢复时启动既有容器；`unless-stopped` 对已经被手动停止的容器会保留停止状态。因此不能声称旧容器必定恢复，但 Engine 不可用时也无法确认这些容器是否存在及其最后停止状态。行为依据：[Docker 官方重启策略说明](https://docs.docker.com/engine/containers/start-containers-automatically/)。
- 用户明确要求“如果需要管理员权限或可能影响其他容器，暂停并报告”“遇到冲突先停止并报告”。基于上述具体配置风险，在启动 Desktop 前暂停。没有执行启动操作，未尝试提权；仅查询了状态及 `docker desktop start --help`。

### 本轮执行范围与真实状态

| 项目 | 本轮实际结果 |
| --- | --- |
| Git 仓库边界、工作区、路径依赖 | 完成只读检查 |
| 未来迁移可行性 | 完成评估，未迁移 |
| CI 范围 | 未毕业工作流限定自身；父仓库 Core CI 仍可能被未毕业改动触发 |
| Docker 状态 | Engine 不可用，发现可能恢复其他项目容器的风险后暂停 |
| 专用 PostgreSQL/Redis 容器、卷与网络 | 未创建、未启动、未修改 |
| PostgreSQL 真实连接、Alembic upgrade、表/外键/索引/唯一约束 | 未执行，不能以旧 SQLite/离线结果代替 |
| Redis PING、基础读写、应用连接 | 未执行 |
| 真实依赖下的 FastAPI readiness、会话、依赖异常 | 未执行 |
| 全部 pytest、前端类型、ESLint、构建、浏览器测试 | 遵照暂停条件，本轮未重跑；历史结果保留在下方 |

仅更新本验证文档。没有修改业务源码、CI、Compose、数据库或容器配置，没有执行 prune、删除卷、提交、推送、部署或项目迁移。

### 恢复条件与下一阶段建议

恢复本轮前，需确认共享 Engine 启动不会恢复其他项目容器，或取得用户针对这项具体影响的明确授权；也可另行确定独立 Engine 方案。本轮未改动旧容器重启策略，没有通过停止或删除其他项目资源规避风险。

条件解除后，再检查 Engine 中的容器/卷归属及端口，仅启动显式 `--project-name weibiye`、明确 `-f` 文件和 `--env-file .env.example` 下的 `postgres redis`，不启动应用、worker 或 runner。随后完成真实迁移、约束与应用连接验证，再重跑工程验收并追加结果。

认证模块仍只建议、不开发：先确定密码哈希与令牌/会话方案，完成注册、登录、会话撤销、通用错误和限流；仓储查询必须携带 owner 条件，覆盖越权、失效/撤销凭据、角色与私人资源边界。真实 PostgreSQL/Redis 验收通过后再开始该业务阶段。

## 环境

- Windows / PowerShell。
- Python 3.13.5、uv 0.11.4、Node 24.14.1、npm 11.11.0。
- Docker Compose CLI v5.4.0 可用，Linux Docker Engine 管道不存在。
- 使用本机已有 Microsoft Edge 的独立临时浏览器上下文进行浏览器验证，未安装全局软件或访问个人浏览器配置。
- 没有读取父项目 `.env`，没有查看现有模型凭据，没有调用付费模型。

## 结果

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| 前端安装 | `npm install`、随后 `npm ci` 成功，227 packages | 有 package-lock.json |
| 前端类型 | `npm run typecheck` 通过 | TypeScript 严格检查 |
| ESLint | `npm run lint` 通过，0 warnings | 含应用、配置、E2E 源码 |
| 前端生产构建 | `npm run build` 通过，Vite 7.3.7 | JS 387.91 kB / gzip 126.65 kB；CSS 25.66 kB |
| 后端安装 | `uv sync --frozen`、`uv pip check` 通过 | 独立 .venv；69 packages 兼容 |
| 后端导入 | 应用、路由与 ORM mapper 导入/配置通过 | 导入不连接数据库 |
| 后端启动 | Playwright 实际启动 Uvicorn，startup complete，HTTP 存活 200 | 本地回环端口，Mock 模式 |
| Ruff | `ruff check .`、`ruff format --check .` 通过 | 61 个 Python 文件格式检查 |
| pytest | **45 passed**，最后运行 6.40 秒 | 没有跳过、删除或 xfail 测试 |
| 数据库迁移 | 临时 SQLite upgrade → check → downgrade → upgrade → check 全通过 | 仅新建临时数据库，不接触已有库 |
| PostgreSQL SQL | Alembic offline 编译通过，含 UUID / BIGINT / 带时区时间 | 不是实际 PostgreSQL 执行 |
| Compose 配置 | `docker compose --env-file .env.example config --quiet` 通过 | 不要求运行 Engine |
| 健康接口 | 存活 200；依赖不可用时就绪 503，返回安全错误信封 | 未伪造就绪 |
| 浏览器 | **5 passed** | 全路由、交互与真实本地 SSE；桌面 1440px、手机 390px |
| 页面截图 | 桌面和手机首页已生成并人工查看 | 本地 `.verification/home-desktop.png`、`home-mobile.png` |
| CI 静态检查 | YAML 解析、路径触发、只读权限、工作目录、服务及关键命令检查通过 | 没有推送或运行 GitHub Actions；未宣称云端 CI 成功 |
| 原项目保护 | `git diff --exit-code` 无已有跟踪文件变更 | 新增 `weibiye/` 和独立 CI 文件；原有未跟踪内容保留 |

## pytest 覆盖

- 存活与就绪区分、安全响应头、请求 ID、统一异常、CORS 白名单。
- 所有私有领域入口未认证拒绝；任意 Bearer 不构成身份。
- 管理员角色依赖、跨用户归属拒绝，含管理员不能越权读取私人资源。
- 未实现业务明确返回 501，没有假令牌和假成功。
- 输入边界、验证错误不回显敏感值、日志脱敏与字段白名单。
- Mock 调用不构造 OpenAI 客户端、不访问数据库；SSE 完成事件和错误事件互斥。
- 开发限流和 Redis 不可用时拒绝请求。
- 严格整数金额验证；负余额、超额预留、重复幂等键、重复点赞、无目标举报的约束。
- 私人会话/消息/记忆跨 owner 引用拒绝；钱包预留、使用量和退款原交易跨账户引用拒绝。
- 迁移往返、15 张表检查、模型/迁移 drift 检查和 PostgreSQL 离线编译。
- CI 与 Compose 配置契约。

## 浏览器覆盖

1. 首页标注演示，11 个指定路由与 404 均可渲染，无 pageerror、无水平溢出。
2. 社区按分类筛选虚构 fixture；发帖弹窗明确未实现，Escape 可关闭。
3. 真实浏览器 → Vite 代理 → FastAPI → LangGraph → Mock → SSE → 页面，响应 200；清空有效，不写 localStorage。
4. 虚构凭据提交登录后显示真实 501 错误，不建立认证状态。
5. 390px 手机菜单可导航，关闭状态正确，主要页面不溢出。

## 尚未验证与阻塞

Docker Engine 返回：`failed to connect ... dockerDesktopLinuxEngine ... The system cannot find the file specified`。因此本次没有执行：

- Docker 镜像构建与容器启动。
- 实际 PostgreSQL 迁移应用与数据库版本一致性检查。
- 实际 Redis Lua 限流、完整依赖就绪与 Compose Nginx 反向代理联调。
- `scripts/integration_check.py` 对真实 PostgreSQL/Redis 的验证。

没有为解除该阻塞启动守护进程、操作其他项目容器或访问已有数据库。GitHub Actions 已配置独立 PostgreSQL/Redis 服务及真实集成检查，仍需在后续授权推送后运行，不能以静态检查替代。

没有验证 OpenAI 网络适配器的真实调用、风险分类/危机响应、记忆检索质量、账户密码安全闭环、钱包并发扣费或真实支付。这些能力本阶段未实现或未开放。

## 本阶段结束状态

基础框架和当前可运行的验证已完成；代码未提交、未推送、未部署。浏览器测试拥有的前后端进程在结束后回收。等待下一步指令，不继续扩展完整业务。

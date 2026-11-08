# P8.3 本轮修改边界

起点 d542866；保留既有未提交成果。本轮没有暂存、提交、推送或公开发布。

## 在现有文件上的局部补丁

- `backend/app/agent/chat_protocol.py`
- `backend/app/agent/chat_runner.py`
- `backend/app/agent/graph.py`
- `backend/app/core/config.py`
- `backend/app/main.py`
- `backend/app/modules/companion/service.py`
- `desktop/scripts/package-portable.cjs`
- `desktop/src/diagnostics.cjs`
- `desktop/src/gateway.cjs`
- `desktop/src/main.cjs`
- `desktop/src/manager.cjs`
- `desktop/src/policy.cjs`
- `desktop/test/gateway.test.cjs`
- `desktop/test/manager.test.cjs`
- `frontend/src/App.tsx`
- `frontend/src/components/layout.tsx`
- `frontend/src/lib/api.ts`
- `frontend/src/pages/auth.tsx`

## 新增文件

- `backend/app/modules/beta_quota/__init__.py`
- `backend/app/modules/beta_quota/http.py`
- `backend/app/modules/beta_quota/models.py`
- `backend/app/modules/beta_quota/privacy.py`
- `backend/app/modules/beta_quota/privacy_models.py`
- `backend/app/modules/beta_quota/privacy_router.py`
- `backend/app/modules/beta_quota/router.py`
- `backend/app/modules/beta_quota/service.py`
- `backend/beta_quota_alembic.ini`
- `backend/beta_quota_migrations/env.py`
- `backend/beta_quota_migrations/versions/q0001_beta_quota.py`
- `backend/beta_quota_migrations/versions/q0002_opt_in_metrics.py`
- `backend/scripts/p83_offline_postgres.py`
- `backend/scripts/p83_test_target.py`
- `backend/tests/beta_helpers.py`
- `backend/tests/integration/test_beta_quota_postgres.py`
- `backend/tests/test_beta_privacy.py`
- `backend/tests/test_beta_quota.py`
- `backend/tests/test_beta_quota_chat.py`
- `backend/tests/test_p83_test_target.py`
- `desktop/service-profile.json`
- `desktop/src/power-recovery.cjs`
- `desktop/src/service-profile.cjs`
- `desktop/src/support-window.cjs`
- `desktop/test/fixtures/p83-electron-bootstrap.cjs`
- `desktop/test/fixtures/p83_https_server.py`
- `desktop/test/p83-https-e2e.cjs`
- `desktop/test/p83-installer.cjs`
- `desktop/test/power-recovery.test.cjs`
- `desktop/test/service-profile.test.cjs`
- `desktop/test/support-window.test.cjs`
- `docs/P83_ARCHITECTURE_AND_PLAN.md`
- `docs/P83_HOSTED_ENVIRONMENT.md`
- `docs/P83_LOCAL_RUNBOOK.md`
- `docs/P83_PRIVACY_AND_DEVICES.md`
- `frontend/src/features/beta/BetaUsage.tsx`
- `frontend/src/features/beta/feedback.ts`
- `frontend/src/pages/beta.tsx`
- `frontend/tests/beta-feedback.test.mjs`
- `docs/P83_CHANGE_MANIFEST.md`
- `docs/P83_VERIFICATION.md`

后端只添加额度/统计边界、独立迁移和必要派发/结算钩子；原 0006/记忆/取消业务逻辑保持基线。桌面修改限于固定 HTTPS 服务配置、帮助、恢复监听与受限反馈下载；前端新增额度/告知/反馈和真实邮件模式说明。

前后源文件哈希清单和历史证据完整性检查见新证据目录 `D:\AIProjects\WeiBiYe-worktrees\consumer-desktop-pivot\.verification\p83\review-694eafb32ab24d05a288edbc5cf76a66`。没有修改共享数据库结构或已有账号/宠物/记忆数据。所有测试模型为本地 Mock 或 HTTPX MockTransport。

生成的 UI、安装器、专用数据库、TLS 测试证书和诊断仅位于既有忽略目录，不进入源码提交或发行包的秘密配置。

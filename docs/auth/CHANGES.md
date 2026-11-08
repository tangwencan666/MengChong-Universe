# P2 修改文件清单

本清单对比开发前 SHA-256 基线；独立仓库此前没有提交，Git 状态仍为未跟踪。没有删除文件。

| 文件 | 状态 |
| --- | --- |
| `.env.example` | 修改 |
| `README.md` | 修改 |
| `backend/app/core/config.py` | 修改 |
| `backend/app/core/errors.py` | 修改 |
| `backend/app/core/ownership.py` | 新增 |
| `backend/app/core/security.py` | 修改 |
| `backend/app/db/models.py` | 修改 |
| `backend/app/main.py` | 修改 |
| `backend/app/modules/applications/router.py` | 修改 |
| `backend/app/modules/auth/mail.py` | 新增 |
| `backend/app/modules/auth/models.py` | 新增 |
| `backend/app/modules/auth/router.py` | 修改 |
| `backend/app/modules/auth/schemas.py` | 新增 |
| `backend/app/modules/auth/service.py` | 新增 |
| `backend/app/modules/auth/store.py` | 新增 |
| `backend/app/modules/companion/router.py` | 修改 |
| `backend/app/modules/companion/schemas.py` | 新增 |
| `backend/app/modules/memory/router.py` | 修改 |
| `backend/app/modules/users/models.py` | 修改 |
| `backend/app/modules/users/router.py` | 修改 |
| `backend/app/modules/wallet/router.py` | 修改 |
| `backend/migrations/env.py` | 修改 |
| `backend/migrations/versions/0002_auth_sessions.py` | 新增 |
| `backend/pyproject.toml` | 修改 |
| `backend/scripts/e2e_server.py` | 新增 |
| `backend/scripts/migration_check.py` | 修改 |
| `backend/scripts/upgrade_auth.py` | 新增 |
| `backend/tests/conftest.py` | 修改 |
| `backend/tests/integration/test_auth_postgres.py` | 新增 |
| `backend/tests/integration/test_local_infrastructure.py` | 修改 |
| `backend/tests/test_api.py` | 修改 |
| `backend/tests/test_auth.py` | 新增 |
| `backend/tests/test_auth_migration.py` | 新增 |
| `backend/tests/test_database.py` | 修改 |
| `backend/uv.lock` | 修改 |
| `frontend/e2e/auth.spec.ts` | 新增 |
| `frontend/e2e/chat-layout.spec.ts` | 修改 |
| `frontend/e2e/foundation.spec.ts` | 修改 |
| `frontend/e2e/helpers/auth.ts` | 新增 |
| `frontend/playwright.config.ts` | 修改 |
| `frontend/src/App.tsx` | 修改 |
| `frontend/src/chat.css` | 修改 |
| `frontend/src/components/layout.tsx` | 修改 |
| `frontend/src/features/auth/AuthProvider.tsx` | 新增 |
| `frontend/src/features/auth/RequireAuth.tsx` | 新增 |
| `frontend/src/features/auth/context.ts` | 新增 |
| `frontend/src/lib/api.ts` | 修改 |
| `frontend/src/pages/auth.tsx` | 新增 |
| `frontend/src/pages/sessions.tsx` | 新增 |
| `frontend/src/pages/workspace.tsx` | 修改 |

另新增 `docs/AUTH_VERIFICATION.md` 和 `docs/auth/` 中的校验、日志、JUnit 与截图证据；不计入上述源码/配置清单。

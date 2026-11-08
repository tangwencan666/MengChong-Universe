import process from 'node:process'
import { defineConfig } from '@playwright/test'

const python = process.env.WEIBIYE_TEST_PYTHON ?? (process.platform === 'win32'
  ? '../backend/.venv/Scripts/python.exe' : '../backend/.venv/bin/python')
const ui = 'http://127.0.0.1:35174'
const api = 'http://127.0.0.1:38101'
if (!process.env.WEIBIYE_DATABASE_URL?.includes('/weibiye_p3_test_')
  || process.env.WEIBIYE_REDIS_URL !== 'redis://127.0.0.1:26380/15') {
  throw new Error('Prepare and explicitly select the isolated P3 integration targets first.')
}

export default defineConfig({
  testDir: './e2e-integration', fullyParallel: false, workers: 1, retries: 0, timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: ui, browserName: 'chromium', screenshot: 'only-on-failure',
    launchOptions: process.env.WEIBIYE_BROWSER_PATH ? { executablePath: process.env.WEIBIYE_BROWSER_PATH } : {},
  },
  webServer: [
    {
      command: `"${python}" -B ../backend/scripts/p3_integration_server.py`,
      url: `${api}/health/ready`, reuseExistingServer: false,
      env: {
        WEIBIYE_ENVIRONMENT: 'test', WEIBIYE_LLM_PROVIDER: 'mock', WEIBIYE_REAL_LLM_ENABLED: 'false',
        WEIBIYE_AUTH_STORE_BACKEND: 'redis', WEIBIYE_RATE_LIMIT_BACKEND: 'redis',
        WEIBIYE_CHAT_RUNNER_ENABLED: 'true', WEIBIYE_DEMO_ENABLED: 'true',
        WEIBIYE_CORS_ORIGINS: JSON.stringify([ui]), WEIBIYE_FRONTEND_ORIGIN: ui,
        WEIBIYE_E2E_API_PORT: '38101',
        WEIBIYE_MOCK_MAIL_DIR: '../.verification/p3-integration-mail',
        WEIBIYE_LOGIN_IP_LIMIT: '300', WEIBIYE_REGISTER_IP_LIMIT: '200',
        WEIBIYE_CHAT_COMMANDS_PER_MINUTE: '100', WEIBIYE_CHAT_IP_COMMANDS_PER_MINUTE: '1000',
      },
    },
    {
      command: 'npm run dev -- --port 35174', url: ui, reuseExistingServer: false,
      env: { WEIBIYE_DEV_API_TARGET: api },
    },
  ],
})

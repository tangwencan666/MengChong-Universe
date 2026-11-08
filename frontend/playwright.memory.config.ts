import process from 'node:process'
import { readFileSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const target = JSON.parse(readFileSync('../.verification/p4c-memory-target.json', 'utf8')) as {
  run_id: string; database: string; cluster: string
}
if (!/^[a-f\d]{32}$/.test(target.run_id)
  || target.database !== `weibiye_p4c_test_${target.run_id}`
  || target.cluster !== '7703042374370492450'
  || !process.env.WEIBIYE_DATABASE_URL?.endsWith(`:25433/${target.database}`)) {
  throw new Error('Prepare and explicitly select the guarded P4-C test database first.')
}
const python = process.env.WEIBIYE_TEST_PYTHON ?? (process.platform === 'win32'
  ? '../backend/.venv/Scripts/python.exe' : '../backend/.venv/bin/python')
const ui = 'http://127.0.0.1:35305'
const api = 'http://127.0.0.1:38305'

export default defineConfig({
  outputDir: '../.verification/p4c-memory-artifacts',
  testDir: './e2e-memory', fullyParallel: false, workers: 1, retries: 0, timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: process.env.WEIBIYE_MEMORY_REPORT_NAME ?? '../.verification/p4c-browser-results.json' }]],
  use: {
    baseURL: ui, browserName: 'chromium', screenshot: 'only-on-failure', trace: 'off',
    launchOptions: process.env.WEIBIYE_BROWSER_PATH ? { executablePath: process.env.WEIBIYE_BROWSER_PATH } : {},
  },
  webServer: [
    {
      command: `"${python}" -B ../backend/scripts/p4c_memory_server.py`,
      url: `${api}/health/ready`, reuseExistingServer: false, timeout: 60_000,
      env: {
        WEIBIYE_ENVIRONMENT: 'test', WEIBIYE_LLM_PROVIDER: 'mock', WEIBIYE_REAL_LLM_ENABLED: 'false',
        WEIBIYE_REDIS_URL: 'redis://127.0.0.1:26380/0',
        WEIBIYE_AUTH_STORE_BACKEND: 'redis', WEIBIYE_RATE_LIMIT_BACKEND: 'redis',
        WEIBIYE_CHAT_RUNNER_ENABLED: 'true', WEIBIYE_MEMORY_MANAGEMENT_ENABLED: 'true',
        WEIBIYE_MEMORY_INJECTION_ENABLED: 'true',
        WEIBIYE_MEMORY_HMAC_KEY: `p4c-test-only-not-production-${target.run_id}`,
        WEIBIYE_DEMO_ENABLED: 'true', WEIBIYE_CORS_ORIGINS: JSON.stringify([ui]),
        WEIBIYE_FRONTEND_ORIGIN: ui, WEIBIYE_E2E_API_PORT: '38305',
        WEIBIYE_LOGIN_IP_LIMIT: '300', WEIBIYE_REGISTER_IP_LIMIT: '200',
        WEIBIYE_CHAT_COMMANDS_PER_MINUTE: '100', WEIBIYE_CHAT_IP_COMMANDS_PER_MINUTE: '1000',
      },
    },
    {
      command: 'npm run dev -- --port 35305 --strictPort', url: ui, reuseExistingServer: false,
      env: { WEIBIYE_DEV_API_TARGET: api },
    },
  ],
})

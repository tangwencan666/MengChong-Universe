import process from 'node:process'
import { defineConfig } from '@playwright/test'

const backendPython = process.env.WEIBIYE_TEST_PYTHON ?? (process.platform === 'win32'
  ? '../backend/.venv/Scripts/python.exe' : '../backend/.venv/bin/python')
function configuredPort(name: string, fallback: number) {
  const value = process.env[name] ?? String(fallback)
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`Invalid ${name}`)
  return Number(value)
}
const uiPort = configuredPort('WEIBIYE_E2E_UI_PORT', 25174)
const apiPort = configuredPort('WEIBIYE_E2E_API_PORT', 28101)
const uiOrigin = `http://127.0.0.1:${uiPort}`
const apiOrigin = `http://127.0.0.1:${apiPort}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: uiOrigin,
    browserName: 'chromium',
    launchOptions: process.env.WEIBIYE_BROWSER_PATH
      ? { executablePath: process.env.WEIBIYE_BROWSER_PATH } : {},
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `"${backendPython}" -B ../backend/scripts/e2e_server.py`,
      url: `${apiOrigin}/health/live`,
      reuseExistingServer: false,
      env: {
        WEIBIYE_DATABASE_URL: 'sqlite+aiosqlite:///:memory:',
        WEIBIYE_REDIS_URL: 'redis://127.0.0.1:1/0',
        WEIBIYE_ENVIRONMENT: 'test',
        WEIBIYE_LLM_PROVIDER: 'mock',
        WEIBIYE_REAL_LLM_ENABLED: 'false',
        WEIBIYE_DEMO_ENABLED: 'true',
        WEIBIYE_RATE_LIMIT_BACKEND: 'memory',
        WEIBIYE_AUTH_STORE_BACKEND: 'memory',
        WEIBIYE_LOGIN_IP_LIMIT: '300',
        WEIBIYE_REGISTER_IP_LIMIT: '200',
        WEIBIYE_RECOVERY_IP_LIMIT: '300',
        WEIBIYE_CORS_ORIGINS: JSON.stringify([uiOrigin]),
        WEIBIYE_E2E_UI_PORT: String(uiPort),
        WEIBIYE_E2E_API_PORT: String(apiPort),
      },
    },
    {
      command: `npm run dev -- --port ${uiPort}`,
      url: uiOrigin,
      reuseExistingServer: false,
      env: { WEIBIYE_DEV_API_TARGET: apiOrigin },
    },
  ],
})

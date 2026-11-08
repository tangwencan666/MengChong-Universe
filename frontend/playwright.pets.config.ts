import process from 'node:process'
import { readFileSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const target = JSON.parse(readFileSync('../.verification/pet-scope/target.json', 'utf8')) as { run_id: string; database: string; cluster: string }
if (!/^[a-f\d]{32}$/.test(target.run_id) || target.database !== `weibiye_pet_test_${target.run_id}`
  || target.cluster !== '7703042374370492450' || !process.env.WEIBIYE_DATABASE_URL?.endsWith(`:25433/${target.database}`)) throw new Error('Prepare/select the isolated pet database first.')
const python = process.platform === 'win32' ? '../backend/.venv/Scripts/python.exe' : '../backend/.venv/bin/python'
const ui = 'http://127.0.0.1:35306'
const api = 'http://127.0.0.1:38306'
const legacyMemoryRegression = process.env.WEIBIYE_PET_LEGACY_MEMORY_REGRESSION === '1'
if (legacyMemoryRegression) {
  process.env.WEIBIYE_MEMORY_UI_ORIGIN = ui
  process.env.WEIBIYE_MEMORY_OBSERVATIONS = '../.verification/pet-scope/provider-observations.jsonl'
}
export default defineConfig({
  testDir: legacyMemoryRegression ? './e2e-memory' : './e2e-pets', outputDir: '../.verification/pet-scope/browser-artifacts', workers: 1, retries: 0, timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: legacyMemoryRegression ? '../.verification/pet-scope/legacy-memory-browser-results.json' : '../.verification/pet-scope/browser-results.json' }]],
  use: { baseURL: ui, screenshot: 'only-on-failure', browserName: 'chromium',
    launchOptions: process.env.WEIBIYE_BROWSER_PATH ? { executablePath: process.env.WEIBIYE_BROWSER_PATH } : {} },
  webServer: [{ command: `"${python}" -B ../backend/scripts/pet_scope_server.py`, url: `${api}/health/ready`, reuseExistingServer: false,
    env: { WEIBIYE_ENVIRONMENT: 'test', WEIBIYE_LLM_PROVIDER: 'mock', WEIBIYE_REAL_LLM_ENABLED: 'false',
      WEIBIYE_MEMORY_MANAGEMENT_ENABLED: 'true', WEIBIYE_MEMORY_INJECTION_ENABLED: 'true',
      WEIBIYE_MEMORY_HMAC_KEY: `pet-browser-fixture-only-${target.run_id}`,
      WEIBIYE_AUTH_STORE_BACKEND: 'redis', WEIBIYE_RATE_LIMIT_BACKEND: 'redis', WEIBIYE_REDIS_URL: 'redis://127.0.0.1:26380/0',
      WEIBIYE_CORS_ORIGINS: JSON.stringify([ui]), WEIBIYE_FRONTEND_ORIGIN: ui,
      WEIBIYE_LOGIN_IP_LIMIT: '300', WEIBIYE_REGISTER_IP_LIMIT: '200', WEIBIYE_CHAT_COMMANDS_PER_MINUTE: '100', WEIBIYE_CHAT_IP_COMMANDS_PER_MINUTE: '1000',
    } },
  { command: 'npm run dev -- --port 35306 --strictPort', url: ui, reuseExistingServer: false, env: { WEIBIYE_DEV_API_TARGET: api } }],
})

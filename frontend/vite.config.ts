import { defineConfig } from 'vite'
import process from 'node:process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    strictPort: true,
    watch: { ignored: ['**/.verification/**', '**/test-results/**', '**/playwright-report/**'] },
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem,key,pfx}', '**/.git/**', '**/.verification/**', '**/.venv/**', '**/*.db', '**/*.sqlite*'],
    },
    proxy: {
      '/api': process.env.WEIBIYE_DEV_API_TARGET ?? 'http://127.0.0.1:38101',
      '/health': process.env.WEIBIYE_DEV_API_TARGET ?? 'http://127.0.0.1:38101',
    },
  },
})

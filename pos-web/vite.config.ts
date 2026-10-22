import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The voice server (FastAPI) runs on :8000; the dev server proxies its socket and API so the
// app can use same-origin URLs everywhere.
const server = process.env.VOICEPOS_SERVER ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
      '/health': server,
      '/parse': server,
    },
  },
  test: { environment: 'node' },
})

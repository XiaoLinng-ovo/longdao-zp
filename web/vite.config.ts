import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: Number(process.env.VITE_PORT || 5174),
    strictPort: true,
    proxy: {
      '/api': process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3100',
      // Browser (and Cloudflare Tunnel) connects to the same origin; Vite bridges
      // the WebSocket to the local FunASR service, which must not be exposed publicly.
      '/funasr-stream': {
        target: process.env.VITE_FUNASR_PROXY_TARGET || 'ws://127.0.0.1:10095',
        ws: true,
        rewrite: (path) => path.replace(/^\/funasr-stream/, '/stream'),
      },
    },
  },
})

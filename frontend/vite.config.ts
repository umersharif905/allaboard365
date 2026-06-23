import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Dev: :5173 → :3001. Test stack (OE_TEST_SERVERS=1 / npm run dev:test): :5273 → :3101
const testServers = process.env.OE_TEST_SERVERS === '1'
const frontendPort = testServers
  ? Number(process.env.OE_TEST_FRONTEND_PORT || 5273)
  : Number(process.env.VITE_PORT || 5173)
const backendPort = testServers
  ? Number(process.env.OE_TEST_BACKEND_PORT || 3101)
  : Number(process.env.VITE_BACKEND_PORT || 3001)
const apiProxyTarget = `http://localhost:${backendPort}`

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  css: {
    postcss: './postcss.config.js',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: frontendPort,
    // Test stack (:5273): no HMR/file watch — stable Cypress runs. Dev :5173 keeps live reload.
    ...(testServers
      ? { hmr: false, watch: null }
      : {}),
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => {
          console.log('Proxying:', path, 'to', path);
          return path;
        }
      }
    }
  }
})
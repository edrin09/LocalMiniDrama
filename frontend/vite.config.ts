import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // dev 模式（npm run dev）
  server: {
    port: 3013,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5679',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/uploads': {
        target: 'http://localhost:5679',
        changeOrigin: true,
      },
    },
  },
  // 生产 preview 模式（npm run build && npm run preview）
  preview: {
    port: 3013,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5679',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/uploads': {
        target: 'http://localhost:5679',
        changeOrigin: true,
      },
    },
  },
});
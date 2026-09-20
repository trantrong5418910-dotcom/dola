import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = process.env.PORT || 8788;

export default defineConfig({
  root: HERE,
  plugins: [vue()],
  resolve: {
    alias: { '@': path.join(HERE, 'src') },
  },
  build: {
    // 构建产物直接给 Express 托管，做到「npm start 单端口」跑起来
    outDir: path.join(HERE, '..', 'server', 'public'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
});

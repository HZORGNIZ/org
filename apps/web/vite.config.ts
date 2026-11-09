import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      disable: process.env.NO_PWA === '1',
      registerType: 'autoUpdate',
      manifest: {
        name: 'MyOrgNiz 团队协作',
        short_name: 'MyOrgNiz',
        description: '团队 AI 协作系统：公告/任务/日报周报/知识库/资源预约',
        theme_color: '#123e86',
        background_color: '#edf2fa',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 预缓存只放带 hash 的静态资源，不把 index.html 收进去：
        // 否则旧版 SW 会用缓存里的 index.html 应答导航，用户明明已经上线新功能却看不到新界面
        globPatterns: ['**/*.{js,css,svg,png,woff2}'],
        // 页面导航一律走网络（nginx 已对 index.html / sw.js 发 no-cache），保证发版可见
        navigateFallback: null,
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});

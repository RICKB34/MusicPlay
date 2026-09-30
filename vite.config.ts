import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Rhythm Forge — 音乐谱面生成器',
        short_name: 'RhythmForge',
        description: '上传本地音乐，自动生成可互动的下落式音游谱面，支持双人同谱对战',
        // 默认主题是 QQ 音乐风：品牌绿状态栏 + 白色启动闪屏背景
        theme_color: '#31c27c',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    // host:true 让同一 WiFi 下的手机能直接访问，现场演示必需
    host: true,
    port: 5173,
    watch: {
      // 绝不能监视音频文件：Vite 的 fs watcher 碰到被其他进程占用的
      // 大文件会抛 EBUSY 并**整个进程退出**（实测踩过：放了个 mp3 进项目
      // 目录，开发服务器就崩了）。音频也不需要热重载，直接排除。
      ignored: [
        '**/test_music/**',
        '**/*.{mp3,flac,wav,m4a,aac,ogg,opus,wma}',
        '**/dist/**',
      ],
    },
  },
  // 分析管线跑在 module worker 里
  worker: { format: 'es' },
})

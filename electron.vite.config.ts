import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import commonjs from '@rollup/plugin-commonjs';
import { resolve } from 'path';

export default defineConfig({
  main: {
    // @hongguo/server（原 data-server，源码在 src/server，CJS 无类型）：alias 到源码入口
    resolve: {
      alias: [
        { find: /^@hongguo\/server$/, replacement: resolve(__dirname, 'src/server/index.js') },
        // js-yaml 固定走其自带 ESM 产物：electron-updater 的 CJS require 链经 commonjs 插件
        // 转换时，循环依赖包装会让 Type 类实例化出 namespace 代理，instanceof 校验失败 →
        // 应用启动即抛 YAMLException（任务 66-B）；单一副本 + 零 CJS 转换彻底规避
        { find: /^js-yaml$/, replacement: resolve(__dirname, 'node_modules/js-yaml/dist/js-yaml.mjs') },
      ],
    },
    // axios/cheerio/tough-cookie/electron-updater 一并内联进产物：打包后无需依赖生产 node_modules
    plugins: [
      externalizeDepsPlugin({ exclude: ['axios', 'cheerio', 'tough-cookie', 'electron-updater'] }),
      // server 源码与 axios/cheerio 均为 CJS，内联进 ESM 产物需 commonjs 转换；
      // strictRequires:'auto'：v29 默认全量严格包装会导致命名导出丢失（electron-updater 需要
      // 命名导入 NsisUpdater 等），auto 模式仅对循环依赖包装，命名导出可被静态检测
      commonjs({ include: [/node_modules/, /src[\\/]server[\\/]/], strictRequires: 'auto' }),
    ],
    build: {
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
      outDir: 'out/main',
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') },
      outDir: 'out/preload',
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});

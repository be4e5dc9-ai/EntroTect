// 核心包测试配置:放宽 Vite 文件系统白名单到系统临时目录,
// 供插件加载器测试动态 import 临时目录下的 .mjs 插件文件。
import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";

export default defineConfig({
  server: {
    fs: {
      allow: [tmpdir()],
    },
  },
});

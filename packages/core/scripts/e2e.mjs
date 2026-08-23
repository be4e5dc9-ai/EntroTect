// =====================================================================
// 真实 API 端到端冒烟:用 %APPDATA%/EntroTect 的配置跑一轮真实闭环。
// 用法: node packages/core/scripts/e2e.mjs
// 无 API Key 时跳过(exit 0);失败 exit 1。
// =====================================================================

import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  buildBuiltinTools,
  buildSystemPrompt,
  createProvider,
  loadConfig,
  runAgent,
} from "../dist/index.js";

const appDataDir = path.join(process.env.APPDATA ?? "", "EntroTect");
const config = await loadConfig(appDataDir);
if (!config.apiKey) {
  console.log("SKIP: 未配置 API Key");
  process.exit(0);
}

const workspace = config.workspaceDir?.trim() || os.homedir();
const artifactDir = await mkdtemp(path.join(tmpdir(), "entrotect-e2e-"));

console.log(`模型: ${config.model}`);
console.log(`工作目录: ${workspace}`);

const provider = createProvider(config);
const toolStates = [];
const result = await runAgent(
  [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "必须调用 glob 工具列出当前工作目录下最多 10 个文件,然后用一句话总结你看到了几个文件。不要省略工具调用。",
        },
      ],
    },
  ],
  {
    provider,
    tools: buildBuiltinTools(),
    systemPrompt: buildSystemPrompt({
      cwd: workspace,
      model: config.model,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
    }),
    maxTokens: config.maxTokens ?? 8192,
    temperature: config.temperature,
    emit: (event) => {
      if (event.type === "tool-state") toolStates.push(event.state);
      if (event.type === "error") console.error("[event:error]", event.message);
    },
    approve: async () => ({ decision: "allow-once" }),
    cwd: workspace,
    artifactDir,
  },
);

console.log("工具生命周期:", toolStates.join(" → "));
console.log("最终文本:", result.finalText);
if (result.error) {
  console.error("E2E 失败:", result.error);
  process.exit(1);
}
if (!result.finalText || toolStates.length === 0) {
  console.error("E2E 失败:未完成工具闭环");
  process.exit(1);
}
console.log("E2E 通过");

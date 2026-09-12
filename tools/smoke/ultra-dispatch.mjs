// Opt-in live check: two model calls, no tool execution or app-data writes.
// Build shared/core first, then: node tools/smoke/ultra-dispatch.mjs <app-data-directory>
import { loadConfig, createProvider, buildSystemPrompt, createTaskTool } from "../../packages/core/dist/index.js";
import { ULTRA_DISPATCH_PROMPT, ultraDirectTool } from "../../packages/core/dist/loop/ultra.js";
import { zodToJsonSchema } from "../../packages/core/dist/tools/zod-json.js";

const appDataDir = process.argv[2];
if (!appDataDir) throw new Error("Pass the application data directory explicitly.");
const config = await loadConfig(appDataDir);
const active = config.providers?.find((entry) => entry.id === config.activeProviderId);
const provider = createProvider({ ...config, ...(active ? { baseUrl: active.baseUrl, apiKey: active.apiKey } : {}) });
const tools = [createTaskTool(async () => { throw new Error("This check never executes delegated tasks."); }), ultraDirectTool];
const systemPrompt = buildSystemPrompt({ cwd: process.cwd(), model: config.model, platform: process.platform, date: new Date().toISOString().slice(0, 10), reasoningEffort: "ultra" }) + ULTRA_DISPATCH_PROMPT;

for (const scenario of [
  { name: "research", prompt: "调研类人脑 Agent 记忆系统的设计方案，以及现有产品和开源项目；比较其架构和证据。", expected: "task" },
  { name: "simple", prompt: "你好，请告诉我 1+1 等于几。", expected: "ultra_direct" },
]) {
  const history = [{ role: "user", content: [{ type: "text", text: scenario.prompt }] }];
  let calls = [];
  let usage;
  let error = false;
  let attempts = 0;
  for (; attempts < 2; attempts++) {
    const blocks = [];
    let reasoningContent;
    calls = [];
    for await (const event of provider.streamBlocks(history, {
      systemPrompt: systemPrompt + (attempts > 0 ? "\n上次未完成有效委派决定，请纠正工具调用；不要重复直接作答。" : ""),
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: zodToJsonSchema(tool.inputSchema) })),
      reasoningEffort: "high", maxTokens: 8192,
    }, AbortSignal.timeout(90_000))) {
      if (event.type === "block") {
        blocks.push(event.block);
        if (event.block.type === "tool-call") calls.push(event.block);
      }
      if (event.type === "turn-complete") {
        usage = event.usage;
        reasoningContent = event.reasoningContent;
      }
      if (event.type === "error") error = true; // Do not print upstream bodies or credentials.
    }
    if (calls.length > 0 || error) break;
    if (blocks.length > 0) history.push({ role: "assistant", content: blocks, ...(reasoningContent ? { reasoningContent } : {}) });
  }
  const valid = !error && calls.length > 0 && calls.every((call) => {
    if (call.name !== scenario.expected) return false;
    try { return tools.find((tool) => tool.name === call.name).inputSchema.safeParse(JSON.parse(call.arguments)).success; }
    catch { return false; }
  });
  console.log(JSON.stringify({ scenario: scenario.name, model: config.model, attempts: attempts + 1, tools: calls.map((call) => call.name), valid, usage }));
  if (!valid) process.exitCode = 1;
}

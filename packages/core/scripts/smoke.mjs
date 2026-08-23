// =====================================================================
// 无头冒烟:mock provider + 真实工具跑一轮完整 agent 闭环。
// 由 tools/smoke/smoke.py 驱动;不依赖网络与真实 API Key。
// =====================================================================

import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildBuiltinTools,
  buildSystemPrompt,
  runAgent,
} from "../dist/index.js";

// 最小 mock provider:第一轮发 read 工具调用,第二轮给最终文本
const mockProvider = {
  model: "mock",
  script: [
    {
      events: [
        { type: "block", block: { type: "tool-call", id: "s1", name: "read", arguments: JSON.stringify({ file_path: "smoke.txt" }) } },
        { type: "turn-complete", finishReason: "tool_calls", usage: null },
      ],
    },
    {
      events: [
        { type: "text-delta", text: "smoke" },
        { type: "text-delta", text: " ok" },
        { type: "block", block: { type: "text", text: "smoke ok" } },
        { type: "turn-complete", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    },
  ],
  async *streamBlocks(messages, _options, _signal) {
    const chunk = this.script.shift();
    for (const event of chunk.events) yield event;
  },
};

const cwd = await mkdtemp(path.join(tmpdir(), "entrotect-smoke-"));
await writeFile(path.join(cwd, "smoke.txt"), "smoke content", "utf8");

const events = [];
const result = await runAgent(
  [{ role: "user", content: [{ type: "text", text: "读 smoke.txt" }] }],
  {
    provider: mockProvider,
    tools: buildBuiltinTools(),
    systemPrompt: buildSystemPrompt({ cwd, model: "mock", platform: "win32", date: new Date().toISOString().slice(0, 10) }),
    maxTokens: 2048,
    emit: (event) => events.push(event),
    approve: async () => "allow-once",
    cwd,
    artifactDir: path.join(cwd, ".artifacts"),
  },
);

const checks = [];
checks.push(["最终文本", result.finalText === "smoke ok"]);
checks.push(["历史配对", result.messages.length === 4]);
checks.push(["工具执行", (await readFile(path.join(cwd, "smoke.txt"), "utf8")) === "smoke content"]);
const toolState = events.filter((e) => e.type === "tool-state");
checks.push(["工具生命周期", toolState.length === 2 && toolState[0].state === "executing" && toolState[1].state === "completed"]);

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);

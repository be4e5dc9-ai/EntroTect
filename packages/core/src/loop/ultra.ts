import { z } from "zod";
import type { Tool } from "../tools/types.js";

/** A per-run coordination step, independent of the provider's native reasoning effort. */
export const ULTRA_DISPATCH_PROMPT = `
<ultra_dispatch>
先决定本轮如何协作，再开始主要工作。此阶段只提供 task 和 ultra_direct。
调研、搜索与比较产品/开源项目、复杂方案设计、排查和实现任务：至少调用一次 task，委派一个独立子问题。纯调研同样需要委派，不以“没有代码实现”为由跳过。
有多个独立方向时可同轮调用多个 task，例如学术依据、开源实现、产品能力；写清范围、已有上下文、是否只读、需要的来源/文件证据和回报。给主代理保留整合和交叉验证工作，勿把原请求整段转交。
依赖子代理回报才能确定内容或参数的操作，等收到回报后下一轮再调用；不要预填未经核验的结果。
只有简单问答/单步操作、用户明确禁止委派、或必须先澄清才能拆分时，调用 ultra_direct 并说明具体原因。
此阶段必须用上述工具之一作出决定，不能只说“我会调研”或直接给最终答案。无需创建 Todo。
</ultra_dispatch>`;

const directSchema = z.strictObject({
  category: z.enum(["simple_request", "user_opt_out", "needs_clarification"]),
  reason: z.string().trim().min(1).describe("说明本轮为什么无需或不能委派；复杂调研不能以无需实现为由跳过"),
});

/** Internal decision only: no filesystem, network, or permission changes. */
export const ultraDirectTool: Tool = {
  name: "ultra_direct",
  description: "仅用于简单请求、用户明确禁止子代理、或必须先澄清的情况，记录不委派的具体原因。复杂调研/比较/设计请调用 task。",
  inputSchema: directSchema,
  isReadOnly: true,
  preview: () => "本轮协作方式",
  async call(args) {
    const { reason } = directSchema.parse(args);
    return `本轮由主代理直接处理。原因：${reason}`;
  },
};

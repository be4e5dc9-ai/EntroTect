// =====================================================================
// glob:文件名模式匹配(fast-glob,默认忽略 node_modules/.git 等)
// =====================================================================

import fg from "fast-glob";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { resolveInsideCwd } from "./paths.js";

const MAX_RESULTS = 500;

const inputSchema = z.strictObject({
  pattern: z.string().describe("glob 模式,如 **/*.ts、src/**/*.test.ts"),
  path: z.string().optional().describe("搜索根目录(默认工作目录)"),
});

type Input = z.infer<typeof inputSchema>;

export const globTool: Tool = {
  name: "glob",
  description:
    "按 glob 模式查找文件名。默认忽略 node_modules、.git、dist、out、.venv 等目录。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => (args as Input).pattern,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const root = args.path ? resolveInsideCwd(ctx.cwd, args.path, ctx.protectedPaths) : ctx.cwd;
    const matches = await fg(args.pattern, {
      cwd: root,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**", "**/.venv/**"],
    });
    if (matches.length === 0) return "无匹配";
    if (matches.length > MAX_RESULTS) {
      return matches.slice(0, MAX_RESULTS).join("\n") +
        `\n... 共 ${matches.length} 个结果,已截断至前 ${MAX_RESULTS} 个`;
    }
    return matches.join("\n");
  },
};

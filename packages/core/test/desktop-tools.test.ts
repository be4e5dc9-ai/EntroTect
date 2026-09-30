import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBrowserTools } from "../src/tools/browser.js";
import { createResearchTools } from "../src/tools/research.js";
import { ResearchService } from "../src/research/service.js";
import { buildApprovalRequest } from "../src/permission/request.js";
import { normalizePermissionResource } from "../src/permission/rules.js";
import { runAgent } from "../src/loop/agent.js";
import { toolsForSession } from "../src/tools/plan.js";
import { MockProvider, textBlock, toolCall, turnComplete } from "./helpers/mock-provider.js";
import type { ToolContext } from "../src/tools/types.js";
import { knownModelSupportsImages } from "../src/provider/contexts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "entrotect-desktop-tools-"));
  roots.push(root);
  const ctx: ToolContext = { cwd: path.join(root, "workspace"), artifactDir: path.join(root, "artifacts"), sandboxMode: "restricted", fileStates: new Map() };
  await mkdir(ctx.cwd);
  return { root, ctx };
}
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=";

describe("desktop tools", () => {
  it("binds research to the captured session, validates inputs and exports through the file gate", async () => {
    const { root, ctx } = await setup();
    const service = new ResearchService(root);
    const tools = createResearchTools("sessionA", (command) => service.execute(command));
    const save = tools.find((tool) => tool.name === "library_save")!;
    const source = { title: "Course notes", url: "https://example.com/course", excerpt: "Evidence" };
    await save.call({ source }, ctx);
    await expect(save.call({ source, sessionId: "sessionB" }, ctx)).rejects.toThrow();
    expect((await service.execute({ action: "list", sessionId: "sessionB" })).sources).toEqual([]);
    const exporter = tools.find((tool) => tool.name === "library_export")!;
    const args = { format: "markdown", file_path: "notes.md" };
    const approval = buildApprovalRequest("export", exporter, args, ctx.cwd, "notes.md");
    expect(approval.targets).toEqual([{ action: "edit", resource: normalizePermissionResource(path.resolve(ctx.cwd, "notes.md")) }]);
    await exporter.call(args, ctx);
    expect(await readFile(path.join(ctx.cwd, "notes.md"), "utf8")).toContain("https://example.com/course");
    await expect(exporter.call({ ...args, file_path: "../escape.md" }, ctx)).rejects.toThrow();
  });

  it("rejects unauthorized parameters and turns backend errors into tool failures", async () => {
    const { ctx } = await setup();
    const tools = createBrowserTools(async () => ({ ok: false, tabs: [], error: "Navigation denied" }));
    const open = tools.find((tool) => tool.name === "browser_open")!;
    await expect(open.call({ url: "https://example.com", userInitiated: true }, ctx)).rejects.toThrow();
    await expect(open.call({ url: "https://example.com" }, ctx)).rejects.toThrow("Navigation denied");
  });

  it("passes screenshots as a separate vision message after paired tool results without leaking base64 into logs", async () => {
    const { ctx } = await setup();
    const tools = createBrowserTools(async () => ({ ok: true, tabs: [], tabId: "tab", screenshot: { dataUrl: `data:image/png;base64,${png}`, width: 1, height: 1 } }));
    const provider = new MockProvider([
      { events: [toolCall("shot", "browser_screenshot", '{"tabId":"tab"}'), turnComplete()] },
      { events: [textBlock("done"), turnComplete()] },
    ]);
    const summaries: string[] = [];
    const result = await runAgent([], { ...ctx, provider, tools, systemPrompt: "test", approve: async () => ({ decision: "allow-once" }), emit: (event) => {
      if (event.type === "tool-state" && event.summary) summaries.push(event.summary);
    } });
    expect(result.error).toBeNull();
    const history = provider.receivedHistory[1]!;
    expect(history[1]!.content[0]).toMatchObject({ type: "tool-result", toolCallId: "shot", isError: false });
    expect(history[2]!.content[1]).toMatchObject({ type: "image", mime: "image/png", dataBase64: png });
    expect(summaries.join("")).not.toContain(png);
    const output = JSON.parse((history[1]!.content[0] as { content: string }).content);
    expect((await readFile(output.screenshot)).subarray(1, 4).toString()).toBe("PNG");
  });

  it("keeps webpage research available in Plan while removing mutation and export tools", () => {
    const tools = [...createBrowserTools(async () => ({ ok: true, tabs: [] })), ...createResearchTools("session", async () => ({}))];
    const names = toolsForSession(tools, { mode: "plan", goal: null }).map((tool) => tool.name);
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_open");
    expect(names).toContain("library_list");
    for (const name of ["browser_click", "browser_type", "browser_press", "library_save", "library_remove", "library_export_table"]) expect(names).not.toContain(name);
  });

  it("saves screenshots without sending images to text-only or undeclared models", async () => {
    const { ctx } = await setup();
    expect(knownModelSupportsImages("mimo-v2.5-pro")).toBe(false);
    expect(knownModelSupportsImages("xiaomi/mimo-v2.5")).toBe(true);
    expect(knownModelSupportsImages("my-custom-model")).toBeUndefined();
    for (const model of ["mimo-v2.5-pro", "my-custom-model"]) {
      let emitted = false;
      const tool = createBrowserTools(async () => ({ ok: true, tabs: [], screenshot: { dataUrl: `data:image/png;base64,${png}`, width: 1, height: 1 } }), { model }).find((entry) => entry.name === "browser_screenshot")!;
      const reply = JSON.parse(await tool.call({ tabId: "tab" }, { ...ctx, modelImage: () => { emitted = true; } }));
      expect(reply.visualInputIncluded).toBe(false);
      expect(reply.note).toContain("browser_snapshot");
      expect(emitted).toBe(false);
      expect((await readFile(reply.screenshot)).subarray(1, 4).toString()).toBe("PNG");
    }
  });
});

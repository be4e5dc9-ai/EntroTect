import { describe, expect, it } from "vitest";
import { SessionPermissionGate } from "../src/permission/gate.js";
import { buildApprovalRequest } from "../src/permission/request.js";
import { normalizePermissionResource, permissionRuleMatches } from "../src/permission/rules.js";
import { buildBuiltinTools } from "../src/tools/registry.js";
import type { ApprovalRequest } from "@entrotect/shared";

function makeRequest(toolName: string, id: string): ApprovalRequest {
  return { toolCallId: id, toolName, preview: "p", description: "d" };
}

const TIMEOUT = 50;

describe("SessionPermissionGate", () => {
  it("只读工具自动放行,不问用户", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT);
    const outcome = await gate.request(makeRequest("read", "1"));
    expect(outcome.decision).toBe("allow-once");
    // 且无挂起审批
    gate.respond("1", "deny");
  });

  it("full 模式:全部工具(含写类)自动放行", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT, "full");
    expect((await gate.request(makeRequest("bash", "f1"))).decision).toBe("allow-once");
    expect((await gate.request(makeRequest("write", "f2"))).decision).toBe("allow-once");
    expect((await gate.request(makeRequest("edit", "f3"))).decision).toBe("allow-once");
  });

  it("setMode 更新写工具的真实闸门判断", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT, "write");

    expect((await gate.request(makeRequest("read", "mode-read"))).decision).toBe("allow-once");

    let writeSettled = false;
    const pendingWrite = gate.request(makeRequest("write", "mode-write"));
    void pendingWrite.then(() => {
      writeSettled = true;
    });
    await Promise.resolve();
    expect(writeSettled).toBe(false);
    gate.setMode("full");
    await Promise.resolve();
    expect(writeSettled).toBe(false);
    gate.respond("mode-write", "allow-once");
    expect((await pendingWrite).decision).toBe("allow-once");

    expect((await gate.request(makeRequest("write", "mode-full-write"))).decision).toBe("allow-once");
  });

  it("setMode ask 让只读工具重新进入真实审批", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT, "full");

    expect((await gate.request(makeRequest("read", "ask-read-full"))).decision).toBe("allow-once");

    gate.setMode("ask");
    let readSettled = false;
    const pendingRead = gate.request(makeRequest("read", "ask-read"));
    void pendingRead.then(() => {
      readSettled = true;
    });
    await Promise.resolve();
    expect(readSettled).toBe(false);
    gate.respond("ask-read", "allow-once");
    expect((await pendingRead).decision).toBe("allow-once");
  });

  it("ask 模式:只读工具也要批准", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT, "ask");
    const pending = gate.request(makeRequest("read", "a1"));
    gate.respond("a1", "allow-once");
    expect((await pending).decision).toBe("allow-once");
    const pending2 = gate.request(makeRequest("grep", "a2"));
    gate.respond("a2", "deny", "不需要");
    expect((await pending2).decision).toBe("deny");
  });

  it("写类工具挂起,respond allow-once 放行", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT);
    const pending = gate.request(makeRequest("write", "2"));
    gate.respond("2", "allow-once");
    expect((await pending).decision).toBe("allow-once");
  });

  it("allow-always 按工具名记忆,后续自动放行", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT);
    const first = gate.request(makeRequest("bash", "3"));
    gate.respond("3", "allow-always");
    expect((await first).decision).toBe("allow-always");

    const second = await gate.request(makeRequest("bash", "4"));
    expect(second.decision).toBe("allow-once"); // 记忆生效,即时放行
  });

  it("deny 带理由回传", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT);
    const pending = gate.request(makeRequest("write", "5"));
    gate.respond("5", "deny", "不要动这个文件");
    const outcome = await pending;
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toBe("不要动这个文件");
  });

  it("fail-closed:审批超时默认拒绝", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT);
    const outcome = await gate.request(makeRequest("bash", "6"));
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toContain("超时");
  });

  it("重复 respond 幂等忽略", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), TIMEOUT);
    const pending = gate.request(makeRequest("write", "7"));
    gate.respond("7", "allow-once");
    gate.respond("7", "deny"); // 第二次应被忽略
    expect((await pending).decision).toBe("allow-once");
  });

  it("dispose 清理挂起审批(fail-closed 收口)", async () => {
    const gate = new SessionPermissionGate(buildBuiltinTools(), 60_000);
    const pending = gate.request(makeRequest("bash", "8"));
    gate.dispose();
    expect((await pending).decision).toBe("deny");
  });

  it("会话授权只放行匹配的 Shell 命令前缀,不会放开整个 bash", async () => {
    const tools = buildBuiltinTools();
    const bash = tools.find((tool) => tool.name === "bash")!;
    const gate = new SessionPermissionGate(tools, TIMEOUT, "write");
    const firstRequest = buildApprovalRequest("shell-1", bash, { command: "git status --short" }, "C:/repo", "git status --short");
    const first = gate.request(firstRequest);
    gate.respond("shell-1", "allow-always");
    expect((await first).decision).toBe("allow-always");

    const samePrefix = buildApprovalRequest("shell-2", bash, { command: "git status --branch" }, "C:/repo", "git status --branch");
    expect(gate.wantsApproval(samePrefix)).toBe(false);

    const differentCommand = buildApprovalRequest("shell-3", bash, { command: "git push" }, "C:/repo", "git push");
    expect(gate.wantsApproval(differentCommand)).toBe(true);

    const chained = buildApprovalRequest("shell-4", bash, { command: "git status --short; git push" }, "C:/repo", "git status --short; git push");
    expect(chained.targets).toHaveLength(2);
    expect(gate.wantsApproval(chained)).toBe(true);
  });

  it("项目规则按工作区隔离并采用 last-match-wins", async () => {
    const tools = buildBuiltinTools();
    const rules = [
      { action: "edit", resource: "*", effect: "allow" as const, workspace: "c:/repo" },
      { action: "edit", resource: "c:/repo/.env", effect: "deny" as const, workspace: "c:/repo" },
    ];
    const gate = new SessionPermissionGate(tools, TIMEOUT, "write", rules);
    const denied: ApprovalRequest = {
      ...makeRequest("write", "rule-1"),
      workspace: "c:/repo",
      targets: [{ action: "edit", resource: "c:/repo/.env" }],
    };
    expect((await gate.request(denied)).decision).toBe("deny");

    const otherWorkspace: ApprovalRequest = {
      ...makeRequest("write", "rule-2"),
      workspace: "c:/other",
      targets: [{ action: "edit", resource: "c:/other/file.ts" }],
    };
    expect(gate.wantsApproval(otherWorkspace)).toBe(true);
  });

  it("运行中新增的项目 deny 会立即撤销已有会话授权", async () => {
    const tools = buildBuiltinTools();
    const bash = tools.find((tool) => tool.name === "bash")!;
    const gate = new SessionPermissionGate(tools, TIMEOUT, "write");
    const request = buildApprovalRequest("revoke-1", bash, { command: "git status --short" }, "C:/repo", "git status --short");
    const pending = gate.request(request);
    gate.respond("revoke-1", "allow-always");
    await pending;
    expect(gate.wantsApproval(buildApprovalRequest("revoke-2", bash, { command: "git status --branch" }, "C:/repo", "git status --branch"))).toBe(false);
    gate.setProjectRules([{ action: "shell", resource: "git status *", effect: "deny", workspace: "c:/repo" }]);
    const outcome = await gate.request(buildApprovalRequest("revoke-3", bash, { command: "git status --branch" }, "C:/repo", "git status --branch"));
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toContain("项目权限规则拒绝");
  });

  it("allow-project 返回可持久化的最小范围规则", async () => {
    const tools = buildBuiltinTools();
    const write = tools.find((tool) => tool.name === "write")!;
    const gate = new SessionPermissionGate(tools, TIMEOUT, "write");
    const request = buildApprovalRequest("persist-1", write, { file_path: "src/a.ts", content: "x" }, "C:/repo", "src/a.ts");
    const pending = gate.request(request);
    gate.respond("persist-1", "allow-project");
    const outcome = await pending;
    expect(outcome.rules).toEqual(request.suggestedRules);
    expect(outcome.rules?.[0]?.workspace).toBe("c:/repo");
  });

  it("危险命令保护是不可被持久规则覆盖的宿主拒绝", async () => {
    const tools = buildBuiltinTools();
    const bash = tools.find((tool) => tool.name === "bash")!;
    const gate = new SessionPermissionGate(tools, TIMEOUT, "full", [
      { action: "shell", resource: "*", effect: "allow" },
    ]);
    const request = buildApprovalRequest("danger-1", bash, { command: "Remove-Item x -Force" }, "C:/repo", "Remove-Item x -Force", "restricted");
    expect(gate.wantsApproval(request)).toBe(false);
    const outcome = await gate.request(request);
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toContain("高风险命令");
  });

  it("解释器与任意执行子命令只生成精确规则", () => {
    const tools = buildBuiltinTools();
    const bash = tools.find((tool) => tool.name === "bash")!;
    const command = buildApprovalRequest("exact-1", bash, { command: 'cmd /c "echo one"' }, "C:/repo", 'cmd /c "echo one"');
    expect(command.suggestedRules?.[0]?.resource).toBe('cmd /c "echo one"');
    const packageExec = buildApprovalRequest("exact-2", bash, { command: "pnpm dlx package" }, "C:/repo", "pnpm dlx package");
    expect(packageExec.suggestedRules?.[0]?.resource).toBe("pnpm dlx package");
  });

  it("默认模式允许网页搜索,但指定网址访问需要按域名授权", () => {
    const tools = buildBuiltinTools();
    const gate = new SessionPermissionGate(tools, TIMEOUT, "write");
    const search = tools.find((tool) => tool.name === "websearch")!;
    const fetchTool = tools.find((tool) => tool.name === "webfetch")!;
    expect(gate.wantsApproval(buildApprovalRequest("net-1", search, { query: "TypeScript" }, "C:/repo", "TypeScript"))).toBe(false);
    const fetchRequest = buildApprovalRequest("net-2", fetchTool, { url: "https://example.com/docs" }, "C:/repo", "https://example.com/docs");
    expect(gate.wantsApproval(fetchRequest)).toBe(true);
    expect(fetchRequest.suggestedRules?.[0]?.resource).toBe("https://example.com/*");
  });

  it("网页权限只规范化来源大小写，精确规则保留路径及 query 大小写", async () => {
    const resource = "HTTPS://EXAMPLE.COM/Admin?Token=A";
    expect(normalizePermissionResource(resource)).toBe("https://example.com/Admin?Token=A");
    const gate = new SessionPermissionGate([], TIMEOUT, "full", [
      { action: "browser.read", resource, effect: "deny" },
    ]);
    const request = (url: string): ApprovalRequest => ({
      ...makeRequest("browser.read", url),
      targets: [{ action: "browser.read", resource: url }],
    });
    expect((await gate.request(request("https://example.com/Admin?Token=A"))).decision).toBe("deny");
    for (const url of [
      "https://example.com/admin?Token=A",
      "https://example.com/Admin?Token=a",
      "https://example.com/Admin?token=A",
      "https://example.com/AdminxToken=A",
    ]) expect((await gate.request(request(url))).decision).toBe("allow-once");
  });

  it("网页授权 wildcard 保持来源规范化，不将精确 query 问号当成通配符", () => {
    const exact = { action: "browser.interact", resource: "https://EXAMPLE.com/Submit?ID=A", effect: "allow" as const };
    expect(permissionRuleMatches(exact, { action: "browser.interact", resource: "https://example.COM/Submit?ID=A" })).toBe(true);
    expect(permissionRuleMatches(exact, { action: "browser.interact", resource: "https://example.com/Submit?ID=a" })).toBe(false);
    expect(permissionRuleMatches(exact, { action: "browser.interact", resource: "https://example.com/SubmitXID=A" })).toBe(false);
    expect(permissionRuleMatches({ ...exact, resource: "https://EXAMPLE.com/*" }, {
      action: "browser.interact", resource: "https://example.com/Submit?ID=A",
    })).toBe(true);
  });

  it.runIf(process.platform === "win32")("Windows 文件路径规则继续忽略大小写及分隔符差异", () => {
    expect(permissionRuleMatches({ action: "edit", resource: "C:\\Repo\\SRC\\A.ts", effect: "allow" }, {
      action: "edit", resource: "c:/repo/src/a.TS",
    })).toBe(true);
  });
});

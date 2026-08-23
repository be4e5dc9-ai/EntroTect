import { describe, expect, it } from "vitest";
import { SessionPermissionGate } from "../src/permission/gate.js";
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
});

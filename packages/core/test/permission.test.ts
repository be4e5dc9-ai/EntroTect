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
});

import { describe, expect, it } from "vitest";
import { SessionOperationScopes } from "../../app-desktop/src/main/session-operations.js";

describe("desktop task operation lifecycle", () => {
  it("shares one activation signal and cancels only the deactivated task", () => {
    const scopes = new SessionOperationScopes();
    const first = scopes.signal("first");
    const second = scopes.signal("second");
    expect(scopes.signal("first")).toBe(first);
    scopes.cancel("first");
    expect(first.aborted).toBe(true);
    expect(() => first.throwIfAborted()).toThrow("对话已切换或关闭");
    expect(second.aborted).toBe(false);
  });

  it("resuming a task cannot revive a late operation's old signal", () => {
    const scopes = new SessionOperationScopes();
    const previous = scopes.signal("task");
    scopes.cancel("task");
    const resumed = scopes.signal("task");
    expect(resumed).not.toBe(previous);
    expect(previous.aborted).toBe(true);
    expect(resumed.aborted).toBe(false);
    scopes.dispose();
    expect(resumed.aborted).toBe(true);
    expect(() => scopes.signal("new-task")).toThrow("应用正在关闭");
  });
});

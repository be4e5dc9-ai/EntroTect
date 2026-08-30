import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveInsideCwd } from "../src/tools/paths.js";

const cwd = process.platform === "win32" ? "C:\\workspace\\proj" : "/workspace/proj";

describe("resolveInsideCwd 路径收容", () => {
  it("cwd 内相对路径通过且等于 path.resolve", () => {
    const p = resolveInsideCwd(cwd, "sub/file.txt");
    expect(p).toBe(path.resolve(cwd, "sub/file.txt"));
  });

  it(". 与 cwd 本身通过", () => {
    expect(resolveInsideCwd(cwd, ".")).toBe(path.resolve(cwd, "."));
    expect(resolveInsideCwd(cwd, "sub/../sub")).toBe(path.resolve(cwd, "sub/../sub"));
  });

  it("越界 ../ 抛错", () => {
    expect(() => resolveInsideCwd(cwd, "../escape.txt")).toThrow("已拦截");
  });

  it("深层越界 ../../ 抛错", () => {
    expect(() => resolveInsideCwd(cwd, "../../x")).toThrow("已拦截");
  });

  it("指向 cwd 外的绝对路径抛错", () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\system32" : "/etc";
    expect(() => resolveInsideCwd(cwd, outside)).toThrow("已拦截");
  });

  it("保护路径命中(含子路径)抛错", () => {
    const protectedPaths = [
      path.join(cwd, "app", "config.json"),
      path.join(cwd, "app", "plugins"),
    ];
    expect(() => resolveInsideCwd(cwd, "app/config.json", protectedPaths)).toThrow("受保护");
    expect(() => resolveInsideCwd(cwd, "app/plugins/evil.mjs", protectedPaths)).toThrow("受保护");
  });

  it("保护路径大小写变体抛错(Windows)", () => {
    if (process.platform !== "win32") return;
    const protectedPaths = [path.join(cwd, "app", "plugins")];
    expect(() => resolveInsideCwd(cwd, "APP\\PLUGINS\\x", protectedPaths)).toThrow("受保护");
  });

  it("保护路径前缀误伤(如 plugins2/)不拦截", () => {
    const protectedPaths = [path.join(cwd, "app", "plugins")];
    expect(resolveInsideCwd(cwd, "app/plugins2/file.txt", protectedPaths)).toBe(
      path.resolve(cwd, "app/plugins2/file.txt"),
    );
  });
});

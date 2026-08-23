import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/tools/types.js";
import { bashTool } from "../src/tools/bash.js";
import {
  analyzeCommand,
  getSandboxMode,
  setSandboxMode,
} from "../src/sandbox/index.js";

async function makeCtx(): Promise<{ ctx: ToolContext; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "entrotect-sandbox-"));
  return {
    root,
    ctx: { cwd: root, artifactDir: path.join(root, ".artifacts") },
  };
}

// 每个用例结束后恢复 full,避免模式状态泄漏到其他测试
afterEach(() => {
  setSandboxMode("full");
});

describe("analyzeCommand 危险命令模式表", () => {
  // 危险命令:命中即 blocked=true 且 reason 非空
  const dangerous = [
    "del /f a.txt",
    "  Del /F /Q a.txt", // 前导空白 + 大小写混写
    "rm -r node_modules",
    "rd /s /q C:\\temp",
    "rmdir C:\\temp",
    "erase a.txt",
    "Remove-Item -Recurse -Force x",
    "remove-item -Recurse x",
    "ri C:\\temp -Force",
    "format C:",
    "format D: /FS:NTFS",
    "reg delete HKLM\\Software\\X",
    "shutdown /s",
    "Stop-Process -Name explorer",
    "Stop-Service spooler",
    "taskkill /F /IM node.exe",
    "Set-ExecutionPolicy Unrestricted",
    "diskpart /s script.txt",
    "deltree /y C:\\old",
    "takeown /f C:\\Windows\\System32\\x.dll",
    "icacls x.txt /deny Everyone:F",
    "cacls x.txt /deny Everyone:F",
    "Add-MpPreference -ExclusionPath C:\\",
    "Clear-RecycleBin",
    "Restart-Computer -Force",
    "Remove-PSDrive X",
    "Optimize-Volume -DriveLetter C",
    "chkdsk C: /f",
    "sfc /scannow",
    "vssadmin delete shadows /for=C:",
  ];
  for (const cmd of dangerous) {
    it(`拦截 ${cmd.trim()}`, () => {
      const verdict = analyzeCommand(cmd);
      expect(verdict.blocked).toBe(true);
      expect(verdict.reason).toBeTruthy();
    });
  }

  // 安全命令:不得误伤
  const safe = [
    "Write-Output hi",
    "git status",
    "npm test",
    "Get-ChildItem",
    "Format-List", // format 族只读格式化 cmdlet,不能误拦
    "sfc /verifyonly", // 只读扫描,只有 /scannow 拦截
    "chkdsk", // 只读检查,不带 /f 不拦截
    "Remove-Item x.txt", // 无 -Recurse/-Force 的裸 Remove-Item 不在此表
  ];
  for (const cmd of safe) {
    it(`放行 ${cmd}`, () => {
      expect(analyzeCommand(cmd).blocked).toBe(false);
    });
  }
});

describe("bash 工具与沙箱联动", () => {
  it("restricted 模式拦截危险命令,full 模式放行", async () => {
    const { ctx } = await makeCtx();

    setSandboxMode("restricted");
    expect(getSandboxMode()).toBe("restricted");
    await expect(bashTool.call({ command: "del /f x.txt" }, ctx)).rejects.toThrow(
      /沙箱.*拦截/,
    );

    // 切回 full:危险命令可执行(安全命令必然放行,只验证后者避免真删文件)
    setSandboxMode("full");
    const out = await bashTool.call({ command: "Write-Output 'ok'" }, ctx);
    expect(out).toContain("Exit code: 0");
    expect(out).toContain("ok");
  });

  it("restricted 模式下安全命令不受影响", async () => {
    const { ctx } = await makeCtx();
    setSandboxMode("restricted");
    const out = await bashTool.call({ command: "Write-Output 'safe-通过'" }, ctx);
    expect(out).toContain("Exit code: 0");
    expect(out).toContain("safe-通过");
  });
});

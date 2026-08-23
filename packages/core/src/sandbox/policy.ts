// =====================================================================
// 沙箱策略:受限模式的危险命令拦截
// 设计依据:agent-study/codex/06——Windows 平台无 bwrap/Seatbelt,
// codex 以 DangerFullAccess 占位;我们做"受限模式 = 危险命令模式拦截"
// (full = 不拦截,restricted = 命中模式即拒绝执行)。
//
// 模块级模式状态 + setter:host 加载配置后调用 setSandboxMode 注入,
// 使 policy 不依赖 config.ts(避免循环依赖,也便于测试注入)。
// =====================================================================

/** 沙箱模式:full = 完全访问(不拦截);restricted = 受限(拦截危险命令) */
export type SandboxMode = "full" | "restricted";

/** 单条危险命令模式:正则(忽略大小写、允许前导空白)+ 一句中文理由 */
interface DangerousPattern {
  pattern: RegExp;
  reason: string;
}

/**
 * 危险命令模式表。全部忽略大小写,允许命令前导空白。
 * 覆盖 Windows/PowerShell 下的删除、格式化、系统关停、提权后门类操作;
 * 命中即拦截(受限模式下),理由回显给模型。
 */
const DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  // 删除类:PowerShell 别名 rm/rd/rmdir/erase/del(后跟空格或路径即拦截)
  {
    pattern: /^\s*(?:rm|rd|rmdir|erase|del)(?:\s+|[/\\])/i,
    reason: "删除文件或目录(rm/rd/rmdir/erase/del)",
  },
  // Remove-Item 带 -Recurse 或 -Force:可能递归删除或强删受保护文件
  {
    pattern: /^\s*remove-item\b[\s\S]*-(?:recurse|force)\b/i,
    reason: "Remove-Item 带 -Recurse/-Force(递归或强制删除)",
  },
  // Remove-Item 别名 ri 带 -Recurse 或 -Force(裸 ri 由上面的 rm 族规则拦,此处只拦强删参数)
  {
    pattern: /^\s*ri(?:\s+|[/\\])[\s\S]*-(?:recurse|force)\b/i,
    reason: "Remove-Item 别名 ri 带 -Recurse/-Force(递归或强制删除)",
  },
  // 磁盘格式化:format C: / format-volume(不可逆)
  { pattern: /^\s*format(?:\s+|:)/i, reason: "格式化磁盘(format,数据不可逆)" },
  // 注册表删除:reg delete(可删除系统关键键值)
  { pattern: /^\s*reg(?:\.exe)?\s+(?:delete|del)\b/i, reason: "删除注册表键值(reg delete)" },
  // 系统关机/重启/注销:shutdown(中断会话)
  { pattern: /^\s*shutdown\b/i, reason: "关机/重启/注销系统(shutdown)" },
  // 强杀进程:Stop-Process(可能终止关键进程导致会话中断)
  { pattern: /^\s*stop-process\b/i, reason: "强制终止进程(Stop-Process)" },
  // 停用服务:Stop-Service(可能停掉关键系统服务)
  { pattern: /^\s*stop-service\b/i, reason: "停止系统服务(Stop-Service)" },
  // taskkill:命令行强杀进程(含 /F 强制)
  { pattern: /^\s*taskkill\b/i, reason: "强制结束进程(taskkill)" },
  // 修改执行策略:Set-ExecutionPolicy(放宽脚本执行限制,降安全水位)
  { pattern: /^\s*set-executionpolicy\b/i, reason: "修改 PowerShell 执行策略(Set-ExecutionPolicy)" },
  // diskpart:分区/格式化等磁盘破坏性操作入口
  { pattern: /^\s*diskpart\b/i, reason: "磁盘分区工具(diskpart,破坏性高)" },
  // deltree:DOS 时代整目录递归删除命令
  { pattern: /^\s*deltree\b/i, reason: "递归删除目录树(deltree)" },
  // takeown:夺取文件所有权(常用于提权前的准备)
  { pattern: /^\s*takeown\b/i, reason: "夺取文件所有权(takeown,提权前兆)" },
  // cacls/icacls /deny:显式拒绝 ACL(可把用户锁在关键路径之外)
  {
    pattern: /^\s*(?:cacls|icacls)\b[\s\S]*\/deny\b/i,
    reason: "cacls/icacls /deny(拒绝式 ACL,可锁死访问)",
  },
  // Add-MpPreference -Exclusion:给 Defender 加排除目录(挖后门)
  // 实际参数名是 -ExclusionPath/-ExclusionProcess/-ExclusionExtension,
  // 故匹配 "-exclusion" 前缀(不加词边界,避免漏掉 -ExclusionPath 这类接尾)
  {
    pattern: /^\s*add-mppreference\b[\s\S]*-exclusion/i,
    reason: "给 Windows Defender 添加扫描排除(Add-MpPreference -Exclusion)",
  },
  // 清空回收站:Clear-RecycleBin(被误删文件无法恢复)
  { pattern: /^\s*clear-recyclebin\b/i, reason: "清空回收站(Clear-RecycleBin,误删难恢复)" },
  // 重启计算机:Restart-Computer(中断会话)
  { pattern: /^\s*restart-computer\b/i, reason: "重启计算机(Restart-Computer)" },
  // 移除 PSDrive:Remove-PSDrive(可能卸掉映射盘/网络盘)
  { pattern: /^\s*remove-psdrive\b/i, reason: "移除 PowerShell 驱动器(Remove-PSDrive)" },
  // 磁盘碎片整理/优化:Optimize-Volume(可能包含 retrim,影响磁盘)
  { pattern: /^\s*optimize-volume\b/i, reason: "优化/整理卷(Optimize-Volume)" },
  // chkdsk /f:修复模式会锁定卷并可能丢数据
  { pattern: /^\s*chkdsk\b[\s\S]*\/f\b/i, reason: "chkdsk /f(修复模式,锁卷且可能损坏数据)" },
  // sfc /scannow:低危但毁坏性高——锁定系统文件并可能替换关键组件,拦截
  {
    pattern: /^\s*sfc\b[\s\S]*\/scannow\b/i,
    reason: "sfc /scannow(修复系统文件,毁坏性高)",
  },
  // vssadmin delete shadows:删除卷影副本(备份/还原点全灭)
  {
    pattern: /^\s*vssadmin\b[\s\S]*delete\b[\s\S]*shadows\b/i,
    reason: "删除卷影副本(vssadmin delete shadows,备份不可恢复)",
  },
];

/** 命令裁决结果:blocked = 是否拦截;拦截时附中文理由 */
export interface CommandVerdict {
  blocked: boolean;
  reason?: string;
}

/**
 * 分析命令是否命中危险模式表。
 * 与当前沙箱模式无关(纯函数):是否生效由调用方结合 getSandboxMode 决定。
 */
export function analyzeCommand(command: string): CommandVerdict {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { blocked: true, reason };
    }
  }
  return { blocked: false };
}

// ---------------------------------------------------------------------
// 模块级模式状态:host 注入配置的唯一切口(setSandboxMode)
// ---------------------------------------------------------------------

let currentMode: SandboxMode = "full";

/** host 侧注入沙箱模式(加载 config 后调用一次;测试直接调用) */
export function setSandboxMode(mode: SandboxMode): void {
  currentMode = mode;
}

/** 读取当前沙箱模式(bash 工具 call 开头用它决定是否拦截) */
export function getSandboxMode(): SandboxMode {
  return currentMode;
}

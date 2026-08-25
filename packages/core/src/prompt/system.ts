// =====================================================================
// 系统提示词组装:静态身份段 + 动态 env 块
// 设计依据:ClaudeCode/05——静态/动态分界,静态前缀字节稳定保 prompt
// cache;动态环境信息追加在尾部,不破坏前缀。
// =====================================================================

export interface SystemPromptEnv {
  cwd: string;
  model: string;
  platform: string;
  date: string;
}

/** 静态段:逐字节稳定,永不随会话变化 */
const STATIC_IDENTITY = `你是 EntroTect,一个运行在 Windows 桌面上的编码 Agent。
你通过工具与本地文件系统和 PowerShell 交互,帮助用户完成编程任务。

行为规范:
1. 修改任何文件前先 read 确认现状,不要臆造内容。
2. 使用 edit 前确保 old_string 与文件内容逐字符一致(含缩进)。
3. 工具调用失败时,根据错误信息分析原因并调整策略重试,不要重复同样的失败调用。
4. 读取大文件时用 read 的 offset/limit 分窗口,不要一次读全。
5. 涉及删除、覆盖等破坏性操作前,先说明影响范围。
6. 完成任务后简要说明做了什么、改了哪些文件。
7. 所有回复使用与用户一致的语言。
8. 结构化需求澄清：当用户输入缺少关键参数、存在歧义或有多种合理实现路径时，除非对话中用户已明确表示放权（如“你决定/随便/全权交给你/直接做不要问”等放权短语），否则不猜测、不直接执行，而是自动生成一组带说明的结构化选择题让用户确认后再继续；每题提供 2–4 个选项，每个选项附带简短说明并标注“推荐”项，用户可用上述放权短语跳过澄清。澄清时以“【需澄清】”开头，按“1) 问题 …”形式列出选择题，必要时可用 \`\`\`clarification JSON 块携带结构化数据以便 UI 渲染卡片。`;

export function buildSystemPrompt(env: SystemPromptEnv): string {
  // 动态块放尾部:静态前缀 + 缓存断点不受影响
  const dynamic = `<environment>
工作目录: ${env.cwd}
操作系统: ${env.platform}
当前日期: ${env.date}
当前模型: ${env.model}
shell: PowerShell(bash 工具的工作目录在多次调用之间持久,Set-Location 会生效)
</environment>`;
  return `${STATIC_IDENTITY}\n\n${dynamic}`;
}

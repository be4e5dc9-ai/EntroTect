// =====================================================================
// 结构化需求澄清辅助：放权检测与启发式
// 设计依据：需求 1「结构化需求澄清」——纯函数、零依赖、可单测
// 供 system.ts 行为规范与 UI 卡片复用
// =====================================================================

/** 放权短语表：命中任一即视为用户已授权跳过澄清 */
export const DELEGATED_PHRASES: readonly string[] = [
  "你决定",
  "随便",
  "全权交给你",
  "直接做不要问",
  "你定",
  "你看着办",
  "不用问",
  "自行决定",
  "全权委托",
  "你安排",
  "听你的",
] as const;

/** UI 识别的澄清标记（system.ts 要求 AI 以此开头便于卡片渲染） */
export const CLARIFICATION_MARKER = "【需澄清】";
/** 结构化数据围栏语言标记：```clarification JSON */
export const CLARIFICATION_FENCE = "clarification";
/** 兼容的备选标记：[[CLARIFICATION]] */
export const CLARIFICATION_ALT_MARKER = "[[CLARIFICATION]]";

/** 系统提示参考的规则摘要（纯文本，供 prompt 拼装或文档展示） */
export const CLARIFICATION_RULE_SUMMARY =
  "当输入缺少关键参数、存在歧义或有多种合理实现路径时需澄清；" +
  "除非命中放权短语（你决定/随便/全权交给你/直接做不要问等），否则不猜测、不直接执行；" +
  "澄清以结构化选择题呈现：每题 2–4 选项、每选项附说明并标注推荐项；" +
  "用户可回复选项编号/文本或使用放权短语跳过。";

/** 单个选项 */
export interface ClarificationOption {
  /** 选项标签，如 A/B/C 或简短标题 */
  label: string;
  /** 选项说明，1 句概括利弊/适用场景 */
  description: string;
  /** 是否为推荐项，单题宜仅一项 */
  recommended?: boolean;
  /** 点击后回传的文本，缺省为 label */
  value?: string;
}

/** 单道选择题 */
export interface ClarificationQuestion {
  /** 问题标题，明确待确认的关键点 */
  title: string;
  options: ClarificationOption[];
}

export interface ClarificationPayload {
  questions: ClarificationQuestion[];
}

/**
 * 检测文本是否包含放权短语。
 * 纯函数：仅做子串包含判断，忽略大小写与首尾空白，对 null/undefined 容错。
 */
export function isDelegated(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return DELEGATED_PHRASES.some((phrase) => trimmed.includes(phrase));
}

/**
 * 启发式：判断输入是否“可能需要澄清”。
 * 规则摘要：缺少关键参数 / 存在歧义 / 多种合理实现路径。
 * 注意：仅作启发式参考，最终是否澄清由模型结合上下文判定；
 * 若已放权则直接返回 false（跳过澄清）。
 *
 * 启发条件（任一命中即视为需要澄清）：
 * - 文本过短（<15 字符）且非放权
 * - 包含模糊动词（帮我/做一个/实现/创建/生成/优化/改一下 等）且长度 <50
 * - 包含多路径提示词（或者/或/都可以/多种/任选/待定/未定）
 * - 以疑问结尾且较短
 */
export function shouldClarify(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (isDelegated(trimmed)) return false;

  // 过短：极可能缺少参数
  if (trimmed.length < 15) return true;

  // 模糊动词 + 较短描述：缺少关键参数
  const vagueVerbs = /(帮我|请帮|做一个|写一个|实现|创建|生成|弄一个|加一个|优化|改一下|处理一下|整一个|搞一个|来一个)/;
  if (vagueVerbs.test(trimmed) && trimmed.length < 50) return true;

  // 多路径提示：存在多种合理实现
  const multiPathHints = /(或者|或\s|都可以|多种|任选|随便选|任意|待定|未定|二选一)/;
  if (multiPathHints.test(trimmed)) return true;

  // 歧义：以疑问收尾且信息量少
  if (/[？?]\s*$/.test(trimmed) && trimmed.length < 40) return true;

  // 极短且仅动词：如“做个网站”“写个脚本”
  if (/^(做|写|实现|创建|生成|弄|加|优化)/.test(trimmed) && trimmed.length < 25) return true;

  return false;
}

/** 判断文本是否包含澄清标记（供 UI 决定是否渲染卡片） */
export function hasClarificationMarker(text: string): boolean {
  if (typeof text !== "string") return false;
  return (
    text.includes(CLARIFICATION_MARKER) ||
    text.includes(CLARIFICATION_ALT_MARKER) ||
    text.includes("```" + CLARIFICATION_FENCE) ||
    text.includes("```" + "clarification")
  );
}

/**
 * 校验结构化澄清载荷是否符合格式规则：
 * - 1–3 题
 * - 每题 2–4 选项
 * - 每选项含 label + description
 * - 每题至少一推荐项（宽容：允许无推荐，但有则仅一项为佳）
 */
export function isValidClarificationPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  const questions = p.questions;
  if (!Array.isArray(questions)) return false;
  if (questions.length < 1 || questions.length > 3) return false;
  for (const q of questions) {
    if (!q || typeof q !== "object") return false;
    const qq = q as Record<string, unknown>;
    if (typeof qq.title !== "string" || qq.title.trim().length === 0) return false;
    const opts = qq.options;
    if (!Array.isArray(opts)) return false;
    if (opts.length < 2 || opts.length > 4) return false;
    for (const o of opts) {
      if (!o || typeof o !== "object") return false;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== "string" || (oo.label as string).trim().length === 0) return false;
      if (typeof oo.description !== "string" || (oo.description as string).trim().length === 0) return false;
    }
  }
  return true;
}

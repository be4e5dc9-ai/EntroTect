// =====================================================================
// 澄清卡片：渲染结构化选择题，支持点击选项回传
// 动效纪律：仅 transform/opacity；尊重 prefers-reduced-motion
// 无新增依赖，复用现有按钮与 tokens
// =====================================================================

import { bridge } from "../bridge";

export interface ClarificationOption {
  label: string;
  description: string;
  recommended?: boolean;
  value?: string;
}

export interface ClarificationQuestion {
  title: string;
  options: ClarificationOption[];
}

export interface ClarificationCardProps {
  /** 结构化数据：优先使用此 prop */
  questions?: ClarificationQuestion[];
  /** 兜底：从助理文本中解析；含特定标记时才渲染 */
  text?: string;
}

/** 尝试从文本中提取 clarification JSON 载荷 */
function tryParseFromText(text: string): ClarificationQuestion[] | null {
  if (!text) return null;
  // 1) ```clarification 围栏
  const fenceRe = /```clarification\s*\n?([\s\S]*?)```/i;
  const fenceMatch = text.match(fenceRe);
  if (fenceMatch && fenceMatch[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      const qs = (parsed?.questions ?? parsed?.clarification?.questions) as unknown;
      if (Array.isArray(qs)) return qs as ClarificationQuestion[];
      if (Array.isArray(parsed)) return parsed as ClarificationQuestion[];
    } catch {
      // fallthrough
    }
  }
  // 2) [[CLARIFICATION]] 后接 JSON 对象
  const altRe = /\[\[CLARIFICATION\]\]\s*(\{[\s\S]*\})/;
  const altMatch = text.match(altRe);
  if (altMatch && altMatch[1]) {
    try {
      const parsed = JSON.parse(altMatch[1].trim());
      const qs = (parsed?.questions ?? parsed) as unknown;
      if (Array.isArray(qs)) return qs as ClarificationQuestion[];
      if (Array.isArray(parsed?.questions)) return parsed.questions as ClarificationQuestion[];
    } catch {
      // fallthrough
    }
  }
  // 3) 裸 JSON：寻找包含 "questions" 的对象
  const jsonObjRe = /\{\s*"questions"\s*:\s*\[[\s\S]*?\]\s*\}/;
  const jsonMatch = text.match(jsonObjRe);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.questions)) return parsed.questions as ClarificationQuestion[];
    } catch {
      // fallthrough
    }
  }
  return null;
}

function isValidQuestions(qs: ClarificationQuestion[] | undefined): boolean {
  if (!Array.isArray(qs) || qs.length === 0 || qs.length > 3) return false;
  for (const q of qs) {
    if (!q || typeof q.title !== "string" || q.title.trim().length === 0) return false;
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return false;
    for (const o of q.options) {
      if (!o || typeof o.label !== "string" || o.label.trim().length === 0) return false;
      if (typeof o.description !== "string" || o.description.trim().length === 0) return false;
    }
  }
  return true;
}

export function ClarificationCard(props: ClarificationCardProps): React.JSX.Element | null {
  const { questions: propQs, text } = props;
  let questions: ClarificationQuestion[] | null = null;

  if (propQs && isValidQuestions(propQs)) {
    questions = propQs;
  } else if (text) {
    const parsed = tryParseFromText(text);
    if (parsed && isValidQuestions(parsed)) questions = parsed;
  }

  // 兜底：若文本含澄清标记但未解析出 JSON，则尝试按 markdown 列表启发式展示
  // 此时不渲染卡片，避免与 markdown 重复；由 markdown 本身展示
  if (!questions) return null;

  const onChoose = (q: ClarificationQuestion, opt: ClarificationOption): void => {
    const chosenText = opt.value ?? `${q.title}：${opt.label} ${opt.description}`;
    bridge().send({ kind: "SendMessage", text: chosenText });
  };

  return (
    <div className="clarification-card" role="group" aria-label="需澄清的选择题">
      <div className="clarification-head">
        <span className="clarification-badge" aria-hidden="true">
          需澄清
        </span>
        <span className="clarification-hint">请选择一项，支持直接回复编号或使用“你决定/随便”等放权短语跳过</span>
      </div>
      {questions.map((q, qi) => (
        <div key={qi} className="clarification-question">
          <div className="clarification-q-title">
            <span className="clarification-q-index">{qi + 1}.</span>
            <span>{q.title}</span>
          </div>
          <div className="clarification-options">
            {q.options.map((opt, oi) => (
              <button
                key={`${qi}-${oi}`}
                type="button"
                className={`clarification-option${opt.recommended ? " is-recommended" : ""}`}
                onClick={() => onChoose(q, opt)}
                aria-label={`${opt.label} ${opt.description}${opt.recommended ? "（推荐）" : ""}`}
              >
                <span className="clarification-opt-label">{opt.label}</span>
                <span className="clarification-opt-desc">{opt.description}</span>
                {opt.recommended && <span className="clarification-opt-rec">推荐</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 供 MessageList 使用的判定：文本是否应渲染卡片 */
export function shouldRenderClarificationCard(text: string): boolean {
  if (!text) return false;
  if (text.includes("【需澄清】") || text.includes("[[CLARIFICATION]]") || text.includes("```clarification")) {
    return tryParseFromText(text) !== null;
  }
  return false;
}

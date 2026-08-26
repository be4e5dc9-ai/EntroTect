// =====================================================================
// 输入区:Enter 发送 / Shift+Enter 换行;忙碌态显示停止按钮。
// 底栏:左侧权限模式,右侧模型 + 思考强度(low/high/xhigh/max)。
// 三个选择器均为 PopoverMenu(cmdk 式悬浮面板,见 PopoverMenu.tsx)。
// =====================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, ReasoningEffort } from "@entrotect/shared";
import {
  EFFORT_LABELS,
  clampEffort,
  getSupportedEffortsForModel,
  isReasoningEffort,
  isSkillInSlash,
} from "@entrotect/shared";
import { fetchSkills, useStore, contextWindowForModel } from "../store";
import { bridge } from "../bridge";
import { PopoverMenu, type MenuOption } from "./PopoverMenu";
import { ContextUsagePopover } from "./ContextUsagePopover";

const PERMISSION_OPTIONS: Array<MenuOption<NonNullable<AppConfig["permissionMode"]>>> = [
  { value: "full", label: "完全访问权限" },
  { value: "write", label: "修改需批准" },
  { value: "ask", label: "全部请求均需批准" },
];

/** 兼容旧配置的 effort 值：保留合法值，否则回退 high */
function normalizeEffort(value: AppConfig["reasoningEffort"]): ReasoningEffort {
  if (value && isReasoningEffort(value)) return value;
  return "high";
}

const boltIcon = (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
    <path
      d="M5.5 1 9 10l-3.5-1.5L2 10 5.5 1Z"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
  </svg>
);

export function Composer(): React.JSX.Element {
  const busy = useStore((s) => s.busy);
  const hasSession = useStore((s) => s.currentSession !== null);
  const config = useStore((s) => s.config);
  const usage = useStore((s) => s.usage);
  const modelsByProvider = useStore((s) => s.modelsByProvider);
  const contextWindowsByProvider = useStore((s) => s.contextWindowsByProvider);
  const skills = useStore((s) => s.skills);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [slashCursor, setSlashCursor] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [clampedHint, setClampedHint] = useState<string | null>(null);

  // 自动拉取 skills(首次挂载)
  useEffect(() => {
    if (skills.length === 0) void fetchSkills();
  }, [skills.length]);

  // 文本不再以 "/" 开头时重置 dismiss
  useEffect(() => {
    if (!text.startsWith("/")) setSlashDismissed(false);
  }, [text]);

  // 点击外部关闭 slash 面板(与 PopoverMenu 一致)
  useEffect(() => {
    if (!text.startsWith("/")) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!composerRef.current?.contains(e.target as Node)) setSlashDismissed(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [text]);

  const slashQuery = text.startsWith("/") ? text.slice(1).split(/\s/)[0]?.toLowerCase() ?? "" : "";
  const hasSlashSpace = text.startsWith("/") && text.slice(1).includes(" ");
  // 按设置页开关过滤:启用且斜杠可见才进补全面板
  const slashSkills = useMemo(
    () => skills.filter((s) => isSkillInSlash(config, s.path)),
    [skills, config],
  );
  const filteredSkills = useMemo(() => {
    if (!text.startsWith("/") || hasSlashSpace) return [];
    if (!slashQuery) return slashSkills;
    return slashSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(slashQuery) ||
        s.description.toLowerCase().includes(slashQuery),
    );
  }, [text, hasSlashSpace, slashQuery, slashSkills]);

  const showSlash =
    text.startsWith("/") && !hasSlashSpace && !slashDismissed && !busy && hasSession && filteredSkills.length > 0;

  useEffect(() => {
    setSlashCursor(0);
  }, [slashQuery, filteredSkills.length]);

  const selectSlash = (name: string) => {
    const next = `/${name} `;
    setText(next);
    setSlashDismissed(true);
    // 聚焦并移动光标到末尾
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.focus();
        ref.current.setSelectionRange(next.length, next.length);
        ref.current.style.height = "auto";
        ref.current.style.height = `${Math.min(ref.current.scrollHeight, 200)}px`;
      }
    });
  };

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    bridge().send({ kind: "SendMessage", text: value });
    setText("");
    setSlashDismissed(false);
    if (ref.current) ref.current.style.height = "auto";
  };

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const updateConfig = (patch: Partial<AppConfig>) => {
    if (!config) return;
    bridge().send({ kind: "SetConfig", config: { ...config, ...patch } });
  };

  // 当前供应商:菜单标题显示其名称,选项取其缓存模型;
  // config.model 必须可选项(不在缓存时置顶,保证旧配置/新模型可用)。
  const configuredProviderId = config?.activeProviderId ?? "deepseek";
  const provider =
    config?.providers?.find((p) => p.id === configuredProviderId) ?? config?.providers?.[0];
  const activeProviderId = provider?.id ?? configuredProviderId;
  const providerName = provider?.name ?? "模型";
  const contextWindow = config?.model
    ? contextWindowForModel(config, contextWindowsByProvider, activeProviderId, config.model)
    : undefined;
  const models = modelsByProvider[activeProviderId] ?? [];
  const modelValues =
    config?.model && !models.includes(config.model) ? [config.model, ...models] : models;
  const modelOptions: Array<MenuOption<string>> = modelValues.map((id, index) => ({
    value: id,
    label: id,
    meta: String(index + 1),
  }));

  // 按模型真实思考档位过滤（声明集 > preset > 通用回退）
  const supportedEfforts = useMemo(
    () => getSupportedEffortsForModel(config ?? null, activeProviderId, config?.model),
    [config, activeProviderId],
  );
  const isBooleanThinking = supportedEfforts.length === 0;
  const effortOptions: Array<MenuOption<ReasoningEffort>> = useMemo(
    () =>
      supportedEfforts.map((eff) => ({
        value: eff,
        label: EFFORT_LABELS[eff] ?? eff,
      })),
    [supportedEfforts],
  );
  const currentEffort = normalizeEffort(config?.reasoningEffort);
  const clampedEffort = useMemo(() => {
    if (isBooleanThinking) return currentEffort;
    if (supportedEfforts.includes(currentEffort)) return currentEffort;
    return clampEffort(currentEffort, supportedEfforts);
  }, [currentEffort, supportedEfforts, isBooleanThinking]);

  // 当前值不在子集则自动钳制并写回（避免发送非法值），并在 UI 提示被 clamp
  useEffect(() => {
    if (!config || isBooleanThinking) return;
    if (!config.reasoningEffort) return;
    if (supportedEfforts.includes(config.reasoningEffort as ReasoningEffort)) return;
    const next = clampEffort(config.reasoningEffort as ReasoningEffort, supportedEfforts);
    if (next !== config.reasoningEffort) {
      setClampedHint(`已钳制 ${config.reasoningEffort} → ${next}`);
      const timer = setTimeout(() => setClampedHint(null), 2800);
      bridge().send({ kind: "SetConfig", config: { ...config, reasoningEffort: next } });
      return () => clearTimeout(timer);
    }
  }, [config, supportedEfforts, isBooleanThinking]);

  useEffect(() => {
    if (!clampedHint) return;
    const t = setTimeout(() => setClampedHint(null), 2800);
    return () => clearTimeout(t);
  }, [clampedHint]);

  return (
    <div className="composer" ref={composerRef}>
      <div className="composer-box" style={{ position: "relative" }}>
        {showSlash && (
          <div className="slash-panel" role="listbox" aria-label="技能指令">
            <div className="menu-heading">Skills · 以 / 触发</div>
            {filteredSkills.map((skill, index) => (
              <button
                key={skill.path}
                type="button"
                role="option"
                aria-selected={index === slashCursor}
                className={`slash-item${index === slashCursor ? " cursor" : ""}`}
                onMouseEnter={() => setSlashCursor(index)}
                onMouseDown={(e) => {
                  // 防止 textarea 失焦
                  e.preventDefault();
                }}
                onClick={() => selectSlash(skill.name)}
              >
                <span className="slash-item-name">/{skill.name}</span>
                <span className="slash-item-desc" title={skill.description}>
                  {skill.description || skill.source}
                </span>
                <span className="slash-item-source" title={skill.path}>
                  {skill.source}
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          className="composer-input"
          placeholder={hasSession ? "输入任务,Enter 发送 · / 触发 Skills" : "先新建一个会话…"}
          value={text}
          disabled={!hasSession}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            setSlashDismissed(false);
            autosize();
          }}
          onKeyDown={(e) => {
            if (showSlash) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashCursor((i) => (i + 1) % filteredSkills.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashCursor((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashDismissed(true);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const current = filteredSkills[slashCursor];
                if (current) selectSlash(current.name);
                return;
              }
              if (e.key === "Tab" && !e.nativeEvent.isComposing) {
                const current = filteredSkills[slashCursor];
                if (current) {
                  e.preventDefault();
                  selectSlash(current.name);
                  return;
                }
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button
            className="btn btn-danger composer-stop"
            onClick={() => bridge().send({ kind: "Interrupt" })}
            aria-label="停止"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" rx="1.5" />
            </svg>
            停止
          </button>
        ) : (
          <button
            className="btn btn-primary composer-send"
            onClick={send}
            disabled={!text.trim()}
            aria-label="发送"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M7 13V2M2.5 6.5 7 2l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>

      <div className="composer-bar">
        <div className="composer-bar-left">
          <PopoverMenu
            value={config?.permissionMode ?? "write"}
            options={PERMISSION_OPTIONS}
            onSelect={(value) => updateConfig({ permissionMode: value })}
            heading="权限"
            icon={boltIcon}
            ariaLabel="权限模式"
            align="left"
          />
        </div>

        <div className="composer-bar-right">
          <PopoverMenu
            value={config?.model ?? ""}
            options={modelOptions}
            onSelect={(value) => updateConfig({ model: value })}
            heading={providerName}
            ariaLabel="模型"
            align="right"
          />
          {!isBooleanThinking && effortOptions.length > 0 && (
            <PopoverMenu
              value={clampedEffort}
              options={effortOptions}
              onSelect={(value) => {
                setClampedHint(null);
                updateConfig({ reasoningEffort: value });
              }}
              heading="思考强度"
              icon={boltIcon}
              ariaLabel="思考强度"
              align="right"
            />
          )}
          {isBooleanThinking && (
            <span className="composer-hint" title="该模型为布尔 thinking，无分档">
              思考常开
            </span>
          )}
          <ContextUsagePopover
            inputTokens={usage?.inputTokens}
            contextWindow={contextWindow}
          />
        </div>
      </div>
      {clampedHint && <div className="composer-clamp-hint">{clampedHint}</div>}
    </div>
  );
}

// =====================================================================
// 输入区:Enter 发送 / Shift+Enter 换行;忙碌态显示停止按钮。
// 底栏:左侧权限模式,右侧模型 + 思考强度。
// 思考强度默认为离散滑块，可在设置切回经典 PopoverMenu。
// =====================================================================

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AppConfig, MessageAttachment, ReasoningEffort } from "@entrotect/shared";
import {
  DEFAULT_REASONING_EFFORT,
  EFFORT_LABELS,
  clampEffort,
  defaultForModel,
  getSupportedEffortsForModel,
  isReasoningEffort,
  isSkillInSlash,
  SLASH_COMMANDS,
  parseSlashCommand,
} from "@entrotect/shared";
import { fetchSkills, useStore, contextWindowForModel } from "../store";
import { bridge } from "../bridge";
import { PopoverMenu, type MenuOption } from "./PopoverMenu";
import { ContextUsagePopover } from "./ContextUsagePopover";
import { ReasoningSlider } from "./ReasoningSlider";

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
  const session = useStore((s) => s.currentSession);
  const hasSession = session !== null;
  const controls = session?.controls;
  const commandNotice = useStore((s) => s.commandNotice);
  const config = useStore((s) => s.config);
  const usage = useStore((s) => s.usage);
  const contextEstimate = useStore((s) => s.contextEstimate);
  const modelsByProvider = useStore((s) => s.modelsByProvider);
  const contextWindowsByProvider = useStore((s) => s.contextWindowsByProvider);
  const skills = useStore((s) => s.skills);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [slashCursor, setSlashCursor] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashId = useId();
  const [clampedHint, setClampedHint] = useState<string | null>(null);
  /** 拖入的附件(图片 Base64 / 文件路径) */
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

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
  const hasSlashSpace = text.startsWith("/") && /\s/.test(text.slice(1));
  // 按设置页开关过滤:启用且斜杠可见才进补全面板
  const slashSkills = useMemo(
    () => skills.filter((s) => isSkillInSlash(config, s.path)),
    [skills, config],
  );
  const slashItems = useMemo(() => {
    if (!text.startsWith("/") || hasSlashSpace) return [];
    const builtins = SLASH_COMMANDS.map((command) => ({ ...command, key: command.name, source: "内置", detail: command.usage }));
    const items = [...builtins, ...slashSkills
      .filter((skill) => !SLASH_COMMANDS.some((command) => command.name === skill.name.toLowerCase()))
      .map((skill) => ({ ...skill, key: skill.path, detail: skill.path }))];
    return items.filter((item) => item.name.toLowerCase().includes(slashQuery) || item.description.toLowerCase().includes(slashQuery));
  }, [text, hasSlashSpace, slashQuery, slashSkills]);

  const showSlash =
    text.startsWith("/") &&
    !hasSlashSpace &&
    !slashDismissed &&
    !busy &&
    hasSession;
  const commandHint = hasSlashSpace ? SLASH_COMMANDS.find((command) => command.name === slashQuery)?.usage : undefined;

  useEffect(() => {
    setSlashCursor(0);
  }, [slashQuery, slashItems.length]);

  useEffect(() => {
    if (showSlash) document.getElementById(`${slashId}-${slashCursor}`)?.scrollIntoView?.({ block: "nearest" });
  }, [showSlash, slashId, slashCursor]);

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
    if ((!value && attachments.length === 0) || busy || !hasSession) return;
    const command = parseSlashCommand(value);
    if (command?.kind === "invalid") {
      useStore.setState({ commandNotice: command.message });
      return;
    }
    if (command && attachments.length && !((command.kind === "plan" && command.prompt) || (command.kind === "goal" && command.action === "set"))) {
      useStore.setState({ commandNotice: "此命令不发送附件。请填写任务内容或先移除附件。" });
      return;
    }
    useStore.setState({ commandNotice: null });
    bridge().send({ kind: "SendMessage", text: value, attachments });
    setText("");
    setAttachments([]);
    setSlashDismissed(false);
    if (ref.current) ref.current.style.height = "auto";
  };

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  /** 拖入文件 → MessageAttachment(图片转 Base64;其他取绝对路径) */
  const addFilesFromDrag = (files: File[]) => {
    for (const file of files) {
      const name = file.name;
      if (/^image\//.test(file.type) && file.size <= 8 * 1024 * 1024) {
        const reader = new FileReader();
        reader.onload = () => {
          const data = String(reader.result ?? "");
          const base64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
          setAttachments((prev) => [
            ...prev,
            { kind: "image", mime: file.type, dataBase64: base64, name },
          ]);
        };
        reader.readAsDataURL(file);
      } else {
        let filePath = "";
        try {
          filePath = bridge().pathOfDragFile(file);
        } catch {
          filePath = "";
        }
        if (!filePath) continue;
        setAttachments((prev) => [...prev, { kind: "file", path: filePath, name }]);
      }
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
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
  const defaultEffort = useMemo(
    () => defaultForModel(config ?? null, activeProviderId, config?.model),
    [config, activeProviderId],
  );
  const reasoningControlStyle = config?.reasoningControlStyle ?? "slider";

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
    <div
      className={`composer${dragging ? " is-dragging" : ""}`}
      ref={composerRef}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) addFilesFromDrag(files);
      }}
    >
      {(controls?.mode === "plan" || controls?.goal) && (
        <div className="composer-session-controls" aria-label="会话模式与目标">
          {controls.mode === "plan" && (
            <div className="composer-control-row">
              <span className="composer-control-label">Plan</span>
              <span className="composer-control-text">仅规划 · 不修改项目</span>
              <div className="composer-control-actions"><button type="button" disabled={busy} onClick={() => bridge().send({ kind: "SendMessage", text: "/plan off" })}>退出规划</button></div>
            </div>
          )}
          {controls.goal && (
            <div className={`composer-control-row goal-${controls.goal.status}`}>
              <span className="composer-control-label">Goal</span>
              <span className="composer-control-text" title={controls.goal.objective}>
                <span className="composer-goal-state">{{ active: "进行中", completed: "已完成", blocked: "受阻" }[controls.goal.status]}</span>
                {controls.goal.objective}
                {controls.goal.summary && <small>{controls.goal.summary}</small>}
              </span>
              <div className="composer-control-actions">{controls.goal.status === "active"
                ? <button type="button" disabled={busy} onClick={() => bridge().send({ kind: "SendMessage", text: "/goal done" })}>标记完成</button>
                : <button type="button" disabled={busy} onClick={() => bridge().send({ kind: "SendMessage", text: "/goal resume" })}>继续目标</button>}
              <button type="button" disabled={busy} aria-label="清除目标" onClick={() => bridge().send({ kind: "SendMessage", text: "/goal clear" })}>×</button>
              </div>
            </div>
          )}
        </div>
      )}
      {commandNotice && (
        <div className="composer-command-notice" role="status">
          <span>{commandNotice}</span>
          <button type="button" aria-label="关闭命令提示" onClick={() => useStore.setState({ commandNotice: null })}>×</button>
        </div>
      )}
      {dragging && <div className="composer-drop-mask">拖到这里添加附件</div>}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((attachment, index) =>
            attachment.kind === "image" ? (
              <div className="attachment-chip attachment-image" key={index}>
                <img
                  src={`data:${attachment.mime};base64,${attachment.dataBase64}`}
                  alt={attachment.name}
                />
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label="移除附件"
                  onClick={() => removeAttachment(index)}
                >
                  ×
                </button>
              </div>
            ) : (
              <div className="attachment-chip attachment-file" key={index}>
                <span className="attachment-name" title={attachment.path}>
                  {attachment.name}
                </span>
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label="移除附件"
                  onClick={() => removeAttachment(index)}
                >
                  ×
                </button>
              </div>
            ),
          )}
        </div>
      )}
      <div className="composer-box" style={{ position: "relative" }}>
        {showSlash && (
          <div className="slash-panel" id={slashId} role="listbox" aria-label="斜杠命令">
            <div className="menu-heading">命令与 Skills <span className="slash-key-hint">↑↓ 选择 · Tab 补全 · Esc 关闭</span></div>
            {slashItems.length === 0 && <div className="slash-empty">没有匹配项；仍可直接发送文本。</div>}
            {slashItems.map((skill, index) => (
              <button
                key={skill.key}
                id={`${slashId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === slashCursor}
                tabIndex={-1}
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
                <span className="slash-item-source" title={skill.detail}>
                  {skill.source}
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          className="composer-input"
          placeholder={hasSession ? (controls?.mode === "plan" ? "描述要规划的任务 · /plan off 退出" : "输入任务,Enter 发送 · / 查看命令与 Skills") : "先新建一个会话…"}
          aria-label="任务输入"
          aria-controls={showSlash ? slashId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showSlash && slashItems[slashCursor] ? `${slashId}-${slashCursor}` : undefined}
          value={text}
          disabled={!hasSession}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            setSlashDismissed(false);
            autosize();
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (showSlash) {
              if (e.key === "ArrowDown" && slashItems.length) {
                e.preventDefault();
                setSlashCursor((i) => (i + 1) % slashItems.length);
                return;
              }
              if (e.key === "ArrowUp" && slashItems.length) {
                e.preventDefault();
                setSlashCursor((i) => (i - 1 + slashItems.length) % slashItems.length);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashDismissed(true);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && slashItems.length) {
                e.preventDefault();
                const current = slashItems[slashCursor];
                if (current) selectSlash(current.name);
                return;
              }
              if (e.key === "Tab" && !e.shiftKey) {
                const current = slashItems[slashCursor];
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
            disabled={!text.trim() && attachments.length === 0}
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
      {commandHint && <div className="composer-command-hint">{commandHint}</div>}

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
          {!isBooleanThinking && effortOptions.length > 0 && reasoningControlStyle === "menu" && (
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
          {!isBooleanThinking && supportedEfforts.length > 0 && reasoningControlStyle === "slider" && (
            <ReasoningSlider
              value={clampedEffort}
              efforts={supportedEfforts}
              defaultValue={defaultEffort}
              model={config?.model ?? ""}
              onSelect={(value) => {
                setClampedHint(null);
                updateConfig({ reasoningEffort: value });
              }}
            />
          )}
          {isBooleanThinking && (
            <button
              type="button"
              className="composer-toggle"
              aria-label="思考开关"
              title="该模型只有 开/关 两档思考；工具调用频繁时关闭更稳定"
              onClick={() =>
                updateConfig({
                  reasoningEffort: currentEffort === "off" ? DEFAULT_REASONING_EFFORT : "off",
                })
              }
            >
              思考·{currentEffort === "off" ? "关" : "开"}
            </button>
          )}
          <ContextUsagePopover
            inputTokens={contextEstimate ?? usage?.inputTokens}
            estimated={contextEstimate != null}
            contextWindow={contextWindow}
          />
        </div>
      </div>
      {clampedHint && <div className="composer-clamp-hint">{clampedHint}</div>}
    </div>
  );
}

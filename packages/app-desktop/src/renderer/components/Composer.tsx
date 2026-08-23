// =====================================================================
// 输入区:Enter 发送 / Shift+Enter 换行;忙碌态显示停止按钮。
// 底栏:左侧权限模式,右侧模型 + 思考强度(low/high/xhigh/max)。
// =====================================================================

import { useRef, useState } from "react";
import type { AppConfig } from "@entrotect/shared";
import { useStore } from "../store";
import { bridge } from "../bridge";

const PERMISSION_OPTIONS: Array<{ value: AppConfig["permissionMode"]; label: string }> = [
  { value: "full", label: "完全访问权限" },
  { value: "write", label: "修改需批准" },
  { value: "ask", label: "全部请求均要人批准" },
];

const EFFORT_OPTIONS = ["low", "high", "xhigh", "max"] as const;

/** 兼容旧配置的 effort 值:off/medium 归一为 high */
function normalizeEffort(value: AppConfig["reasoningEffort"]): (typeof EFFORT_OPTIONS)[number] {
  return value && (EFFORT_OPTIONS as readonly string[]).includes(value as string)
    ? (value as (typeof EFFORT_OPTIONS)[number])
    : "high";
}

export function Composer(): React.JSX.Element {
  const busy = useStore((s) => s.busy);
  const hasSession = useStore((s) => s.currentSession !== null);
  const config = useStore((s) => s.config);
  const models = useStore((s) => s.models);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    bridge().send({ kind: "SendMessage", text: value });
    setText("");
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

  const modelOptions = config?.model && !models.includes(config.model)
    ? [config.model, ...models]
    : models;

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          className="composer-input"
          placeholder={hasSession ? "输入任务,Enter 发送" : "先新建一个会话…"}
          value={text}
          disabled={!hasSession}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
          }}
          onKeyDown={(e) => {
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
          <label className="bar-select" title="授予 AI 的权限">
            <span className="bar-select-icon" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path
                  d="M5.5 1 9 10l-3.5-1.5L2 10 5.5 1Z"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <select
              value={config?.permissionMode ?? "write"}
              onChange={(e) =>
                updateConfig({
                  permissionMode: e.target.value as AppConfig["permissionMode"],
                })
              }
              aria-label="权限模式"
            >
              {PERMISSION_OPTIONS.map((option) => (
                <option key={String(option.value)} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="composer-bar-right">
          <label className="bar-select" title="模型">
            <select
              value={config?.model ?? ""}
              onChange={(e) => updateConfig({ model: e.target.value })}
              aria-label="模型"
            >
              {modelOptions.length === 0 && <option value="">—</option>}
              {modelOptions.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>

          <label className="bar-select" title="思考强度">
            <span className="bar-select-icon" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path
                  d="M5.5 1 9 10l-3.5-1.5L2 10 5.5 1Z"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <select
              value={normalizeEffort(config?.reasoningEffort)}
              onChange={(e) =>
                updateConfig({ reasoningEffort: e.target.value as AppConfig["reasoningEffort"] })
              }
              aria-label="思考强度"
            >
              {EFFORT_OPTIONS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

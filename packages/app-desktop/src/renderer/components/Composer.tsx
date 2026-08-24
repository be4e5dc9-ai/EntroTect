// =====================================================================
// 输入区:Enter 发送 / Shift+Enter 换行;忙碌态显示停止按钮。
// 底栏:左侧权限模式,右侧模型 + 思考强度(low/high/xhigh/max)。
// 三个选择器均为 PopoverMenu(cmdk 式悬浮面板,见 PopoverMenu.tsx)。
// =====================================================================

import { useRef, useState } from "react";
import type { AppConfig } from "@entrotect/shared";
import { useStore, contextWindowForModel } from "../store";
import { bridge } from "../bridge";
import { PopoverMenu, type MenuOption } from "./PopoverMenu";
import { ContextUsagePopover } from "./ContextUsagePopover";

const PERMISSION_OPTIONS: Array<MenuOption<NonNullable<AppConfig["permissionMode"]>>> = [
  { value: "full", label: "完全访问权限" },
  { value: "write", label: "修改需批准" },
  { value: "ask", label: "全部请求均要人批准" },
];

const EFFORT_OPTIONS: Array<MenuOption<NonNullable<AppConfig["reasoningEffort"]>>> = [
  { value: "low", label: "low" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

/** 兼容旧配置的 effort 值:off/medium 归一为 high */
function normalizeEffort(
  value: AppConfig["reasoningEffort"],
): NonNullable<AppConfig["reasoningEffort"]> {
  return value
    ? (value as NonNullable<AppConfig["reasoningEffort"]>)
    : "high";
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
          <PopoverMenu
            value={normalizeEffort(config?.reasoningEffort)}
            options={EFFORT_OPTIONS}
            onSelect={(value) => updateConfig({ reasoningEffort: value })}
            heading="思考强度"
            icon={boltIcon}
            ariaLabel="思考强度"
            align="right"
          />
          <ContextUsagePopover
            inputTokens={usage?.inputTokens}
            contextWindow={contextWindow}
          />
        </div>
      </div>
    </div>
  );
}

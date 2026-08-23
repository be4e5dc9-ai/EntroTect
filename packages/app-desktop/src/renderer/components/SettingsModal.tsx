// =====================================================================
// 设置弹窗:模型配置(baseUrl/apiKey/model/工作目录/maxTokens)
// "显示模型思考过程"为即时生效开关(点击即保存,无需点保存按钮)。
// =====================================================================

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { bridge } from "../bridge";
import type { AppConfig } from "@entrotect/shared";

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen);
  const config = useStore((s) => s.config);
  const [form, setForm] = useState<AppConfig | null>(null);
  const wasOpen = useRef(false);

  // 仅"打开瞬间"用最新 config 初始化表单;打开期间用户编辑不被 config 事件覆盖
  useEffect(() => {
    if (open && !wasOpen.current) {
      const current = useStore.getState().config;
      if (current) setForm({ ...current });
    }
    wasOpen.current = open;
  }, [open]);

  // 兜底:打开时 config 尚未到达,到达后补一次初始化
  useEffect(() => {
    if (open && !form && config) setForm({ ...config });
  }, [open, form, config]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useStore.setState({ settingsOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !form) return null;

  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  const chooseFolder = async () => {
    const dir = await bridge().chooseFolder();
    if (dir) set("workspaceDir", dir);
  };

  const save = () => {
    if (form) bridge().send({ kind: "SetConfig", config: form });
    useStore.setState({ settingsOpen: false });
  };

  // 即时生效开关:点击即保存并广播,不会因未点保存/Esc 而丢失
  const toggleShowReasoning = () => {
    const next = !(form.showReasoning ?? false);
    setForm((f) => (f ? { ...f, showReasoning: next } : f));
    const current = useStore.getState().config;
    if (current) {
      bridge().send({ kind: "SetConfig", config: { ...current, showReasoning: next } });
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <h3 className="settings-title">设置</h3>

        <label className="field">
          <span>API Base URL</span>
          <input
            value={form.baseUrl}
            onChange={(e) => set("baseUrl", e.target.value)}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => set("apiKey", e.target.value)}
            placeholder="sk-…"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>模型</span>
          <input
            value={form.model}
            onChange={(e) => set("model", e.target.value)}
            placeholder="deepseek-chat"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>工作目录(默认工作目录,新建任务时可另行选择)</span>
          <div className="field-row">
            <input
              value={form.workspaceDir ?? ""}
              onChange={(e) => set("workspaceDir", e.target.value)}
              placeholder="留空 = 用户主目录"
              spellCheck={false}
            />
            <button className="btn btn-ghost" onClick={chooseFolder} type="button">
              选择
            </button>
          </div>
        </label>
        <label className="field">
          <span>最大输出 tokens(留空用默认 8192)</span>
          <input
            type="number"
            min={256}
            value={form.maxTokens ?? ""}
            onChange={(e) =>
              set("maxTokens", e.target.value === "" ? undefined : Number(e.target.value))
            }
          />
        </label>

        <div className="field field-inline">
          <div className="field-inline-text">
            <span className="field-inline-title">显示模型思考过程</span>
            <span className="field-inline-desc">即时生效并保存;开启后消息中的"思考过程"区块展示模型的推理内容</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={form.showReasoning ?? false}
            className={`switch${form.showReasoning ? " on" : ""}`}
            onClick={toggleShowReasoning}
          >
            <span className="switch-knob" />
          </button>
        </div>

        <div className="settings-actions">
          <button className="btn btn-ghost" onClick={() => useStore.setState({ settingsOpen: false })}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

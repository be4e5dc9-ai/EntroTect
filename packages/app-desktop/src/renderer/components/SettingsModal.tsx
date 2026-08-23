// =====================================================================
// 设置弹窗:模型配置(baseUrl/apiKey/model/工作目录/maxTokens)
// =====================================================================

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { bridge } from "../bridge";
import type { AppConfig } from "@entrotect/shared";

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen);
  const config = useStore((s) => s.config);
  const [form, setForm] = useState<AppConfig | null>(null);

  useEffect(() => {
    if (open && config) setForm({ ...config });
  }, [open, config]);

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
          <span>工作目录(工具执行的基准目录)</span>
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

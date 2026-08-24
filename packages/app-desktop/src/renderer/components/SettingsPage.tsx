// =====================================================================
// 设置页:替代旧设置弹窗,作为主区独立页面(view === "settings")
// 分区:供应商(多供应商管理)+ 外观 + 通用(工作目录 / tokens / 开关)。
// 文本字段走局部 form + 保存按钮(进入瞬间快照,防 config 事件覆盖);
// showReasoning / sandboxMode 为即时生效开关(点击即保存)。
// 双栏导航:nav-primary 160px + nav-secondary 220px + detail,active 持久化
// =====================================================================

import { useEffect, useRef, useState } from "react";
import type { AppConfig, ProviderConfig } from "@entrotect/shared";
import { ACCENT_PRESETS } from "../../appearance";
import { applyAccentColor, applyTheme } from "../appearance";
import { mergeCachedProviderDataIntoConfig, useStore, type Theme } from "../store";
import { bridge } from "../bridge";

type FetchState = "fetching" | "ok" | "failed";
type Primary = "providers" | "appearance" | "general";

/** 快照配置:深拷贝供应商数组,避免表单编辑污染 store */
function snapshotConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    providers: config.providers?.map((p) => ({
      ...p,
      models: [...p.models],
      ...(p.contextWindows === undefined ? {} : { contextWindows: { ...p.contextWindows } }),
    })),
  };
}

export function SettingsPage(): React.JSX.Element | null {
  const config = useStore((s) => s.config);
  const modelsByProvider = useStore((s) => s.modelsByProvider);
  const contextWindowsByProvider = useStore((s) => s.contextWindowsByProvider);
  const theme = useStore((s) => s.theme);
  const accentColor = useStore((s) => s.accentColor);
  // 进入设置页瞬间用最新 config 初始化;编辑期间 config 事件不覆盖表单
  const [form, setForm] = useState<AppConfig | null>(() => {
    const state = useStore.getState();
    return state.config
      ? snapshotConfig(
          mergeCachedProviderDataIntoConfig(
            state.config,
            state.modelsByProvider,
            state.contextWindowsByProvider,
          ),
        )
      : null;
  });
  const [fetchState, setFetchState] = useState<Record<string, FetchState>>({});
  const previousCache = useRef({ modelsByProvider, contextWindowsByProvider });

  // 双栏导航状态:primary + secondary active provider
  const [primary, setPrimary] = useState<Primary>(() => {
    try {
      const saved = localStorage.getItem("entrotect-settings-primary");
      return saved === "providers" || saved === "appearance" || saved === "general"
        ? saved
        : "providers";
    } catch {
      return "providers";
    }
  });
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("entrotect-settings-provider");
    } catch {
      return null;
    }
  });

  // 兜底:进入时 config 尚未到达,到达后补一次初始化
  useEffect(() => {
    if (!form && config) {
      setForm(
        snapshotConfig(
          mergeCachedProviderDataIntoConfig(
            config,
            modelsByProvider,
            contextWindowsByProvider,
          ),
        ),
      );
    }
  }, [form, config, modelsByProvider, contextWindowsByProvider]);

  // App 的常驻事件订阅先写入 store;设置页挂载后再把发生变化的未落盘缓存补入当前表单。
  useEffect(() => {
    const previous = previousCache.current;
    const providerIds = new Set([
      ...Object.keys(previous.modelsByProvider),
      ...Object.keys(modelsByProvider),
      ...Object.keys(previous.contextWindowsByProvider),
      ...Object.keys(contextWindowsByProvider),
    ]);
    const changedProviderIds = new Set(
      [...providerIds].filter(
        (providerId) =>
          previous.modelsByProvider[providerId] !== modelsByProvider[providerId] ||
          previous.contextWindowsByProvider[providerId] !==
            contextWindowsByProvider[providerId],
      ),
    );
    previousCache.current = { modelsByProvider, contextWindowsByProvider };
    if (!form || changedProviderIds.size === 0) return;
    setForm((current) =>
      current
        ? mergeCachedProviderDataIntoConfig(
            current,
            modelsByProvider,
            contextWindowsByProvider,
            changedProviderIds,
          )
        : current,
    );
  }, [modelsByProvider, contextWindowsByProvider]);

  // 拉取状态仍由页面监听;模型与元数据统一从常驻 store 缓存回填。
  useEffect(() => {
    const unsubscribe = bridge().onEvent((event) => {
      if (event.type !== "models-listed") return;
      setFetchState((state) =>
        state[event.providerId] !== "fetching"
          ? state
          : { ...state, [event.providerId]: event.models.length > 0 ? "ok" : "failed" },
      );
    });
    return unsubscribe;
  }, []);

  // 持久化 primary / provider
  useEffect(() => {
    try {
      localStorage.setItem("entrotect-settings-primary", primary);
    } catch {}
  }, [primary]);

  useEffect(() => {
    if (!selectedProviderId) return;
    try {
      localStorage.setItem("entrotect-settings-provider", selectedProviderId);
    } catch {}
  }, [selectedProviderId]);

  if (!form) return null;

  const providers = form.providers ?? [];
  // 有效的选中供应商:优先 selected,其次 activeProvider,最后首个
  const effectiveProviderId =
    selectedProviderId && providers.some((p) => p.id === selectedProviderId)
      ? selectedProviderId
      : (providers.find((p) => p.id === form.activeProviderId)?.id ?? providers[0]?.id ?? null);
  const selectedProvider = providers.find((p) => p.id === effectiveProviderId) ?? null;

  // 当 primary 为 providers 且无有效选中时,自动选中 fallback 并持久化
  useEffect(() => {
    if (primary !== "providers") return;
    if (!effectiveProviderId) return;
    if (effectiveProviderId !== selectedProviderId) {
      setSelectedProviderId(effectiveProviderId);
    }
  }, [primary, effectiveProviderId, selectedProviderId]);

  const save = () => {
    bridge().send({ kind: "SetConfig", config: form });
  };

  const selectTheme = (next: Theme) => {
    const accent = useStore.getState().accentColor;
    applyTheme(next, accent);
    bridge().setTheme(next);
    useStore.setState({ theme: next });
  };

  const selectAccent = (next: string) => {
    const normalized = applyAccentColor(next, theme);
    bridge().setAccentColor(normalized);
    useStore.setState({ accentColor: normalized });
  };

  const chooseFolder = async () => {
    const dir = await bridge().chooseFolder();
    if (dir) setForm((f) => (f ? { ...f, workspaceDir: dir } : f));
  };

  // 即时生效开关:点击即保存并广播,不会因未点保存而丢失
  const toggleShowReasoning = () => {
    const next = !(form.showReasoning ?? false);
    setForm((f) => (f ? { ...f, showReasoning: next } : f));
    const current = useStore.getState().config;
    if (current) {
      bridge().send({ kind: "SetConfig", config: { ...current, showReasoning: next } });
    }
  };

  const toggleSandbox = () => {
    const next = (form.sandboxMode ?? "full") === "restricted" ? "full" : "restricted";
    setForm((f) => (f ? { ...f, sandboxMode: next } : f));
    const current = useStore.getState().config;
    if (current) {
      bridge().send({ kind: "SetConfig", config: { ...current, sandboxMode: next } });
    }
  };

  const updateProvider = (id: string, patch: Partial<ProviderConfig>) => {
    setForm((f) =>
      f
        ? {
            ...f,
            providers: f.providers?.map((p) => (p.id === id ? { ...p, ...patch } : p)),
          }
        : f,
    );
  };

  const requestModels = (providerId: string) => {
    setFetchState((s) => ({ ...s, [providerId]: "fetching" }));
    bridge().send({ kind: "ListModels", providerId });
  };

  // 设为当前:激活该供应商,模型同步为列表第一个(空列表保持原 model)
  const activate = (provider: ProviderConfig) => {
    bridge().send({
      kind: "SetConfig",
      config: {
        ...form,
        activeProviderId: provider.id,
        model: provider.models[0] ?? form.model,
      },
    });
  };

  const addProvider = () => {
    const providersList = form.providers ?? [];
    const customCount = providersList.filter((p) => !p.builtin).length;
    const provider: ProviderConfig = {
      id: `custom-${crypto.randomUUID().slice(0, 8)}`,
      name: `自定义供应商 ${customCount + 1}`,
      baseUrl: "",
      apiKey: "",
      models: [],
    };
    const next = { ...form, providers: [...providersList, provider] };
    setForm(next);
    bridge().send({ kind: "SetConfig", config: next });
    setSelectedProviderId(provider.id);
    setPrimary("providers");
  };

  const removeProvider = (id: string) => {
    const providersList = (form.providers ?? []).filter((p) => p.id !== id);
    const activeId = providersList.some((p) => p.id === form.activeProviderId)
      ? form.activeProviderId
      : (providersList[0]?.id ?? "deepseek");
    const active = providersList.find((p) => p.id === activeId);
    const next: AppConfig = {
      ...form,
      providers: providersList,
      activeProviderId: activeId,
      model: active?.models[0] ?? form.model,
    };
    setForm(next);
    bridge().send({ kind: "SetConfig", config: next });
    // 选中态顺延
    if (selectedProviderId === id) {
      const fallback = providersList.find((p) => p.id === activeId)?.id ?? providersList[0]?.id ?? null;
      setSelectedProviderId(fallback);
    }
  };

  const addModel = (providerId: string, model: string) => {
    const trimmed = model.trim();
    if (!trimmed) return;
    setForm((f) =>
      f
        ? {
            ...f,
            providers: f.providers?.map((p) =>
              p.id === providerId && !p.models.includes(trimmed)
                ? { ...p, models: [...p.models, trimmed] }
                : p,
            ),
          }
        : f,
    );
  };

  const removeModel = (providerId: string, model: string) => {
    setForm((f) =>
      f
        ? {
            ...f,
            providers: f.providers?.map((p) =>
              p.id === providerId
                ? { ...p, models: p.models.filter((m) => m !== model) }
                : p,
            ),
          }
        : f,
    );
  };

  /** 手动设置某模型的上下文窗口(tokens);留空/非法 = 自动识别 */
  const setModelContext = (providerId: string, model: string, raw: string) => {
    setForm((f) => {
      if (!f) return f;
      const next = Number.parseFloat(raw);
      return {
        ...f,
        providers: f.providers?.map((p) => {
          if (p.id !== providerId) return p;
          const map = { ...(p.contextWindows ?? {}) };
          if (Number.isFinite(next) && next > 0) map[model] = Math.floor(next);
          else delete map[model];
          return { ...p, contextWindows: map };
        }),
      };
    });
  };

  return (
    <main className="main settings-page">
      <header className="chat-header">
        <div className="chat-title">
          <button
            className="btn btn-ghost"
            onClick={() => useStore.setState({ view: "chat" })}
            aria-label="返回对话"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path
                d="M8 2.5 4.5 6.5 8 10.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            返回对话
          </button>
          <span className="chat-title-text">设置</span>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav-primary" aria-label="主导航">
          <button
            className={`settings-nav-item${primary === "providers" ? " active" : ""}`}
            onClick={() => setPrimary("providers")}
            type="button"
          >
            供应商
          </button>
          <button
            className={`settings-nav-item${primary === "appearance" ? " active" : ""}`}
            onClick={() => setPrimary("appearance")}
            type="button"
          >
            外观
          </button>
          <button
            className={`settings-nav-item${primary === "general" ? " active" : ""}`}
            onClick={() => setPrimary("general")}
            type="button"
          >
            通用
          </button>
        </nav>

        {primary === "providers" && (
          <nav className="settings-nav-secondary" aria-label="供应商列表">
            <div className="settings-secondary-list">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  className={`settings-provider-row${provider.id === effectiveProviderId ? " active" : ""}`}
                  onClick={() => setSelectedProviderId(provider.id)}
                  type="button"
                >
                  <span className="settings-provider-name">{provider.name}</span>
                  {provider.id === form.activeProviderId && (
                    <span className="provider-badge provider-badge-active">当前</span>
                  )}
                </button>
              ))}
            </div>
            <div className="settings-secondary-foot">
              <button className="btn btn-ghost" onClick={addProvider} type="button">
                添加供应商
              </button>
            </div>
          </nav>
        )}

        <div className="settings-detail">
          <div className="settings-detail-scroll">
            {primary === "general" ? (
              <section className="settings-section">
                <h3 className="settings-section-title">通用</h3>

                <label className="field">
                  <span>工作目录(默认工作目录,新建任务时可另行选择)</span>
                  <div className="field-row">
                    <input
                      value={form.workspaceDir ?? ""}
                      onChange={(e) =>
                        setForm((f) => (f ? { ...f, workspaceDir: e.target.value } : f))
                      }
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
                      setForm((f) =>
                        f
                          ? {
                              ...f,
                              maxTokens: e.target.value === "" ? undefined : Number(e.target.value),
                            }
                          : f,
                      )
                    }
                  />
                </label>

                <div className="field field-inline">
                  <div className="field-inline-text">
                    <span className="field-inline-title">显示模型思考过程</span>
                    <span className="field-inline-desc">
                      即时生效并保存;开启后消息中的"思考过程"区块展示模型的推理内容
                    </span>
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

                <div className="field field-inline">
                  <div className="field-inline-text">
                    <span className="field-inline-title">拦截危险命令(沙箱)</span>
                    <span className="field-inline-desc">
                      即时生效;开启后删除/格式化/关停等危险命令将被拒绝执行
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={(form.sandboxMode ?? "full") === "restricted"}
                    className={`switch${(form.sandboxMode ?? "full") === "restricted" ? " on" : ""}`}
                    onClick={toggleSandbox}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                <div className="settings-actions">
                  <button className="btn btn-primary" onClick={save} type="button">
                    保存
                  </button>
                </div>
              </section>
            ) : primary === "appearance" ? (
              <section className="settings-section appearance-section">
                <h3 className="settings-section-title">外观</h3>

                <div className="appearance-control">
                  <div className="field-inline-text">
                    <span className="field-inline-title">主题</span>
                    <span className="field-inline-desc">选择日间或夜间模式</span>
                  </div>
                  <div className="appearance-theme-options" role="radiogroup" aria-label="主题">
                    <button
                      type="button"
                      role="radio"
                      aria-label="日间模式"
                      aria-checked={theme === "light"}
                      className={`appearance-theme-option${theme === "light" ? " active" : ""}`}
                      onClick={() => selectTheme("light")}
                    >
                      <span className="appearance-theme-option-label">日间模式</span>
                      <span className="appearance-theme-option-desc">明亮背景，适合白天使用</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-label="夜间模式"
                      aria-checked={theme === "dark"}
                      className={`appearance-theme-option${theme === "dark" ? " active" : ""}`}
                      onClick={() => selectTheme("dark")}
                    >
                      <span className="appearance-theme-option-label">夜间模式</span>
                      <span className="appearance-theme-option-desc">深色背景，减少夜间眩光</span>
                    </button>
                  </div>
                </div>

                <div className="appearance-control">
                  <div className="field-inline-text">
                    <span className="field-inline-title">强调色</span>
                    <span className="field-inline-desc">选择界面中的强调颜色</span>
                  </div>
                  <div className="appearance-color-grid" role="radiogroup" aria-label="强调色">
                    {ACCENT_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        role="radio"
                        aria-label={preset.label}
                        aria-checked={accentColor === preset.color}
                        className={`appearance-color-option${accentColor === preset.color ? " active" : ""}`}
                        onClick={() => selectAccent(preset.color)}
                      >
                        <span
                          className="appearance-color-swatch"
                          style={{
                            display: "inline-block",
                            width: 20,
                            height: 20,
                            backgroundColor: preset.color,
                          }}
                          aria-hidden="true"
                        />
                        <span>{preset.label}</span>
                      </button>
                    ))}
                  </div>
                  <label className="appearance-custom-color">
                    <span>自定义颜色</span>
                    <input
                      type="color"
                      aria-label="自定义颜色"
                      value={accentColor}
                      onChange={(e) => selectAccent(e.target.value)}
                    />
                  </label>
                </div>
              </section>
            ) : selectedProvider ? (
              <ProviderCard
                provider={selectedProvider}
                isActive={selectedProvider.id === form.activeProviderId}
                fetchState={fetchState[selectedProvider.id]}
                onPatch={(patch) => updateProvider(selectedProvider.id, patch)}
                onFetch={() => requestModels(selectedProvider.id)}
                onActivate={() => activate(selectedProvider)}
                onRemove={() => removeProvider(selectedProvider.id)}
                onAddModel={(model) => addModel(selectedProvider.id, model)}
                onRemoveModel={(model) => removeModel(selectedProvider.id, model)}
                onContextChange={(model, raw) => setModelContext(selectedProvider.id, model, raw)}
              />
            ) : (
              <div className="settings-empty">暂无供应商</div>
            )}
            {primary === "providers" && selectedProvider && (
              <div className="settings-actions">
                <button className="btn btn-primary" onClick={save} type="button">
                  保存
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------
// 单张供应商卡片:名称/Base URL/API Key 可编辑,模型 chips 可增删
// ---------------------------------------------------------------------

interface ProviderCardProps {
  provider: ProviderConfig;
  isActive: boolean;
  fetchState?: FetchState;
  onPatch: (patch: Partial<ProviderConfig>) => void;
  onFetch: () => void;
  onActivate: () => void;
  onRemove: () => void;
  onAddModel: (model: string) => void;
  onRemoveModel: (model: string) => void;
  onContextChange: (model: string, raw: string) => void;
}

function ProviderCard({
  provider,
  isActive,
  fetchState,
  onPatch,
  onFetch,
  onActivate,
  onRemove,
  onAddModel,
  onRemoveModel,
  onContextChange,
}: ProviderCardProps): React.JSX.Element {
  const [newModel, setNewModel] = useState("");

  const add = () => {
    onAddModel(newModel);
    setNewModel("");
  };

  return (
    <div className={`provider-card${isActive ? " active" : ""}`}>
      <div className="provider-head">
        <input
          className="provider-name-input"
          value={provider.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          aria-label="供应商名称"
          spellCheck={false}
        />
        {provider.builtin && <span className="provider-badge">内置</span>}
        {isActive && <span className="provider-badge provider-badge-active">当前</span>}
        <div className="provider-actions">
          <button className="btn btn-ghost" onClick={onFetch} type="button">
            拉取模型
          </button>
          <button className="btn btn-primary" onClick={onActivate} disabled={isActive} type="button">
            设为当前
          </button>
          {!provider.builtin && (
            <button className="btn btn-danger" onClick={onRemove} type="button">
              删除
            </button>
          )}
        </div>
      </div>

      <div className="provider-grid">
        <label className="field">
          <span>Base URL</span>
          <input
            value={provider.baseUrl}
            onChange={(e) => onPatch({ baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={provider.apiKey}
            onChange={(e) => onPatch({ apiKey: e.target.value })}
            placeholder="sk-…"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>Models URL</span>
          <input
            value={provider.modelsUrl ?? ""}
            onChange={(e) => onPatch({ modelsUrl: e.target.value || undefined })}
            placeholder="https://api.example.com/models"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>API Format</span>
          <select
            value={provider.apiFormat ?? "openai"}
            onChange={(e) => onPatch({ apiFormat: e.target.value as ProviderConfig["apiFormat"] })}
            aria-label="API Format"
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="google">google</option>
          </select>
        </label>
      </div>

      <div className="provider-models">
        <span className="provider-models-title">模型</span>
        {provider.models.length > 0 ? (
          <table className="model-table">
            <thead>
              <tr>
                <th>模型 ID</th>
                <th>上下文窗口</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {provider.models.map((model) => (
                <tr key={model} className="model-row">
                  <td className="model-cell-name" title={model}>
                    {model}
                  </td>
                  <td className="model-cell-context">
                    <input
                      className="model-context-input"
                      value={String(provider.contextWindows?.[model] ?? "")}
                      onChange={(e) => onContextChange(model, e.target.value)}
                      placeholder="自动"
                      inputMode="numeric"
                      aria-label={`${model} 的上下文窗口(tokens),留空为自动识别`}
                      title="上下文窗口 tokens;留空 = 自动识别"
                      spellCheck={false}
                    />
                  </td>
                  <td className="model-cell-action">
                    <button
                      className="model-remove-btn"
                      onClick={() => onRemoveModel(model)}
                      aria-label={`移除模型 ${model}`}
                      type="button"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {provider.models.length === 0 && !fetchState && (
          <div className="model-empty">未获取,可拉取或手动添加</div>
        )}
        {fetchState === "fetching" && <div className="model-status">拉取中…</div>}
        {fetchState === "ok" && <div className="model-status model-status-ok">拉取成功</div>}
        {fetchState === "failed" && <div className="model-status model-status-failed">拉取失败</div>}
        <div className="model-add-row">
          <input
            className="model-add-input"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && newModel.trim()) {
                add();
              }
            }}
            placeholder="手动添加模型 id,如 deepseek-chat"
            spellCheck={false}
          />
          <button className="btn btn-ghost" onClick={add} disabled={!newModel.trim()} type="button">
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

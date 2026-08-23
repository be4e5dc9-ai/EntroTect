// =====================================================================
// App 骨架:事件订阅 + 布局(titlebar 拖拽区 / 侧栏 / 聊天区)
// =====================================================================

import { useEffect } from "react";
import { useStore, applyEvent } from "./store";
import { bridge } from "./bridge";
import { Sidebar } from "./components/Sidebar";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ApprovalModal } from "./components/ApprovalModal";
import { SettingsModal } from "./components/SettingsModal";
import { Toasts } from "./components/Toasts";

export function App(): React.JSX.Element {
  const session = useStore((s) => s.currentSession);
  const usage = useStore((s) => s.usage);
  const busy = useStore((s) => s.busy);
  const config = useStore((s) => s.config);

  useEffect(() => {
    const unsubscribe = bridge().onEvent(applyEvent);
    bridge().send({ kind: "ListSessions" });
    bridge().send({ kind: "GetConfig" });
    return unsubscribe;
  }, []);

  const setEffort = (value: "off" | "low" | "medium" | "high") => {
    if (!config) return;
    bridge().send({ kind: "SetConfig", config: { ...config, reasoningEffort: value } });
  };

  return (
    <div className="app">
      <div className="titlebar" />
      <div className="app-body">
        <Sidebar />
        <main className="main">
          <header className="chat-header">
            <div className="chat-title">
              <span className="chat-title-text">{session?.title ?? "EntroTect"}</span>
              {busy && <span className="chat-busy" aria-label="运行中">运行中</span>}
            </div>
            <div className="chat-meta">
              {session && <span className="chat-model">{session.model}</span>}
              <label className="effort-select" title="思考强度">
                <span className="effort-icon" aria-hidden="true">
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
                  value={config?.reasoningEffort ?? "off"}
                  onChange={(e) =>
                    setEffort(e.target.value as "off" | "low" | "medium" | "high")
                  }
                  aria-label="思考强度"
                >
                  <option value="off">关</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </label>
              {usage && (
                <span className="chat-usage">
                  ↑{usage.inputTokens.toLocaleString()} ↓{usage.outputTokens.toLocaleString()}
                </span>
              )}
            </div>
          </header>
          <div className="chat-scroll">
            <MessageList />
          </div>
          <Composer />
        </main>
      </div>
      <ApprovalModal />
      <SettingsModal />
      <Toasts />
    </div>
  );
}

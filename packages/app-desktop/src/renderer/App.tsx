// =====================================================================
// App 骨架:事件订阅 + 布局(titlebar 拖拽区 / 侧栏 / 主区)
// 主区按 view 切换:chat = 聊天区,settings = 设置页(独立成页)。
// 侧栏宽度与收起状态持久化(localStorage)。
// =====================================================================

import { useEffect, useState } from "react";
import { useStore, applyEvent } from "./store";
import { bridge } from "./bridge";
import { Sidebar } from "./components/Sidebar";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ApprovalModal } from "./components/ApprovalModal";
import { SettingsPage } from "./components/SettingsPage";
import { Toasts } from "./components/Toasts";
import { DetailPanel } from "./components/DetailPanel";

const DEFAULT_SIDEBAR_WIDTH = 248;

export function App(): React.JSX.Element {
  const session = useStore((s) => s.currentSession);
  const usage = useStore((s) => s.usage);
  const busy = useStore((s) => s.busy);
  const view = useStore((s) => s.view);
  const activeProviderId = useStore((s) => s.config?.activeProviderId);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("entrotect-sidebar-width"));
    return saved >= 200 && saved <= 460 ? saved : DEFAULT_SIDEBAR_WIDTH;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("entrotect-sidebar-collapsed") === "1",
  );
  const detail = useStore((s) => s.detail);

  useEffect(() => {
    const unsubscribe = bridge().onEvent(applyEvent);
    bridge().send({ kind: "ListSessions" });
    bridge().send({ kind: "GetConfig" });
    return unsubscribe;
  }, []);

  // 启动(config 到达)与切换供应商后,拉取当前供应商的模型列表
  useEffect(() => {
    if (activeProviderId) {
      bridge().send({ kind: "ListModels", providerId: activeProviderId });
    }
  }, [activeProviderId]);

  const persistWidth = (width: number) => {
    setSidebarWidth(width);
    localStorage.setItem("entrotect-sidebar-width", String(width));
  };

  const collapse = () => {
    setSidebarCollapsed(true);
    localStorage.setItem("entrotect-sidebar-collapsed", "1");
  };

  const expand = () => {
    setSidebarCollapsed(false);
    localStorage.setItem("entrotect-sidebar-collapsed", "0");
  };

  return (
    <div className="app">
      <div className="titlebar">
        {sidebarCollapsed && (
          <button className="btn btn-ghost sidebar-peek" onClick={expand} aria-label="打开对话列表">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="M2 3.5h9M2 6.5h9M2 9.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            对话列表
          </button>
        )}
      </div>
      <div className="app-body">
        {!sidebarCollapsed && (
          <Sidebar width={sidebarWidth} onWidthChange={persistWidth} onCollapse={collapse} />
        )}
        {view === "settings" ? (
          <SettingsPage />
        ) : (
          <main className="main">
            <header className="chat-header">
              <div className="chat-title">
                <span className="chat-title-text">{session?.title || "EntroTect"}</span>
                {busy && <span className="chat-busy" aria-label="运行中">运行中</span>}
              </div>
              <div className="chat-meta">
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
        )}
        {detail && <DetailPanel />}
      </div>
      <ApprovalModal />
      <Toasts />
    </div>
  );
}

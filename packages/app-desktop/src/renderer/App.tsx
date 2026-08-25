// =====================================================================
// App 骨架:事件订阅 + 布局(titlebar 拖拽区 / 侧栏 / 主区)
// 主区按 view 切换:chat = 聊天区,settings = 设置页(独立成页)。
// 侧栏/详情栏宽度与收起状态持久化(localStorage)。
// =====================================================================

import { useEffect, useState } from "react";
import { fetchSkills, useStore, applyEvent } from "./store";
import { bridge } from "./bridge";
import { PanelCollapseIcon, Sidebar } from "./components/Sidebar";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ApprovalModal } from "./components/ApprovalModal";
import { SettingsPage } from "./components/SettingsPage";
import { Toasts } from "./components/Toasts";
import { DetailPanel } from "./components/DetailPanel";

const DEFAULT_SIDEBAR_WIDTH = 248;
const DEFAULT_DETAIL_WIDTH = 420;

export function App(): React.JSX.Element {
  const session = useStore((s) => s.currentSession);
  const usage = useStore((s) => s.usage);
  const busy = useStore((s) => s.busy);
  const view = useStore((s) => s.view);
  const activeProviderId = useStore((s) => s.config?.activeProviderId);
  const detailTabs = useStore((s) => s.detailTabs);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("entrotect-sidebar-width"));
    return saved >= 200 && saved <= 460 ? saved : DEFAULT_SIDEBAR_WIDTH;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("entrotect-sidebar-collapsed") === "1",
  );
  const activeDetailId = useStore((s) => s.activeDetailId);
  const [detailWidth, setDetailWidth] = useState(() => {
    const saved = Number(localStorage.getItem("entrotect-detail-width"));
    return saved >= 320 && saved <= 640 ? saved : DEFAULT_DETAIL_WIDTH;
  });
  const [detailCollapsed, setDetailCollapsed] = useState(
    () => localStorage.getItem("entrotect-detail-collapsed") === "1",
  );

  useEffect(() => {
    const unsubscribe = bridge().onEvent(applyEvent);
    bridge().send({ kind: "ListSessions" });
    bridge().send({ kind: "GetConfig" });
    void fetchSkills();
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

  const persistDetailWidth = (width: number) => {
    setDetailWidth(width);
    localStorage.setItem("entrotect-detail-width", String(width));
  };

  const collapse = () => {
    setSidebarCollapsed(true);
    localStorage.setItem("entrotect-sidebar-collapsed", "1");
  };

  const expand = () => {
    setSidebarCollapsed(false);
    localStorage.setItem("entrotect-sidebar-collapsed", "0");
  };

  const collapseDetail = () => {
    setDetailCollapsed(true);
    localStorage.setItem("entrotect-detail-collapsed", "1");
  };

  const expandDetail = () => {
    setDetailCollapsed(false);
    localStorage.setItem("entrotect-detail-collapsed", "0");
  };

  const hasDetail = detailTabs.length > 0 && activeDetailId !== null;

  return (
    <div className="app">
      <div className="titlebar">
        <span
          className={`titlebar-live${busy ? " is-busy" : ""}`}
          aria-hidden="true"
        />
        {view === "chat" && (
          <button
            type="button"
            className={`btn btn-ghost sidebar-toggle${sidebarCollapsed ? " with-label" : ""}`}
            onClick={sidebarCollapsed ? expand : collapse}
            aria-label={sidebarCollapsed ? "展开对话列表" : "收起对话列表"}
            title={sidebarCollapsed ? "展开对话列表" : "收起对话列表"}
          >
            <PanelCollapseIcon direction={sidebarCollapsed ? "right" : "left"} />
            {sidebarCollapsed && "对话列表"}
          </button>
        )}
        {view === "chat" && detailCollapsed && hasDetail && (
          <button
            type="button"
            className="btn btn-ghost detail-peek"
            onClick={expandDetail}
            aria-label="Open details"
            title="Open details"
          >
            <PanelCollapseIcon direction="left" />
          </button>
        )}
      </div>
      <div className="app-body">
        {view === "chat" && !sidebarCollapsed && (
          <Sidebar width={sidebarWidth} onWidthChange={persistWidth} />
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
        {view === "chat" && hasDetail && !detailCollapsed && (
          <DetailPanel
            width={detailWidth}
            onWidthChange={persistDetailWidth}
            onCollapse={collapseDetail}
          />
        )}
      </div>
      <ApprovalModal />
      <Toasts />
    </div>
  );
}

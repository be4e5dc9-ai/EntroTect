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

  useEffect(() => {
    const unsubscribe = bridge().onEvent(applyEvent);
    bridge().send({ kind: "ListSessions" });
    bridge().send({ kind: "GetConfig" });
    return unsubscribe;
  }, []);

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

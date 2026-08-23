// =====================================================================
// 侧栏:会话列表 + 新建 + 设置入口
// =====================================================================

import { useStore } from "../store";
import { bridge } from "../bridge";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString();
}

function toggleTheme(): void {
  const next = useStore.getState().theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("entrotect-theme", next);
  bridge().setTheme(next);
  useStore.setState({ theme: next });
}

export function Sidebar(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const currentSession = useStore((s) => s.currentSession);
  const busy = useStore((s) => s.busy);
  const theme = useStore((s) => s.theme);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="./icon.png" alt="" className="brand-mark" draggable={false} />
        <span className="brand-name">EntroTect</span>
      </div>

      <button
        className="btn btn-primary sidebar-new"
        onClick={() => bridge().send({ kind: "NewSession" })}
        disabled={busy}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        新会话
      </button>

      <nav className="session-list">
        {sessions.map((session) => (
          <button
            key={session.id}
            className={`session-item${currentSession?.id === session.id ? " active" : ""}`}
            onClick={() => bridge().send({ kind: "ResumeSession", sessionId: session.id })}
            title={session.title}
          >
            <span className="session-title">{session.title || "未命名"}</span>
            <span className="session-time">{relativeTime(session.createdAt)}</span>
          </button>
        ))}
        {sessions.length === 0 && (
          <p className="session-empty">还没有会话,点击上方"新会话"开始</p>
        )}
      </nav>

      <div className="sidebar-footer">
        <button
          className="btn btn-ghost settings-btn"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
          title={theme === "dark" ? "日间模式" : "夜间模式"}
        >
          {theme === "dark" ? (
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <circle cx="7.5" cy="7.5" r="3" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M7.5 1v1.6M7.5 12.4V14M1 7.5h1.6M12.4 7.5H14M2.9 2.9l1.13 1.13M10.97 10.97l1.13 1.13M12.1 2.9l-1.13 1.13M4.03 10.97l-1.13 1.13"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path
                d="M12.5 9.2A5.5 5.5 0 0 1 5.8 2.5a5.5 5.5 0 1 0 6.7 6.7Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {theme === "dark" ? "日间模式" : "夜间模式"}
        </button>
        <button
          className="btn btn-ghost settings-btn"
          onClick={() => useStore.setState({ settingsOpen: true })}
          aria-label="设置"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path
              d="M7.5 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M12.5 7.5c0 .3-.03.58-.08.86l1.06.83-1.5 2.6-1.25-.5a5.6 5.6 0 0 1-1.5.86l-.19 1.35h-3l-.19-1.35a5.6 5.6 0 0 1-1.5-.86l-1.25.5-1.5-2.6 1.06-.83A5.5 5.5 0 0 1 2.5 7.5c0-.3.03-.58.08-.86L1.52 5.8l1.5-2.6 1.25.5a5.6 5.6 0 0 1 1.5-.86l.19-1.35h3l.19 1.35a5.6 5.6 0 0 1 1.5.86l1.25-.5 1.5 2.6-1.06.83c.05.28.08.56.08.86Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          设置
        </button>
      </div>
    </aside>
  );
}

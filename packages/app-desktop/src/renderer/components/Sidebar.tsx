// =====================================================================
// 侧栏:任务(按工作目录分组) + 对话列表
// 顶部:标题(收起/展开由标题栏常驻按钮接管);New 按钮新建任务(选择工作目录);
// 每个任务行右侧 "+" 在此任务下新建对话;对话行 hover 出 ⋮ 删除。
// 右缘手柄可拖动调整宽度(持久化)。
// =====================================================================

import { useState } from "react";
import type { SessionMeta } from "@entrotect/shared";
import { useStore } from "../store";
import { bridge } from "../bridge";

function dirName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop() ?? cwd;
  if (!name) return cwd;
  return name.length > 26 ? `${name.slice(0, 26)}…` : name;
}

interface ProjectGroup {
  cwd: string;
  label: string;
  sessions: SessionMeta[];
}

const COL_RESIZE_MAX = 460;
const COL_RESIZE_MIN = 200;

interface SidebarProps {
  width: number;
  onWidthChange: (width: number) => void;
}

export function PanelCollapseIcon({
  direction,
}: {
  direction: "left" | "right";
}): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.25" y="2.5" width="13.5" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 2.5v13" stroke="currentColor" strokeWidth="1.2" />
      <path
        d={direction === "left" ? "m6 6.5-2 2.5 2 2.5" : "m12 6.5 2 2.5-2 2.5"}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Sidebar({ width, onWidthChange }: SidebarProps): React.JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const currentSession = useStore((s) => s.currentSession);
  const busy = useStore((s) => s.busy);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  // 按工作目录分组:一个任务 = 一个目录,下面多个对话
  const groups: ProjectGroup[] = [];
  for (const session of sessions) {
    const existing = groups.find((group) => group.cwd === session.cwd);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.push({ cwd: session.cwd, label: dirName(session.cwd), sessions: [session] });
    }
  }

  const newProject = async () => {
    const dir = await bridge().chooseFolder();
    if (dir) bridge().send({ kind: "NewProject", cwd: dir });
  };

  const deleteSession = (sessionId: string) => {
    if (armedDelete === sessionId) {
      bridge().send({ kind: "DeleteSession", sessionId });
      setArmedDelete(null);
    } else {
      setArmedDelete(sessionId);
      // 3s 未二次确认回到未武装
      setTimeout(() => setArmedDelete((id) => (id === sessionId ? null : id)), 3000);
    }
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = width;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const next = Math.min(COL_RESIZE_MAX, Math.max(COL_RESIZE_MIN, startWidth + ev.clientX - startX));
      onWidthChange(next);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <span className="sidebar-head-title">对话列表</span>
      </div>

      <button className="btn btn-primary sidebar-new" onClick={newProject} disabled={busy}>
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <path d="M6.5 1.5v10M1.5 6.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        New
      </button>

      <nav className="session-list">
        {groups.map((group) => (
          <div className="project-group" key={group.cwd}>
            <div className="project-row">
              <span className="project-name" title={group.cwd}>
                {group.label}
              </span>
              <button
                className="project-add"
                onClick={() => bridge().send({ kind: "NewProject", cwd: group.cwd })}
                aria-label="新建对话"
                title="在此任务下新建对话"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M6 2.2v7.6M2.2 6h7.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {group.sessions.map((session) => (
              <div className="session-row" key={session.id}>
                <button
                  className={`session-item${currentSession?.id === session.id ? " active" : ""}`}
                  onClick={() => bridge().send({ kind: "ResumeSession", sessionId: session.id })}
                  title={session.title}
                >
                  <span
                    className={`session-dot${currentSession?.id === session.id && busy ? " is-running" : ""}`}
                    aria-hidden="true"
                  />
                  <span className="session-title">{session.title || "未命名"}</span>
                </button>
                {armedDelete === session.id ? (
                  <span className="session-confirm" onClick={() => deleteSession(session.id)}>
                    确认删除?
                  </span>
                ) : (
                  <button
                    className="session-more"
                    onClick={() => deleteSession(session.id)}
                    aria-label="删除对话"
                    title="删除对话"
                  >
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor" aria-hidden="true">
                      <circle cx="2.5" cy="6.5" r="1.1" />
                      <circle cx="6.5" cy="6.5" r="1.1" />
                      <circle cx="10.5" cy="6.5" r="1.1" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="session-empty">点击 New 新建任务,选择工作目录开始</p>
        )}
      </nav>

      <div className="sidebar-footer">
        <button
          className="btn btn-ghost settings-btn"
          onClick={() => useStore.setState({ view: "settings" })}
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

      <div className="sidebar-resizer" onPointerDown={startResize} />
    </aside>
  );
}

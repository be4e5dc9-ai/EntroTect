// =====================================================================
// Toast 通知:入场走 Python 烘焙的 toast 关键帧,退场走 transition
// =====================================================================

import { useStore } from "../store";

export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          {toast.kind === "error" && (
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6.5 3.8v3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <circle cx="6.5" cy="9.2" r="0.7" fill="currentColor" />
            </svg>
          )}
          <span>{toast.text}</span>
        </div>
      ))}
    </div>
  );
}

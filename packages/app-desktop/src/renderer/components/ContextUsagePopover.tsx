import { useEffect, useRef, useState } from "react";
import { getContextSnapshot } from "../store";

export interface ContextUsagePopoverProps {
  inputTokens?: number;
  contextWindow?: number;
}

export interface ContextUsageDisplay {
  used: string;
  total: string;
  summary: string;
  percentage: string;
  remaining: string;
}

/** Compact units keep the usage summary readable inside the Composer. */
export function formatTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "unknown";
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}k`;
  return String(Math.round(value));
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function formatContextUsage(
  inputTokens?: number,
  contextWindow?: number,
): ContextUsageDisplay {
  const snapshot = getContextSnapshot(inputTokens, contextWindow);
  if (!snapshot) {
    return {
      used: "unknown",
      total: "unknown",
      summary: "Context unknown",
      percentage: "unknown",
      remaining: "unknown",
    };
  }

  const used = formatTokenCount(snapshot.inputTokens);
  const total = formatTokenCount(snapshot.contextWindow);
  return {
    used,
    total,
    summary: `${used} / ${total}`,
    percentage: `${Math.round(snapshot.usedRatio * 100)}%`,
    remaining: formatTokenCount(snapshot.remainingTokens),
  };
}

function ContextRing({
  ratio,
  known,
}: {
  ratio: number;
  known: boolean;
}): React.JSX.Element {
  return (
    <span
      className={`context-usage-ring${known ? "" : " unknown"}`}
      style={
        known
          ? {
              background: `conic-gradient(var(--accent-strong) ${ratio * 100}%, var(--surface-active) 0)`,
            }
          : undefined
      }
      aria-hidden="true"
    >
      <span className="context-usage-ring-center" />
    </span>
  );
}

export function ContextUsagePopover({
  inputTokens,
  contextWindow,
}: ContextUsagePopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const snapshot = getContextSnapshot(inputTokens, contextWindow);
  const display = formatContextUsage(inputTokens, contextWindow);
  const known = snapshot !== null;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;

    panelRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // The listeners intentionally follow the open/closed lifecycle only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const triggerLabel = known
    ? `Context usage: ${display.summary} (${display.percentage})`
    : "Context unknown";

  return (
    <div className="context-usage" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`context-usage-trigger${open ? " open" : ""}${known ? "" : " unknown"}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="context-usage-popover"
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        <ContextRing ratio={snapshot?.usedRatio ?? 0} known={known} />
      </button>

      {open && (
        <div
          ref={panelRef}
          id="context-usage-popover"
          className="context-usage-popover"
          role="dialog"
          aria-label="Context usage"
          tabIndex={-1}
        >
          {known ? (
            <>
              <div className="context-usage-summary">
                <span>Context window</span>
                <strong>
                  {display.summary}{" "}
                  <span className="context-usage-percent">({display.percentage})</span>
                </strong>
              </div>
              <div className="context-usage-meter" aria-hidden="true">
                <span style={{ width: `${snapshot.usedRatio * 100}%` }} />
              </div>
              <div className="context-usage-remaining">
                <span>Remaining</span>
                <strong>{display.remaining}</strong>
              </div>
            </>
          ) : (
            <div className="context-usage-unknown">Context unknown</div>
          )}
        </div>
      )}
    </div>
  );
}

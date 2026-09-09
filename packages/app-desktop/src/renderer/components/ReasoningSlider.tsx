import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ReasoningEffort } from "@entrotect/shared";

const SHORT_LABEL: Record<ReasoningEffort, string> = {
  off: "关闭",
  low: "轻量",
  medium: "均衡",
  high: "深入",
  xhigh: "极高",
  max: "最大",
  ultra: "超强",
};

const DESCRIPTION: Record<ReasoningEffort, string> = {
  off: "不请求模型推理",
  low: "更快响应",
  medium: "速度与深度平衡",
  high: "适合复杂编码",
  xhigh: "投入更多推理",
  max: "模型最大推理强度",
  ultra: "最大推理并主动调度子代理",
};

interface ReasoningSliderProps {
  value: ReasoningEffort;
  efforts: ReasoningEffort[];
  defaultValue: ReasoningEffort;
  model: string;
  onSelect: (value: ReasoningEffort) => void;
}

function SparkIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M7.2 1.5 3.1 7h3L5.8 11.5 10 5.8H7.1l.1-4.3Z" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ReasoningSlider({
  value,
  efforts,
  defaultValue,
  model,
  onSelect,
}: ReasoningSliderProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const index = Math.max(0, efforts.indexOf(value));
  const selected = efforts[index] ?? value;
  const fill = efforts.length <= 1 ? 100 : (index / (efforts.length - 1)) * 100;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu menu-right reasoning-slider" ref={rootRef}>
      <button
        type="button"
        className={`bar-select menu-trigger reasoning-slider-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`思考强度：${SHORT_LABEL[selected]}`}
      >
        <span className="bar-select-icon"><SparkIcon /></span>
        <span className="menu-trigger-label">{SHORT_LABEL[selected]}</span>
        {selected === "ultra" && <span className="reasoning-ultra-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="reasoning-slider-panel" role="dialog" aria-label="调整思考强度">
          <div className="reasoning-slider-head">
            <span className="reasoning-slider-mark"><SparkIcon /></span>
            <span className="reasoning-slider-copy">
              <strong>{SHORT_LABEL[selected]}</strong>
              <span>{model || "当前模型"}</span>
            </span>
            <button
              type="button"
              className="reasoning-slider-reset"
              onClick={() => onSelect(defaultValue)}
              aria-label={`恢复默认强度：${SHORT_LABEL[defaultValue]}`}
              title="恢复模型默认强度"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path d="M3.2 4.1H1.6V2.5M1.9 4A5 5 0 1 1 2 9.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div
            className="reasoning-range-wrap"
            style={{ "--reasoning-fill": `${fill}%` } as CSSProperties}
          >
            <input
              className="reasoning-range"
              type="range"
              min={0}
              max={Math.max(0, efforts.length - 1)}
              step={1}
              value={index}
              onChange={(event) => {
                const next = efforts[Number(event.target.value)];
                if (next) onSelect(next);
              }}
              aria-label="思考强度"
              aria-valuetext={`${SHORT_LABEL[selected]}：${DESCRIPTION[selected]}`}
            />
            <div className="reasoning-range-dots" aria-hidden="true">
              {efforts.map((effort, effortIndex) => (
                <span
                  key={effort}
                  className={`${effortIndex <= index ? "is-filled" : ""}${effortIndex === index ? " is-current" : ""}`}
                />
              ))}
            </div>
          </div>

          <div className="reasoning-slider-foot">
            <span>{DESCRIPTION[selected]}</span>
            <code>{selected}</code>
          </div>
        </div>
      )}
    </div>
  );
}

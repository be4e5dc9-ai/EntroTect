// =====================================================================
// PopoverMenu:cmdk 式悬浮下拉菜单
// 设计依据:贴图样式(Model 菜单:标题头 + 行/编号 + 选中勾)+
// emil 规范——面板 origin-aware(从触发器方向弹出,不居中),
// 入场用 Python 烘焙的 pop 弹簧关键帧;触发器本身零动画。
// 支持:点击外部关闭 / Esc 关闭 / ↑↓ 光标 / Enter 选中。
// =====================================================================

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface MenuOption<V extends string> {
  value: V;
  label: string;
  /** 行右侧的弱化标注(如模型序号) */
  meta?: string;
}

interface PopoverMenuProps<V extends string> {
  value: V;
  options: MenuOption<V>[];
  /** 命中即关闭并回调 */
  onSelect: (value: V) => void;
  heading?: string;
  icon?: ReactNode;
  ariaLabel: string;
  /** 面板贴触发器哪一侧对齐(右侧对齐时 origin 在右下) */
  align?: "left" | "right";
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg className="menu-check" width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.8 5.2 9.5 10.5 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PopoverMenu<V extends string>(
  props: PopoverMenuProps<V>,
): React.JSX.Element {
  const { value, options, onSelect, heading, icon, ariaLabel, align = "left" } = props;
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  // 打开时:光标落在选中项;外部点击/Esc 关闭;方向键导航
  useEffect(() => {
    if (!open) return;
    setCursor(selectedIndex);
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((i) => (i + 1) % options.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((i) => (i - 1 + options.length) % options.length);
      } else if (event.key === "Enter") {
        const current = options[cursor];
        if (current) {
          onSelect(current.value);
          setOpen(false);
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trigger = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className={`menu menu-${align}`} ref={rootRef}>
      <button
        type="button"
        className={`bar-select menu-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {icon && <span className="bar-select-icon">{icon}</span>}
        <span className="menu-trigger-label">{trigger?.label ?? ariaLabel}</span>
      </button>

      {open && (
        <div className="menu-panel" role="listbox" aria-label={ariaLabel}>
          {heading && <div className="menu-heading">{heading}</div>}
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`menu-item${index === cursor ? " cursor" : ""}${option.value === value ? " selected" : ""}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => {
                onSelect(option.value);
                setOpen(false);
              }}
            >
              <span className="menu-item-label">{option.label}</span>
              {option.value === value && <CheckIcon />}
              {option.meta && <span className="menu-item-meta">{option.meta}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

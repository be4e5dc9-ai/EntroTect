// =====================================================================
// preload 桥接的类型安全包装
// =====================================================================

import type { AppEvent, Op } from "@entrotect/shared";

export interface EntroTectBridge {
  send: (op: Op) => void;
  onEvent: (callback: (event: AppEvent) => void) => () => void;
  chooseFolder: () => Promise<string | null>;
}

declare global {
  interface Window {
    entrotect?: EntroTectBridge;
  }
}

export function bridge(): EntroTectBridge {
  if (!window.entrotect) throw new Error("preload 桥接未就绪");
  return window.entrotect;
}

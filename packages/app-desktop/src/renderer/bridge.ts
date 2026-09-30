// =====================================================================
// preload 桥接的类型安全包装
// =====================================================================

import type { AppEvent, Op, SkillInfo, BrowserCommand, BrowserReply, BrowserTabState, BrowserViewport, ResearchCommand, ResearchReply } from "@entrotect/shared";

export interface EntroTectBridge {
  send: (op: Op) => void;
  onEvent: (callback: (event: AppEvent) => void) => () => void;
  chooseFolder: () => Promise<string | null>;
  setTheme: (theme: "dark" | "light") => void;
  setAccentColor: (color: string) => void;
  listSkills: () => Promise<SkillInfo[]>;
  pathOfDragFile: (file: File) => string;
  browserCommand: (sessionId: string, command: BrowserCommand) => Promise<BrowserReply>;
  browserViewport: (sessionId: string, tabId: string, bounds: BrowserViewport | null) => void;
  onBrowserTabs: (callback: (sessionId: string, tabs: BrowserTabState[]) => void) => () => void;
  researchCommand: (command: ResearchCommand) => Promise<ResearchReply>;
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

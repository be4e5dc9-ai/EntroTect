// =====================================================================
// Preload:contextBridge 暴露类型安全的 Op 发送与 AppEvent 订阅
// =====================================================================

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppEvent, Op, SkillInfo, BrowserCommand, BrowserReply, BrowserTabState, BrowserViewport, ResearchCommand, ResearchReply } from "@entrotect/shared";

export interface EntroTectBridge {
  send: (op: Op) => void;
  onEvent: (callback: (event: AppEvent) => void) => () => void;
  chooseFolder: () => Promise<string | null>;
  setTheme: (theme: "dark" | "light") => void;
  setAccentColor: (color: string) => void;
  listSkills: () => Promise<SkillInfo[]>;
  /** 拖拽文件 → 绝对路径(webUtils,仅 renderer 进程可用) */
  pathOfDragFile: (file: File) => string;
  browserCommand: (sessionId: string, command: BrowserCommand) => Promise<BrowserReply>;
  browserViewport: (sessionId: string, tabId: string, bounds: BrowserViewport | null) => void;
  onBrowserTabs: (callback: (sessionId: string, tabs: BrowserTabState[]) => void) => () => void;
  researchCommand: (command: ResearchCommand) => Promise<ResearchReply>;
}

const bridge: EntroTectBridge = {
  send: (op) => {
    ipcRenderer.send("entrotect:op", op);
  },
  onEvent: (callback) => {
    const listener = (_event: unknown, payload: AppEvent) => callback(payload);
    ipcRenderer.on("entrotect:event", listener);
    return () => {
      ipcRenderer.removeListener("entrotect:event", listener);
    };
  },
  chooseFolder: () => ipcRenderer.invoke("entrotect:choose-folder"),
  setTheme: (theme) => {
    void ipcRenderer.invoke("entrotect:set-theme", theme);
  },
  setAccentColor: (color) => {
    void ipcRenderer.invoke("entrotect:set-accent-color", color);
  },
  listSkills: () => ipcRenderer.invoke("entrotect:list-skills") as Promise<SkillInfo[]>,
  browserCommand: (sessionId, command) => ipcRenderer.invoke("entrotect:browser", sessionId, command),
  browserViewport: (sessionId, tabId, bounds) => ipcRenderer.send("entrotect:browser-viewport", sessionId, tabId, bounds),
  onBrowserTabs: (callback) => {
    const listener = (_event: unknown, payload: { sessionId: string; tabs: BrowserTabState[] }) => callback(payload.sessionId, payload.tabs);
    ipcRenderer.on("entrotect:browser-tabs", listener);
    return () => ipcRenderer.removeListener("entrotect:browser-tabs", listener);
  },
  researchCommand: (command) => ipcRenderer.invoke("entrotect:research", command),
  pathOfDragFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
};

contextBridge.exposeInMainWorld("entrotect", bridge);

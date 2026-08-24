// =====================================================================
// Preload:contextBridge 暴露类型安全的 Op 发送与 AppEvent 订阅
// =====================================================================

import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent, Op } from "@entrotect/shared";

export interface EntroTectBridge {
  send: (op: Op) => void;
  onEvent: (callback: (event: AppEvent) => void) => () => void;
  chooseFolder: () => Promise<string | null>;
  setTheme: (theme: "dark" | "light") => void;
  setAccentColor: (color: string) => void;
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
};

contextBridge.exposeInMainWorld("entrotect", bridge);

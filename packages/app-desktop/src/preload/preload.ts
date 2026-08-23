// =====================================================================
// Preload:contextBridge 暴露类型安全的 Op 发送与 AppEvent 订阅
// =====================================================================

import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent, Op } from "@entrotect/shared";

export interface EntroTectBridge {
  send: (op: Op) => void;
  onEvent: (callback: (event: AppEvent) => void) => () => void;
  chooseFolder: () => Promise<string | null>;
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
};

contextBridge.exposeInMainWorld("entrotect", bridge);

// =====================================================================
// Electron 主进程:窗口 + IPC 桥 + SessionHost 装配
// =====================================================================

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { opSchema, type Op } from "@entrotect/shared";
import { SessionHost } from "./host.js";
import { createAccentWindowIcon } from "./window-icon.js";
import { discoverSkills } from "./skills.js";

// 主进程产物为 CJS,直接用 __dirname 定位资源
const here = __dirname;

let mainWindow: BrowserWindow | null = null;
let host: SessionHost | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#0d0d10",
    autoHideMenuBar: true,
    icon: path.join(here, "../../build/icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0d0d10",
      symbolColor: "#8f8f9d",
      height: 40,
    },
    webPreferences: {
      preload: path.join(here, "../preload/preload.cjs"),
      // 渲染层加固(P3-1):显式写死与当前默认一致,防未来 Electron 默认变化
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.loadFile(path.join(here, "../renderer/index.html"));
  // 渲染层加固(P3-1):禁 window.open,只允许本地 index.html 自身导航,
  // 防聊天内链接把整窗导航到外部并把 preload 桥暴露给远程页面。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) e.preventDefault();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.on("entrotect:op", (_event, raw: unknown) => {
  const parsed = opSchema.safeParse(raw);
  if (!parsed.success) {
    host?.emit({ type: "error", message: `非法操作: ${parsed.error.message}` });
    return;
  }
  void host?.handleOp(parsed.data as Op);
});

ipcMain.handle("entrotect:choose-folder", async () => {
  const options = {
    properties: ["openDirectory" as const],
    title: "选择工作目录",
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// 主题切换:同步 titleBarOverlay 颜色,否则标题栏与内容区色差突兀
ipcMain.handle("entrotect:set-theme", (_event, theme: unknown) => {
  if (!mainWindow) return;
  const light = theme === "light";
  mainWindow.setTitleBarOverlay({
    color: light ? "#f7f5f1" : "#0d0d10",
    symbolColor: light ? "#55514a" : "#8f8f9d",
    height: 40,
  });
});

ipcMain.handle("entrotect:set-accent-color", (_event, raw: unknown) => {
  if (typeof raw !== "string" || !mainWindow) return;
  try {
    mainWindow.setIcon(createAccentWindowIcon(raw));
  } catch {
    // A native icon failure must not affect renderer appearance state.
  }
});

ipcMain.handle("entrotect:list-skills", async () => {
  try {
    return await discoverSkills();
  } catch {
    return [];
  }
});

// 单实例:重复启动聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    host = new SessionHost({
      appDataDir: app.getPath("userData"),
      getWindow: () => mainWindow,
    });
    await host.init();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

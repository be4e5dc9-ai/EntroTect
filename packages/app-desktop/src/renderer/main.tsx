// =====================================================================
// 渲染进程入口:主题先于渲染应用,避免闪烁;字体 + 样式
// =====================================================================

import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@entrotect/shared/tokens/motion.css";
import "./styles/base.css";
import "./styles/app.css";
import { App } from "./App";
import {
  applyAccentColor,
  applyTheme,
  readStoredAccentColor,
  readStoredTheme,
} from "./appearance";
import { bridge } from "./bridge";
import { applyEvent, useStore } from "./store";

// 主题首帧生效:读 localStorage 直接落在 <html data-theme>
const savedTheme = readStoredTheme();
const savedAccentColor = readStoredAccentColor();
applyTheme(savedTheme, savedAccentColor);
useStore.setState({ theme: savedTheme, accentColor: savedAccentColor });
bridge().setTheme(savedTheme);
bridge().setAccentColor(savedAccentColor);

// 调试句柄:E2E 探针与诊断用(只读访问 store/applyEvent)
(window as unknown as Record<string, unknown>).__entrotectDebug = { useStore, applyEvent };

createRoot(document.getElementById("root")!).render(<App />);

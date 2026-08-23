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
import { bridge } from "./bridge";
import { useStore, type Theme } from "./store";

// 主题首帧生效:读 localStorage 直接落在 <html data-theme>
const savedTheme = (localStorage.getItem("entrotect-theme") ?? "dark") as Theme;
document.documentElement.dataset.theme = savedTheme;
useStore.setState({ theme: savedTheme });
bridge().setTheme(savedTheme);

createRoot(document.getElementById("root")!).render(<App />);

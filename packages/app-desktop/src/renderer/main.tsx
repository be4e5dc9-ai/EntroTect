// =====================================================================
// 渲染进程入口:字体 + 样式(Python 烘焙的 motion tokens + 设计基座)
// =====================================================================

import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "highlight.js/styles/github-dark.css";
import "@entrotect/shared/tokens/motion.css";
import "./styles/base.css";
import "./styles/app.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);

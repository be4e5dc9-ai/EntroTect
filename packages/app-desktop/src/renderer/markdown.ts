// =====================================================================
// Markdown 渲染(markdown-it + highlight.js 按需注册语言)
// html:false 防注入;hljs 只打包常用语言,控制包体与启动速度。
// =====================================================================

import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = {
  bash, cpp, csharp, css, go, java, javascript, json, markdown, plaintext,
  powershell, python, rust, sql, typescript, xml, yaml,
};
for (const [name, grammar] of Object.entries(languages)) {
  hljs.registerLanguage(name, grammar);
}
// 别名
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["ps1", "pwsh", "shell"], { languageName: "powershell" });
hljs.registerAliases(["sh", "zsh"], { languageName: "bash" });

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

md.set({
  highlight: (code: string, lang: string): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        // 降级:纯文本输出
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

export function renderMarkdown(text: string): string {
  return md.render(text);
}

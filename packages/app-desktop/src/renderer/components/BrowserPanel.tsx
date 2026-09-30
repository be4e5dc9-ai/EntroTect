import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BrowserCommand, BrowserExtraction, BrowserReply, BrowserTabState } from "@entrotect/shared";
import { bridge } from "../bridge";
import { activateBrowserTab, applyBrowserTabs, openResearchTab, pushToast, useStore } from "../store";
import "../styles/browser.css";

export function BrowserIcon(): React.JSX.Element {
  return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.3" />
    <ellipse cx="10" cy="10" rx="3.2" ry="7.2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3 10h14" stroke="currentColor" strokeWidth="1.3" />
  </svg>;
}

export function ResearchIcon(): React.JSX.Element {
  return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M3 4.5h5.5L10 6h7v10H3V4.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M6 9h8M6 12h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>;
}

/** Remote web contents render natively, outside the trusted application DOM. */
function useBrowserViewport(sessionId: string, tabId: string | null, blocked: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!tabId) return;
    const el = viewport.current;
    const update = () => {
      const modal = document.querySelector('[role="dialog"], dialog[open], .modal-backdrop');
      const rect = el?.getBoundingClientRect();
      const visible = !blocked && !modal && !document.hidden && rect && rect.width > 0 && rect.height > 0;
      bridge().browserViewport(sessionId, tabId, visible ? {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.floor(rect.width), height: Math.floor(rect.height),
      } : null);
    };
    update();
    const observer = new ResizeObserver(update);
    if (el) observer.observe(el);
    const modals = new MutationObserver(update);
    modals.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-modal", "open", "class"] });
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      modals.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
      bridge().browserViewport(sessionId, tabId, null);
    };
  }, [sessionId, tabId, blocked]);
  return viewport;
}

export function BrowserPanel({ sessionId, tabId, tab }: {
  sessionId: string; tabId: string | null; tab: BrowserTabState | undefined;
}): React.JSX.Element {
  const approval = useStore((s) => s.approval);
  const [address, setAddress] = useState(tab?.url ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tables, setTables] = useState<BrowserExtraction | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const viewport = useBrowserViewport(sessionId, tabId, pending || !!approval || !!tables || !!screenshot || !!error || !!tab?.error);

  useEffect(() => { setAddress(tab?.url ?? ""); }, [tab?.url, tabId]);

  const run = async (command: BrowserCommand): Promise<BrowserReply | null> => {
    setError(null);
    setPending(true);
    try {
      const reply = await bridge().browserCommand(sessionId, command);
      applyBrowserTabs(sessionId, reply.tabs);
      if (!reply.ok) throw new Error(reply.error ?? "浏览器操作未完成");
      if (command.action === "open" && reply.tabId) activateBrowserTab(sessionId, reply.tabId);
      return reply;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally { setPending(false); }
  };

  const navigate = (event: React.FormEvent) => {
    event.preventDefault();
    const raw = address.trim();
    if (!raw) return;
    const url = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    void run(tabId ? { action: "navigate", tabId, url } : { action: "open", url });
  };

  const save = async (selectionOnly: boolean) => {
    if (!tabId) return;
    const result = await run({ action: "extract", tabId });
    const page = result?.extraction;
    if (!page) return;
    if (selectionOnly && !page.selection.trim()) {
      pushToast("info", "请先在网页中选中要摘录的文字。");
      return;
    }
    setPending(true);
    try {
      const reply = await bridge().researchCommand({ action: "save", sessionId, source: {
        title: page.title || page.url, url: page.url,
        ...(page.author ? { authors: [page.author] } : {}),
        ...(page.doi ? { doi: page.doi } : {}),
        ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
        excerpt: selectionOnly ? page.selection : page.text,
      } });
      if (reply.error) throw new Error(reply.error);
      pushToast("info", selectionOnly ? "选中文字已保存到本会话资料库。" : "网页来源与正文摘录已保存到本会话资料库。");
    } catch (cause) { pushToast("error", cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };

  const exportTable = async (index: number) => {
    const table = tables?.tables[index];
    if (!table || !tables) return;
    setPending(true);
    try {
      const reply = await bridge().researchCommand({ action: "export_table", sessionId,
        rows: table.rows, title: table.caption || `${tables.title}-表格${index + 1}`, sourceUrl: tables.url });
      if (reply.error) throw new Error(reply.error);
      if (reply.exportedPath) pushToast("info", `表格已导出，可用 Excel 打开：${reply.exportedPath}`);
    } catch (cause) { pushToast("error", cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };

  return <section className="browser-panel" aria-label="内置浏览器">
    <form className="browser-navigation" onSubmit={navigate}>
      <button type="button" className="browser-icon-button" title="后退" aria-label="后退" disabled={pending || !tab?.canGoBack} onClick={() => tabId && void run({ action: "back", tabId })}>←</button>
      <button type="button" className="browser-icon-button" title="前进" aria-label="前进" disabled={pending || !tab?.canGoForward} onClick={() => tabId && void run({ action: "forward", tabId })}>→</button>
      <button type="button" className={`browser-icon-button${tab?.loading ? " is-loading" : ""}`} title="刷新" aria-label="刷新" disabled={pending || !tabId} onClick={() => tabId && void run({ action: "reload", tabId })}>↻</button>
      <input aria-label="网页地址" className="browser-address" placeholder="输入网址" value={address} onChange={(event) => setAddress(event.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      <button type="submit" className="browser-go" disabled={pending || !address.trim()}>打开</button>
    </form>
    {tabId && <div className="browser-tools" aria-label="网页资料工具">
      <button type="button" disabled={pending || !!tab?.loading} onClick={() => void save(false)}>收藏来源</button>
      <button type="button" disabled={pending || !!tab?.loading} onClick={() => void save(true)}>摘录选区</button>
      <button type="button" disabled={pending || !!tab?.loading} onClick={async () => {
        const reply = await run({ action: "extract", tabId });
        if (reply?.extraction) setTables(reply.extraction);
      }}>网页表格</button>
      <button type="button" disabled={pending} onClick={async () => {
        const reply = await run({ action: "screenshot", tabId });
        if (reply?.screenshot) setScreenshot(reply.screenshot.dataUrl);
      }}>截图</button>
      <button type="button" onClick={openResearchTab} title="打开资料库" aria-label="打开资料库"><ResearchIcon /></button>
    </div>}
    <div className={`browser-progress${pending || tab?.loading ? " is-active" : ""}`} role="status" aria-label={pending || tab?.loading ? "网页操作中" : "网页已就绪"} />
    <div className="browser-viewport" ref={viewport}>
      {!tabId && <div className="browser-welcome">
        <div className="browser-welcome-icon"><BrowserIcon /></div>
        <h2>浏览、摘录，留住来源</h2>
        <p>打开课程资料、论文或工作网页。收藏来源和选中文字，提取表格，继续在对话中整理。</p>
        <span>浏览器使用独立登录会话，不读取系统浏览器数据。</span>
      </div>}
      {(error || tab?.error) && <div className="browser-error" role="alert"><strong>页面操作未完成</strong><p>{error || tab?.error}</p><button type="button" onClick={() => { setError(null); if (tabId) void run({ action: "reload", tabId }); }}>重试</button></div>}
      {approval && !tables && !screenshot && <div className="browser-paused">等待操作审批，网页暂时隐藏。</div>}
      {tables && <div className="browser-extraction">
        <header><div><strong>网页表格</strong><span>{tables.tables.length} 张 · {tables.title}</span></div><button type="button" className="browser-icon-button" onClick={() => setTables(null)} aria-label="返回网页">×</button></header>
        {!tables.tables.length && <div className="browser-empty-extraction">这个页面没有可提取的 HTML 表格。图片和 PDF 中的表格暂不支持。</div>}
        {tables.tables.map((table, index) => <article className="browser-table-card" key={index}>
          <div className="browser-table-heading"><strong>{table.caption || `表格 ${index + 1}`}</strong><button type="button" disabled={pending} onClick={() => void exportTable(index)}>导出 CSV</button></div>
          <span>{table.rows.length} 行{table.truncated ? " · 内容已截断，请核对原网页" : ""}</span>
          <div className="browser-table-preview"><table><tbody>{table.rows.slice(0, 5).map((row, rowIndex) => <tr key={rowIndex}>{row.slice(0, 6).map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>
          {table.rows.length > 5 && <small>仅预览前 5 行，导出包含所有已提取行。</small>}
        </article>)}
      </div>}
      {screenshot && <div className="browser-extraction"><header><strong>网页截图</strong><button type="button" className="browser-icon-button" onClick={() => setScreenshot(null)} aria-label="返回网页">×</button></header><img className="browser-screenshot" src={screenshot} alt="当前网页截图" /></div>}
    </div>
    <footer className="browser-status"><span>{tabId ? "独立浏览会话" : "支持 HTTP / HTTPS 网页"}</span><span>{tab?.loading ? "加载中…" : tabId ? "已就绪" : "输入网址开始"}</span></footer>
  </section>;
}

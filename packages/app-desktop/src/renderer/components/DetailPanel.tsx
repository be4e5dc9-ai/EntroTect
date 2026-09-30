// =====================================================================
// 右侧详情栏(浏览器式):标签页条 + 路径信息行 + 内容区。
// 打开的文件与子代理窗口都是标签页(可多个、点切换、× 关闭);
// 路径信息行显示当前页地址(file://<path> 或 subagent://<标题>);
// 左缘手柄可拖拽调宽(pointer capture,localStorage 持久化)。
// =====================================================================

import { useMemo } from "react";
import {
  activateDetailTab,
  closeDetailTab,
  openBrowserTab,
  openResearchTab,
  useComposerPrompt,
  useStore,
  type DetailTab,
  type UiMessage,
  type UiToolBlock,
} from "../store";
import { fileName } from "./FileCard";
import { SubagentChat } from "./SubagentChat";
import { BrowserIcon, BrowserPanel, ResearchIcon } from "./BrowserPanel";
import { ResearchLibrary } from "./ResearchLibrary";
import { bridge } from "../bridge";

const RESIZE_MAX = 640;
const RESIZE_MIN = 320;

/** 在全部消息里定位 task 工具卡片 */
function findTaskBlock(messages: UiMessage[], toolCallId: string): UiToolBlock | undefined {
  for (const message of messages) {
    const block = message.blocks.find(
      (b): b is UiToolBlock => b.kind === "tool-call" && b.id === toolCallId,
    );
    if (block) return block;
  }
  return undefined;
}

/** 子代理标签标题:task 卡 args.prompt 前 12 字(缺省回落 preview) */
function subagentTitle(block: UiToolBlock | undefined): string {
  const prompt = (block?.args as { prompt?: unknown } | null)?.prompt;
  const text =
    typeof prompt === "string" && prompt.length > 0
      ? prompt
      : block?.preview ?? "子代理任务";
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

function FileIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M3.2 1.8h4.4l3.2 3.2v7.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M7.6 1.8v3.2h3.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function SubagentIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.6" cy="5" r="0.85" fill="currentColor" />
      <circle cx="8.4" cy="5" r="0.85" fill="currentColor" />
      <path
        d="M4.4 8.2c.6.55 1.3.85 2.1.85s1.5-.3 2.1-.85"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FileDetailBody({ path }: { path: string }): React.JSX.Element {
  const content = useStore((s) => s.fileContents[path]);

  if (content === undefined) {
    return <div className="detail-loading">读取中…</div>;
  }
  if (content === null) {
    return <div className="detail-error">读取失败:文件不存在或无法访问</div>;
  }
  const lines = content.replace(/\n$/, "").split("\n");
  return (
    <div className="file-view">
      {lines.map((line, index) => (
        <div className="file-line" key={index}>
          <span className="file-num">{index + 1}</span>
          <span className="file-code">{line.length > 0 ? line : "\u00A0"}</span>
        </div>
      ))}
    </div>
  );
}

interface DetailPanelProps {
  width: number;
  onWidthChange: (width: number) => void;
}

export function DetailPanel({ width, onWidthChange }: DetailPanelProps): React.JSX.Element {
  const tabs = useStore((s) => s.detailTabs);
  const activeDetailId = useStore((s) => s.activeDetailId);
  const messages = useStore((s) => s.messages);
  const sessionId = useStore((s) => s.currentSession?.id);
  const browserTabs = useStore((s) => sessionId ? s.browserTabs[sessionId] : undefined);
  const active = tabs.find((tab) => tab.id === activeDetailId) ?? null;

  const taskBlockOf = useMemo(
    () => (toolCallId: string) => findTaskBlock(messages, toolCallId),
    [messages],
  );

  const tabTitle = (tab: DetailTab): string => {
    if (tab.kind === "file") return fileName(tab.path);
    if (tab.kind === "subagent") return subagentTitle(taskBlockOf(tab.toolCallId));
    if (tab.kind === "research") return "资料库";
    return browserTabs?.find((item) => item.id === tab.tabId)?.title || "新网页";
  };

  const address = (tab: DetailTab): string =>
    tab.kind === "file" ? `file://${tab.path}`
      : tab.kind === "subagent" ? `subagent://${tabTitle(tab)}`
      : tab.kind === "research" ? "本会话的来源、笔记与工作模板"
      : browserTabs?.find((item) => item.id === tab.tabId)?.url ?? "";

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = width;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const next = Math.min(
        RESIZE_MAX,
        Math.max(RESIZE_MIN, startWidth + startX - ev.clientX),
      );
      onWidthChange(next);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  return (
    <aside id="detail-panel" className="detail-panel" style={{ width }} aria-label="详情栏">
      <div className="detail-head">
        <div className="detail-tabs" role="tablist">
          {tabs.length === 0 && <span className="detail-empty-title">详情</span>}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`detail-tab${tab.id === active?.id ? " active" : ""}`}
              onClick={() => activateDetailTab(tab.id)}
              role="tab"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activateDetailTab(tab.id); }
              }}
              aria-selected={tab.id === active?.id}
              title={tab.kind === "file" ? tab.path : tabTitle(tab)}
            >
              <span className="detail-tab-icon">
                {tab.kind === "file" ? <FileIcon /> : tab.kind === "subagent" ? <SubagentIcon /> : tab.kind === "browser" ? <BrowserIcon /> : <ResearchIcon />}
              </span>
              <span className="detail-tab-title">{tabTitle(tab)}</span>
              <button
                className="detail-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeDetailTab(tab.id);
                }}
                aria-label="关闭标签页"
              >
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
                  <path d="M1.5 1.5l6 6M7.5 1.5l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="browser-icon-button detail-browser-add" onClick={openBrowserTab} disabled={!sessionId} title="新网页" aria-label="新网页">+</button>
      </div>
      {active && active.kind !== "browser" && <div className="detail-meta">
        <span className={`detail-meta-dot${active.kind === "subagent" ? " subagent" : ""}`} aria-hidden="true" />
        <span className="detail-meta-text" title={address(active)}>
          {address(active)}
        </span>
        <button
          type="button"
          className="detail-close"
          onClick={() => closeDetailTab(active.id)}
          aria-label="关闭当前页"
          title="关闭当前页"
        >
          <svg width="10" height="10" viewBox="0 0 9 9" fill="none" aria-hidden="true">
            <path d="M1.5 1.5l6 6M7.5 1.5l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>}
      <div className="detail-body">
        {!active ? (
          <div className="detail-empty">
            <FileIcon />
            <p>文件、网页与资料，在一处继续</p>
            <span>点击对话中的文件或子代理卡片，也可以打开浏览器收集来源。</span>
            <div className="workspace-tools">
              <button type="button" onClick={openBrowserTab} disabled={!sessionId}><BrowserIcon />浏览网页</button>
              <button type="button" onClick={openResearchTab} disabled={!sessionId}><ResearchIcon />资料库</button>
            </div>
          </div>
        ) : active.kind === "file" ? (
          <FileDetailBody path={active.path} />
        ) : active.kind === "subagent" ? (
          <SubagentChat toolCallId={active.toolCallId} />
        ) : active.kind === "browser" && sessionId ? (
          <BrowserPanel key={active.id} sessionId={sessionId} tabId={active.tabId} tab={browserTabs?.find((tab) => tab.id === active.tabId)} />
        ) : active.kind === "research" && sessionId ? (
          <ResearchLibrary key={sessionId} sessionId={sessionId} request={(command) => bridge().researchCommand(command)} onUsePrompt={useComposerPrompt} />
        ) : null}
      </div>
      <div className="detail-resizer" onPointerDown={startResize} />
    </aside>
  );
}

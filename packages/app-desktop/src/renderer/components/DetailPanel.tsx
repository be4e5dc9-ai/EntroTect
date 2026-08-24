// =====================================================================
// 右侧详情栏(浏览器式):标签页条 + 地址栏 + 内容区。
// 打开的文件与子代理窗口都是标签页(可多个、点切换、× 关闭);
// 地址栏显示当前页地址(file://<path> 或 subagent://<标题>);
// 左缘手柄可拖拽调宽(pointer capture,localStorage 持久化)。
// =====================================================================

import { useMemo } from "react";
import {
  activateDetailTab,
  closeDetailTab,
  useStore,
  type DetailTab,
  type UiMessage,
  type UiToolBlock,
} from "../store";
import { fileName } from "./FileCard";
import { SubagentChat } from "./SubagentChat";
import { PanelCollapseIcon } from "./Sidebar";

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
  onCollapse: () => void;
}

export function DetailPanel({ width, onWidthChange, onCollapse }: DetailPanelProps): React.JSX.Element | null {
  const tabs = useStore((s) => s.detailTabs);
  const activeDetailId = useStore((s) => s.activeDetailId);
  const messages = useStore((s) => s.messages);
  const active = tabs.find((tab) => tab.id === activeDetailId) ?? null;
  if (!active) return null;

  const taskBlockOf = useMemo(
    () => (toolCallId: string) => findTaskBlock(messages, toolCallId),
    [messages],
  );

  const tabTitle = (tab: DetailTab): string =>
    tab.kind === "file"
      ? fileName(tab.path)
      : subagentTitle(taskBlockOf(tab.toolCallId));

  const address = (tab: DetailTab): string =>
    tab.kind === "file"
      ? `file://${tab.path}`
      : `subagent://${tabTitle(tab)}`;

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
    <aside className="detail-panel" style={{ width }}>
      <div className="detail-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`detail-tab${tab.id === active.id ? " active" : ""}`}
            onClick={() => activateDetailTab(tab.id)}
            role="tab"
            aria-selected={tab.id === active.id}
            title={tab.kind === "file" ? tab.path : tabTitle(tab)}
          >
            <span className="detail-tab-icon">
              {tab.kind === "file" ? <FileIcon /> : <SubagentIcon />}
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
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="detail-address">
        <span className={`detail-address-dot${active.kind === "subagent" ? " subagent" : ""}`} aria-hidden="true" />
        <span className="detail-address-text" title={address(active)}>
          {address(active)}
        </span>
        <button
          type="button"
          className="detail-panel-collapse"
          onClick={onCollapse}
          aria-label="Collapse details"
          title="Collapse details"
        >
          <PanelCollapseIcon direction="right" />
        </button>
        <button
          type="button"
          className="detail-close"
          onClick={() => closeDetailTab(active.id)}
          aria-label="关闭当前页"
          title="关闭当前页"
        >
          ×
        </button>
      </div>
      <div className="detail-body">
        {active.kind === "file" ? (
          <FileDetailBody path={active.path} />
        ) : (
          <SubagentChat toolCallId={active.toolCallId} />
        )}
      </div>
      <div className="detail-resizer" onPointerDown={startResize} />
    </aside>
  );
}

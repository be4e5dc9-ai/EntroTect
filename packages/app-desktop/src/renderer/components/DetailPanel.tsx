// =====================================================================
// 右侧详情栏(第三段布局):文件详情(带行号全文)与子代理详情
// (任务描述 + 实时活动日志 + 最终汇报)。detail 为 null 时整体隐藏。
// =====================================================================

import { useEffect, useMemo, useRef } from "react";
import { useStore, type UiMessage, type UiToolBlock } from "../store";
import { fileName } from "./FileCard";
import { STATE_LABEL } from "./ToolCard";

function closeDetail(): void {
  useStore.setState({ detail: null });
}

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

function FileDetailPanel({ path }: { path: string }): React.JSX.Element {
  const content = useStore((s) => s.fileContents[path]);

  let body: React.JSX.Element;
  if (content === undefined) {
    body = <div className="detail-loading">读取中…</div>;
  } else if (content === null) {
    body = <div className="detail-error">读取失败:文件不存在或无法访问</div>;
  } else {
    const lines = content.replace(/\n$/, "").split("\n");
    body = (
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

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div className="detail-head-main">
          <span className="detail-file-name">{fileName(path)}</span>
          <span className="detail-file-path">{path}</span>
        </div>
        <button className="detail-close" onClick={closeDetail} aria-label="关闭详情">
          ×
        </button>
      </div>
      <div className="detail-body">{body}</div>
    </aside>
  );
}

function SubagentDetailPanel({ toolCallId }: { toolCallId: string }): React.JSX.Element {
  const messages = useStore((s) => s.messages);
  const block = useMemo(() => findTaskBlock(messages, toolCallId), [messages, toolCallId]);
  const logRef = useRef<HTMLPreElement>(null);

  // 活动日志实时滚动:新行追加时贴底
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [block?.log]);

  const body = block ? (
    <div className="detail-body subagent-body">
      <section className="subagent-section">
        <h3 className="subagent-section-title">任务描述</h3>
        <p className="subagent-desc">{block.preview}</p>
      </section>
      <section className="subagent-section subagent-section-grow">
        <h3 className="subagent-section-title">活动日志</h3>
        <pre ref={logRef} className="subagent-log">
          {block.log ?? "(暂无活动)"}
        </pre>
      </section>
      <section className="subagent-section">
        <h3 className="subagent-section-title">最终汇报</h3>
        <pre className="subagent-report">{block.summary ?? "(暂无汇报)"}</pre>
      </section>
    </div>
  ) : (
    <div className="detail-body">
      <div className="detail-loading">任务已结束</div>
    </div>
  );

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div className="detail-head-main">
          <span className="detail-title">子代理</span>
          {block && (
            <span className={`tool-state-label state-${block.state}`}>
              {block.state === "executing" && <span className="spin" aria-hidden="true" />}
              {STATE_LABEL[block.state]}
            </span>
          )}
        </div>
        <button className="detail-close" onClick={closeDetail} aria-label="关闭详情">
          ×
        </button>
      </div>
      {body}
    </aside>
  );
}

export function DetailPanel(): React.JSX.Element | null {
  const detail = useStore((s) => s.detail);
  if (!detail) return null;
  if (detail.kind === "file") return <FileDetailPanel path={detail.path} />;
  return <SubagentDetailPanel toolCallId={detail.toolCallId} />;
}

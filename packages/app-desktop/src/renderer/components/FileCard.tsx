// =====================================================================
// 文件产出卡片:紧跟工具卡片之后,展示本轮 write/edit 产出的文件
// 点击 → 打开右侧详情栏(ReadFile 拉取内容,有缓存则不重发)。
// =====================================================================

import { useStore, type UiFileBlock } from "../store";
import { bridge } from "../bridge";

function FileIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M3.2 1.8h4.4l3.2 3.2v7.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path d="M7.6 1.8v3.2h3.2" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/** 取 path 末尾一段作为展示文件名 */
export function fileName(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

export function FileCard({ block }: { block: UiFileBlock }): React.JSX.Element {
  const open = (): void => {
    useStore.setState({ detail: { kind: "file", path: block.path } });
    const cached = useStore.getState().fileContents[block.path];
    if (cached === undefined) {
      bridge().send({ kind: "ReadFile", path: block.path });
    }
  };

  return (
    <button className="file-card" onClick={open} aria-label={`查看文件 ${block.path}`}>
      <span className="file-card-icon">
        <FileIcon />
      </span>
      <span className="file-card-name">{fileName(block.path)}</span>
      <span className={`file-card-badge file-badge-${block.action}`}>
        {block.action === "edited" ? "修改" : "写入"}
      </span>
      <span className="file-card-path">{block.path}</span>
    </button>
  );
}

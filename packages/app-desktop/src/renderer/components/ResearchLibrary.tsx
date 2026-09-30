import { useEffect, useRef, useState } from "react";
import type { ResearchCommand, ResearchReply, ResearchSource, ResearchSourceInput } from "@entrotect/shared";
import "../styles/research.css";

interface Props {
  sessionId: string;
  request: (command: ResearchCommand) => Promise<ResearchReply>;
  onUsePrompt: (prompt: string) => void;
}

interface Draft {
  title: string; url: string; authors: string; publishedAt: string; doi: string;
  excerpt: string; note: string; tags: string;
}
const emptyDraft = (): Draft => ({ title: "", url: "", authors: "", publishedAt: "", doi: "", excerpt: "", note: "", tags: "" });
const toDraft = (source: ResearchSource): Draft => ({
  title: source.title, url: source.url, authors: source.authors.join("; "),
  publishedAt: source.publishedAt, doi: source.doi, excerpt: source.excerpt,
  note: source.note, tags: source.tags.join(", "),
});
const toInput = (draft: Draft): ResearchSourceInput => ({ ...draft, authors: draft.authors.split(/[;；]/).map((value) => value.trim()).filter(Boolean), tags: draft.tags.split(/[,，]/).map((value) => value.trim()).filter(Boolean) });

export function ResearchLibrary({ sessionId, request, onUsePrompt }: Props): React.JSX.Element {
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setSources([]); setSelection(new Set()); setEditingId(null); setAdding(false);
    setMessage(""); setError(""); setFilter(""); setBusy(true);
    void requestRef.current({ action: "list", sessionId }).then((reply) => {
      if (current !== generation.current) return;
      if (reply.error) setError(reply.error);
      else setSources(reply.sources ?? []);
    }).catch((cause: unknown) => {
      if (current === generation.current) setError(String(cause));
    }).finally(() => { if (current === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [sessionId]);

  async function perform(command: ResearchCommand): Promise<ResearchReply | undefined> {
    const current = generation.current;
    setBusy(true); setError(""); setMessage("");
    try {
      const reply = await requestRef.current(command);
      if (current !== generation.current) return;
      if (reply.error) { setError(reply.error); return; }
      if (reply.sources) {
        setSources(reply.sources);
        setSelection((old) => new Set([...old].filter((id) => reply.sources!.some((source) => source.id === id))));
      }
      return reply;
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  }

  function edit(source: ResearchSource): void {
    setAdding(false); setEditingId(source.id); setDraft(toDraft(source)); setRemoveConfirm(false); setError(""); setMessage("");
  }
  async function save(): Promise<void> {
    const reply = await perform(editingId
      ? { action: "update", sessionId, id: editingId, patch: toInput(draft) }
      : { action: "save", sessionId, source: toInput(draft) });
    if (reply?.source) { edit(reply.source); setMessage("资料已保存"); }
  }
  async function remove(): Promise<void> {
    if (!editingId) return;
    if (!removeConfirm) { setRemoveConfirm(true); return; }
    const reply = await perform({ action: "remove", sessionId, id: editingId });
    if (reply) { setEditingId(null); setRemoveConfirm(false); setMessage("已删除这条资料"); }
  }
  async function exportSources(format: "markdown" | "bibtex"): Promise<void> {
    const reply = await perform({ action: "export", sessionId, format, sourceIds: [...selection] });
    if (reply) setMessage(reply.canceled ? "已取消导出" : reply.exportedPath ? `已导出：${reply.exportedPath}` : "导出内容已生成");
  }
  async function useTemplate(template: "report" | "study" | "meeting"): Promise<void> {
    const reply = await perform({ action: "prompt", sessionId, template, sourceIds: [...selection] });
    if (reply?.prompt) { onUsePrompt(reply.prompt); setMessage("已放入输入框，可补充需求后发送"); }
  }
  function field(key: keyof Draft, value: string): void { setDraft((old) => ({ ...old, [key]: value })); }
  const visible = sources.filter((source) => `${source.title} ${source.url} ${source.tags.join(" ")} ${source.note}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));

  return (
    <section className="research-library" aria-label="资料与笔记" aria-busy={busy}>
      <div className="research-heading">
        <div><h3>资料与笔记</h3><p>为这段对话保留来源、摘录和想法</p></div>
        <button disabled={busy} onClick={() => { setAdding(true); setEditingId(null); setDraft(emptyDraft()); setRemoveConfirm(false); }}>添加</button>
      </div>
      <div className="research-search-row">
        <input type="search" aria-label="搜索资料" placeholder="搜索标题、标签或笔记…" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <button disabled={busy} aria-label="刷新资料库" title="刷新资料库" onClick={() => { void perform({ action: "list", sessionId }); }}>↻</button>
      </div>
      {error && <p className="research-error" role="alert">{error}</p>}
      {message && <p className="research-notice" role="status">{message}</p>}
      {!sources.length && !busy && !error && <div className="research-empty">资料库还是空的<p>在内置浏览器中收藏网页或选中摘录，也可以手动添加资料。保存仅发生在本机。</p></div>}
      {!!sources.length && <div className="research-selection">
        <label><input type="checkbox" disabled={busy} checked={selection.size === sources.length} onChange={(event) => setSelection(event.target.checked ? new Set(sources.map((source) => source.id)) : new Set())} />全选</label>
        <span>已选 {selection.size} / {sources.length}</span>
      </div>}
      <div className="research-source-list">
        {visible.map((source) => <div className={`research-source${editingId === source.id ? " selected" : ""}`} key={source.id}>
          <input type="checkbox" aria-label={`选择 ${source.title}`} checked={selection.has(source.id)} disabled={busy} onChange={(event) => setSelection((old) => { const next = new Set(old); if (event.target.checked) next.add(source.id); else next.delete(source.id); return next; })} />
          <button className="research-source-open" disabled={busy} onClick={() => edit(source)}>
            <strong>{source.title}</strong><small>{new URL(source.url).hostname}</small>
            {source.tags.length > 0 && <span className="research-tags">{source.tags.join(" · ")}</span>}
          </button>
        </div>)}
        {!!sources.length && !visible.length && <p className="research-empty">没有匹配的资料</p>}
      </div>
      {(adding || editingId) && <form className="research-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="research-editor-heading"><h4>{adding ? "添加来源" : "编辑资料"}</h4><button type="button" disabled={busy} onClick={() => { setAdding(false); setEditingId(null); }}>收起</button></div>
        <label>标题<input required maxLength={2_000} value={draft.title} onChange={(event) => field("title", event.target.value)} /></label>
        <label>来源网址<input required type="url" maxLength={8_192} placeholder="https://…" value={draft.url} onChange={(event) => field("url", event.target.value)} /></label>
        <details><summary>作者与引用信息</summary>
          <label>作者（用分号分隔）<input value={draft.authors} onChange={(event) => field("authors", event.target.value)} /></label>
          <div className="research-field-pair"><label>发布日期<input placeholder="未提供时留空" value={draft.publishedAt} onChange={(event) => field("publishedAt", event.target.value)} /></label><label>DOI<input placeholder="10.…" value={draft.doi} onChange={(event) => field("doi", event.target.value)} /></label></div>
        </details>
        <label>原文摘录<textarea rows={4} maxLength={100_000} value={draft.excerpt} placeholder="保留原文，便于核查来源" onChange={(event) => field("excerpt", event.target.value)} /></label>
        <label>我的笔记<textarea rows={4} maxLength={100_000} value={draft.note} placeholder="想法、疑问、课程或会议要点…" onChange={(event) => field("note", event.target.value)} /></label>
        <label>标签（用逗号分隔）<input value={draft.tags} placeholder="课程, 调研, 项目" onChange={(event) => field("tags", event.target.value)} /></label>
        <div className="research-editor-actions"><button type="submit" className="research-primary" disabled={busy}>{busy ? "处理中…" : "保存资料"}</button>{editingId && <button type="button" className="research-delete" disabled={busy} onClick={() => { void remove(); }}>{removeConfirm ? "确认删除？" : "删除"}</button>}</div>
      </form>}
      <div className="research-actions">
        <h4>使用选中的资料</h4>
        <p>模板会放入对话输入框；不会自动发送或编造引用。</p>
        <div><button disabled={busy || !selection.size} onClick={() => { void useTemplate("report"); }}>调研简报</button><button disabled={busy || !selection.size} onClick={() => { void useTemplate("study"); }}>学习指南</button><button disabled={busy || !selection.size} onClick={() => { void useTemplate("meeting"); }}>会议准备</button></div>
        <div><button disabled={busy || !selection.size} onClick={() => { void exportSources("markdown"); }}>导出笔记 .md</button><button disabled={busy || !selection.size} onClick={() => { void exportSources("bibtex"); }}>导出引用 .bib</button></div>
      </div>
    </section>
  );
}

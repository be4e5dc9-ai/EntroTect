const elementHelpers = String.raw`
  const clean = (s,n=300) => String(s || '').replace(/\s+/g,' ').trim().slice(0,n);
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.visibility !== 'collapse' && s.display !== 'none'; };
  const name = el => clean(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)?.textContent || '').join(' ') || Array.from(el.labels || []).map(x=>x.textContent).join(' ') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name'));
  const sensitive = el => el.tagName === 'INPUT' && (['password','file','hidden'].includes(el.type) || /(?:^|\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:\s|$)/i.test(el.getAttribute('autocomplete') || ''));
  const signature = el => JSON.stringify([el.tagName,el.getAttribute('role'),name(el),el.getAttribute('href'),el.getAttribute('type'),el.getAttribute('autocomplete')]);
`;

/** Scripts run in an Electron isolated world: page JavaScript cannot rewrite our ref map. */
export function snapshotScript(generation: string): string {
  return `(() => {
    const generation = ${JSON.stringify(generation)};
    let state = globalThis.__entrotectBrowserRefs;
    if (!state || state.generation !== generation) state = globalThis.__entrotectBrowserRefs = {generation, nodes:new Map(), ids:new WeakMap(), next:1};
    ${elementHelpers}
    const selector = 'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"],summary';
    const all = Array.from(document.querySelectorAll(selector)).filter(visible);
    const elements = all.slice(0,250).map(el => {
      let ref = state.ids.get(el);
      if (!ref) { ref = generation + ':' + state.next++; state.ids.set(el,ref); }
      state.nodes.set(ref,{element:el,signature:signature(el)});
      const role = el.getAttribute('role') || ({A:'link',BUTTON:'button',TEXTAREA:'textbox',SELECT:'combobox',SUMMARY:'button'}[el.tagName]) || (el.tagName === 'INPUT' ? (['checkbox','radio'].includes(el.type) ? el.type : 'textbox') : 'textbox');
      const item = {ref,role,name:name(el)};
      if ('value' in el && !sensitive(el)) item.value = clean(el.value,300);
      if (el.tagName === 'A') item.href = el.href;
      return item;
    });
    for (const [ref,entry] of state.nodes) if (!entry.element.isConnected) state.nodes.delete(ref);
    const full = (document.querySelector('main') || document.querySelector('article') || document.body)?.innerText || '';
    const frames = document.querySelectorAll('iframe').length;
    return {title:document.title,url:location.href,text:full.slice(0,24000) + (frames ? '\\n[页面包含 '+frames+' 个子框架；快照仅包含主文档。]' : ''),elements,truncated:full.length > 24000 || all.length > 250};
  })()`;
}

export function interactionScript(action: "click" | "type", ref: string, text?: string): string {
  return `(() => {
    const state = globalThis.__entrotectBrowserRefs;
    const ref = ${JSON.stringify(ref)};
    const entry = state?.nodes.get(ref);
    const el = entry?.element;
    if (!el || !el.isConnected) throw new Error('元素引用已失效，请重新获取 browser_snapshot。');
    ${elementHelpers}
    if (entry.signature !== signature(el)) throw new Error('元素内容已经变化，请重新获取 browser_snapshot。');
    if (!visible(el)) throw new Error('元素当前不可见，请重新获取快照。');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('该元素已禁用。');
    if (sensitive(el)) throw new Error('文件上传、密码或敏感凭据输入需要用户手动操作，目前不向模型开放。');
    el.scrollIntoView({block:'center',inline:'nearest'});
    ${action === "click" ? "el.click();" : `
      const text = ${JSON.stringify(text ?? "")};
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.readOnly) throw new Error('该输入框为只读。');
        el.focus();
        const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text);
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
      } else if (el.isContentEditable) {
        el.focus(); el.textContent = text; el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      } else throw new Error('此元素不是可输入文本框。');
    `}
    return true;
  })()`;
}

/** Native keyboard events must not bypass the restrictions on click/type. */
export const pressGuardScript = `(() => {
  ${elementHelpers}
  const el = document.activeElement;
  if (el && sensitive(el)) throw new Error('密码、文件或敏感凭据控件需要用户手动操作，目前不向模型开放。');
  return true;
})()`;

export const extractionScript = `(() => {
  const meta = (...names) => { for (const name of names) { const el = document.querySelector('meta[name="'+name+'"],meta[property="'+name+'"]'); if (el?.content) return el.content.slice(0,2000); } return ''; };
  const full = (document.querySelector('article') || document.querySelector('main') || document.body)?.innerText || '';
  const tables = [];
  const tableNodes = document.querySelectorAll('table');
  let totalTableBudget = 1000000;
  for (let t = 0; t < Math.min(tableNodes.length,10); t++) {
    const table = tableNodes[t];
    // Cache live collections and their lengths; repeatedly materializing them can be quadratic.
    const rowNodes = table.rows;
    const rowCount = rowNodes.length;
    const rows = [];
    let tableBudget = 200000;
    let truncated = rowCount > 201;
    for (let r = 0; r < Math.min(rowCount,201); r++) {
      if (tableBudget <= 0 || totalTableBudget <= 0) { truncated = true; break; }
      const cellNodes = rowNodes[r].cells;
      const cellCount = cellNodes.length;
      if (cellCount > 40) truncated = true;
      const cells = [];
      for (let c = 0; c < Math.min(cellCount,40); c++) {
        const limit = Math.min(4000,tableBudget,totalTableBudget);
        if (limit <= 0) { truncated = true; break; }
        const raw = (cellNodes[c].innerText || '').trim();
        const value = raw.slice(0,limit);
        if (value.length < raw.length) truncated = true;
        cells.push(value);
        tableBudget -= value.length;
        totalTableBudget -= value.length;
      }
      rows.push(cells);
    }
    const caption = table.caption?.innerText || '';
    tables.push({caption:caption.slice(0,300),rows,truncated:truncated || caption.length > 300});
  }
  const doi = meta('citation_doi','dc.Identifier','DC.Identifier') || (full.match(/10\\.\\d{4,9}\\/[-._;()/:A-Z0-9]+/i)?.[0] || '');
  const selection = getSelection();
  return {title:meta('citation_title','og:title') || document.title,url:location.href,
    author:meta('citation_author','author','dc.creator'),publishedAt:meta('citation_publication_date','article:published_time','date'),doi,
    selection:selection && !selection.isCollapsed ? selection.toString().slice(0,20000) : '',text:full.slice(0,60000),tables,extractedAt:new Date().toISOString()};
})()`;

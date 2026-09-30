// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserExtraction, BrowserSnapshot } from "@entrotect/shared";
import { extractionScript, interactionScript, pressGuardScript, snapshotScript } from "../../app-desktop/src/main/browser/scripts.js";

const innerTextDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
  document.head.innerHTML = "<title>Fixture</title>";
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).__entrotectBrowserRefs;
  // jsdom has no layout/innerText; supply these browser primitives while running the actual generated scripts.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 100, height: 30, top: 0, right: 100, bottom: 30, left: 0, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent || ""; } });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (innerTextDescriptor) Object.defineProperty(HTMLElement.prototype, "innerText", innerTextDescriptor);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).innerText;
  delete (globalThis as Record<string, unknown>).__entrotectBrowserRefs;
});

function snapshot(generation = "page1"): BrowserSnapshot { return window.eval(snapshotScript(generation)); }
function refFor(name: string): string {
  const element = snapshot().elements.find((item) => item.name === name);
  if (!element) throw new Error(`Missing fixture ref: ${name}`);
  return element.ref;
}

describe("browser generated DOM scripts", () => {
  it("reads accessible names, excludes hidden controls and redacts password/revealed credential values", () => {
    document.body.innerHTML = '<main>Course notes</main><label for="q">Search courses</label><input id="q" value="physics"><input type="password" aria-label="Password" value="secret-password"><input autocomplete="current-password" aria-label="Revealed password" value="still-secret"><input autocomplete="one-time-code" aria-label="OTP" value="123456"><input type="file" aria-label="Upload"><button style="display:none">Hidden</button><button aria-labelledby="label">Ignored text</button><span id="label">Submit form</span>';
    const result = snapshot();
    expect(result.text).toBe("Course notes");
    expect(result.elements.find((item) => item.name === "Search courses")).toMatchObject({ value: "physics", role: "textbox" });
    for (const name of ["Password", "Revealed password", "OTP", "Upload"]) expect(result.elements.find((item) => item.name === name)).not.toHaveProperty("value");
    expect(JSON.stringify(result)).not.toContain("secret-password");
    expect(JSON.stringify(result)).not.toContain("still-secret");
    expect(JSON.stringify(result)).not.toContain("123456");
    expect(result.elements.some((item) => item.name === "Hidden")).toBe(false);
    expect(result.elements.some((item) => item.name === "Submit form")).toBe(true);
  });

  it("keeps references stable on repeated snapshots and invalidates them on document generation changes", () => {
    document.body.innerHTML = "<button>Search</button>";
    const ref = refFor("Search");
    expect(snapshot().elements[0].ref).toBe(ref);
    expect(snapshot("page2").elements[0].ref).not.toBe(ref);
    expect(() => window.eval(interactionScript("click", ref))).toThrow("引用已失效");
  });

  it("rejects detached or semantically changed references before invoking page handlers", () => {
    document.body.innerHTML = '<a href="https://example.com/search">Search</a><button>Run</button>';
    const oldLink = refFor("Search");
    const click = vi.fn();
    const link = document.querySelector("a")!;
    link.addEventListener("click", click);
    link.href = "https://example.com/delete";
    expect(() => window.eval(interactionScript("click", oldLink))).toThrow("内容已经变化");
    expect(click).not.toHaveBeenCalled();
    const buttonRef = refFor("Run");
    document.querySelector("button")!.remove();
    expect(() => window.eval(interactionScript("click", buttonRef))).toThrow("引用已失效");
  });

  it("types text literally and sends the input/change events expected by reactive forms", () => {
    document.body.innerHTML = '<input aria-label="Query"><textarea aria-label="Notes"></textarea>';
    const input = document.querySelector("input")!;
    const inputEvent = vi.fn();
    const changeEvent = vi.fn();
    input.addEventListener("input", inputEvent);
    input.addEventListener("change", changeEvent);
    const text = 'quoted " text; globalThis.unwanted = true; \\n $()';
    expect(window.eval(interactionScript("type", refFor("Query"), text))).toBe(true);
    expect(input.value).toBe(text);
    expect(inputEvent).toHaveBeenCalledOnce();
    expect(changeEvent).toHaveBeenCalledOnce();
    expect((globalThis as Record<string, unknown>).unwanted).toBeUndefined();
    window.eval(interactionScript("type", refFor("Notes"), "Lecture summary"));
    expect(document.querySelector("textarea")!.value).toBe("Lecture summary");
  });

  it("rejects disabled, readonly, invisible and sensitive inputs", () => {
    document.body.innerHTML = '<input aria-label="Readonly" readonly><button disabled>Disabled</button><input aria-label="Secret" type="password"><input aria-label="Upload" type="file"><button>Visible</button>';
    expect(() => window.eval(interactionScript("type", refFor("Readonly"), "x"))).toThrow("只读");
    expect(() => window.eval(interactionScript("click", refFor("Disabled")))).toThrow("禁用");
    for (const name of ["Secret", "Upload"]) expect(() => window.eval(interactionScript("type", refFor(name), "x"))).toThrow("用户手动操作");
    const ref = refFor("Visible");
    document.querySelector("button:last-child")!.setAttribute("style", "visibility:hidden");
    expect(() => window.eval(interactionScript("click", ref))).toThrow("不可见");
  });

  it("prevents keyboard events from bypassing sensitive input restrictions", () => {
    document.body.innerHTML = '<input type="password"><input autocomplete="one-time-code"><input type="file"><input type="text">';
    const inputs = document.querySelectorAll("input");
    for (const input of [...inputs].slice(0, 3)) {
      input.focus();
      expect(() => window.eval(pressGuardScript)).toThrow("用户手动操作");
    }
    inputs[3].focus();
    expect(window.eval(pressGuardScript)).toBe(true);
  });

  it("caps snapshots and reports unavailable iframe contents", () => {
    document.body.innerHTML = `<main>${"a".repeat(25000)}</main>${"<button>Action</button>".repeat(251)}<iframe></iframe>`;
    const result = snapshot();
    expect(result.elements).toHaveLength(250);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("快照仅包含主文档");
    expect(result.text.startsWith("a".repeat(24000))).toBe(true);
  });

  it("extracts source metadata, selected text and bounded table content", () => {
    document.head.innerHTML += '<meta name="citation_title" content="Research methods"><meta name="citation_author" content="Ada"><meta name="citation_publication_date" content="2026-09-30"><meta name="citation_doi" content="10.1234/study">';
    document.body.innerHTML = '<article>Selected evidence<table><caption>Survey results</caption><tr><th>Group</th><th>Count</th></tr><tr><td>A</td><td>12</td></tr></table></article>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("article")!.firstChild!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const result: BrowserExtraction = window.eval(extractionScript);
    expect(result).toMatchObject({ title: "Research methods", author: "Ada", publishedAt: "2026-09-30", doi: "10.1234/study", selection: "Selected evidence" });
    expect(result.tables[0]).toMatchObject({ caption: "Survey results", rows: [["Group", "Count"], ["A", "12"]], truncated: false });
    expect(Number.isFinite(Date.parse(result.extractedAt))).toBe(true);
  });

  it("keeps large imported survey tables and page text within bounded extraction output", () => {
    const wideRow = `<tr>${"<td>Survey cell</td>".repeat(45)}</tr>`;
    document.body.innerHTML = `<article>${"a".repeat(65000)}<table>${wideRow.repeat(205)}</table></article>`;
    const result: BrowserExtraction = window.eval(extractionScript);
    expect(result.text).toHaveLength(60000);
    expect(result.tables[0].rows).toHaveLength(201);
    expect(result.tables[0].rows[0]).toHaveLength(40);
    expect(result.tables[0].truncated).toBe(true);
  });

  it("caps combined table text before large cells can amplify a source into megabytes", () => {
    const row = `<tr>${`<td>${"x".repeat(4000)}</td>`.repeat(40)}</tr>`;
    document.body.innerHTML = `<table>${row.repeat(2)}</table>`.repeat(6);
    const result: BrowserExtraction = window.eval(extractionScript);
    const sizes = result.tables.map((table) => table.rows.flat().reduce((sum, value) => sum + value.length, 0));
    expect(sizes.every((size) => size <= 200000)).toBe(true);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1000000);
    expect(result.tables.every((table) => table.truncated)).toBe(true);
  });
});

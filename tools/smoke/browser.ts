// Bundle with the app's esbuild, then run with Electron. Uses only local fixtures.
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { BrowserManager } from "../../packages/app-desktop/src/main/browser/manager.js";
import type { BrowserCommand } from "../../packages/shared/src/browser.js";

async function main(): Promise<void> {
const dataDirectory = await mkdtemp(path.join(tmpdir(), "entrotect-browser-smoke-"));
app.setPath("userData", dataDirectory);
// Match the application's default Chromium compositor; no GPU settings are changed.
await app.whenReady();
const window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
const authorizations: Array<{ action: string; url: string }> = [];
const manager = new BrowserManager({ getWindow: () => window, onChange: () => {}, authorize: async (request) => { authorizations.push(request); return true; } });
const fixture = `<!doctype html><html><head><title>课程与办公资料</title><meta name="author" content="Fixture Author"><meta name="citation_doi" content="10.1234/example"></head><body>
<h1>课程资料</h1><label for="query">检索关键词</label><input id="query" aria-label="检索关键词"><button id="apply" onclick="document.querySelector('#result').textContent='已检索：'+document.querySelector('#query').value">检索</button>
<p id="result">等待检索</p><input type="password" value="secret-fixture-password"><table><caption>课程成绩</caption><tr><th>课程</th><th>分数</th></tr><tr><td>数学</td><td>90</td></tr></table>
<a href="/next">下一页</a></body></html>`;
const server = createServer((request, response) => {
  if (request.url === "/redirect-private") { response.writeHead(302, { location: "http://127.0.0.2:1/" }); response.end(); return; }
  response.setHeader("content-type", "text/html;charset=utf-8");
  response.end(request.url === "/next" ? "<!doctype html><title>下一页</title><h1>后续资料</h1>" : fixture);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
let assertions = 0;
const check = (condition: unknown, message: string) => { assert(condition, message); assertions++; };
const execute = async (command: BrowserCommand, options?: { abortSignal?: AbortSignal }) => {
  const result = await manager.execute("smoke-session", command, options);
  check(result.ok, result.error ?? "operation failed");
  return result;
};
try {
  const denied = await manager.execute("smoke-session", { action: "open", url: origin });
  check(!denied.ok && denied.error?.includes("阻止"), "private address must require explicit grant");
  manager.grantPrivateOrigin("smoke-session", origin);
  // A deleted task must cancel both pending authorization and queued operations.
  let authorizeStarted!: () => void;
  let releaseAuthorization!: (allowed: boolean) => void;
  const started = new Promise<void>((resolve) => { authorizeStarted = resolve; });
  const lifecycleManager = new BrowserManager({ getWindow: () => null, onChange: () => {}, authorize: () => {
    authorizeStarted();
    return new Promise<boolean>((resolve) => { releaseAuthorization = resolve; });
  } });
  try {
    lifecycleManager.grantPrivateOrigin("deleted-session", origin);
    const pending = lifecycleManager.execute("deleted-session", { action: "open", url: origin });
    await started;
    const queued = lifecycleManager.execute("deleted-session", { action: "list" });
    lifecycleManager.closeSession("deleted-session");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      Promise.all([pending, queued]),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("session deletion did not cancel pending operations")), 1000); }),
    ]).finally(() => clearTimeout(deadline));
    check(results.every((reply) => !reply.ok && reply.error?.includes("对话已关闭")), "deletion cancels authorization and queued work");
    releaseAuthorization(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(lifecycleManager.list("deleted-session").length === 0, "late authorization cannot resurrect a deleted task");
    check(!(await lifecycleManager.execute("deleted-session", { action: "open", url: origin })).ok, "closed task rejects future opens");
    assert.throws(() => lifecycleManager.grantPrivateOrigin("deleted-session", origin), /对话已关闭/);
    assertions++;
  } finally { lifecycleManager.dispose(); }
  const opened = await execute({ action: "open", url: origin });
  const tabId = opened.tabId!;
  check(authorizations.some((request) => request.action === "browser.navigate"), "model navigation must be authorized");
  const snapshot = (await execute({ action: "snapshot", tabId })).snapshot!;
  check(snapshot.title === "课程与办公资料", "title extraction");
  check(!JSON.stringify(snapshot).includes("secret-fixture-password"), "password values must not leak");
  const input = snapshot.elements.find((element) => element.name === "检索关键词")!;
  check(!!input, "input has stable ref");
  await execute({ action: "type", tabId, ref: input.ref, text: "大学课程" });
  const button = (await execute({ action: "snapshot", tabId })).snapshot!.elements.find((element) => element.name === "检索")!;
  await execute({ action: "click", tabId, ref: button.ref });
  const updated = (await execute({ action: "snapshot", tabId })).snapshot!;
  check(updated.text.includes("已检索：大学课程"), "click and type update live page");
  const page = (await execute({ action: "extract", tabId })).extraction!;
  check(page.author === "Fixture Author" && page.doi === "10.1234/example", "source metadata");
  check(page.tables[0]?.rows[1]?.join(",") === "数学,90", "table extraction");
  const baseChildren = window.contentView.children.length;
  manager.setViewport("smoke-session", tabId, { x: 0, y: 0, width: 800, height: 600 });
  check(window.contentView.children.length === baseChildren + 1, "native view attaches");
  const screenshot = (await execute({ action: "screenshot", tabId })).screenshot!;
  check(screenshot.dataUrl.startsWith("data:image/png;base64,"), "real Chromium screenshot");
  check(screenshot.width >= 100 && screenshot.height >= 100, "attached screenshot has a rendered surface");
  await writeFile(path.join(dataDirectory, "attached.png"), Buffer.from(screenshot.dataUrl.split(",")[1]!, "base64"));
  manager.setViewport("smoke-session", "", null);
  check(window.contentView.children.length === baseChildren, "native view hides for dialogs");
  const detachedShot = (await execute({ action: "screenshot", tabId })).screenshot!;
  check(detachedShot.dataUrl.startsWith("data:image/png;base64,"), "detached tab screenshot");
  check(detachedShot.width >= 100 && detachedShot.height >= 100, "detached screenshot has a rendered surface");
  await writeFile(path.join(dataDirectory, "detached.png"), Buffer.from(detachedShot.dataUrl.split(",")[1]!, "base64"));
  check(BrowserWindow.getAllWindows().length === 1, "temporary screenshot windows are cleaned up");
  const crossSession = await manager.execute("different-session", { action: "snapshot", tabId });
  check(!crossSession.ok, "task isolation");
  await execute({ action: "navigate", tabId, url: `${origin}/next` });
  const stale = await manager.execute("smoke-session", { action: "click", tabId, ref: button.ref });
  check(!stale.ok && stale.error?.includes("失效"), "old navigation ref rejected");
  const cancel = new AbortController();
  const waiting = manager.execute("smoke-session", { action: "wait", tabId, text: "never-present", timeoutMs: 15000 }, { abortSignal: cancel.signal });
  setTimeout(() => cancel.abort(), 100);
  const canceled = await waiting;
  check(!canceled.ok, "wait cancellation");
  const blocked = await manager.execute("smoke-session", { action: "navigate", tabId, url: `${origin}/redirect-private` });
  check(!blocked.ok, "redirect cannot inherit a private origin grant");
  await execute({ action: "close", tabId });
  check(manager.list("smoke-session").length === 0, "close cleans up tab");
  console.log(JSON.stringify({ ok: true, assertions, dataDirectory }));
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ ok: false, dataDirectory }));
  process.exitCode = 1;
} finally {
  manager.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  window.destroy();
  app.exit(process.exitCode ?? 0);
}
}
void main().catch((error) => { console.error(error); app.exit(1); });

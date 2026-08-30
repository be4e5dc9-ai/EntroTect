import { describe, expect, it, afterEach } from "vitest";
import { websearchTool } from "../src/tools/websearch.js";

// 旧版 Bing(cite 完整、href 为 ck/a 跳转),验证 cite 还原仍向后兼容
const BING_FIXTURE = `<!DOCTYPE html><html><body>
<ul>
<li class="b_algo"><h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=abc">Hello, world - Wikipedia</a></h2>
<div class="b_caption"><p>Hello, world is a small program used to demonstrate programming basics.</p></div>
<cite>https://en.wikipedia.org › wiki › Hello,_world</cite></li>
<li class="b_algo"><h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=def">GitHub - agnilondapakou/helloWorld</a></h2>
<div class="b_caption"><p>Hello world is an Open Source project.</p></div>
<cite>https://github.com › agnilondapakou › helloWorld</cite></li>
</ul></body></html>`;

const EMPTY_FIXTURE = "<html><body><ul><li>no results</li></ul></body></html>";

// 新版 Bing: h2 锚点 href 已是直链,cite 为截断展示串(含 "…")
const BING_NEW_FIXTURE = `<!DOCTYPE html><html><body>
<ul>
<li class="b_algo"><div class="b_tpcn"><a class="tilk" href="https://www.runoob.com/xxx"><div class="tpic"></div></a></div><h2 class=""><a target="_blank" href="https://www.runoob.com/w3cnote/write-hello-world-program-26-different-programming-languages.html" h="ID=SERP,1">26 种不同的编程语言的 “<strong>Hello World</strong>” 程序 | 菜鸟教程</a></h2><div class="b_caption"><p class="b_lineclamp2">学习编程语言的第一个程序一般是输出 “Hello World”。&ensp;&#0183;&ensp;接下来我们看下 26 种不同语言。</p></div><cite>https://www.runoob.com › write-hello-world-program...</cite></li>
<li class="b_algo"><h2><a target="_blank" href="https://zhuanlan.zhihu.com/p/133177244" h="ID=SERP,2">为什么各大编程语言，都是用 Hello World 入门呢？</a></h2><div class="b_caption"><p>Hello World 是一个最著名的程序。</p></div><cite>https://zhuanlan.zhihu.com</cite></li>
</ul></body></html>`;

// DuckDuckGo html 端: result__title + uddg 跳转
const DDG_FIXTURE = `<html><body>
<div class="result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fstackoverflow.com%2Fquestions%2F69259024%2Fhow-to-handle-conflicting-peer-dependencies">How to handle conflicting peer dependencies? - Stack Overflow</a></h2><a class="result__snippet">Resolving npm ERESOLVE peer dependency conflicts in a monorepo.</a></div>
<div class="result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.npmjs.com%2Fcli%2Fv11%2Fconfiguring-npm%2Fpackage-json">npm docs: package.json</a></h2><a class="result__snippet">Official npm package.json documentation.</a></div>
</body></html>`;

// Stack Exchange API(JSON): search/advanced 返回的 items
const SO_FIXTURE = JSON.stringify({
  items: [
    {
      title: "What does npm install --legacy-peer-deps do exactly?",
      link: "https://stackoverflow.com/questions/66239691/what-does-npm-install-legacy-peer-deps-do-exactly",
      tags: ["npm", "node.js"],
      answer_count: 4,
    },
    {
      title: "Unable to resolve dependency tree error when installing npm packages",
      link: "https://stackoverflow.com/questions/64573177/unable-to-resolve-dependency-tree-error",
      tags: ["npm"],
      answer_count: 6,
    },
  ],
});

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

/** 按 URL 关键字路由到不同引擎,模拟三引擎并行抓取 */
function mockFetch(routes: Record<string, string>) {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : ((input as { url?: string }).url ?? "");
    if (url.includes("stackexchange")) {
      return new Response(routes.stackexchange ?? '{"items":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const matched = Object.keys(routes).find((key) => url.includes(key));
    return new Response(matched ? routes[matched]! : EMPTY_FIXTURE, { status: 200 });
  }) as typeof fetch;
}

async function run(query: string): Promise<string> {
  return websearchTool.call({ query }, {
    cwd: ".",
    artifactDir: ".",
    sandboxMode: "full",
  } as never);
}

describe("websearch 多引擎合并", () => {
  it("StackOverflow 结果优先于其它引擎,且带标签/回答数摘要", async () => {
    mockFetch({ stackexchange: SO_FIXTURE, duckduckgo: DDG_FIXTURE, "bing.com": BING_FIXTURE });
    const out = await run("npm ERESOLVE");
    expect(out).toContain("https://stackoverflow.com/questions/66239691/what-does-npm-install-legacy-peer-deps-do-exactly");
    expect(out).toContain("[npm] [node.js]");
    expect(out).toContain("4 个回答");
    // StackOverflow 的 SO 结果排在 DDG 的 SO 结果之前
    const soIdx = out.indexOf("legacy-peer-deps");
    const ddgIdx = out.indexOf("How to handle conflicting peer dependencies");
    expect(soIdx).toBeGreaterThan(-1);
    expect(ddgIdx).toBeGreaterThan(-1);
    expect(soIdx).toBeLessThan(ddgIdx);
  });

  it("Bing 成功: 解析 b_algo 标题/cite 还原 URL/摘要(向后兼容)", async () => {
    mockFetch({ "bing.com": BING_FIXTURE, duckduckgo: EMPTY_FIXTURE });
    const out = await run("hello world");
    expect(out).toContain("Hello, world - Wikipedia");
    expect(out).toContain("https://en.wikipedia.org/wiki/Hello,_world");
    expect(out).toContain("https://github.com/agnilondapakou/helloWorld");
    expect(out).toContain("demonstrate programming basics");
  });

  it("新版结构: 优先采用 h2 直链而非截断 cite", async () => {
    mockFetch({ "bing.com": BING_NEW_FIXTURE, duckduckgo: EMPTY_FIXTURE });
    const out = await run("hello world");
    expect(out).toContain(
      "https://www.runoob.com/w3cnote/write-hello-world-program-26-different-programming-languages.html",
    );
    expect(out).toContain("https://zhuanlan.zhihu.com/p/133177244");
    expect(out).not.toContain("write-hello-world-program...");
    expect(out).toContain("Hello World");
    expect(out).not.toContain("&#0183;");
    expect(out).not.toContain("&ensp;");
  });

  it("DDG 结果优先于 Bing(相关度更高)", async () => {
    mockFetch({ duckduckgo: DDG_FIXTURE, "bing.com": BING_FIXTURE });
    const out = await run("npm ERESOLVE");
    expect(out).toContain("https://stackoverflow.com/questions/69259024/how-to-handle-conflicting-peer-dependencies");
    expect(out).toContain("https://docs.npmjs.com/cli/v11/configuring-npm/package-json");
    const ddgIdx = out.indexOf("Stack Overflow");
    const bingIdx = out.indexOf("Wikipedia");
    expect(ddgIdx).toBeGreaterThan(-1);
    expect(bingIdx).toBeGreaterThan(-1);
    expect(ddgIdx).toBeLessThan(bingIdx);
  });

  it("按规范化 URL 去重,同一 URL 只保留首条", async () => {
    const ddgDup = `<h2 class="result__title"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsame">Same Page (DDG)</a></h2>`;
    const bingDup = `<li class="b_algo"><h2><a href="https://example.com/same">Same Page (Bing)</a></h2><cite>https://example.com › same</cite></li>`;
    mockFetch({ duckduckgo: ddgDup, "bing.com": bingDup });
    const out = await run("dedup");
    expect(out).toContain("Same Page (DDG)");
    expect(out).not.toContain("Same Page (Bing)");
    const occurrences = out.split("https://example.com/same").length - 1;
    expect(occurrences).toBe(1);
  });

  it("两个引擎均无结果时给出失败提示", async () => {
    mockFetch({ duckduckgo: EMPTY_FIXTURE, "bing.com": EMPTY_FIXTURE });
    const out = await run("hello world");
    expect(out).toContain("搜索失败");
    expect(out).toContain("Bing");
    expect(out).toContain("DuckDuckGo");
  });
});

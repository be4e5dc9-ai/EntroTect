import { describe, expect, it, vi, afterEach } from "vitest";
import { websearchTool } from "../src/tools/websearch.js";

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

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

async function run(query: string): Promise<string> {
  return websearchTool.call({ query }, {
    cwd: ".",
    artifactDir: ".",
    sandboxMode: "full",
  } as never);
}

describe("websearch 多引擎回退", () => {
  it("Bing 成功: 解析 b_algo 标题/cite 还原 URL/摘要", async () => {
    globalThis.fetch = (async () =>
      new Response(BING_FIXTURE, { status: 200 })) as typeof fetch;
    const out = await run("hello world");
    expect(out).toContain("Hello, world - Wikipedia");
    expect(out).toContain("https://en.wikipedia.org/wiki/Hello,_world");
    expect(out).toContain("https://github.com/agnilondapakou/helloWorld");
    expect(out).toContain("demonstrate programming basics");
    expect(out).toContain("Bing");
  });

  it("新版结构: 优先采用 h2 直链而非截断 cite", async () => {
    globalThis.fetch = (async () =>
      new Response(BING_NEW_FIXTURE, { status: 200 })) as typeof fetch;
    const out = await run("hello world");
    // 直链完整保留,不得含 "…"/截断路径
    expect(out).toContain(
      "https://www.runoob.com/w3cnote/write-hello-world-program-26-different-programming-languages.html",
    );
    expect(out).toContain("https://zhuanlan.zhihu.com/p/133177244");
    expect(out).not.toContain("write-hello-world-program...");
    expect(out).not.toContain("https://zhuanlan.zhihu.com\n");
    // title 内 <strong> 被剥离
    expect(out).toContain("Hello World");
    // 摘要实体 &#0183;/&ensp; 被解码
    expect(out).not.toContain("&#0183;");
    expect(out).not.toContain("&ensp;");
  });

  it("两个引擎均无结果时给出失败提示", async () => {
    globalThis.fetch = (async () =>
      new Response(EMPTY_FIXTURE, { status: 200 })) as typeof fetch;
    const out = await run("hello world");
    expect(out).toContain("搜索失败");
    expect(out).toContain("Bing");
    expect(out).toContain("DuckDuckGo");
  });
});

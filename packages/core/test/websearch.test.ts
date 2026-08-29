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

  it("两个引擎均无结果时给出失败提示", async () => {
    globalThis.fetch = (async () =>
      new Response(EMPTY_FIXTURE, { status: 200 })) as typeof fetch;
    const out = await run("hello world");
    expect(out).toContain("搜索失败");
    expect(out).toContain("Bing");
    expect(out).toContain("DuckDuckGo");
  });
});

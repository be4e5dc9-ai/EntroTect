import { describe, expect, it, afterEach } from "vitest";
import {
  matchStackExchangeQuestion,
  fetchStackExchangeQuestion,
} from "../src/tools/webfetch.js";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("matchStackExchangeQuestion", () => {
  it("识别 StackOverflow 问题 URL", () => {
    expect(matchStackExchangeQuestion(new URL("https://stackoverflow.com/questions/12345/some-title"))).toEqual({
      site: "stackoverflow",
      id: "12345",
    });
  });

  it("剥 www 前缀", () => {
    expect(matchStackExchangeQuestion(new URL("https://www.stackoverflow.com/questions/7/x"))).toEqual({
      site: "stackoverflow",
      id: "7",
    });
  });

  it("识别 *.stackexchange.com 子站", () => {
    expect(matchStackExchangeQuestion(new URL("https://math.stackexchange.com/questions/999/foo"))).toEqual({
      site: "math",
      id: "999",
    });
  });

  it("识别 superuser/serverfault/askubuntu", () => {
    expect(matchStackExchangeQuestion(new URL("https://superuser.com/questions/55/x"))).toEqual({
      site: "superuser",
      id: "55",
    });
    expect(matchStackExchangeQuestion(new URL("https://askubuntu.com/questions/12/x"))).toEqual({
      site: "askubuntu",
      id: "12",
    });
  });

  it("非问题页/非 SE 域返回 null", () => {
    expect(matchStackExchangeQuestion(new URL("https://stackoverflow.com/questions"))).toBeNull();
    expect(matchStackExchangeQuestion(new URL("https://stackoverflow.com/"))).toBeNull();
    expect(matchStackExchangeQuestion(new URL("https://example.com/questions/123"))).toBeNull();
    expect(matchStackExchangeQuestion(new URL("https://stackoverflow.com/questions/123/answer"))).not.toBeNull();
  });
});

describe("fetchStackExchangeQuestion", () => {
  it("读取问题正文 + 回答,解码实体并标记已采纳", async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : ((input as { url?: string }).url ?? "");
      if (url.includes("/answers")) {
        return new Response(
          JSON.stringify({
            items: [
              { body: "<p>Answer body with <code>code</code></p>", score: 42, is_accepted: true },
              { body: "<p>Second answer.</p>", score: 10, is_accepted: false },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ items: [{ title: "Test &amp; title?", body: "<p>Question body.</p>" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const out = await fetchStackExchangeQuestion("stackoverflow", "123", 12000);
    expect(out).toContain("标题: Test & title?");
    expect(out).toContain("Question body.");
    expect(out).toContain("回答(按投票排序,共 2 条):");
    expect(out).toContain("[1] ✓ 已采纳");
    expect(out).toContain("Answer body with code");
    expect(out).toContain("[2] 投票 10");
    expect(out).toContain("Second answer.");
  });
});

# opencode 原生 LLM 路由层 @opencode-ai/llm：Route 四轴正交分解

> 归属：`agent-study/opencode/` | 关键词：Protocol、Endpoint、Auth、Framing、LLMEvent、providerExecuted、generateObject
> 核心文件：`packages/llm/src/protocols/{openai-chat,openai-responses,anthropic-messages,gemini,bedrock-converse}.ts`（每个 19-41KB）、AGENTS.md（packages/llm）

---

## 1. 设计动机（包内 AGENTS.md 写得极清楚）

传统做法每家 provider 一份 300-400 行的路由克隆。opencode 把 Route 分解为四个正交轴：

| 轴 | 职责 |
|---|---|
| **Protocol** | 请求体构造 + 流事件状态机 |
| **Endpoint** | URL |
| **Auth** | bearer / header / SigV4 签名 |
| **Framing** | SSE 或 AWS event-stream 二进制帧 |

```ts
Route.make({ protocol, endpoint, auth, framing })
```

收益量化（原文）："DeepSeek、TogetherAI、Cerebras、Baseten、Fireworks、DeepInfra 全部原样复用 OpenAIChat.protocol——每家只是 5-15 行的 Route.make 调用，而不是 300-400 行的路由克隆；协议修一个 bug 全部受益"。

## 2. 五大协议实现

openai-chat / openai-responses / anthropic-messages / gemini / bedrock-converse。

## 3. 统一事件模型 LLMEvent

```
text-delta | reasoning-* | tool-input-* | tool-call | tool-result
| step-start | step-finish(usage) | provider-error | finish
类型守卫：LLMEvent.is.textDelta 等
```

**hosted 工具直通**：Anthropic web_search、OpenAI Responses code_interpreter 等供应商托管工具带 `providerExecuted: true` 标记——调用方跳过本地分发，processor 也不为其创建本地工具循环（prompt.ts:1106-1109）。

## 4. 单轮语义

> "`LLM.stream(request)` 恰好执行一个 provider turn"，工具循环留给上层——职责切割干净：这一层永远不知道工具循环的存在。

## 5. generateObject 的跨协议技巧

刻意不用各家原生 JSON 模式，而是内部强制一个**合成工具调用**以保证跨协议行为一致（llm.ts:146-157）——结构化输出在所有 provider 上走同一条代码路径。

## 6. 自研启示

1. 多 provider 支持的正交分解法：协议×端点×认证×分帧，组合爆炸变线性叠加。
2. 统一中间事件表示（LLMEvent）是上层（processor/压缩/token 统计）与下层解耦的关键。
3. hosted 工具的 providerExecuted 标记避免"本地又执行一遍供应商已执行的工具"这类事故。

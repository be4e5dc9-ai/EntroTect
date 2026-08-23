# Claude Code API 调用层与 SSE 流式解析

> 归属：`agent-study/ClaudeCode/` | 关键词：queryModel、paramsFromContext、raw stream、content_block_stop、input_json_delta、看门狗
> 核心文件：`src/services/api/claude.ts`（3419 行）、`src/query/deps.ts`

---

## 1. 调用链与依赖注入

```
主循环 state.deps.callModel
  = queryModelWithStreaming        (src/query/deps.ts:36 默认实现)
    → queryModelStream             (services/api/claude.ts:752)
      → queryModel                 (:1017)
```

依赖注入使测试可替换 callModel 为 mock，也让 fallback 模型切换只改一个注入点。

## 2. 请求参数构建 paramsFromContext（claude.ts:1538-1728）

| 参数 | 处理细节 |
|---|---|
| model | 经 normalizeModelStringForAPI 归一化 |
| messages | `addCacheBreakpoints(messages)`：在稳定前缀处打 cache_control 断点 |
| system | 分段数组，静态段打 global cache 断点（见 05-提示词） |
| tools | schema 数组（见 03/04 工具系统） |
| betas | 按 provider 合并的 beta header 列表 |
| max_tokens | 显式传入 |
| thinking | **adaptive 或 budget_tokens clamp 到 max_tokens−1**（`:1596-1630`）；temperature 仅在关闭思考时发送 |
| context_management / output_config | 上下文管理与服务端工具开关 |

**启示**：thinking budget 必须 < max_tokens，clamp 到 −1 是防 400 的实战细节。

## 3. 为什么用 raw stream 而不是官方 SDK 流封装

`:1822` 直接 `anthropic.beta.messages.create({...,stream:true})` 拿原始 SSE。【上游注释称】官方 BetaMessageStream 对每个 delta 做 O(n²) 的部分 JSON 解析，长 tool_use 输入时 CPU 爆炸（claude.ts 源码注释自述，本笔记未独立复测其复杂度结论，但"避免 SDK 封装层开销、自行控制解析"这一动机可直接从代码结构证实）。

外包 `withRetry`（`:1778`）：指数退避、529 过载计数、FallbackTriggeredError 触发换模型（详见 10-Provider与韧性）。

## 4. SSE 手工解析器状态机（claude.ts:1979-2303）

对每个 SSE event 的处理语义：

| SSE event | 处理 |
|---|---|
| `message_start` | 记录 message id / usage 基线 |
| `content_block_start` | 新内容块；tool_use 块初始化 `input=''` |
| `content_block_delta` (text_delta) | 文本增量 → 推给 UI |
| `content_block_delta` (**input_json_delta**) | `contentBlock.input += partial_json` —— **tool 输入用字符串累积，结束后一次性 JSON.parse** |
| `content_block_stop` | ★ **每个内容块完成即 yield 一条独立 AssistantMessage**（`:2192-2210`，uuid=randomUUID）——并发多个 tool_use 天然拆成多条消息，后续执行器可逐块处理 |
| `message_delta` | usage / stop_reason **就地改写最后一条已 yield 的消息**（transcript 写队列持引用惰性序列化，`:2244-2248`）；stop_reason=max_tokens 时产 apiError 消息 |
| `error` / ping | 错误上抛 / 心跳忽略 |

**关键设计**：一条 AssistantMessage = 一个 content_block。这简化了"一次响应多个工具调用"的下游处理（每条消息独立 uuid/parentUuid 链）。

## 5. 流健康监控

| 机制 | 位置 | 行为 |
|---|---|---|
| 流空闲看门狗 | `:1874-1928` | 90s 无任何 delta 即判定挂死，断开重试 |
| 卡顿检测 | 同区域 | delta 间隔异常拉长告警 |
| 空流转非流式 | — | 流式返回空时降级为非流式请求重试（300s 总超时） |

## 6. 发送前的消息归一化 normalizeMessagesForAPI（utils/messages.ts:1989）

- 剔除 progress / system / virtual 消息（它们只在本地 UI 有意义）；
- 合并相邻 user 消息（Bedrock 不允许连续同 role）；
- attachment 类消息重排到合法位置；
- system 单独走 `system[]` 字段，不混入 messages。

内部消息类型（`types/message.ts:124`）：

```ts
// MessageBase (:6-17) —— 所有消息共有的链路字段
{ uuid, parentUuid, timestamp, isMeta, toolUseResult }
// 具体类型：UserMessage / AssistantMessage / SystemMessage /
//          AttachmentMessage / ProgressMessage / TombstoneMessage
```

- `parentUuid` 构成单链表 → JSONL 持久化与 resume 重建全靠它（见 08-持久化）。
- `isMeta=true` 表示"合成消息"（如 "Resume directly…" 提示），发给模型但不渲染给用户。
- `toolUseResult` 缓存该 user 消息对应的工具原始结果供 UI 展示。

## 7. 自研启示清单

1. 手写 SSE switch 只需 5 个 case 就能跑：message_start / content_block_start / input_json_delta / text_delta / content_block_stop。
2. tool 输入按字符串累积再 parse，不要尝试流式增量 parse JSON。
3. 每个完整 content_block 产一条独立 assistant 消息，天然获得并发工具的隔离。
4. usage/stop_reason 后到 → 用"改写最后一条已 yield 消息"解决，而不是缓存整条响应等齐。

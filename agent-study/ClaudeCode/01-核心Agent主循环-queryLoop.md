# Claude Code 核心 Agent 主循环（queryLoop）

> 归属：`agent-study/ClaudeCode/` | 关键词：query、queryLoop、while(true)、异步生成器、tool_use 收集、循环推进
> 核心文件：`src/query.ts`（1729 行）

---

## 0. 一句话

> Agent = 一个 while(true) 异步生成器：把「模型输出中的 tool_use」翻译成「本地副作用」，再把副作用结果翻译回「user 消息里的 tool_result」。循环推进的唯一方式是 state.messages 重赋值。

## 1. 结构

入口 `query()`（`src/query.ts:219-239`）→ `queryLoop()`（`:241-1729`）。

```ts
// src/query.ts:181-217 —— 主循环入参与跨迭代状态
type QueryParams = {
  messages; systemPrompt; userContext; systemContext;
  canUseTool;                  // 权限回调统一签名（见 06-权限）
  toolUseContext;              // 贯穿所有工具执行的上下文（cwd、abortController、appState…）
  fallbackModel?; querySource; maxTurns?;
  deps?: QueryDeps             // 依赖注入：callModel 等可替换，测试友好
}
type State = {
  messages;                    // 全量对话历史（含 tool_result）
  toolUseContext;
  maxOutputTokensRecoveryCount;// max_output_tokens 恢复已尝试次数（≤3）
  hasAttemptedReactiveCompact; // 413 被动压缩只试一次
  stopHookActive; turnCount; transition
}
```

**设计要点**：`deps?: QueryDeps` 把"调用哪个模型"做成注入参数（`query/deps.ts:36` 默认 `queryModelWithStreaming`）——整个主循环不直接依赖 SDK 类型。

## 2. 每轮固定顺序（13 步，全部在 queryLoop 内）

| # | 行号 | 步骤 | 说明 |
|---|---|---|---|
| 1 | `:365` | 取压缩边界后的消息 | compaction 后的消息窗口起点 |
| 2 | `:379` | 工具结果聚合预算 | 单消息 >200k 字符时替换最大块为落盘引用（见 04-执行管线） |
| 3 | `:401` | Snip 强制截断 | HISTORY_SNIP 门控 |
| 4 | `:414` | Microcompact | 只清老 tool_result 内容留结构（见 07-上下文管理） |
| 5 | `:440` | ContextCollapse 分段归档 | 投影式归档 |
| 6 | `:449` | 组装 system prompt | appendSystemContext（动态 env 块） |
| 7 | `:454` | Autocompact 判定 | 阈值触发 forked-agent 全量摘要 |
| 8 | `:628` | 硬阻塞检查 | 关闭 autocompact 时 effective−3k 直接终止回合提示手动 /compact |
| 9 | `:659-863` | **流式调模型并收集 tool_use** | 边流边把 tool_use 喂给 StreamingToolExecutor.addTool（`:841-844`） |
| 10 | `:1062-1358` | 韧性恢复分支 | 413 / max_output_tokens / fallback model（见 10-Provider与韧性） |
| 11 | `:1380-1408` | 执行工具收集结果 | runTools() 或消费 StreamingToolExecutor 的 yielded 结果 |
| 12 | `:1580-1628` | attachments 注入 | 本地文件变更等作为附件注入下一轮 |
| 13 | `:1715-1717` | **推进状态** | 见下 |

```ts
// src/query.ts:1715-1717 —— 循环推进的唯一方式
state = { messages: [...messagesForQuery, ...assistantMessages, ...toolResults], ... }
```

## 3. 循环出口信号：看 tool_use 数量，不看 stop_reason

```ts
// src/query.ts:554 附近注释：stop_reason 不可靠
出口条件 = 本次响应中 toolUseBlocks.length === 0
```

> **实战铁律**：不要依赖 stop_reason 判断是否继续循环——不同 provider/代理网关对 stop_reason 的填充不一致且不可靠。数一数实际收到了几个 tool_use 块才是真相。

## 4. 两条不可违背的铁律

1. **tool_result 必须紧跟对应的 tool_use**：即使工具被中断/拒绝，也必须合成一条取消或错误结果的 tool_result 回填历史，否则下次请求会被 API 以 400 拒绝。
2. **一切工具异常包成 is_error 的 tool_result 回喂**（`services/tools/toolExecution.ts:469-489`）：

```
<tool_use_error>具体错误信息</tool_use_error>
```

让模型看到错误自行纠正换路，而不是让进程崩溃或静默吞掉。

## 5. 边流边执行（Streaming Overlap）

流式期间每解析出一个完整 tool_use 就立刻交给 `StreamingToolExecutor.addTool`（`query.ts:841-844`）开始排队/预执行——不等整条响应结束。收益：

- 第一个工具在模型还在生成后续文本时就开始跑；
- 并发安全的工具（多个 Read/Grep）自然重叠执行；
- 执行器内部有 queued/executing/completed/yielded 状态机保证顺序语义（详见 04-执行管线）。

## 6. 中断与轮次控制

- `AbortController` 贯穿 toolUseContext：用户 Ctrl-C 即触发，正在流的请求与正在跑的工具同时收到取消信号。
- `maxTurns` 参数给子代理设上限，防止无限循环烧钱。
- Stop hooks 可注入 blocking errors 强制续跑，但保留 compact 标志防死循环烧 API（`:1290-1297`）。

## 7. 对自研的最小启示

最小可行主循环只有五行语义：

```
while (true):
  res    = callModel(messages, system, tools)      # 流式
  blocks = collectToolUses(res)
  if blocks.isEmpty(): break                       # 出口=无 tool_use
  results = for each block: execute(block)          # 异常→is_error 结果
  messages += [...assistantMsgs, ...resultsAsUserMsg]
```

其余一切（权限、压缩、持久化、子代理）都是围绕这个翻译器的可靠性工程。

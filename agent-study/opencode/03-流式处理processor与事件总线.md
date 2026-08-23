# opencode 流式处理 processor 与事件总线（EventV2 三层）

> 归属：`agent-study/opencode/` | 关键词：handleEvent、doom-loop、interrupted 补偿、fromError、toModelMessages、durable event、SSE
> 核心文件：`packages/opencode/src/session/processor.ts`、`packages/core/src/event.ts`、`event-v2-bridge.ts`

---

## 1. processor.process()：LLM 事件流 → Part 落库

```ts
// processor.ts:627-683
process() = llm.stream(input)
  经 Stream.tap(handleEvent) 逐事件落库
  takeUntil(needsCompaction) 中途截断（provider 报 overflow 时）
  外包 retry 策略 + ensuring(cleanup)     // cleanup 保证中断安全
```

### handleEvent 状态机表（processor.ts:278-537）

| LLMEvent | 处理 |
|---|---|
| text-start/delta/end | 建 TextPart；delta 发 `message.part.delta` 增量事件推 UI；end 触发 experimental.text.complete 钩子 |
| reasoning-start/delta/end | ReasoningPart 同理 |
| tool-input-* / tool-call | ensureToolCall 建 pending→running ToolPart；**doom-loop 检测：连续 3 次同工具同参数 → 强制 permission.ask("doom_loop")**（29、355-380） |
| tool-result / tool-error | complete/failToolCall；权限拒绝且未开 continue_loop_on_deny 则整轮停止（ctx.blocked） |
| step-start | 记 git snapshot |
| step-finish | 算 usage/cost 写 tokens、diff 出 PatchPart、fork 后台 summarize（424-484）；providerMetadata 一并保存 |

## 2. 中断安全 ★

```
cleanup() (539-597)：把仍在 running 的 ToolPart 标为 error{interrupted:true}
重放历史时：
  isOrphanedInterruptedTool (prompt.ts:96-100) 识别孤儿，避免悬空 tool_use 阻塞退出
  toModelMessages 对 pending/running 工具补发合成错误结果
    "[Tool execution was interrupted]"        ← 满足 Anthropic「每个 tool_use 必须有
                                               tool_result」约束 (message-v2.ts:349-360)
```

## 3. 错误归一化与投影降级

- `MessageV2.fromError`（message-v2.ts:606-734）：Abort/APICall/Zlib/HeaderTimeout → 统一命名错误；识别 context_overflow → **ContextOverflowError**（驱动压缩）；
- `toModelMessages`（131-415）：发给模型前的投影降级——跨模型切换剥离 providerMetadata/签名推理；不支持工具结果内媒体的 provider 把媒体抽成独立 user 消息。

## 4. 事件总线三层

1. **EventV2**（core/src/event.ts）：`define({type, schema, durable:{aggregate:"sessionID", version}})` 定义事件；durable 发布在 SQLite 事务内分配每聚合单调 seq 并写 event/event_sequence 表（205-260），再经 PubSub 广播；接口 publish/subscribe/listen/project/replay/claim（126-148）——**事件溯源 + projector 投影**。
2. **EventV2Bridge**：publish 自动附加实例 Location（目录/workspace/project），并把全部事件镜像进 GlobalBus（供 server 全局流与 sync 载荷 `{id,type,seq,aggregateID,data}` 使用）。
3. **对外 SSE**（handlers/event.ts:25-87）实现要点：
   - 监听器**先于响应体启动注册**（防丢事件）；
   - 按 directory+workspace 过滤；
   - 首帧 server.connected、10 秒心跳；
   - 收到 server.instance.disposed 主动终止流。

V1 会话事件清单见 schema/v1/session.ts:571-676（session.created/updated、message.updated、message.part.updated/delta——delta 为 live-only 不持久化）。

## 5. V2 Runner 前瞻机制（core/session/runner/llm.ts）

| 机制 | 说明 |
|---|---|
| 准入/执行分离 | SessionInput.admit 先写 session_input 收件箱表，runner 在安全边界才发布 Prompted 提升（promotion）为可见消息 |
| steer/queue 双语义 | steer 在下一安全边界立即插入；queue 仅在 drain 将空闲时逐条提升（390-413 drain 双循环） |
| 每 turn 恰一次 stream | tool-call 到达即在 FiberSet 中 eager 结算，流毕 await 全部再续 |
| wake 前清残留 | failInterruptedTools 把上进程遗留 running 工具 durably 置败（119-139） |

## 6. 自研启示

1. 中断补偿（合成 tool_result）是跨 provider 正确性的硬要求。
2. doom-loop 检测（同工具同参数连续 N 次→强制问人）成本极低收益极高。
3. SSE 监听器先注册再开流——丢事件类 bug 的标准解法。

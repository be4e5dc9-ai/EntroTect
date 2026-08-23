# DeepSeek Harness 核心主循环：turn/step 两级状态机与输入语义

> 归属：`agent-study/deepseek-harness/` | 关键词：Phase、followup、steer、inject、kick、pre-step、step/end、TurnEndReason
> 核心文件：`packages/core/agent-loop/src/agent.ts`（515 行，类 ReactLoopAgent）

---

## 1. 显式状态机 Phase

```ts
// agent.ts:38-46 —— 对外只暴露 idle|running（runtime-types.ts:50），每次迁移发 agent/status 事件(:104-111)
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

maintenance 相位专供 compaction 等独占任务（runMaintenance()），与普通运行互斥。

## 2. 三种输入语义（agent.ts:113-132）——steering 的工程化

```ts
followup(input) => send(input, 'next-turn', true)   // 新开一个 turn（用户正常发消息）
steer(input)    => send(input, 'next-step', true)   // 注入最近 step 边界并唤醒——"驾驶"
inject(input)   => send(input, 'next-step', false)  // 注入上下文但不唤醒，等下次顺路搭车
```

- 唤醒型消息立即开新工作；注入型在 inbox 排队直到下一个自然请求边界。
- **wake latch** 处理竞态："唤醒落在已中止活动上"时 latch 重放（:114-117, :172-181）。

## 3. 驱动入口 kick()（:210-223)

```ts
while (await this.turn()) {}    // 队列还有活且未中止就继续开 turn
// finally: 归还 idle 相位并重放 latch 的 wake
```

## 4. 一个 turn 的骨架（:246-330，精简注释版）

```ts
private async turn(): Promise<boolean> {
  this.session.append('turn/start', { turn })              // 持久化开 turn
  while (true) {
    const decision = await this.preStep(...)               // agent/pre-step waterfall：
                                                           // 插件可改写/拒绝进入的 step
    if (decision.kind === 'reject') { turnEnds={kind:'blocked'}; return false }
    if (首步且无消息) { turnEnds={kind:'completed'}; return false } // 不花模型调用
    this.session.append('step/start', { turn, step })
    for (const m of decision.messages)
      this.session.append('user/message', m, { surfaceOp:'append' })
    const stepEnd = await this.step(decision.assembly)
    // max-tokens 是粘性的：后续正常完成的 step 不得降级 turn 结果 ★
    if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
    this.session.append('step/end', { turn, step })
    if (turnEnds && inbox.nextStep.length === 0) {
      await dispatch.serial('agent/turn-stopping', {...})  // 终止前串行检查点：
                                                           // listener 只能 steer 续命，
                                                           // 无法用顺序翻案（数据决定结局）
      if (inbox.nextStep.length === 0) break
    }
  }
  // finally: append('turn/end', { turn, reason })
}
```

**TurnEndReason 可扩展联合**（core/session/src/types.ts:155-177）：
`completed | aborted | blocked | error | max-tokens | interrupted`
（interrupted 由持久化后端给崩溃孤儿 turn 打标，loop 自己永不产生。）

错误全结构化：catch 把任意异常压成 `{kind:'error', error: LlmError(保留facts) | {message: errorChain(e), code:'UNKNOWN'}}`（:302-315）。

## 5. 一个 step：模型请求 + 工具执行（:332-420）

```ts
private async step(assembly): Promise<StepEndReason | null> {
  const system = renderPrompt(assembly)
  while (true) {                                    // 循环体只为错误重试服务
    const { request } = await this.buildRequest(turn, step, assembly.tools,
                                   system, session.deriveMessages(), signal)
    const assembler = new BlockAssembler()
    for await (const chunk of stream) {
      chunkSeqs.push(session.append('assistant/chunk', {...}).seq)  // 原始 chunk 入库
      assembler.push(chunk)
    }
    session.append('assistant/message', {message, usage},
                   { sourceEventSeqs: chunkSeqs })  // ★ 反向引用构成它的 chunks
    if (finish.kind === 'max-tokens') return { kind:'max-tokens' }
    const toolCalls = message.content.filter(b => b.type === 'tool-call')
    if (!toolCalls.length) return { kind:'completed' }   // 模型不要工具 → 收口候选
    const { concluded } = await executeToolCalls(ctx, toolCalls, ...)
    return concluded ? { kind:'completed' } : null       // null = 还欠一次模型请求
}
```

要点：
1. step 返回 null 表示"模型还欠响应"，turn 检查 inbox 后续跑——**终止完全由数据决定，没有隐藏计数上限**。
2. 每个 chunk 都入日志；assistant/message 用 sourceEventSeqs 引用 chunk 序号——UI 重放保真与派生历史分离（types.ts L265-277：raw chunks 用于 token 级重放，派生只用 message 事件）。

## 6. 请求构建 buildRequest（:426-514）

- 种子配置：首请求取 AgentOptions；后续取日志里最近的 `request/header` 快照；
- 经 `agent/request` waterfall 让插件改路由/参数（compaction-basic 在这里拦截 context overflow 触发 retry）;
- 写两类账目事件：`request/header`（含 system 全文+tools schema，崩溃后重建请求）、`request/context`（provider/model/contextWindow 变更时）;
- `markAgentLoopRequest(deepFreeze(...))` 打标：loop 构建的请求是日志的纯函数，llm/stream 监听器只许读不许改（llm/index.ts:53-65 契约）。

## 7. 中立消息词汇（llm/llm/src/types.ts）

```
ContentBlock = text | reasoning | image
             | tool-call{id, name, arguments:原始JSON字符串}     ← 不预解析参数！
             | tool-result{toolCallId, content, isError?}
FinishReason = stop | tool-calls | max-tokens | aborted | error
StreamChunk  = block-start | text-delta | reasoning-delta | tool-call-delta
             | block-end | usage | finish{reason, replayState?}
GenerateOptions.purpose?: 'compaction' | 'session-title'        ← 辅助调用打标(L376)
```

## 8. 自研启示

1. turn/step 两级 + inbox(next-turn/next-step) 是比裸 while(true) 更可运维的循环骨架：每级都有持久化边界事件。
2. sticky max-tokens：部分失败不能被后续成功掩盖。
3. request/header 快照让崩溃恢复/换适配器后仍能精确重建请求并命中 provider KV cache。

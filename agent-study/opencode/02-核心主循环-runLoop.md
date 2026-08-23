# opencode 核心主循环：prompt 入口、createUserMessage 与 runLoop

> 归属：`agent-study/opencode/` | 关键词：prompt()、@file 展开、LSP 符号扩展、runLoop、单写者、SessionRunState
> 核心文件：`packages/opencode/src/session/prompt.ts`（1081-1341 为主循环）

---

## 1. 入口与 user 消息创建

### prompt()（prompt.ts:1052-1071）

清理 revert → 建 user 消息 → 把 `input.tools` 开关翻译成 session 级 permission rules（1060-1067）→ 进 loop。

### createUserMessage()（635-1050）要点

1. 解析 agent/model/variant；currentModel 从 DB 回退到历史最后一条 user 消息（614-633）；
2. **parts 展开**：
   - `@file` 引用真实读取——支持 `file.ts?start=&end=` 行区间，并借 **LSP documentSymbol 把符号名扩展为行范围**（830-906）：`@src/foo.ts?start=123` 若命中某符号行则扩展到整个符号；
   - MCP resource 附件（703-784）；
   - `@agent` 提及生成 AgentPart + 引导文本 "Use the above message and context to generate a prompt and call the task tool with subagent: X"（974-990）；用户直呼时设置 bypassAgentCheck 跳过 task 权限询问（1223）；
3. 插件钩子 chat.message 可改写消息（999-1009）；
4. 图片归一化后逐条 schema 校验、updateMessage/updatePart 落库。

## 2. runLoop 主循环（prompt.ts:1081-1341）

```ts
while (true) {
  status.set(sessionID, "busy")
  msgs = MessageV2.filterCompactedEffect(sessionID)      // 投影历史（跳过已压缩段）
  {lastUser, lastAssistant, finished, tasks} = MessageV2.latest(msgs)
  // 退出条件（1111-1130）：finish 且非 tool-calls/unknown 且无未决工具调用
  // 孤儿 interrupted 工具不阻塞退出（isOrphanedInterruptedTool, 96-100）
  if (step===1) fork title 生成                          // 小模型异步起标题（1132-1139）
  if (task?.type==="subtask")    { handleSubtask(); continue }     // 子代理分支
  if (task?.type==="compaction") { compaction.process(); continue } // 压缩哨兵分支
  if (isOverflow(finished.tokens, model)) {
    compaction.create(auto); continue                    // 超限触发压缩（1161-1168）
  }
  apply reminders                                        // plan 模式提示等（1180-1184）
  const msg = {...空 Assistant}; updateMessage(msg)       // ★ 先持久化占位再流式填充
  handle = processor.create({assistantMessage: msg, model})
  tools  = SessionTools.resolve({agent, session, model, processor})        // 1226-1241
  if (format.json_schema)
    tools.StructuredOutput = createStructuredOutputTool()                  // 1243-1250
  system = [env块, instructions, mcpInstructions, skills]  // system.ts:67-135 组装
  result = handle.process({system, messages: modelMsgs(+MAX_STEPS_PROMPT 若末步),
                           tools, toolChoice, model})
  if (result==="stop") break
  if (result==="compact") compaction.create()
}
fork compaction.prune(sessionID)                          // 收尾后台剪枝
return lastAssistant(sessionID)
```

## 3. 单写者并发控制

SessionRunState.ensureRunning（run-state.ts:88-94）：同 session 复用同一 Runner，busy 时拒绝并发 prompt——**一个会话同时只有一个循环在跑**，避免历史竞争。

## 4. 自研启示

1. 任务哨兵模式：compaction/subtask 作为特殊 task 记录在消息流里，主循环检测到就分派处理——可恢复、可追踪。
2. assistant 占位先落库再流式更新——崩溃后留下的是"未完成"而非"不存在"。
3. 循环退出条件要同时看 finish 原因和未决工具数。

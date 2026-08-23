# Codex 主循环：run_turn 与采样请求（Responses API 交互）

> 归属：`agent-study/codex/` | 关键词：run_turn、StepContext、run_sampling_request、ResponseEvent、FuturesOrdered、needs_follow_up、end_turn
> 核心文件：`codex-rs/core/src/session/turn.rs`（153-589 主流程；1340-1440 采样；2179-2776 流消费）

---

## 1. run_turn 单次 turn 完整流程（turn.rs:153-589）

```
run_turn()
 ├─ drain_async_hook_results(before_user_prompt)      // 上轮异步钩子结果
 ├─ run_pre_sampling_compact()                        // 采样前预压缩 (:169)
 ├─ required_mcp_servers_for_input()                  // @提及 → 需要哪些 MCP server
 ├─ capture_step_context_with_required_mcp_servers()  // 固化本轮 StepContext
 ├─ record_context_updates_and_set_reference_context_item()  // 注入 environment_context 等
 ├─ build_skills_and_plugins()                        // skill/plugin 注入项
 └─ loop {                                            // ★ 步骤(step)循环
      pending_input = input_queue.get_pending_input()  // 用户 steer 插入的新输入
      step_context = capture_step_context()            // 每步重新捕获（工具集可能变化）
      sampling_input = sess.clone_history().for_prompt(modalities)
      run_sampling_request(...)?
      match result {
        Ok(out) => {
          needs_follow_up |= has_pending_input
          if should_roll_over (token 超限) => run_auto_compact(); continue   // :458-498
          if !needs_follow_up {
             stop_hook 判定是否续跑 (:502-535)
             break                                     // ★ turn 结束
          }
          continue                                     // 有工具调用待跟进 → 下一步
        }
        Err(TurnAborted) => return Err,
        Err(e)  => 发射 ErrorEvent 后 break             // 让用户继续会话 (:574-584)
      }
   }
```

★ StepContext 捕获原则（turn.rs:333 注释）："Capture once so context, advertised tools, and tool calls share one request view."——同一请求内上下文/工具声明/工具调用视图必须一致。

## 2. Prompt 结构 = 发给模型的全部内容（core/src/client_common.rs:19-37）

```rust
pub struct Prompt {
    pub input: Vec<ResponseItem>,           // 对话历史（增量构建，绝不重写历史）
    pub(crate) tools: Arc<[ToolSpec]>,      // 本轮可用工具（含 MCP）
    pub(crate) parallel_tool_calls: bool,
    pub base_instructions: BaseInstructions, // 系统 prompt（按模型选模板）
    pub output_schema: Option<Value>,        // codex exec --output-schema
    pub output_schema_strict: bool,
}
```

## 3. run_sampling_request 重试外壳（turn.rs:1340-1440）

```rust
let tool_runtime = ToolCallRuntime::new(sess, step_context, tracker);  // 每次采样新建
let max_retries = turn_context.provider.info().stream_max_retries();
loop {
    let prompt = build_prompt(history_snapshot, step_context, base_instructions); // :1312
    match try_run_sampling_request(...).await {
        Ok(output) => return Ok((output, original_input.unwrap_or(prompt.input))),
        Err(err) => match err.details() {
            CodexErrorDetails::ContextWindowExceeded => { set_total_tokens_full; return Err }
            CodexErrorDetails::UsageLimitReached(e)   => { update_rate_limits; return Err }
            _ => {}
        },
    }
    if !err.is_retryable() { return Err(err) }
    handle_retryable_response_stream_error(&mut retry_state, max_retries, err, ...)
    // 指数退避重连流
}
```

## 4. 流消费与并行工具排队（try_run_sampling_request :2179-2776）

```rust
let mut stream = client_session.stream(prompt, &model_info, ...)
                    .or_cancel(&cancellation_token).await??;
let mut in_flight: FuturesOrdered<BoxFuture<'static, CodexResult<ResponseInputItem>>>
    = FuturesOrdered::new();                       // ★ 保序收割并行工具
loop {
    let event = stream.next().or_cancel(&cancellation_token).await ...;
    match event {
        ResponseEvent::Created => {}
        ResponseEvent::OutputItemAdded(item) => { /* 流式开始：发 ItemStarted */ }
        ResponseEvent::OutputItemDone(item) => {
            let out = handle_output_item_done(&mut ctx, item, previously_streamed_item).await?;
            if let Some(tool_future) = out.tool_future { in_flight.push_back(tool_future) }
            needs_follow_up |= out.needs_follow_up;
        }
        ResponseEvent::OutputTextDelta(d)       => 发 AgentMessageContentDelta,
        ResponseEvent::ReasoningSummaryDelta{..} => 发 ReasoningContentDelta,
        ResponseEvent::RateLimits(snap)         => record_rate_limits_info,
        ResponseEvent::Completed { response_id, token_usage, end_turn } => {
            record_token_usage_info(...);
            if end_turn == Some(false) { needs_follow_up = true }  // 服务端要求续跑
            break Ok(SamplingRequestResult { needs_follow_up, last_agent_message });
        }
    }
}
drain_in_flight(&mut in_flight, ...).await?;   // :2130-2154 等所有工具完成并写入历史
```

ResponseEvent 完整定义在 codex-api/src/common.rs:76-123。

## 5. 工具调用的解析与错误二元化（stream_events_utils.rs:289-391）

```rust
match ToolRouter::build_tool_call(item.clone()) {
    Ok(Some(call)) => {
        record_completed_response_item(...);              // 先持久化 function_call 再执行
        let tool_future = Box::pin(ctx.tool_runtime.handle_tool_call(call, ct));
        output.needs_follow_up = true;                    // 模型还需下一轮
        output.tool_future  = Some(tool_future);
    }
    Ok(None) => { /* message/reasoning → TurnItem，提取 last_agent_message */ }
    Err(FunctionCallError::RespondToModel(message)) => {
        // 参数解析失败等：把错误文本作为 function_call_output 写回历史，让模型自纠 ★
        output.needs_follow_up = true;
    }
    Err(FunctionCallError::Fatal(message)) => return Err(CodexErr::Fatal(message)),
}
```

★ **错误二元化是类型级约束**：`FunctionCallError::{RespondToModel, Fatal}`——可自愈错误回流模型，致命错误终结 turn。编译器强制每个错误处理点想清楚归属。

## 6. 并行控制与取消（core/src/tools/parallel.rs:92-208）

- 每个 tool call tokio::spawn 到独立任务（AbortOnDropHandle 包裹）；
- 用 `Arc<RwLock<()>>` 门闩：支持并行的工具拿**读锁**，串行工具拿**写锁**（152-156）；
- `tokio::select! { res = &mut dispatch_handle, _ = cancellation_token.cancelled() }`——取消时若已到终态则取结果，否则 abort 任务并生成 aborted_response 回写历史（179-204）。

## 7. 自研启示

1. turn 内 step 循环 + needs_follow_up 布尔是比"消息里数 tool_use"更显式的终止协议。
2. end_turn:false 是服务端主动要求续跑的信号，必须处理。
3. 先持久化 function_call 再异步执行——崩溃后知道有哪些调用在途。

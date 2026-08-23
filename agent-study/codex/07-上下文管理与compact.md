# Codex 上下文管理：token 计数、context window 与 compact

> 归属：`agent-study/codex/` | 关键词：TokenUsage、ContextWindowTokenStatus、BodyAfterPrefix、SUMMARIZATION_PROMPT、InitialContextInjection
> 核心文件：`codex-rs/core/src/compact.rs`、`core/src/session/{mod.rs,context_window.rs}`

---

## 1. Token 计数与窗口

- 权威用量来自服务端：ResponseEvent::Completed { token_usage } → Session::record_token_usage_info()（session/mod.rs:3958-3992）累计 total/last 两套 TokenUsage 并记录 rollout 预算；
- 无服务端计数时兜底估算：recompute_token_usage()（3994-4027）→ estimate_token_count_with_base_instructions()（codex-utils-output-truncation 提供 approx_token_count）;
- send_token_count_event()（4068-4075）发 TokenCountEvent { info, rate_limits }；set_total_tokens_full()（4077-4083）在 ContextWindowExceeded 时把用量钉满窗口。

窗口判定集中在 session/context_window.rs:6-91：

```rust
token_limit_reached =
    buffered_auto_compact_limit.is_some_and(|limit| auto_compact_scope_tokens >= limit)
    || full_context_window_limit_reached;
```

支持 AutoCompactTokenLimitScope::{Total, **BodyAfterPrefix**}——后者只统计"前缀之后新增"的 token（配合服务端 prefill 缓存），auto_compact_window_prefill_tokens 记录该基线（37-51）★。TurnContext::model_context_window() 优先取 config 覆盖 model_context_window，否则取模型目录值。

## 2. Compact / Summarization（core/src/compact.rs）

压缩 prompt 即 SUMMARIZATION_PROMPT；用户消息上限 COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000（57 行）。

关键区分两种注入模式（59-74）：

```rust
pub(crate) enum InitialContextInjection {
    /// Mid-turn 压缩：摘要必须插在最后一条真实用户消息之上（模型训练如此约定）
    BeforeLastUserMessage { world_state, step_context },
    /// Pre-turn/manual 压缩：替换为纯摘要，下一轮再整体重注入初始上下文
    DoNotInject,
}
```

三个触发点：

| 触发点 | 位置 |
|---|---|
| turn 开始前预压缩 | run_pre_sampling_compact（turn.rs:169） |
| mid-turn 达限自动压缩 | run_auto_compact（turn.rs:1178，CompactionReason::ContextLimit + CompactionPhase::MidTurn，成功后 continue 继续当前 turn，469-497） |
| 用户手动 Op::Compact | tasks/compact.rs 独立任务 |

变体与钩子：远端压缩 compact_remote*.rs（后端 /responses 代做摘要）+ 降级链 compact_model_fallback.rs；PreCompact/PostCompact 钩子可在压缩前后注入内容或拦截。压缩产物持久化为 RolloutItem::Compacted，恢复会话据此重建。

## 3. 上下文铁律（AGENTS.md:91-100 原文）

> "No history rewrite – incremental only; avoid cache-busting changes; no unbounded items – hard caps; no item > 10K tokens; all injected fragments must be structs in `core/context` implementing `ContextualUserFragment`"

解读：
1. 不重写历史——只增量追加；
2. 避免打爆缓存的前缀变更；
3. 无界条目禁止——一切有硬上限；
4. 单条不超过 10K token；
5. 所有注入片段必须是 core/context 中实现 ContextualUserFragment 的结构体——注入行为类型化、可审计。

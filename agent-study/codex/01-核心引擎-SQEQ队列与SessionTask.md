# Codex 核心引擎：SQ/EQ 队列、submission_loop 与 SessionTask

> 归属：`agent-study/codex/` | 关键词：async_channel、oneshot、SessionTask、AbortOnDropHandle、RegularTask、input_queue
> 核心文件：`codex-rs/core/src/session/{mod.rs,handlers.rs}`、`core/src/tasks/{mod.rs,regular.rs}`

---

## 1. 通道建立（session/mod.rs）

```rust
// :461-462, :533-534
pub(crate) const SUBMISSION_CHANNEL_CAPACITY: usize = 512;
let (tx_sub, rx_sub)     = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY); // SQ 有界=背压
let (tx_event, rx_event) = async_channel::unbounded();                          // EQ 无界=事件不可丢

// :782-788 常驻提交循环
let session_loop_handle = tokio::spawn(async move {
    submission_loop(session_for_loop, configured_config, rx_sub)
        .instrument(info_span!("session_loop", thread_id = %thread_id)).await;
});
```

Submission 携带唯一 sub_id；Event 携带关联 id，客户端据此把事件关联回提交（protocol_v1.md:53-64）。

## 2. 提交循环 = Op 分发器（handlers.rs:515-694）

```rust
pub(super) async fn submission_loop(sess: Arc<Session>, config: Arc<Config>,
                                    rx_sub: Receiver<Submission>) {
    let mut shutdown_received = false;
    while let Ok(sub) = rx_sub.recv().await {
        let should_exit = async {
            match sub.op {
                Op::Interrupt => { interrupt(&sess).await; false }
                Op::TurnInput { request, mode, reply } => {
                    let result = turn_input::handle(&sess, *request, mode, sub.id).await;
                    let _ = reply.send(result);   // ★ oneshot 回执路由决策
                    false
                }
                Op::ExecApproval { .. } => { exec_approval(..).await; false }
                Op::Compact => { compact(&sess, ..).await; false }
                Op::Shutdown => shutdown(&sess, sub.id.clone()).await,
                _ => false,   // enum 为 non_exhaustive，未知 op 忽略
            }
        }.instrument(dispatch_span).await;
        if should_exit { break }
    }
}
```

★ `Op::TurnInput` 变体内嵌 `oneshot::Sender` 作为回复通道（protocol.rs:573-577）——"请求-应答复用消息队列"的经典手法。

## 3. Task 抽象（tasks/mod.rs:187-227）

```rust
pub(crate) trait SessionTask: Send + Sync + 'static {
    fn kind(&self) -> TaskKind;        // Regular / Compact / Review / UserShell ...
    fn span_name(&self) -> &'static str;
    fn run(self: Arc<Self>, session: Arc<Session>, ctx: Arc<TurnContext>,
           input: Vec<TurnInput>, cancellation_token: CancellationToken)
        -> impl Future<Output = SessionTaskResult> + Send;   // RPITIT，禁 #[async_trait]
    fn abort(&self, ...) -> impl Future<Output = ()> + Send { ... }
}
```

start_task（291-432）：取消并替换旧任务 → 记录 turn 开始时间/token 基线 → 取走队列 pending input → 发射 turn 开始生命周期 → tokio::spawn 运行并用 **AbortOnDropHandle** 包裹句柄（420-431 构造 RunningTask）——杜绝泄漏任务。

任务结束统一走 on_task_finished（571-846）：发射 TurnComplete/TurnAborted、上报 token 用量指标、清理 active_turn。

## 4. RegularTask：对话任务主骨架（tasks/regular.rs:30-91）

```rust
async fn run(...) -> SessionTaskResult {
    let mut next_input = input;
    loop {
        let last_agent_message =
            run_turn(Arc::clone(&sess), Arc::clone(&ctx), next_input,
                     prewarmed_client_session.take(),
                     cancellation_token.child_token()).await?;
        if !sess.input_queue.has_pending_input(&sess.active_turn).await {
            return Ok(last_agent_message);      // 无排队输入 → 结束任务
        }
        next_input = Vec::new();                 // 用户在 turn 进行中又输入了内容 → 继续
    }
}
```

## 5. 优雅中止模式

先 cancel → `Notify` 等待最多 100ms（GRACEFULL_INTERRUPTION_TIMEOUT_MS，tasks/mod.rs:66、905-911）→ 再 handle.abort() → 调 task.abort() 清理 → 补写中断标记到 rollout。

## 6. 自研启示

1. SQ 有界/EQ 无界的 channel 对是 UI-核心解耦的最小完备方案。
2. Op 变体内嵌 oneshot sender 实现请求-应答，无需额外 RPC 层。
3. 所有 spawn 处 AbortOnDropHandle 包裹——Rust 异步任务泄漏的标准防线。

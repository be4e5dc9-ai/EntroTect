# Codex Rust 工程设计借鉴

> 归属：`agent-study/codex/` | 关键词：CancellationToken、AbortOnDropHandle、or_cancel、FuturesOrdered、RPITIT、CodexErrorDetails、协议即代码
> 参考文件：codex-rs/AGENTS.md、各 crate

---

## 1. 异步运行时与取消安全

| 模式 | 细节 |
|---|---|
| 全仓 tokio | 所有长任务持 tokio_util::sync::CancellationToken，spawn 处用 AbortOnDropHandle 包裹（tasks/mod.rs:422）杜绝泄漏 |
| or_cancel 组合子 | codex-async-utils 的 `future.or_cancel(&ct)` 让任意 future 参与协作取消（turn.rs:2222、2269）|
| 生产者通知 | Drop for ResponseStream 里 consumer_dropped.cancel() 主动通知生产者停止拉流（client_common.rs:120-124）|
| 优雅中止 | cancel → Notify 等最多 100ms（GRACEFULL_INTERRUPTION_TIMEOUT_MS，tasks/mod.rs:66、905-911）→ handle.abort() → task.abort() 清理 → 补写中断标记 |

## 2. channel 使用范式

- SQ **有界** async_channel（背压，容量 512），EQ 无界（事件不可丢）（session/mod.rs:533-534）;
- 请求-应答复用队列：Op 变体内嵌 oneshot::Sender（protocol.rs:576）;
- 并行工具用 FuturesOrdered<BoxFuture> 保序收割（turn.rs:2224、2130-2154）;
- 并行门闩：Arc<RwLock<()>> 读锁并行 / 写锁独占（parallel.rs:152-156）;
- Notify / watch 用于完成信号与暂停开关。

## 3. trait 设计

- 禁 #[async_trait]，要求 RPITIT + 显式 Send 约束（AGENTS.md:23-28）：

```rust
fn foo(&self) -> impl Future<Output = T> + Send;
```

- SessionTask（泛型内层，tasks/mod.rs:187）+ AnySessionTask（对象安全 dyn 外层擦除版，229-276）的"泛型内层 + dyn 外层"双层封装是标准解法。

## 4. 错误处理

- thiserror 定义 CodexErr + CodexErrorDetails 分类（TurnAborted / ContextWindowExceeded / UsageLimitReached / InvalidImageRequest…），上层据此决定重试/压缩/终止而非字符串匹配;
- 工具层错误二元化 FunctionCallError::{RespondToModel, Fatal}——"可自愈错误回流模型"成为类型约束（stream_events_utils.rs:363-387）;
- workspace 级 `clippy::unwrap_used / expect_used = deny`（Cargo.toml:506-542）；库 crate `#![deny(clippy::print_stdout)]`（core/lib.rs:6）。

## 5. 协议即代码

一套 Rust 类型派生四份工件——serde JSON（wire）、schemars JSON Schema、ts-rs TypeScript、strum Display；non_exhaustive + serde alias 保证前后兼容（task_started ↔ turn_started）。改协议必须 just write-app-server-schema 再生 fixture。

## 6. 可观测性与仓库治理

- tracing span 贯穿：turn/tool/dispatch 各级 span 带 otel 语义字段 gen_ai.usage.*（turn.rs:2250-2264）；OTel 指标（TURN_TOKEN_USAGE_METRIC 等）+ analytics 事实表双轨；insta 快照测试锁 UI 渲染；
- Bazel+Cargo 双构建（BUILD.bazel 与 Cargo.toml 同步，AGENTS.md:37-43 说明 compile_data 陷阱）；
- 模块 <500 LoC 纪律 + 独立 *_tests.rs 文件（AGENTS.md:49-61、165-178）；
- just 驱动 fmt/test/fix；集成测试基建 core_test_support::responses（mock SSE 服务器 + 断言 POST body，AGENTS.md:222-250）。

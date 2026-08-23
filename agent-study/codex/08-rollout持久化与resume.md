# Codex 会话持久化：rollout 文件格式与 resume/fork

> 归属：`agent-study/codex/` | 关键词：RolloutLine、RolloutItem、SessionMeta、zstd、InitialHistory、rollout_reconstruction、barrier flush
> 核心文件：`codex-rs/rollout/src/{recorder,rollout_file_name,compression,state_db}.rs`、`history/src/lib.rs`

---

## 1. 文件格式

存放位置：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`（rollout_file_name.rs）；归档在 archived_sessions/（lib.rs:67-68）。

每行一个 RolloutLine（history/src/lib.rs:201-207）：

```rust
pub struct RolloutLine {
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u64>,          // 行序号（并发追加去乱序）
    #[serde(flatten)]
    pub item: RolloutItem,
}

pub enum RolloutItem {                  // history/src/lib.rs:95-105
    SessionMeta(SessionMetaLine),       // 首行：id/cwd/originator/cli_version/base_instructions...
    ResponseItem(ResponseItemEnvelope), // 模型可见条目原样持久化（含 harness 元数据）
    InterAgentCommunication(..), InterAgentCommunicationMetadata { trigger_turn: bool },
    Compacted(CompactedItem),           // 压缩检查点
    TurnContext(TurnContextItem),       // 每轮 cwd/approval/sandbox 快照（resume 还原用）
    WorldState(WorldStateItem),
    SecurityRiskScore(..),
    EventMsg(EventMsg),                 // 事件也留痕（供 UI 重放）
}
```

首行 SessionMeta（protocol.rs:2881-2921）记录 thread id、fork/parent 血缘、cwd、provider、base_instructions、dynamic_tools 等——resume 时无需重新推导。

大文件优化：
- compression.rs 提供 zstd 压缩 rollout 及后台压缩 worker（spawn_rollout_compression_worker）；
- decode_rollout_line（lib.rs:45-65）绕过 serde flattened+arbitrary_precision 的浮点缓冲 bug;
- SQLite state_db.rs 存线程索引/元数据支撑列表页与全文搜索（list.rs、search.rs）。

## 2. Resume / Fork

- 类型层面 InitialHistory::{New, Cleared, Resumed(ResumedHistory), Forked(Vec<RolloutItem>)}（history/lib.rs:216-222）；ResumedHistory { conversation_id, history: Arc<Vec<RolloutItem>>, rollout_path };
- 重建逻辑 core/src/session/rollout_reconstruction.rs（22KB 实现 + 78KB 测试）：从 rollout 条目重建内存历史、世界状态基线、每轮 settings hydration，并处理跨版本兼容（旧会话缺 turn_context_id 等）;
- CLI 面：codex exec resume <SESSION_ID|--last>、fork（exec/src/cli.rs:143-265，含 "--last 时把位置参数当 prompt" 的 clap 变通）;
- app-server 面：thread/resume、thread/fork（ForkSnapshot::TruncateBeforeNthUserMessage(n) 等截断语义，thread_manager.rs:168-181）。

## 3. 写入端顺序保证 ★

RolloutRecorder（recorder.rs）批量缓冲 + 显式 barrier flush——turn 结束、abort、中断标记前后都强制 flush_rollout() 保证事件顺序可依赖。tasks/mod.rs:395-406 与 930-936 注释解释了为何 TurnAborted 前必须先落盘中断标记：崩溃恢复时要能区分"正常结束"和"被打断"。

## 4. 自研启示

1. rollout = JSONL + 时间戳 + ordinal 序号，是最简单的崩溃安全会话格式。
2. TurnContextItem（每轮环境快照）让 resume 精确还原当时的审批/沙箱配置。
3. 关键节点（abort/中断）前强制 flush 是可依赖事件顺序的前提。

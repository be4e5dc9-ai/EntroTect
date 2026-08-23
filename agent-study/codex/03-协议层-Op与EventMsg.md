# Codex 协议层：Op（客户端→核心）与 EventMsg（核心→客户端）

> 归属：`agent-study/codex/` | 关键词：non_exhaustive、serde tag、oneshot、审批反请求、ts-rs、协议演进
> 核心文件：`codex-rs/protocol/src/protocol.rs`（541-705 Op；1290-1506 EventMsg）

---

## 1. Op 枚举（protocol.rs:541-705，节选）

```rust
/// Submission operation
#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
#[non_exhaustive]                                   // ★ 向后兼容：未知变体可安全忽略
pub enum Op {
    Interrupt,
    CleanBackgroundTerminals,
    RealtimeConversationStart(ConversationStartParams),   // 语音实时会话族
    TurnInput { request: Box<TurnInputRequest>, mode: TurnInputMode,
                reply: oneshot::Sender<CodexResult<TurnInputSubmission>> },  // 主入口
    RecoverTurn { thread_settings, reply },               // 中断恢复
    ThreadSettings { thread_settings: ThreadSettingsOverrides },
    InterAgentCommunication { communication: InterAgentCommunication },
    ExecApproval { id, turn_id, decision: ReviewDecision },
    PatchApproval { id, decision: ReviewDecision },
    ResolveElicitation { server_name, request_id, decision, content, meta }, // MCP elicitation 答复
    UserInputAnswer { id, response },                     // request_user_input 工具答复
    RequestPermissionsResponse { id, response },
    DynamicToolResponse { id, response },                 // 自定义动态工具答复
    RefreshMcpServers, ReloadUserConfig,
    Compact,                                              // 手动压缩历史
    ThreadRollback { num_turns: u32 },                    // 丢弃最近 N 个用户轮
    Review { review_request: ReviewRequest },
    ApproveGuardianDeniedAction { event: GuardianAssessmentEvent },
    Shutdown,
    RunUserShellCommand { command: String },              // TUI "!cmd"
}
```

## 2. EventMsg 枚举（protocol.rs:1290-1506，节选）

```rust
#[derive(Debug, Clone, Deserialize, Serialize, Display, JsonSchema, TS)]  // ★ 一套类型派生多工件
#[serde(tag = "type", rename_all = "snake_case")]                          // internally-tagged
pub enum EventMsg {
    Error(ErrorEvent), Warning(WarningEvent),
    TurnStarted(TurnStartedEvent),   // v1 wire 兼容: serde rename "task_started",
                                     // alias "turn_started" (1339)
    TurnComplete(TurnCompleteEvent), // 同上(1348)；含 last_agent_message/error/duration/ttft
    TokenCount(TokenCountEvent),     // 含 info + rate limits
    AgentMessage(..), AgentReasoning(..),
    AgentMessageContentDelta(..), ReasoningContentDelta(..), PlanDelta(..),
    ItemStarted(ItemStartedEvent), ItemCompleted(ItemCompletedEvent),   // v2 条目流
    ExecCommandBegin/OutputDelta/End(..),
    ExecApprovalRequest(..), ApplyPatchApprovalRequest(..),
    RequestPermissions(..), RequestUserInput(..), ElicitationRequest(..),
    DynamicToolCallRequest(..),
    PatchApplyBegin/Updated/End(..), TurnDiff(TurnDiffEvent),
    ContextCompacted(..), ThreadRolledBack(..),
    McpStartupUpdate/Complete(..), McpToolCallBegin/End(..),
    WebSearchBegin/End(..), RawResponseItem(..), RawResponseCompleted(..),
    StreamError(StreamErrorEvent), TurnAborted(TurnAbortedEvent),
    CollabAgent*Begin/End(..) 十种多代理协作事件, SubAgentActivity(..),
    ShutdownComplete, HookStarted/Completed(..),
    RealtimeConversation*(语音), ...
}
```

EventMsg 同时被**持久化为 rollout 行**并被 **ts-rs 导出成 TypeScript** 供前端使用——一套 Rust 类型派生四份工件：serde JSON（wire）、schemars JSON Schema、ts-rs TS、strum Display。

## 3. UI 与核心如何解耦：三层客户端同一核心

| 客户端 | 通信方式 | 证据 |
|---|---|---|
| TUI | 进程内 InProcessAppServerClient 或远程 app-server；TUI 只说 JSON-RPC（thread/start、turn/start、通知 item/*、turn/completed） | tui/src/app_server_session.rs:263-377（AppServerSession、ThreadParamsMode::{Embedded,Remote}） |
| VS Code 等 | codex app-server stdio/WebSocket/UDS 上的 JSON-RPC v2（thread/start\|resume\|fork\|read\|list、turn/start\|steer\|interrupt、审批反请求 execCommandApproval/applyPatchApproval） | docs/codex_mcp_interface.md:11-33、app-server/README.md:76-84 |
| codex exec | 同样经 InProcessAppServerClient（exec/lib.rs:808-812） | — |

## 4. 协议演进规则（AGENTS.md:260-306）

- v2-only 开发；
- camelCase wire；
- `#[serde(tag="type")]` 显式判别联合；
- `just write-app-server-schema` 再生 fixture；
- non_exhaustive + serde alias 保证前后兼容（task_started ↔ turn_started）。

## 5. 自研启示

1. 客户端→核心用带 id 的命令枚举（Op），核心→客户端用带 id 的事件枚举（EventMsg），双向皆 non_exhaustive——这是 agent 进程内/跨进程通信的最稳骨架。
2. 审批是"核心→客户端请求 + 客户端→核心应答"的反向 RPC，与普通事件走同一条队列。
3. 协议类型即代码生成源：改协议必须同步再生 schema/fixture。

# OpenAI Codex CLI 总览：项目定位与 Workspace 结构

> 归属：`agent-study/codex/` | 关键词：codex-rs、crate 划分、Rust、Apache-2.0、app-server、MCP server
> 分析对象：`D:\my agent\codex\`——主体 `codex-rs/`（约 130 个 Rust crate 的 Cargo workspace，edition 2024）+ `codex-cli/`（npm 包装）+ `sdk/`
> 引用基线：commit `343074d4207d572809bd8cea15f4be1d09d98e0b`（main，2026-08-22）——本目录所有 `文件:行号` 仅对该 commit 有效；行号漂移时按文中符号名检索。详见 [`../PINNED-COMMITS.md`](../PINNED-COMMITS.md)

---

## 1. 项目定位

README.md:1："Codex CLI is a coding agent from OpenAI that runs locally on your computer." 本地运行的终端 coding agent：接收指令 → 调 LLM（Responses API）→ 沙箱中执行 shell / 应用补丁 → 流式回传事件给 UI。

它同时是五种形态：
1. 交互式 TUI（`codex`）
2. headless 执行器（`codex exec`，可输出 JSONL）
3. JSON-RPC 服务端（`codex app-server`，驱动 VS Code 扩展等富客户端，app-server/README.md:3）
4. MCP server（`codex mcp-server`）
5. MCP client（连接外部 MCP 工具服务器）

## 2. Workspace 成员分组（codex-rs/Cargo.toml:2-138）

| 分组 | crate | 职责 |
|---|---|---|
| **协议** | `protocol` | 核心数据契约：Op、EventMsg、ResponseItem、AskForApproval、SandboxPolicy、ReviewDecision（纯类型无 IO） |
| | `app-server-protocol` / `codex-api` | app-server JSON-RPC v1/v2 载荷（ts-rs 导出 TS）/ Responses API 结构 + SSE→ResponseEvent 映射（src/common.rs:76） |
| **引擎** | `core` | Agent 引擎：Session / turn 循环 / 工具注册表 / 审批编排 / MCP 编排 / 压缩 / rollout 写入。AGENTS.md:72-83 警告 "resist adding code to codex-core"，鼓励拆新 crate |
| | `tools` / `apply-patch` | ToolSpec、JsonSchema、ToolExecutor trait；自定义补丁格式解析与应用 |
| | `models-manager` / `model-provider-info` / `state` / `history` | 模型目录管理（ETag 增量刷新）、ModelProviderInfo、SQLite 状态库、RolloutItem/RolloutLine 类型 |
| **执行环境** | `sandboxing` / `linux-sandbox` / `windows-sandbox-rs` / `execpolicy` / `network-proxy` / `exec-server` | 跨平台沙箱管理器（Seatbelt/bwrap/Windows RestrictedToken 统一抽象）、bwrap+seccomp 助手二进制、Starlark 命令前缀规则、MITM 网络代理审计、远程执行环境 |
| **客户端** | `tui` / `exec` / `cli` / `app-server` / `mcp-server` / `codex-mcp` / `rmcp-client` | ratatui 终端界面（作为 app-server 的客户端运行）、headless、主二进制子命令分发、JSON-RPC 服务端（stdio/websocket/UDS）、暴露为 MCP server、MCP 连接管理器、rmcp 传输（stdio/HTTP/OAuth 全套 oauth.rs） |
| **持久化/配置** | `rollout` / `config` / `login` | 会话文件（JSONL/zstd）读写列表搜索、config.toml 分层加载与 schema 导出、ChatGPT 登录/API key 认证 |
| **扩展** | `ext/*` | agent、connectors、goal、guardian-v2（LLM 自动审批评审）、image-generation、items、memories、mcp、queue、skills、web-search 等功能插件；extension-api 定义扩展 trait |
| **工具库** | `utils/*` 约 25 个小 crate | absolute-path、output-truncation、stream-parser、pty、fuzzy-match 等单一职责库 |

## 3. 总体心智模型（docs/protocol_v1.md:13-47）

```
UI ──Submission{id, op}──► [SQ 有界512] ──► Codex 核心 ──► [EQ 无界] ──Event{id, msg}──► UI

Session 至多运行一个 Task；一个 Task 由多个 Turn 组成；
每个 Turn = 一次模型请求 + 流式收集 + 工具执行 +（必要时）审批暂停。
"The output of one Turn is the input to the next Turn.
 A Turn yielding no output terminates the Task."
```

SQ 用有界 channel（背压，SUBMISSION_CHANNEL_CAPACITY=512，mod.rs:461）；EQ 用无界（事件不可丢）（mod.rs:533-534）。

## 4. 自研启示

1. 协议 crate 零依赖先行——类型先于一切实现。
2. core 保持薄：功能一律拆独立 crate（"resist adding code to codex-core"）。
3. 同一引擎服务 TUI/exec/app-server/MCP 五种形态——协议解耦的回报。

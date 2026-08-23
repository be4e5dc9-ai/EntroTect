# Codex MCP 接入与其他内置 handler

> 归属：`agent-study/codex/` | 关键词：connection_manager、rmcp-client、namespace、defer_loading、tool_search、elicitation、dynamic tools
> 核心文件：`codex-rs/codex-mcp/src/connection_manager.rs`（40KB）、`core/src/tools/handlers/`

---

## 1. 外部 MCP server 接入

- 配置位置：config.toml `[mcp_servers]`；
- **connection_manager.rs 统一管理连接生命周期与工具清单缓存**——AGENTS.md:35 明确指定此处为所有 MCP 工具/调用变更的唯一入口；
- 传输层在 rmcp-client crate：stdio、streamable HTTP、OAuth 登录全套（oauth.rs 64KB）;
- 工具以 `namespace` 形式暴露给模型（ToolName { namespace, name }，protocol/src/tool_name.rs）；
- 大量工具时经 defer_loading + tool_search 检索式按需加载（见 04 文档 ToolSpec 节）。

### MCP elicitation（服务器向用户征询）

映射为 `EventMsg::ElicitationRequest`，用户答复经 `Op::ResolveElicitation` 回传（protocol.rs:624-635）；Guardian 自动审批者也可代答（core/src/session/mcp.rs:68-76）。

## 2. 其他内置 handler 一览（core/src/tools/handlers/）

| handler | 功能 |
|---|---|
| plan.rs | update_plan 计划更新工具 |
| view_image.rs | 把本地图片附加进上下文 |
| current_time.rs | 当前时间 |
| get_context_remaining.rs | 告知剩余 token 预算 ★ |
| request_user_input*.rs | 模型主动向用户提问，阻塞等待 Op::UserInputAnswer |
| request_permissions.rs | 模型主动要权限，等待 Op::RequestPermissionsResponse |
| dynamic.rs | app-server 客户端通过协议注册的**自定义提示工具**（schema 来自 protocol/src/dynamic_tools.rs，答案经 Op::DynamicToolResponse 回传） |
| multi_agents*.rs | spawn_agent / send_message 子代理协作 |
| tool_search.rs | 检索式延迟工具加载 |
| sleep.rs | 等待 |

每个 handler 都是 CoreToolRuntime 的实现 = codex_tools::ToolExecutor<ToolInvocation> trait + 钩子/遥测/diff 元数据（registry.rs:55-171），注册进 ToolRegistry。

## 3. 自研启示

1. get_context_remaining（告知模型剩余上下文）是极低成本高收益的工具。
2. "模型主动提问/要权限"作为阻塞式工具 + Op 应答实现，比单向通知更可控。
3. 动态工具注册协议让客户端（IDE）能注入自己的工具而不改核心。

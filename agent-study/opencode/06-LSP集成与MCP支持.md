# opencode LSP 集成与 MCP 支持

> 归属：`agent-study/opencode/` | 关键词：documentSymbol、goToDefinition、mcp local/remote、oauth、resources、mcp_instructions
> 核心文件：`packages/opencode/src/lsp/`、`packages/core/src/v1/config/mcp.ts`、`packages/opencode/src/mcp/index.ts`

---

## 1. LSP（Language Server Protocol）集成

### 服务端组件

| 文件 | 职责 |
|---|---|
| server.ts（56KB） | JSON-RPC LSP 客户端实现 |
| language.ts | 语言 → 服务器映射 |
| launch.ts | 进程拉起 |
| client.ts（23KB） | 会话管理；diagnostics 作为事件广播 |

### 暴露给模型的 lsp 工具（tool/lsp.ts）

9 种操作（11-21 行）：`goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol / goToImplementation / prepareCallHierarchy / incomingCalls / outgoingCalls`

流程：assertExternalDirectoryEffect + `ctx.ask({permission:"lsp"})` → 按 1-based 行列转 LSP 位置执行。

### 隐性使用（即使 lsp 工具关闭）

@文件引用支持 `file.ts?start=123` 形式——若 start 恰好命中某 symbol 行，用 documentSymbol 把范围**扩展为整个符号**（prompt.ts:839-850）。@引用因此可以只给一个行号就拿到完整函数体。

## 2. MCP（Model Context Protocol）支持

### 配置 schema（core/src/v1/config/mcp.ts）

判别联合：
- `local`：stdio——command/cwd/environment/timeout（默认 5000ms）
- `remote`：url/headers/timeout + 可选 oauth（支持 RFC 7591 动态客户端注册、本地回调默认端口 19876）

### 服务状态机（mcp/index.ts，1004 行）

```
connected | disabled | failed | needs_auth | needs_client_registration
接口：clients/tools/prompts/resources/resourceTemplates/add/connect/disconnect/
     getPrompt/readResource/startAuth/authenticate
OAuth 流程：startAuth 返回授权 URL → 本地回调服务器收码 → 换 token 重连
```

基于 `@modelcontextprotocol/sdk` 的 Client。

### 三种接入面

| 面 | 机制 |
|---|---|
| **工具** | McpCatalog.convertTool 转 AI SDK tool；schema 过 ProviderTransform 按 provider 修正；执行前统一 `ctx.ask({permission:<工具名>, patterns:["*"], always:["*"]})`——默认每次询问，一旦 allow 永久记忆 |
| **资源** | 有 resources 能力的服务器额外获得 `list_mcp_resources / list_mcp_resource_templates / read_mcp_resource` 合成工具；权限 pattern 为 `mcp:<server>:<uri>`；blob 大小上限 10MB，mime 白名单（pdf/gif/jpeg/png/webp），其余降级占位文本（442-461） |
| **指令** | 服务器 instructions 字段以 `<mcp_instructions>` XML 注入系统提示词；按权限过滤掉全部工具被禁用的服务器（system.ts:119-135） |

## 3. 自研启示

1. LSP 的价值不只在 lsp 工具本身——符号感知的 @ 引用让上下文注入精准一截。
2. MCP 接入分三面（工具/资源/指令），每面独立开关与权限。
3. 远程 MCP 的 OAuth 动态注册是开箱即用的关键（用户不用手动建 client）。

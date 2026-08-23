# Codex 配置体系与 ModelProvider

> 归属：`agent-study/codex/` | 关键词：ConfigToml、profile、分层加载、strict_config、ModelProviderInfo、WireApi
> 核心文件：`codex-rs/config/src/{config_toml,profile_toml}.rs`、loader/、model-provider-info/src/lib.rs

---

## 1. ConfigToml 顶层类型（config_toml.rs:152-400+）

```rust
#[derive(Deserialize)] #[schemars(deny_unknown_fields)]   // ★ 未知字段报错
pub struct ConfigToml {
    pub model: Option<String>,
    pub model_provider: Option<String>,               // 指向 model_providers map 的 key
    pub model_context_window: Option<i64>,
    pub model_auto_compact_token_limit: Option<i64>,
    pub model_auto_compact_token_limit_scope: Option<AutoCompactTokenLimitScope>,
    pub approval_policy: Option<AskForApproval>,
    pub sandbox_mode: Option<SandboxMode>,
    pub sandbox_workspace_write: Option<SandboxWorkspaceWrite>,
    pub default_permissions: Option<String>,          // ":workspace_roots" 等内置名
    pub permissions: Option<PermissionsToml>,         // 新一代细粒度权限
    pub notify: Option<Vec<String>>,
    pub instructions / developer_instructions,
    pub mcp_servers: HashMap<String, McpServerConfig>,
    pub model_providers: HashMap<String, ModelProviderInfo>,   // 内置 id 不可覆盖 (290-293)
    pub profile: Option<String>,
    pub profiles: HashMap<String, ConfigProfile>,
    pub history: Option<History>,                     // ~/.codex/history.jsonl
    pub features: FeaturesToml,                       // 特性开关矩阵
    ...
}
```

### Profile（profile_toml.rs:22-72）

一组常用选项的命名打包（model/provider/approval/sandbox/effort/personality/features/tui…）；CLI `--profile <name>` 或 config `profile = "..."` 选择，叠加优先级高于全局。

## 2. 分层加载（config/src/loader/）

```
编译期默认 → 用户 $CODEX_HOME/config.toml → 项目级 → 企业 requirements 层
→ 云配置 bundle → -c key=value CLI 覆盖（最高）
```

- strict_config 打开时未知字段报错；
- 改动 ConfigToml 必须跑 `just write-config-schema` 更新 core/config.schema.json（AGENTS.md:34）——配置 schema 与代码同步再生。

## 3. ModelProviderInfo（model-provider-info/src/lib.rs:94-151）

```rust
pub struct ModelProviderInfo {
    pub name: String,
    pub base_url: Option<String>,
    pub env_key: Option<String>,                      // API key 环境变量名
    pub experimental_bearer_token: Option<RedactedString>,
    pub auth: Option<ModelProviderAuthInfo>,          // 命令式取 token
    pub aws: Option<ModelProviderAwsAuthInfo>,        // SigV4（Bedrock）
    pub wire_api: WireApi,                            // 仅剩 Responses；"chat" 已删除并给迁移指引 (57-91)
    pub query_params / http_headers / env_http_headers,
    pub request_max_retries: Option<u64>,             // 上限 100 (34-35)
    pub stream_max_retries / stream_idle_timeout_ms / websocket_connect_timeout_ms,
    pub requires_openai_auth: bool,                   // ChatGPT 登录 vs API key
    pub supports_websockets: bool,                    // Responses over WebSocket
    pub supports_standalone_web_search: bool,
}
```

内置 provider 表 built_in_model_providers()（502）：openai（chatgpt.com/backend-api/codex 或 api.openai.com）、ollama/lmstudio OSS provider、amazon-bedrock 系列。模型能力目录由 models-manager 管理，ETag 增量刷新（ResponseEvent::ModelsEtag，turn.rs:2532-2538）。

## 4. 自研启示

1. deny_unknown_fields + strict 模式是配置 typo 的第一道防线。
2. profile 机制让"不同任务不同审批/沙箱策略"一键切换。
3. provider 配置里显式声明 context window 覆盖值——目录数据不可信时的逃生口。

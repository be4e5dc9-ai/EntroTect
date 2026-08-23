# 跨 Agent 共性总结：四家 coding agent 的共识、分歧与选型建议

> 归属：`agent-study/` | 用途：从零开发自己 agent 前的横向对照。四份源码学习笔记的结论在此收敛。
> 引用基线：四个仓库的分析 commit 见 [`PINNED-COMMITS.md`](./PINNED-COMMITS.md)；本文不直接引用行号，具体机制与行号以各 agent 子目录的主题文件为准。

---

## 1. 四家速览对比表

| 维度 | ClaudeCode | deepseek-harness (dsh) | opencode | codex |
|---|---|---|---|---|
| 语言/运行时 | TS + Bun + React/Ink | TS + Cordis 插件框架（~150 包） | TS + Bun + Effect-TS（V2） | Rust（~130 crate）+ tokio |
| 主循环形态 | while(true) 异步生成器，出口=tool_use 数量 | turn/step 两级状态机 + inbox(next-turn/next-step) | 单写者 runLoop + 任务哨兵（compaction/subtask） | SQ/EQ 队列对 + Task/Turn 状态机 |
| 消息持久化 | JSONL + parentUuid 单链 | 事件溯源 13 种事件 + SurfaceOp replace 可逆压缩 | SQLite Message/Part JSON blob + durable 事件表 | rollout JSONL（timestamp+ordinal） |
| 权限模型 | 五层防御（模式/规则/Bash 安全/LLM 分类器/沙箱+hooks），deny 回喂理由 | 沙箱×审批两旋钮三预设；fail-closed；单调 guard | Ruleset last-match-wins + Deferred ask/reply + cascade reject + always 学习 | AskForApproval 四态 + SandboxPolicy 四态 + 升级重试审批缓存 |
| 工具执行并发 | 连续 safe 分组并行 ≤10 | 屏障+有界滚动池 ≤10，按模型顺序提交 | AI SDK 内结算（V2 FiberSet eager） | spawn+FuturesOrdered 保序收割 + RwLock 门闩 |
| 上下文压缩 | 六层阶梯（预算/snip/micro/collapse/auto/reactive），阈值公式 | 五层防线（计量/剪枝/spill/compaction/SurfaceOp），KV-cache 感知 | overflow 公式 + 哨兵消息两阶段滚动摘要 + prune | pre-sampling/mid-turn/manual 三触发点 + InitialContextInjection 两模式 |
| 子代理 | **递归调用同一 query()**（过滤工具池+sidechain 落盘） | subagent 缝六 provider（含对接 claude-code/codex！）spawn/fork + continuable | TaskTool 派生子会话（深度限制默认 1，结果只回传最后 text） | multi_agents handlers + InterAgentCommunication |
| Provider 抽象 | 同协议多后端（1P/Bedrock/Vertex/Foundry 共用 Anthropic 接口） | LlmAdapter SPI（唯一必须 stream()）+ 代际绑定 | models.dev 目录 + @ai-sdk/* 懒加载 + @opencode-ai/llm Route 四轴 | ModelProviderInfo + WireApi(仅 Responses) |
| 扩展模型 | hooks 协议 + MCP + feature gate 目录 | 一切皆插件（waterfall 中间件）"Plugins, not loop changes" | 插件 Hooks 全集 + MCP 三面接入 + 自定义工具目录 | ext/* crate + hooks + MCP 双向 |

## 2. 全体共识（照做不亏的铁律）

1. **tool_result 必须配对 tool_use**：中断/取消也要合成结果回填——四家都为此写了专门代码。
2. **错误回喂而非崩溃**：工具异常包成 is_error 结果让模型自纠（ClaudeCode `<tool_use_error>` / codex RespondToModel vs Fatal 二元化）。
3. **prompt cache 是一等公民**：静态前缀稳定、schema 缓存、cache_control 断点、BodyAfterPrefix 计量——所有性能设计围绕字节级稳定的前缀。
4. **输出治理前置**：截断常量（50k 字符落盘换预览等量级）在压缩之前先掐住最大爆炸源。
5. **fail-closed 安全默认**：未知工具报错、无沙箱后端拒绝放行、权限无匹配默认询问。
6. **会话 append-only**：改历史都是"新记录阴影旧记录"，磁盘无损可审计。
7. **单写者会话**：一个 session 同时只有一个循环在跑。
8. **取消语义完备**：已启动 drain、未启动写合成配对结果、优雅中止有时限。
9. **循环出口由数据决定**：数 tool_use / needs_follow_up / step 返回值，不信 stop_reason。
10. **UI 只是主循环的消费者**：query()/app-server/server 先做成库或服务，TUI/IDE/headless 都是客户端。

## 3. 关键分歧点（自研时的路线选择）

| 分歧 | 选项 A | 选项 B | 建议 |
|---|---|---|---|
| Provider 层 | 同协议多后端（ClaudeCode） | 中立词汇层多协议（dsh/opencode-llm/codex Responses-only） | 目标单一模型家族选 A；要多家族选 B，且学 opencode 的 Route 正交分解 |
| 会话存储 | JSONL 文件（ClaudeCode/codex） | SQLite（opencode）/ 事件溯源+dsh SurfaceOp | 起步 JSONL；需要同步/审计/多端再上事件溯源 |
| 历史修改 | 就地替换消息数组 | append-only + 表面 replace 阴影 | 直接抄 dsh 的 SurfaceOp 思想，后期迁移成本最低 |
| 权限粒度 | 规则字符串匹配（Tool(pattern)） | tree-sitter AST 解析命令提路径（opencode bash） | 起步规则匹配；bash 安全第二遍上 AST |
| 子代理实现 | 进程内递归 loop（ClaudeCode/opencode） | 独立 provider 注册表可跨进程跨产品（dsh） | 先进程内递归；预留 provider 接口 |
| 压缩策略 | forked agent 九段式摘要 | serialize 成 [User]:/[Assistant]: 文本再摘要 | 后者更简单且四家中两家采用；摘要 prompt 必须保留用户消息与未完成任务 |

## 4. 自研 agent 的推荐骨架（综合最优路径）

```
第 0 周  协议与词汇层：ResponseItem/ContentBlock + Op/EventMsg 信封（抄 codex 第1步）
         最小 SSE 客户端（抄 ClaudeCode 5-case 解析器）
第 1 周  最小主循环（while + tool_use 收集 + is_error 回喂）
         四个工具：read/edit/write/bash（超时+强杀+50k 截断落盘）
第 2 周  权限闸门（三态 behavior + findLast 规则求值 + deny 回喂理由）
         JSONL 持久化 + resume
第 3 周  autocompact（阈值公式 + serialize 摘要 + 工具配对检查）
         错误韧性（413→压缩、max_output→续跑≤3、fallback model+孤儿补偿）
第 4 周  子代理（递归 loop + 工具池过滤 + 防递归）
         server 化（HTTP API + SSE）使 UI 可替换
之后按需：MCP 接入 → LSP → 沙箱平台后端 → 插件 hooks → 事件溯源升级
```

每一步的详细参照文件见各 agent 子目录对应主题文档。

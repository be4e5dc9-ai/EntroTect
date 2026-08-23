# agent-study：四大开源 Coding Agent 源码学习笔记（导航索引）

> **用途**：为下一阶段"从零开发自己的 Agent"做准备。本目录是对四个仓库源码的架构级拆解，每个主题独立成文件，文件名即内容，便于 AI 与人类按主题检索。
>
> **分析对象**（完整克隆于工作区 `D:\my agent\` 下，各含 `.git`）：
> `D:\my agent\ClaudeCode\` ｜ `D:\my agent\deepseek-harness\` ｜ `D:\my agent\opencode\` ｜ `D:\my agent\codex\`
>
> **阅读约定**：
> 1. 所有 `文件:行号` 相对对应仓库根目录，且**仅对 `PINNED-COMMITS.md` 所列 commit 有效**——上游更新后行号会漂移，届时请按笔记中的符号名检索重新锚定；
> 2. 定量数据分三级标注：【源码常量】直接读自代码；【上游注释称】来自上游注释/文档自述、未独立复测；【分析推断】本笔记推断。详见 `PINNED-COMMITS.md` §3。

---

## 快速导航

| 想了解什么 | 去读 |
|---|---|
| **引用基线 / 行号有效性 / 数据来源规范** | [`PINNED-COMMITS.md`](./PINNED-COMMITS.md) |
| **各家提示词原文（逐字汇编，自研直接改编）** | 各目录 `prompts-原文.md` |
| 四家横向对比 + 自研选型建议 | `../00-跨Agent共性总结与选型建议.md` |
| 主循环怎么写 | 各目录 `01/02-核心主循环…` |
| 工具系统怎么设计 | 各目录 `03/04-工具系统…` |
| 权限审批怎么做 | 各目录 `-权限…` 文件 |
| 上下文压缩怎么做 | 各目录 `-上下文管理…` 文件 |
| 会话持久化/resume | 各目录 `-会话存储/持久化…` 文件 |
| 子代理怎么实现 | 各目录 `-子代理…` 文件 |

---

## ClaudeCode/（12 个文件）

从 npm source map 还原的 Claude Code 完整 TS 源码（Bun + React Ink）。

| 文件 | 内容 | 关键词 |
|---|---|---|
| 00-项目定位-技术栈与目录结构.md | 入口链、53+工具目录组织、三前端共享主循环 | dev-entry、REPL、QueryEngine |
| 01-核心Agent主循环-queryLoop.md | while(true) 异步生成器、13 步轮次表、出口=tool_use 数量、两条铁律 | query.ts:241、StreamingToolExecutor.addTool |
| 02-API调用与SSE流式解析.md | paramsFromContext、raw stream 防 O(n²)、SSE 状态机（每 block 一条消息）、90s 看门狗、消息归一化 | content_block_stop、input_json_delta、parentUuid |
| 03-工具系统-接口注册与内置清单.md | Tool 接口逐字段、buildTool fail-closed 默认、注册管线、Zod strictObject、schema 缓存 | toolToAPISchema、assembleToolPool |
| 04-工具执行管线-并发编排与截断.md | partitionToolCalls 连续 safe 分组 ≤10、runToolUse 八步流水线、超时 120/600s、截断三道闸 50k/200k/25k-token | StreamingToolExecutor 状态机 |
| 05-系统提示词组装与缓存策略.md | 静态段+DYNAMIC_BOUNDARY 分界符+动态注册表；gitStatus 走 user prepend 通道保 cache | computeSimpleEnvInfo |
| 06-权限与安全五层防御.md | mode 三态、决策三类+suggestions 协议、规则八来源、Bash wrapper 剥离、sed -i 模拟编辑、yoloClassifier、hooks | CanUseToolFn |
| 07-上下文管理-六层压缩栈.md | 六层阶梯表、阈值公式（effective−13k）、九段式摘要、cache-editing API、熔断 ≤3 | autoCompact threshold 公式 |
| 08-会话持久化与Resume.md | JSONL+parentUuid 链布局、recordTranscript 接链、resume 函数链、sidechain | loadTranscriptFile |
| 09-子代理机制.md | 递归 query() 核心代码、防递归工具隔离、Coordinator 四工具模式、fork 变体冻结 prompt cache | createSubagentContext |
| 10-Provider抽象与韧性恢复.md | 四后端同协议、withRetry/529/fallback、413/max_output/降级三条恢复管线、错误扣留 | FallbackTriggeredError |
| 11-从零复刻最小路径与设计精华.md | 10 步实施表（含验收标准）+ 10 条设计精华 + 行号速查表 | — |
| **prompts-原文.md** | 系统提示词 getSystemPrompt 全实现（静态段+动态注册表）、压缩摘要提示词全文、分界符常量——TS 内嵌模板字符串逐字切片 | You are Claude Code、compact/prompt.ts |

## deepseek-harness/（12 个文件）

DeepSeek 官方 harness（"一切皆插件"，Cordis waterfall 中间件框架）。

| 文件 | 内容 | 关键词 |
|---|---|---|
| 00-总览-Cordis插件框架与包结构.md | harness 含义、Cordis 五要素、waterfall=around-middleware、包分组全景、Python SDK 定位 | "Plugins, not loop changes" |
| 01-核心主循环-turn-step状态机.md | Phase 三态、followup/steer/inject 三输入语义、turn 骨架、sticky max-tokens、request/header 快照、中立词汇类型 | ReactLoopAgent |
| 02-工具调度器-并行池与取消语义.md | 屏障+有界滚动池 ≤10、池边界重分类、ABORTED_BEFORE_DISPATCH 合成配对结果 | commitReady 保序 |
| 03-工具系统-定义接口与执行瀑布管线.md | ToolDefinition（output.render 强制）、七段瀑布管线、单调 guard、signal 熔合、作用域 restrict | canonical 值 |
| 04-内置工具全集与CodeMode.md | 全部内置工具目录表、run_code 折叠 N→1、提示词与执行器共用 collapses() 谓词 | Log-only 子调用 |
| 05-系统提示词注册表.md | PromptSection order 约定、严格变量插值、动态上下文=持久化 user 快照、AGENTS.md touch 注入 | "Model-visible ⟺ logged" |
| 06-LLM适配层SPI.md | LlmAdapter 抽象类、resolveModel 提供 contextWindow、prepareCall 代际绑定、llm/stream waterfall | design-verification twin |
| 07-上下文管理五层防线.md | 计量/剪枝/spill/压缩/SurfaceOp replace 五层详解；KV-cache 感知摘要；compactRegion 工具配对平衡 | SurfaceOp replace ★ |
| 08-权限预设-沙箱缝与审批缝.md | 三预设 yaml、confine(argv,policy) 抽象、ConfinedArgv 方言区分、fail-closed、四后端矩阵 | SANDBOX_UNAVAILABLE |
| 09-会话存储与事件溯源.md | 13 种事件、lossless JSON/seq 连续/ignorable 三纪律、JSONL packChunks+torn tail、fork/end-seed | delegationDepth 持久化 |
| 10-多智能体-subagent-jobs-workflow.md | 六 provider 注册表、continuable vs one-shot、reportFrom 单向回报、jobs 统一注册表、ralph 循环 | subagent-codex 跨产品委托 |
| 11-从零复刻最小路径与设计精华.md | 设计 Top10 + 0-9 阶段路线 + 三条纪律 + 文件索引 | — |
| **prompts-原文.md** | 固定身份段 harness:identity、headless persona 模板（{{model}}/{{cwd}} 变量用法）、压缩指令 COMPACTION_INSTRUCTION——"薄提示词"流派样本 | You are an AI agent powered by DeepSeek Harness |

## opencode/（14 个文件）

SST 团队终端 agent（Server-first，V1→V2 Effect 化演进中）。

| 文件 | 内容 | 关键词 |
|---|---|---|
| 00-总览-monorepo结构与工程文化.md | 包职责表、specs/v2 活文档、分层 AGENTS.md、CONTEXT.md | Server-first |
| 01-消息数据模型-MessagePart与ToolState.md | WithParts 结构、12 种 Part 表、ToolState 四态机、tokens/cost 字段 | CompactionPart |
| 02-核心主循环-runLoop.md | createUserMessage @file LSP 符号扩展、runLoop 伪代码、任务哨兵分支、单写者 ensureRunning | isOverflow 触发点 |
| 03-流式处理processor与事件总线.md | handleEvent 映射表、doom-loop 检测、中断补偿合成结果、EventV2 durable 事件溯源、SSE 先注册监听 | fromError/toModelMessages |
| 04-工具系统-清单与执行管线.md | 内置工具条件启用表（apply_patch 仅 gpt）、动态加载 file:// URL、invalid 兜底、before/after 钩子 | describeTask 动态描述 |
| 05-bash工具实现与Truncate输出治理.md | tree-sitter AST 提路径做权限、命令前缀记忆、raceAll+强杀、30KB 环形预览、Truncate 服务+"委派子代理读" | BashArity.prefix |
| 06-LSP集成与MCP支持.md | lsp 工具 9 操作、@file 符号扩展隐性用 LSP、MCP local/remote/oauth、资源三面接入 | mcp_instructions XML |
| 07-Provider层-modelsdev与运行时适配.md | models.dev 缓存+Flock 锁、20+ SDK 懒加载、repairToolCall 两级修复、transformParams 收口 | BUNDLED_PROVIDERS |
| 08-原生llm路由层-Route四轴分解.md | Protocol×Endpoint×Auth×Framing 正交分解、五大协议、providerExecuted 直通、generateObject 合成工具 | Route.make |
| 09-权限系统-lastmatchwins.md | findLast 求值代码、ask/reply 流程、cascade reject、always 学习重评 pending、默认值表、.env 保护 | evaluate() |
| 10-上下文管理与压缩.md | overflow 公式、哨兵消息两阶段、preserve_recent_tokens clamp(25%,2k..15k)、prune 双阈值、V2 Context Epoch | compaction.txt 无工具 agent |
| 11-存储Share与ServerClient架构.md | SQLite 表清单、share 增量同步、API 端点全集、TUI 只走 SDK、headless/Embedded | session_input 收件箱 |
| 12-子代理TaskTool派发.md | 六内置 agent 表、深度限制默认 1、三条保险 deny、前台晋升后台、task_id 续跑、只回传最后 text | deriveSubagentSessionPermission |
| 13-配置系统插件Hooks与复刻路径.md | 六层配置合并顺序、command $ARGUMENTS、Hooks 全集、9 步复刻路径、设计 Top10 | — |
| **prompts-原文.md** | 系统提示词按模型族 10 份全文（anthropic/gpt/gemini/default/codex/beast…）+ 计划模式 + 子代理/压缩/标题 prompt + 全部 17 个工具描述 txt + 命令模板 | anthropic.txt、compaction.txt、shell.txt |

## codex/（13 个文件）

OpenAI Codex CLI（Rust，协议优先，"核心极简+特性外挂"）。

| 文件 | 内容 | 关键词 |
|---|---|---|
| 00-总览-workspace结构.md | 五种运行形态、crate 分组表、SQ/EQ 心智模型 | resist adding code to core |
| 01-核心引擎-SQEQ队列与SessionTask.md | 有界/无界 channel 对、submission_loop match、oneshot 回执、AbortOnDropHandle、优雅中止时限 | RegularTask pending input 续跑 |
| 02-主循环-run_turn与采样请求.md | run_turn 流程图、StepContext 一次捕获原则、Prompt 结构、FuturesOrdered 并行收割、错误二元化 RespondToModel/Fatal、end_turn:false | needs_follow_up |
| 03-协议层-Op与EventMsg.md | Op/EventMsg 枚举节选、non_exhaustive 兼容策略、三层客户端同一核心、协议演进规则 | ts-rs 导出 TS |
| 04-工具系统-exec_command与apply_patch.md | ToolSpec 五变体、exec_command 全参数+session_id 长驻进程、write_stdin、apply_patch Lark 文法+lenient heredoc+流式解析+验证后应用 | FreeformTool |
| 05-MCP接入与其他handler.md | connection_manager 唯一入口、elicitation 反向 RPC、get_context_remaining、dynamic tools | namespace 工具名 |
| 06-沙箱与审批策略.md | 平台矩阵（Seatbelt/bwrap+seccomp/受限令牌）、AskForApproval/SandboxPolicy 枚举、.git/hooks 保护、升级重试审批缓存、Guardian | SandboxViolationEvent 回喂模型 |
| 07-上下文管理与compact.md | token 计数权威+兜底、BodyAfterPrefix 计量口径、InitialContextInjection 两模式、AGENTS.md 上下文铁律 | ContextualUserFragment |
| 08-rollout持久化与resume.md | RolloutLine/RolloutItem 格式、SessionMeta 血缘、zstd 后台压缩、abort 前 barrier flush | rollout_reconstruction |
| 09-配置体系与ModelProvider.md | ConfigToml 字段、profile 打包、六层加载、deny_unknown_fields、WireApi 仅 Responses | just write-config-schema |
| 10-exec模式-TUI-npm包装.md | exec JSONL 稳定事件契约、TUI 只说 JSON-RPC、npm 二进制引导信号转发 | EventProcessorWithJsonOutput |
| 11-Rust工程设计借鉴.md | 取消安全范式、channel 范式、RPITIT trait、错误分类驱动控制流、协议即代码四工件 | clippy unwrap deny |
| 12-从零复刻最小路径.md | 7 步路线（10-14 人日）+ 文件速查表 | — |
| **prompts-原文.md** | 各模型基础指令 md 全文（gpt_5_codex/gpt_5_1/gpt_5_2/apply_patch 版等 6 份）+ prompts crate 模板（SUMMARIZATION_PROMPT=templates/compact/prompt.md、review rubric、审批策略文案等 8 份） | You are Codex, based on GPT-5 |

# opencode 配置系统、插件 Hooks 与复刻路径

> 归属：`agent-study/opencode/` | 关键词：config 合并顺序、command/*.md、$ARGUMENTS、plugin hooks、createOpencode、复刻步骤
> 核心文件：`packages/opencode/src/config/config.ts`、`packages/core/src/v1/config/config.ts:32-190`、`packages/plugin/src/index.ts`

---

## 1. 配置文件位置与加载顺序（config.ts，优先级低→高深合并）

1. 远程 well-known 配置（域名 `/.well-known/opencode` 发现，375-396）；
2. 全局：`~/.config/opencode/{config.json, opencode.json, opencode.jsonc}`（legacy config/ 目录自动迁移 140-141、258-271）；
3. `OPENCODE_CONFIG` 环境变量指定文件 / `OPENCODE_CONFIG_CONTENT` 内联 JSON（401-404、468-476）；
4. 项目：从 worktree 向上 rootFirst 发现 `opencode.json(c)` + 各级 `.opencode/` 目录内同名文件（406-433；OPENCODE_DISABLE_PROJECT_CONFIG 可关）;
5. 账号组织下发配置（console API，478-514）;
6. 企业托管配置：managed 目录 + macOS MDM .mobileconfig 最高优先（516-534）。

同一轮还完成：
- 后台安装插件依赖（437-457）；
- 加载 `command/*.md`：frontmatter 命令模板，支持 `$ARGUMENTS`、`$1..$N` 占位与 `` !`cmd` `` shell 内插（prompt.ts:1356-1481、1592-1596 正则实现）；
- 加载 `agent/*.md`（body 即 prompt）、发现 `.opencode/tool(s)` 与 `.opencode/plugin`；
- 所有文件 `$schema` 指向 https://opencode.ai/config.json 获编辑器补全。

### Schema 全貌（core/src/v1/config/config.ts:32-190）

`$schema / shell / logLevel / server / command / skills / references / watcher / snapshot / plugin[] / share(manual|auto|disabled) / autoupdate / disabled_providers / enabled_providers / model / small_model / default_agent / subagent_depth / username / agent(record) / provider(record) / mcp(record) / formatter / lsp / instructions[] / permission / tools / attachment / enterprise / tool_output{max_lines,max_bytes} / compaction{auto,prune,tail_turns,preserve_recent_tokens,reserved} / experimental{batch_tool, openTelemetry, primary_tools, continue_loop_on_deny, mcp_timeout, policies…}`

## 2. 插件系统（packages/plugin/src/index.ts）

```ts
Plugin = (input, options) => Promise<Hooks>
// input 含 SDK client、project/directory/worktree、$: BunShell (56-74)
```

Hooks 全集（222-334）：chat.message（消息创建前改写）、chat.params（temperature/topP/maxOutputTokens）、chat.headers、permission.ask、command.execute.before、tool.execute.before/after、tool.definition、shell.env、experimental.chat.messages.transform（发 LLM 前重写全部消息）、experimental.chat.system.transform、experimental.text.complete、experimental.session.compacting（替换压缩提示词）、experimental.compaction.autocontinue、event（订阅全部事件）、auth（为任意 provider 提供 OAuth/API-key 登录 UI）、provider.models（注入自定义模型列表）、tool（自带工具）。

加载途径：npm 包（配置 plugin:["pkg",["pkg",opts]]）、`.opencode/plugin` 自动发现；V2 在 packages/plugin/src/v2 建立 Effect/Promise 双 API 面。

## 3. 从零复刻最小路径（9 步）

1. **消息模型**：User/Assistant + Part 判别联合（Text/Reasoning/File/Tool 四态/StepStart/StepFinish 六种起步）；JSON 落 SQLite 两张表足矣。
2. **LLM 适配层**：先接一家 AI SDK 包，把流归一化成自己的 LLMEvent（text-delta/tool-call/step-finish…）——这一步决定后面所有代码的可移植性。
3. **最小循环**：prompt() 建 user 消息 → while(true){ 取历史 → 无未决工具且 finish≠tool-calls 则 break → 建 assistant 占位持久化 → resolve 工具 → stream 处理事件落库 }。
4. **工具框架**：define(id,{description,parameters,execute}) + 统一包装（解码校验→执行→截断→span）；先做 read/grep/glob/bash/edit/write 七件套；bash 至少有超时、abort 强杀、输出截断落盘。
5. **权限**：Ruleset + evaluate(findLast last-match-wins, 默认 ask) + pending Deferred + once/always/reply + cascade reject；默认规则抄权限文档 §4。
6. **Server/Client 分层**：HttpApi + POST /session/:id/message + SSE /event（先注册监听再开流）；前端只走 SDK。
7. **子代理**：TaskTool 派生子会话（parentID + 深度限制 + 结果只回传最后 text）。
8. **压缩**：overflow 公式 + 哨兵消息两阶段 + serialize 滚动摘要——长会话可用性分水岭。
9. 再逐步引入 MCP、LSP、plugins hooks、快照回滚、share、Context Epoch。

## 4. 设计精华 Top 10

1. 规格先行 + 可执行约定（specs/v2 活文档、分层 AGENTS.md）。
2. Effect 化服务拓扑：Service extends Context.Service + Layer 组合声明依赖闭包。
3. 事件溯源会话内核：durable 事件 + projector 投影 → 免费获得崩溃恢复、多端同步、审计。
4. 准入/提升分离的输入队列（steer/queue 双语义）。
5. 权限即数据：通配符规则集、last-match-wins、cascade reject、always 学习、可见性过滤、fail-closed 默认、.env 保护、doom-loop 检测。
6. 输出治理三件套：生产者采集上限 → Registry 统一 bounding → Truncate 落盘+"委派子代理去读"提示语。
7. Provider 层正交分解（Protocol×Endpoint×Auth×Framing）+ 统一 LLMEvent。
8. 务实安全工程：tree-sitter 解析 bash 提路径做权限、孤儿 tool_use 补偿、repairToolCall 自愈。
9. 小细节：跨进程 Flock 锁、原子写、端口回退、每 listener 刷新 ConfigProvider。
10. 测试基建：HTTP 录制卡座（cassette 回放/RECORD 重录）。

# DeepSeek Harness（dsh）总览：Cordis 插件框架与包结构

> 归属：`agent-study/deepseek-harness/` | 关键词：harness、Cordis、插件、waterfall、一切皆插件、workspace、Python SDK
> 分析对象：`D:\my agent\deepseek-harness\`（DeepSeek 官方 agent harness，MIT，v0.1.1-rc.2，pnpm monorepo 约 150 个包）
> 引用基线：commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（master，2026-08-21）——本目录所有 `文件:行号` 仅对该 commit 有效；行号漂移时按文中符号名检索。详见 [`../PINNED-COMMITS.md`](../PINNED-COMMITS.md)

---

## 1. "harness" 的含义与三个定位事实

Harness（挽具）= 把"只会生成文本与 tool call 的 LLM"变成可持续工作 agent 所需的全部外围机械：主循环、历史管理、工具管线、提示词组装、持久化、审批、沙箱、子代理编排、Web UI、SDK。**模型每轮只做一次决策，其余全是 harness 职责。**

1. **一切皆插件**（docs/architecture.md:11-13）："There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads." 连 agent loop 本身都是插件。
2. **Cordis 框架被 vendor 进仓库**（vendor/），设计论文《A Programming Paradigm for Spatiotemporal Composability》。
3. **运行方式**：`npx @deepseek-ai/dsh web` → http://127.0.0.1:3080；源码 `pnpm install && pnpm run build && pnpm dsh web`。

## 2. Cordis 框架五要素（docs/cordis-primer.md:7-13）

| 要素 | 说明 |
|---|---|
| 插件 | 实现了 Service 的对象，或带 inject/apply 的函数 |
| context | 服务仓库；服务认领 `ctx.<key>`（如 `ctx.tools`） |
| 依赖 | `static inject = [...]` 声明，按服务可用性激活而非手工排序 |
| 类型化事件 | 四种分发模式：emit / **waterfall** / parallel / serial |
| 可逆注册 | 所有注册都是 effect，返回 disposer，随插件卸载自动回卷 |

**Waterfall 即 around-middleware**（primer L28-34）：listener 收到 `(...args, next)`，调 `next()` 委托给下一环、不调即短路。这是整个项目唯一的扩展哲学——仓库规则明文 **"Plugins, not loop changes"**。

## 3. Workspace 划分（pnpm-workspace.yaml:1-22）

```yaml
packages:
  - vendor/*            # vendored Cordis
  - packages/*/*        # ~150 个 @deepseek-ai/dsh-* 包（50 个组）
  - native/landlock-run # Landlock 沙箱原生启动器
  - apps/*              # cli（拥有 dsh bin）、web（前端构建产物）
  - website / examples / python/sdk-runtime
```

## 4. 包分组全景

| 组 | 代表包 | 职责 |
|---|---|---|
| **core/** | agent（接口/事件词汇）、agent-loop（默认驱动）、agent-default-model、agent-tool-presentation、scope、session（事件溯源）、system-prompt、tools | 产品 API 主干 |
| **llm/** | llm（中立接口）、llm-deepseek（直连适配器）、llm-pi-ai（多 provider 孪生，休眠挂载）、llm-retry、token-meter | 模型接入 |
| **shell/** | shell 缝 + bash-local/pwsh-local + bash-sandbox/pwsh-sandbox + tool-bash(-persistent) | 命令执行 |
| **fs/** | fs 缝（版本守卫原子写）+ fs-local/fs-sandbox + tool-fs + tool-fs-search(ripgrep) + tool-str-replace-editor | 文件能力 |
| 其他缝 | subprocess / terminal(PTY 六工具) / jobs / e2b 远程沙箱 / lsp / web(search+fetch) / code-runtime(run_code) | 能力扩展 |
| **上下文** | compaction 缝+basic 实现 / spill-policy / token-meter / tool-result-pruner | 五层防线（见 07） |
| 多代理 | subagent / workflow / experimental(agent-team) | （见 10） |
| 交互守卫 | user-approval、user-questions、commands、permission-presets、repeat-tool-reminder([3,5,8])、tool-call-timeout-policy、plan-mode、goal 四件套、schedule、tool-todo、skill、hooks 桥接(Claude Code/Codex hooks 配置兼容)、mcp 桥 | 人机协作 |
| 会话 | session(JSONL/SQLite 后端) / session-query(FTS5) / storage / attachment / settings / credentials | 持久化 |
| 产品面 | bundle(base/headless/web-app)、boot、host(webserver)、api、acp、sdk(protocol/server/client)、client(ui-* 约40个 React 插件)、typert | 装配与界面 |

## 5. Python 部分是什么（python/README.md:5）

**不是评测/benchmark/训练环境——是客户端 SDK**：把 harness 当子进程驱动，stdio 上 newline-delimited JSON-RPC。

```py
from deepseek_harness import DeepSeekHarness
with DeepSeekHarness(provider="deepseek-official", model="deepseek-v4-flash",
                     max_tokens=49_152, cordis="examples/jsonrpc-agent/cordis.yml") as h:
    result = h.run("Make the requested code change.")
# RunResult(session_id, final_response, finish_reason, events, notifications, session_root)
```

- python/sdk = 高层 turns API + 低层 JSON-RPC client；
- python/sdk-runtime = 单 exe 构建部署根（scripts/build-exe-for-python-sdk*.ts 把 workspace 闭包打成可执行文件）；
- finish_reason = 根会话最后一个 turn/end 的 reason.kind——wire 协议直接投影 TS 侧会话事件词汇。

## 6. 自研启示

1. "harness 与模型分离"的心智模型值得照搬：loop 只消费中立的 ContentBlock/StreamChunk。
2. waterfall 中间件模式让所有扩展（压缩、重试、审批、路由）都不改 loop 本体。
3. fail-loud 文化：配置错误在加载时抛错，绝不静默降级。

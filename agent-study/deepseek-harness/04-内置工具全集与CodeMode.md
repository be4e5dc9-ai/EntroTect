# DeepSeek Harness 内置工具全集与 Code Mode（run_code）

> 归属：`agent-study/deepseek-harness/` | 关键词：tool-catalog、bash、str_replace_editor、terminal、job、subagent_fork、run_code、collapses
> 参考文件：`docs/tool-catalog.md`（生成物，L16-43 映射表）、`packages/core/tools/src/code-mode.ts`

---

## 1. 内置工具全集（docs/tool-catalog.md）

| 类别 | 模型可见名 | 包 | 备注 |
|---|---|---|---|
| Shell | `bash` / `pwsh`（一次性）；persistent 变体同名走 PTY | shell/tool-bash(-persistent)、tool-pwsh(-persistent) | run_in_background→jobs |
| 文件读 | `read` `read_image` | fs/tool-fs | — |
| 文件写 | `write` `edit`；`str_replace_editor`(view/create/str_replace/insert) | fs/tool-fs、tool-str-replace-editor | — |
| 搜索 | `glob` `grep`（ripgrep） | fs/tool-fs-search | 250 条封顶溢出转 spill |
| 终端 | `terminal_open/send/read/list/signal/close` | terminal/tool-terminal | owner 隔离 PTY 会话 |
| 任务 | `todo_write`（整列表快照 last-write-wins）；`create_goal/get_goal/update_goal` | tool-todo / goal 四件套 | — |
| 后台 | `job_output/job_list/job_kill` | jobs/tool-jobs | 后台 bash、PTY 发送、subagent 共用同一注册表 |
| Web | `web_search` `web_fetch` | web/tool-web | fetch 默认禁用——SSRF 面留给部署者显式开启（base yml L396-418） |
| 子代理 | `subagent`（continuable）/`subagent_fork`(one-shot)；全局 `send_message/interrupt_agent/list_agents`；child 侧 `report` | subagent/* | 见 10-多智能体 |
| 交互 | `ask_user_question`（挂起直至人回答）；`exit_plan_mode` | interaction/ plan-mode | — |
| 结构化 | `lsp`(definition/references/implementation/hover)；`skill`；`session_search/session_trace/session_event_read…`；`schedule_create/delete/list` | lsp/skill/session-query/schedule | — |
| 编排 | `workflow`（worker 线程跑模型写的 JS 编排脚本）；`ralph`（fresh-agent 固定循环 maxRounds 64） | workflow/* | — |
| Code Mode | `run_code`（唯一保留传输名） | core/tools 自身 | 见下 |
| 自修改(opt-in) | `cordis_define/cordis_run/cordis_stop/cordis_undefine/cordis_inspect_*` | extensions/tool-cordis | agent 挂载自己写的插件 |
| 实验 | Agent Teams 十件套（spawn_teammate/wait_agent/team_task_*…） | experimental/agent-team | 默认禁用 |

目录中每个条目都标注"Requires 哪些缝 / Writes 哪些事件"——**工具被刻意建模为能力缝的 Consumer**。

## 2. Code Mode：把 N 个工具折叠成一个程序调用

### 2.1 机制

- `Config.mode: 'native' | 'code' | 'both'`；
- code 下 wire 上只送 **run_code 一个 schema**，其余工具以生成的 SDK 文档段落进入系统提示词（TypeScript 或 Python 渲染器，SDK_RENDERERS L60-63）;
- 模型写异步函数体，`await tools.name(args)` 触发**嵌套子分发**：
  - 子调用携带 parent token（ToolExecutionInput.parent L330-336）绕过塌缩判定；
  - 重走完整守卫管线（权限不因折叠而绕过）;
  - 结果链接到外层 run_code 结果；
- 子调用日志用独立事件对 `tool/code-dispatch-start` / `tool/code-dispatch`，**Log-only：deriveMessages 忽略它们**——子调用不重复进模型上下文 ★（N 个工具调用只占 1 轮上下文）。

### 2.2 关键不变量：提示词与执行器共用同一谓词

```ts
// L855-863 注释: "the SAME predicate the executor denies by,
//                 so the prompt cannot state a rule the registry does not enforce"
提示词里的塌缩声明 与 执行器拒绝谓词 = 同一个函数 collapses()
CODE_ONLY_INSTRUCTION (L58) 明确告知模型"直接调别的工具会失败"
```

**文档即行为**：模型被告知的规则与注册表强制的规则出自同一处代码，永不漂移。

### 2.3 收益

- 工具数量多时 schema 爆炸 → 折叠后 wire 上只有 1 个工具；
- 循环/条件逻辑在代码里完成，减少多轮往返；
- 代价：需要模型代码能力强 + 沙箱执行环境。

## 3. 自研启示

1. 工具目录文档由脚本 boot 出真值并 verify fresh——文档不会腐烂。
2. Code Mode 的"同谓词"技巧适用于任何"告知模型的限制"：规则只写一处。

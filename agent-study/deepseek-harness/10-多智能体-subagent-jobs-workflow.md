# DeepSeek Harness 多智能体：subagent 缝、jobs 缝、workflow

> 归属：`agent-study/deepseek-harness/` | 关键词：SubagentRuntime、spawn/fork、continuable、delegationDepth、reportFrom、job_output、ralph
> 核心文件：`packages/subagent/subagent/src/index.ts`、`packages/jobs/`、`packages/workflow/workflow/src/index.ts`

---

## 1. 子代理缝：命名 provider 注册表

模块文档（index.ts L4-11）点明取舍：与 bash 缝"一个 context 一个 executor"不同，这里**多 provider 共存**、按名字选择，形状镜像 LLM adapter registry。

六种官方 provider：

| provider | 说明 |
|---|---|
| spawn | 进程内全新子 agent |
| fork | 父日志前缀种子的子 agent |
| subagent-acp | 跨进程 ACP 子进程 |
| **subagent-claude-code / subagent-codex** | 对接别家产品的 one-shot 委托 ★ |
| subagent-dsh-sdk | stdio JSON-RPC 子进程 |

能力协商（L497-512）：请求带 outputSchema/maxDepth/toolFilter/persona 时 provider 必须声明对应 capability，否则 UNSUPPORTED_CAPABILITY。

## 2. 两种运行形态

| 形态 | API | 特点 |
|---|---|---|
| One-shot | start(name, request) → SubagentRun（L430-442） | descriptor 快照随请求固化；前台 |
| **Continuable（持久续聊）** | startContinuable(spec) | child 的 SessionHeader.origin='subagent' + delegationDepth；followup(parent, childId, content) 向 resident child 直投 inbox 或对冷 child 从持久化日志复活（L216-238）；reportFrom(child, content) 是 child→父单向回报（child 是凭据，调用方不能指定收件人）；interrupt(target, authority) 带权限校验 |

★ 深度预算 `assertSubagentMaxDepth` 读的是**持久化的** delegationDepth——types.ts L87-91 注释："runtime-only depth would reset a resumed child to top-level"（重启后递归深度不能清零）。

模型侧工具与注册位置：

```
subagent (continuable，默认后台+自动结算通知)  ┐ 同一包的两份配置实例
subagent_fork (one-shot 前台)                ┘ fork 保持 one-shot 是为了不破坏父请求前缀
send_message / interrupt_agent / list_agents   全局注册一次
report                                          只注册进 continuable child 的作用域
```

## 3. jobs 缝：种类无关的后台作业注册表

- 后台 bash、PTY 发送、schedule、subagent 后台委托**全部登记于同一注册表**；
- 统一能力：id 分配、owner 隔离、轮询、取消、完成监听；
- 模型通过统一三件套操作：`job_output / job_list / job_kill`；
- "后台完成通知"经 agent.inject() 变成下个请求的 user 上下文（搭车进入）。

## 4. Workflow：模型写编排脚本

- workflow 缝 + workflow-worker-thread provider：在 worker 线程跑**模型编写的 JS 编排脚本**，脱离宿主事件循环；脚本内 `agent()` 调用桥接回 ctx.subagents；
- 事件词汇：workflow/start|phase|log|agent-start|agent-end|end（workflow/src/index.ts:36-90）；fatal 错误码枚举 SCRIPT_PARSE/AGENT_CAP/CANCELLED…（L108-120）；
- `ralph` 工具是其固定形态：每轮起 fresh child，模型只选目标与轮数上限（maxRounds 64，base yml L377-383）；
- 实验性 Agent Teams：在 continuable 子代理之上叠 roster/mailbox/task DAG（experimental/agent-team，默认禁用）。

## 5. 自研启示

1. 子代理最小实现 = spawn 一个过滤上下文的子 loop + 结果取最后文本。
2. 深度预算必须持久化到会话 header，否则 resume 后防护失效。
3. 后台作业统一注册表（jobs）比每类任务各写一套管理逻辑省得多。

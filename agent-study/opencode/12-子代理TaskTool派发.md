# opencode 子代理机制：Agent 概念与 TaskTool 派发

> 归属：`agent-study/opencode/` | 关键词：Agent.Info、primary/subagent、build/plan/general/explore、深度限制、后台晋升、task_id 续跑
> 核心文件：`packages/opencode/src/agent/agent.ts`、`tool/task.ts`

---

## 1. Agent 概念（agent.ts:35-56）

```ts
Agent.Info {
  mode: "subagent" | "primary" | "all"
  description, prompt, temperature?, topP?,
  model?, variant?, steps?          // steps = 步数上限
  color, hidden,
  permission: Ruleset               // agent 级权限规则
}
```

内置六个原生 agent（140-265）：

| 名称 | mode | 要点 |
|---|---|---|
| build | primary | 默认；question/plan_enter 放开 |
| plan | primary | edit 全 deny（仅 plans/*.md 例外）、task.general deny 防逃逸 |
| general | subagent | 通用多步研究/执行；todowrite deny |
| explore | subagent | 只读白名单（grep/glob/list/bash/webfetch/websearch/read + 只读 external_directory）；prompt 要求声明 thoroughness 级别 |
| compaction / title / summary | primary(hidden) | 无工具（"*":"deny"）的功能型小 agent |

用户配置 cfg.agent[name] 与原生定义深合并，可覆盖/新建/disable（267-294）。配置目录 `agent/*.md` 的 body 即 prompt。

## 2. TaskTool 派发机制（tool/task.ts）

| 环节 | 细节 | 行号 |
|---|---|---|
| **深度限制** | 沿 parentID 链回溯，超过 cfg.subagent_depth（默认 1，即禁止套娃）报错 | 104-117 |
| 权限门 | 非用户直呼先 ctx.ask({permission:"task", patterns:[subagent_type], always:["*"]}) | 119-129 |
| 子会话派生 | sessions.create({parentID, title:"<desc> (@agent subagent)"})；权限=deriveSubagentSessionPermission(父,子) 再补三条保险 deny：todowrite/task/experimental.primary_tools——子代理默认不能再派子代理 | 139-172 |
| 前台等待 | acquireUseRelease 注册父 abort 监听（中止即取消子会话）；主体 raceFirst(background.wait, waitForPromotion)——允许中途把前台任务"晋升"为后台 | 328-358 |
| 后台模式 | 实验开关；立即返回引导文案 "DO NOT sleep, poll for progress… Work on non-overlapping tasks"；完成后 notify→inject 把 <task_result> XML 作为合成 user 消息注入父会话 | 25-41, 227-254 |
| 续跑 | task_id 参数复用既有子会话继续对话 | 136-138 |
| 结果回传 | **只取子会话最后一条 text part**——子代理的一切中间过程对父不可见 | 224 |

## 3. @提及派发与并行

- 输入里 `@explore` 被 resolvePromptParts 转成 AgentPart + 追加引导文本让模型去调 task 工具（prompt.ts:974-990）；用户直呼时 bypassAgentCheck 跳过 task 权限询问（1223）；
- 并行：同一 assistant turn 里多个 task 调用各自独立结算（V2 用无界 FiberSet eager 执行）。

## 4. 自研启示

1. 子代理 = 子会话（parentID 关联）+ 权限收窄 + 深度限制。
2. 三条保险 deny（todo/task/primary_tools）防递归与状态污染。
3. "结果只回传最后 text"是控制上下文成本的关键取舍。

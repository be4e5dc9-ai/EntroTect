# opencode 权限系统：Ruleset 求值、ask/reply 流程与默认值

> 归属：`agent-study/opencode/` | 关键词：last-match-wins、findLast、Deferred、cascade reject、always 学习、fail-closed、.env 保护
> 核心文件：`packages/schema/src/v1/permission.ts`、`packages/opencode/src/permission/index.ts`、`agent.ts:119-137`

---

## 1. 数据模型（schema/v1/permission.ts:16-35）

```ts
Action  = ["allow", "deny", "ask"]
Rule    = { permission: string, pattern: string, action: Action }
Ruleset = Rule[]
Request = { id, sessionID,
            permission: string,      // 如 "bash"、"edit"、"external_directory"、"doom_loop"
            patterns: string[],      // 本次请求涉及的资源模式
            metadata,                // UI 展示用（命令、路径等）
            always: string[],        // 用户选 always 时要记录的模式
            tool?: {messageID, callID} }
Reply  = ["once", "always", "reject"]
```

## 2. 求值函数：last-match-wins ★

```ts
// permission/index.ts:28-38
export function evaluate(permission, pattern, ...rulesets) {
  return rulesets.flat().findLast(rule =>
      Wildcard.match(permission, rule.permission) &&   // 权限名通配
      Wildcard.match(pattern, rule.pattern))           // 资源模式通配
    ?? { action: "ask", permission, pattern: "*" }     // 无匹配默认 ask
}
```

两个维度（permission 名 × 资源 pattern）都要匹配；**后匹配者优先**——用户后写的规则覆盖先写的。

## 3. ask/allow/deny 完整流程（Permission.Service）

### ask()（index.ts:67-107）

逐 pattern 求 evaluate：
- 任一 `deny` → 立刻抛 DeniedError（附命中规则集供 UI 显示原因）；
- 存在 `ask` → 创建 Deferred 放入 pending Map，发布 permission.asked 事件，挂起等待。

### reply()（109-167 行）——精华

| Reply | 行为 |
|---|---|
| reject | 该 Deferred 以 RejectedError（或带用户反馈的 CorrectedError）失败，并且**级联拒绝同 session 其余所有 pending 请求**——拒绝通常意味着方向错误，后续同类请求没有意义 |
| once | 仅成功当前 |
| **always** | 把 request.always 的模式追加进 approved 规则集，然后**重新求值同 session 所有 pending**，已被新规则覆盖的直接自动成功（153-166）——批准 `git *` 后排队中的 `git commit` 立即放行 |

UI 闭环：permission.asked 经 SSE 到 TUI 弹窗 → `POST /session/:id/permissions/:permissionID {response:"once"|"always"|"reject"}`。

## 4. 配置展开与内置默认

fromConfig（186-198）：一层形式 `{"edit": "ask"}` 或二层形式 `{"bash": {"git *": "allow", "rm *": "deny"}}`；pattern 支持 `~/`、`$HOME` 展开。

内置默认（agent.ts:119-137）：

```ts
{ "*": "allow",
  doom_loop: "ask",
  external_directory: { "*": "ask", /* 截断目录/tmp/skills/references 白名单 */ },
  question: "deny", plan_enter: "deny", plan_exit: "deny",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.example": "allow" } }
```

生效规则：**agent 规则 ⊕ 用户配置 ⊕ session 临时规则** 三层 merge（tools.ts:87）。

## 5. 可见性过滤与 plan 模式

- 整体 deny 的工具直接从工具目录隐藏（visibleTools/disabled，index.ts:204-219）——plan agent 用 `{"edit":{"*":"deny"}}` 实现只读，且模型根本看不到 edit/write；
- task 工具描述里的子代理清单也经 `Permission.evaluate("task", agentName, …)` 过滤（registry.ts:265-270）;
- plan agent 额外 deny `task.general` 防止借子代理逃逸。

## 6. V2 权限增强（core/src/permission.ts）

- assert()：评估+必要时创建持久 Request；
- **项目级持久化批准**：PermissionSaved 服务按 project 存 pattern，跨会话生效；
- source: {type:"tool", messageID, callID} 精确溯源；
- fail-closed 默认：无 agent 权限时 `[{action:"*",resource:"*",effect:"deny"}]`;
- DeclinedError / CorrectedError(feedback) 区分纯拒绝与"拒绝+指导"。

## 7. 自研启示清单

1. 最小权限内核 = Ruleset + findLast 求值 + Deferred pending + 三种 reply + cascade reject + always 学习。
2. 无匹配默认 ask 是安全底线；被整体 deny 的工具从 schema 里消失。
3. .env 文件读取保护是必抄细节。

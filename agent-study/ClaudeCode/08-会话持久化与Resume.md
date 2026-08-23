# Claude Code 会话持久化（JSONL）与 Resume

> 归属：`agent-study/ClaudeCode/` | 关键词：sessionStorage、JSONL、parentUuid、recordTranscript、resume、sidechain
> 核心文件：`src/utils/sessionStorage.ts`

---

## 1. 磁盘布局

```
~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl          ← 主 transcript
~/.claude/projects/<sanitized-cwd>/<sessionId>/
    subagents/agent-<agentId>.jsonl                            ← 子代理 sidechain
    subagents/agent-<agentId>.meta.json                        ← 子代理元数据侧车
    tool-results/<id>.{json|txt}                               ← 超限工具结果落盘
```

按 cwd 哈希分目录 → 同一项目的历史自然聚在一起，`--continue` 按目录找最近会话。

## 2. 格式：JSONL + parentUuid 单链

每行一个 entry，核心字段即 MessageBase：

```ts
{ uuid, parentUuid, timestamp, isMeta, toolUseResult, type, message... }
```

- **增量追加**、崩溃安全（写坏只损失最后一行）；
- 读取保护：单文件 50MB 上限防 OOM；
- parentUuid 链使 resume 时能沿链重建出精确的消息序列（含分支）。

## 3. 写入路径 recordTranscript（:1408）

```
diff 新消息 → insertMessageChain 接到现有链尾
约束："已记录消息仅构成前缀时才追踪父指针"（:1391-1407 注释）
      —— 防 compaction 边界产生孤儿链
flush 队列 100ms 批量落盘（remote 场景切 10ms）
```

## 4. Resume 链路

| 入口 | 函数链 |
|---|---|
| `--resume <sessionId\|.jsonl>` | `loadTranscriptFile :3472` → `buildConversationChain :2069`（沿 parentUuid 重建）→ `checkResumeConsistency :2224` |
| `--continue` | 同上，自动选本目录最近会话 |
| fork 语义 | `adoptResumedSessionFile :1530`：非 fork 直接沿用旧文件续写；fork 复制新文件 |

## 5. 自研启示

1. JSONL + uuid/parentUuid 是最小够用的会话格式——append-only、崩溃安全、可 resume。
2. 大工具结果单独落盘（tool-results 目录），transcript 里只存引用。
3. 子代理 transcript 与主 transcript 物理分离（sidechain），resume 主会话不背子代理历史。

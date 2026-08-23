# opencode 消息数据模型：Message、Part 判别联合与 ToolState

> 归属：`agent-study/opencode/` | 关键词：WithParts、TextPart、ToolPart 四态、StepFinish、CompactionPart、tokens/cost
> 核心文件：`packages/schema`（session schema）、`packages/core/src/session/sql.ts`

---

## 1. Message 与 Part 分离

```ts
WithParts = { info: User | Assistant, parts: Part[] }
```

消息本体（info）只存元数据，内容拆成有序 Part 列表。存储为 SQLite 中的 JSON blob（core/src/session/sql.ts:68-98 `MessageTable.data / PartTable.data`），读取经 `MessageV2.page/hydrate` 游标分页拼装（base64url 编码 {id,time} 游标）。

## 2. AssistantMessage 关键字段

| 字段 | 说明 |
|---|---|
| parentID | 指向触发的 user 消息 |
| modelID / providerID / mode / agent | 本次生成环境 |
| path: {cwd, root} | 快照工作目录 |
| summary?: true | **compaction 摘要消息标记** |
| cost / tokens:{input,output,reasoning,cache:{read,write}} | 用量与成本 |
| 错误联合 | 含 **ContextOverflowError**（驱动压缩）/ ContentFilterError / StructuredOutputError |
| finish? | stop \| tool-calls \| error… |

## 3. Part 判别联合（12 种）

| Part | 要点 |
|---|---|
| TextPart | 文本；`synthetic` 合成标记、time.start/end |
| ReasoningPart | 推理文本 + providerMetadata（如 anthropic signature——跨模型切换时需剥离） |
| FilePart | 附件 mime/url/source(file/symbol/resource 三种来源) |
| **ToolPart** | callID/tool/state——四态机见下 |
| StepStart / StepFinish | step 边界；finish 记 tokens/cost/reason |
| PatchPart / SnapshotPart | git 快照 diff（hash+files） |
| SubtaskPart | 子任务委派记录 |
| CompactionPart | auto/overflow/tail_start_id 压缩标记 |
| AgentPart / RetryPart | @提及派发 / 重试通知 |

## 4. ToolState 状态机（schema 259-313 行）

```
pending   { input, raw }
  → running   { input, title?, metadata?, time.start }      ← ctx.metadata() 运行中多次回调更新
  → completed { output, title, metadata, time{start,end,compacted?}, attachments? }
  | error     { error, metadata?.interrupted }              ← 中断标记
```

- `time.compacted` 时间戳用于 prune 后的 "[Old tool result content cleared]" 占位；
- `metadata.interrupted` 标记被中断的工具，重放时据此补发合成结果。

## 5. 自研启示

1. Message/Part 两层分离让"一条 assistant 消息含多个工具调用+文本交错"变得自然。
2. ToolPart 的 metadata 实时回调通道是 UI 流式进度的通用解法（bash 输出预览就用它）。
3. tokens/cost 存在消息上而非全局计数器——按轮统计免费获得。

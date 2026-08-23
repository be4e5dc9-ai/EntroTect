# Claude Code Provider 抽象与错误韧性恢复

> 归属：`agent-study/ClaudeCode/` | 关键词：getAnthropicClient、Bedrock、Vertex、Foundry、withRetry、413、max_output_tokens、fallback
> 核心文件：`src/services/api/client.ts`（88-316）、`withRetry.ts`、`src/query.ts:1062-1358`

---

## 1. Provider 抽象：同协议多后端

`getAnthropicClient`（client.ts:88-316）按环境变量选后端，四种都伪装成**同一个 Anthropic 客户端接口**：

| Provider | 开关 | 认证与细节 |
|---|---|---|
| Anthropic 1P | 默认 / OAuth | apiKey 与 authToken 双轨；一方专属注入 x-client-request-id |
| Bedrock | `CLAUDE_CODE_USE_BEDROCK` | region 选择（Haiku 有专属 region 变量）；Bearer/API-key/SigV4 三种认证；beta 走 extra_body 而非 betas 数组 |
| Vertex | `CLAUDE_CODE_USE_VERTEX` | 模型级 region 变量优先；GCP 凭证自动刷新 |
| Foundry (Azure) | `CLAUDE_CODE_USE_FOUNDRY` | Azure AD DefaultAzureCredential |

配套：
- `normalizeModelStringForAPI` 模型名归一化；
- beta header 按 provider 合并（tool-search header 也分 provider 差异）；
- **request-id 链**：同一查询链的连续请求共享 id 串联——供服务端/本地分析 prompt cache 命中率。

> 对比：这与 dsh/opencode 的"多协议适配层"是两种哲学。Claude Code 只说 Anthropic 协议，换的是后端；后者定义中立词汇表换的是协议。自研时按目标模型家族二选一。

## 2. 统一重试 withRetry（withRetry.ts）

- 指数退避 + 抖动；
- 529 过载专门计数，达到阈值提前放弃；
- `FallbackTriggeredError` 作为信号：主模型连续失败 → 切 fallbackModel 重试。

## 3. 主循环内的韧性恢复分支（query.ts:1062-1358）

| 故障 | 恢复管线 | 行号 |
|---|---|---|
| **HTTP 413**（请求体过大） | contextCollapse 排水 → reactive compact 全量摘要 → 仍失败才报错 | `query.ts:1119` |
| **max_output_tokens 截断** | 先升到 64k 重试一次 → 注入 meta 消息 "Resume directly from where you left off..." 续跑 → 最多 3 次 | `:164, :1188-1256` |
| **模型持续故障** | FallbackTriggeredError → 换 fallbackModel 重试 + 给孤儿 tool_use 补合成 tool_result + 必要时剥 thinking 签名（不同模型签名不兼容） | `:893-953` |
| **Stop hooks 死循环** | hook 可注入 blocking errors 强制续跑；保留 compact 标志位防止"续跑→压缩→续跑"烧 API | `:1290-1297` |

**关键细节——错误扣留（error withholding）**：流式阶段发生的 API 错误先被扣住不推给 UI（`:799-825`），等恢复管线跑完：恢复了就无声继续，恢复不了才作为最终错误展示。用户看到的是"卡了一下然后继续"，而不是红字报错。

## 4. 自研启示

1. 错误分类驱动恢复：413→压缩；截断→提额+续跑指令；模型故障→换模型+补孤儿结果。
2. 孤儿 tool_use 必须补合成 tool_result（铁律的恢复面）。
3. 恢复动作对用户不可见优先——错误扣留机制。

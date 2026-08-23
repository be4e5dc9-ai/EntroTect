# DeepSeek Harness LLM Provider 适配层（三层结构）

> 归属：`agent-study/deepseek-harness/` | 关键词：LlmAdapter、stream、resolveModel、prepareCall、代际绑定、llm/stream waterfall、llm-retry
> 核心文件：`packages/llm/llm/src/index.ts`、`types.ts`；官方适配器 `packages/llm/llm-deepseek/`、`llm-pi-ai/`

---

## 1. 三层结构总览

```
(1) 词汇层 types.ts      —— provider 中立的 Message/ContentBlock/StreamChunk/
                            FinishReason/TokenUsage/GenerateOptions
(2) Adapter SPI          —— 抽象类 LlmAdapter：唯一必须实现 stream()
(3) Runtime 服务          —— 注册表 + waterfall 中间件 + 故障规范化
```

## 2. 词汇层要点

- ContentBlock / FinishReason / StreamChunk 七种（见主循环文档 §7）；
- `GenerateOptions.purpose?: 'compaction' | 'session-title'`（L376）：给辅助调用打标，adapter 可映射到隐藏传输元数据或专用生成策略（如压缩调用不计入会话标题）。

## 3. Adapter SPI（index.ts L191-260）

```ts
export abstract class LlmAdapter {
  providerInfo(provider): LlmProviderInfo
  providerRetryPolicy(provider): ResolvedRetryPolicy | undefined
  listModels(provider): Promise<readonly LlmModelInfo[]>
    // 目录仅供参考，绝不据此拒绝请求 ★
  resolveModel(provider, model, signal?): Promise<LlmResolvedModelInfo>
    // 精确路由元数据：
    //   context.contextWindow   ← compaction 的压力基准
    //   defaultMaxTokens
    //   reasoning.efforts/defaultEffort ← runtime 据此校验，
    //     不支持的努力等级直接 UNSUPPORTED_REASONING_EFFORT (L790-808)
  prepareCall(provider, model, signal?): Promise<PreparedAdapterCall>
    // 代际绑定：模型元数据解析与最终 dispatch 绑定到同一 adapter 注册代际
    // 防 HMR 半途换 adapter 导致能力错配 (L816-869)
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>  // 唯一必须实现
}
```

**adapterDefaults 标记**（agent.ts:54-61 requestProposal）：prepareCall 物化的默认值会被打标，下一请求提议时剥掉——避免"adapter 默认"伪装成"用户显式选择"。

## 4. Runtime 服务（index.ts L311+）

| 能力 | 细节 |
|---|---|
| 注册 | registerAdapter(providers[], adapter) 全有或全无；原子 replace()（L365-394） |
| 休眠路由 | registerConfigurableProviders（L458-511）声明"可通过设置激活的 provider 目录"——pi-ai 孪生适配器即如此挂载：设置页写入 `llm-pi-ai:` 节激活、清空撤下（base yml L88-97） |
| 模型发现 | discoverModels（L559-586）为设置页"添加自定义 endpoint"服务 |
| PreparedLlmCall | prepareCall 返回一次性调用对象，校验 config 未变否则 INVALID_PREPARED_CALL |
| **llm/stream waterfall** | 所有调用穿过它（L985-999）：重试(llm-retry)、无钥匙快照重放(test-support/llm-replay 从录制 JSONL 重建 chunk)、路由都在这一层插入 |
| 故障规范化 | adapter 抛出的任何失败 → 终结 finish{error\|aborted} chunk（L1003-1011）；中间件/消费者的失败保持 throw——故障归属清晰 |

## 5. 官方双适配器

| 适配器 | 说明 |
|---|---|
| llm-deepseek | 直连 chat-completions：SSE 解析、thinking/reasoningEffort、Files API 上传、translate/serialize 层。默认路由 deepseek-official/deepseek-v4-flash（base yml L63-67） |
| llm-pi-ai | 借 pi-ai 库获得多 provider 目录。README 称 "design-verification twin"——同一契约的两份独立实现互为正确性验证 |

## 6. 自研启示

1. 最小可用 = 只实现 stream() 一个方法的中立词汇层。
2. contextWindow 必须由 resolveModel 提供并喂给压缩引擎——不要硬编码。
3. 所有调用过统一 waterfall：重试、录制重放、路由全部成为外挂。
4. adapter 失败转终结 chunk vs 中间件失败 throw——故障归属清晰的分界线。

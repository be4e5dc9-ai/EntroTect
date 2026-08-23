# opencode Provider 层：models.dev 目录、运行时适配与 turn 组装

> 归属：`agent-study/opencode/` | 关键词：models.dev、BUNDLED_PROVIDERS、懒加载、wrapSSE、repairToolCall、transformParams
> 核心文件：`packages/core/src/models-dev.ts`、`packages/opencode/src/provider/provider.ts`（2047 行）、`session/llm.ts`

---

## 1. models.dev 模型目录客户端（core/src/models-dev.ts）

| 机制 | 细节 |
|---|---|
| 数据源 | `https://models.opencode.ai/api.json`（OPENCODE_MODELS_URL 可覆盖） |
| 缓存 | `~/.cache/opencode/models.json`，原子写 tempfile+rename（202-215） |
| 新鲜度 | Effect.cachedInvalidateWithTTL + mtime 5 分钟检查（165-173、233）；后台每 60 分钟 Schedule.spaced 强刷（255-258） |
| **跨进程并发锁** | 多个 opencode 进程可能同时刷新 → Flock.effect 文件锁互斥（223-229）★ |
| 离线兜底 | bundle 时可内联 OPENCODE_MODELS_DEV 全局常量快照（198-200） |

Model schema（67-121 行）包含：limit.context/input/output、cost（分层计费）、modalities、reasoning_options、interleaved（思考交错字段名）、provider.npm/api（指定用哪个 AI SDK 包与 API 形态）。

## 2. 运行时适配（provider/provider.ts）

- BUNDLED_PROVIDERS 映射表（113-140）：20+ 条 `"@ai-sdk/anthropic": () => import(...).then(m => m.createAnthropic)` ——**全部懒加载**，启动零开销；
- 任意 provider：目录里 provider.npm 指向未内置的 AI SDK 包时，通过 Npm 服务运行时安装并动态 import，再调其自定义 CustomLoader（autoload/getModel/vars/options/discoverModels，142-152）;
- getModel 带 fuzzysort 模糊建议（ModelNotFoundError.suggestions，prompt.ts:601-603 消费——报错即给相近模型名）;
- 网络健壮性：SSE 读空闲超时包装器 wrapSSE（37-83）、请求头超时控制器（85-92）、Vertex 区域端点推导（94-105）。

## 3. 每次 provider turn 的组装（session/llm.ts LLM.Service.stream）

```ts
// llm.ts:95-103 并发取四个依赖
const [language, cfg, item, auth] = yield* Effect.all([
  provider.getLanguage(input.model),   // AI SDK LanguageModelV3 实例
  config.get(),
  provider.getProvider(input.model.providerID),
  auth.get(input.model.providerID),    // API key / OAuth 凭据
])
const prepared = yield* LLMRequestPrep.prepare({...})   // 参数/头/消息预处理
return { type: "ai-sdk", result: streamText({
    includeRawChunks: providerID.includes("github-copilot"), // Copilot 只在原始块里给计费金额
    async experimental_repairToolCall(failed) {              // ★ 工具名自愈 (296-312)
      const lower = failed.toolCall.toolName.toLowerCase()
      if (lower !== failed.toolCall.toolName && prepared.tools[lower])
        return {...failed.toolCall, toolName: lower}
      return {...failed.toolCall, toolName: "invalid",
              input: JSON.stringify({tool, error: failed.error.message})}
    },
    activeTools: Object.keys(prepared.tools).filter(x => x !== "invalid"),
    providerOptions: ProviderTransform.providerOptions(model, prepared.params.options),
    maxRetries: input.retries ?? 0,
    model: wrapLanguageModel({ model: language, middleware: [{
      async transformParams(args) {          // ★ 最后一道按 provider 的消息降级管线
        args.params.prompt = ProviderTransform.message(args.params.prompt, model, ...)
        return args.params
      }}]}),
})}
```

## 4. 双运行时代缝

若开启 flags.experimentalNativeLlm：优先走 LLMNativeRuntime.stream（自研 @opencode-ai/llm 原生路由），不支持时携带原因回落 ai-sdk（226-269）。两条路都归一化为同一 LLMEvent 流（ai-sdk fullStream 经 LLMAISDK.toLLMEvents 逐 part 转换，357-381）。

## 5. 自研启示

1. 模型目录外置（models.dev 类服务）+ 本地缓存 + 跨进程文件锁，是"支持所有模型"的低成本路径。
2. repairToolCall 两级修复：大小写修正 → invalid 兜底回喂。
3. transformParams 中间件作为消息降级的唯一收口点。

---
name: entrotect-provider-adaptation
description: 在 EntroTect 中诊断供应商 API 报错（尤其 400）或接入新供应商时使用。按「查官方文档 → 定 profile → 改适配器 → 补测试 → 发布」的纪律改 packages/core/src/provider。触发词：Mimo/DeepSeek/Kimi/Qwen/OpenAI 等供应商 400、接入新供应商、provider 适配、thinking 参数、reasoning_content。
agent_created: true
---

# EntroTect 供应商 API 适配

## 核心纪律（血泪教训）

1. **绝不靠「收到 400 就换请求体重试」解决问题**。0.4.1–0.4.3 三次补丁都是这个思路，全部失败，因为真正的错在消息体里（缺 `reasoning_content`）。
2. **请求格式在发出前由 profile 决定**：`profiles.ts` 的 `resolveProviderProfile()` 决定鉴权头、token 字段、思考参数、`stream_options`、`temperature`、`preserveReasoningContent`。
3. **HTTP 4xx 是确定的协议错误**：走 `errors.ts` 把上游正文 + 脱敏 URL 抛给 UI；只有网络层失败才由 `transport.ts` 做指数退避重试。
4. **空 `tools: []` 整个字段省略**，严格网关会对空数组 400。

## 排查 400 的固定顺序

1. 让用户贴完整错误信息（重构后错误已带上游正文与 URL）。
2. 查供应商官方文档确认六件事：
   - 鉴权头（`api-key` / `Authorization: Bearer` / `x-goog-api-key`）——只发一个，不要「齐发三个」；
   - 端点路径与 base URL（用 `appendEndpoint` 避免用户粘了完整 URL 时重复拼接）；
   - token 字段：`max_tokens` 还是 `max_completion_tokens`；
   - 思考参数形态：`reasoning_effort`（分档）/ `enable_thinking`（布尔）/ `thinking: {type}`（布尔）/ 无；是否支持关闭；
   - 是否支持 `stream_options.include_usage`；
   - **多轮工具调用时历史 assistant 的 `reasoning_content` 是否必须回传**（Mimo/Kimi/GLM 都要求，缺失直接 400）。
3. 对照 `profiles.ts` 里该供应商的 profile，逐项修正。
4. 若是新供应商：在 `profiles.ts` 加 case + 识别规则（显式 `apiProfile` > `providerId` 匹配 > `baseUrl` 匹配 > **模型名匹配** > generic），并在 `packages/shared/src/reasoning.ts` 的 `PRESET_MODEL_EFFORTS` 里登记真实档位（无分档就写 `[]`，UI 会自动变成布尔开关）。
5. 在 `packages/core/test/provider.test.ts` 补「请求形状」测试：断言 headers、token 字段、thinking 参数，以及**不应存在**的字段。

## 改完必须做的验证

```bash
pnpm --filter @entrotect/shared build    # shared 是类型源，先编
pnpm --filter @entrotect/core build      # host-context.test.ts 走 @entrotect/core 的 dist！
cd packages/core && ./node_modules/.bin/vitest run > out.txt 2>&1   # 再读 out.txt
pnpm --filter @entrotect/app-desktop build
```

**坑**：
- 改了 `packages/core/src` 但没重新 build core，`host-context.test.ts` 会用旧 dist，表现为「测试莫名失败」。
- Bash 工具跑 vitest 时 stdout 经常被吞，必须重定向到文件再用 Read 看。

## 发布

```powershell
powershell -ExecutionPolicy Bypass -File tools\release\auto-release.ps1 -Version 0.4.x -Message "..."
```
（必须用 PowerShell 工具，不能用 Bash 调 powershell。）

## reasoning_content 双向保留链路

`openai-compatible.ts` 流中累积 → `turn-complete.reasoningContent` → `loop/agent.ts` 写入 assistant `Message.reasoningContent` → `session/store.ts` 经 `messageSchema` 持久化 → 下轮 `toOpenAiMessages({preserveReasoning})` 回传。
新增供应商时若要求回传，profile 里 `preserveReasoningContent: true`。

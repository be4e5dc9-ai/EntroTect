## EntroTect 0.4.4

### provider 层整体重构（修复 Mimo 400）

**根因**：小米官方文档确认 —— Mimo 在思考模式下进行多轮工具调用时，历史 assistant 消息的 `reasoning_content` 必须回传，缺失会被 400 拒绝。此前 0.4.1–0.4.3 的「收到 400 就降级重试」补丁只改可选参数，无法修复消息体缺失。

**重构内容**：

- 请求体改由**供应商 profile** 决定（鉴权头 / `max_tokens` vs `max_completion_tokens` / thinking 参数 / `stream_options` / temperature），一次发对，删除 400 猜测式降级
- `reasoning_content` **双向保留**：流中累积 → 存入 assistant 消息（跨会话持久化）→ 按 profile 回传
- `systemPrompt` 首次真正下发（此前三个 provider 都未使用，等于系统提示词从未生效）
- 空 `tools: []` 字段整体省略（严格网关会对空数组 400）
- 修复 Anthropic 适配器致命 BUG：SSE `event:` 行解析丢失导致内容全空；补 thinking_delta / system 注入
- 修复 Google 适配器：systemInstruction 注入、工具结果按工具名配对
- 统一错误处理：上游错误正文 + 脱敏 URL 直达 UI；仅网络错误做指数退避重试
- Mimo 思考档位按官方文档改为布尔开关（仅 enabled/disabled，无分档），输入框底栏布尔 thinking 模型支持 开/关 切换（小米建议在频繁工具调用时关闭 thinking）

**测试**：core 24 文件 / 272 用例全绿（+12）。

**注意**：升级前的旧会话历史缺少 `reasoning_content`，使用 Mimo 等严格供应商时建议升级后新建会话。

### 资产

- `EntroTect-Setup-0.4.4.exe` — Windows 安装包（免管理员权限）
- `SHA256SUMS.txt` — 安装包校验和

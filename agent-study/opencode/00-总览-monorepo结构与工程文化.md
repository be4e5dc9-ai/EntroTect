# opencode 总览：monorepo 结构与工程文化

> 归属：`agent-study/opencode/` | 关键词：SST、Bun、Effect-TS、V1/V2 演进、specs/v2、CONTEXT.md、AGENTS.md 分层
> 分析对象：`D:\my agent\opencode\`（SST 团队开源终端 coding agent，TypeScript monorepo，turbo 构建）
> 引用基线：commit `3a31c4ea801915c0b050df4b3842997ea62b6e93`（dev，2026-08-22）——本目录所有 `文件:行号` 仅对该 commit 有效；行号漂移时按文中符号名检索。详见 [`../PINNED-COMMITS.md`](../PINNED-COMMITS.md)

---

## 1. 一句话本质

> **opencode = 持久化的消息投影 + 单写者 agent 循环 + 数据驱动的权限/工具/事件三个正交子系统 + 一层把 20 家 provider 折叠成统一事件流的适配层。**
> V1 代码（packages/opencode）是"如何写对一个 agent loop"的最佳教材；V2 规格（packages/core + specs/v2）是"如何把 loop 做对到工业级"的路线图。

## 2. 形态

本地 HTTP server 承载全部能力；TUI / VS Code 扩展 / headless CLI / JS SDK 全部是 server 的客户端。`opencode run "prompt"` 可非交互运行。

## 3. 关键包职责

| 包 | 职责 |
|---|---|
| `packages/opencode` | **V1 核心**：session/prompt 主循环、工具、provider、server、权限、压缩 |
| `packages/core` | **V2 新核心**：Effect-TS 服务拓扑、事件溯源、Context Epoch（specs/v2 是其设计文档） |
| `packages/tui` | SolidJS/OpenTUI 终端界面——唯一后端边界是生成的 SDK（specs/tui-package.md:16-31 有所有权划分表） |
| `packages/plugin` | 插件系统（Hooks 全集，见 13-配置） |
| `packages/schema` | Effect Schema 类型（config/permission/message） |
| `packages/llm` | 自研 provider 路由层 @opencode-ai/llm（未来唯一 provider 层） |
| `packages/sdk/js` | createOpencode() 一行嵌入内嵌 server+client |
| `sdks/vscode` | IDE 扩展 |

## 4. 工程文化（值得抄的文档体系）

1. **规格先行**：`specs/v2/*.md` 是活的设计文档——含 ASCII 时序图、状态表、"Current Runner Follow-Ups" 待办清单；
2. **分层 AGENTS.md**：仓库根/包/目录三级，把架构铁律写成 agent 可执行的约束（如"禁止 barrel index"、"Effect v4 没有 Effect.fork，用 forkIn(scope)"）；
3. **CONTEXT.md** 维护领域语言甚至包含示例问答与"已标记歧义"；
4. 测试基建：HTTP 录制卡座（一场景一 cassette、顺序回放、RECORD=true 重录）、fixture-first provider 测试。

## 5. 自研启示

1. 先写 spec 再写码的节奏在 agent 这种复杂系统里收益巨大。
2. Server-first 架构让 UI 可替换（TUI/IDE/headless 共享同一后端）。
3. V1→V2 渐进重写而非推倒重来：新旧两代通过明确的边界共存。

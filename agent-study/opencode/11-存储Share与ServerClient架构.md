# opencode Session 存储、Share 与 Server/Client 架构

> 归属：`agent-study/opencode/` | 关键词：SQLite、Drizzle、share 同步、HttpApi、SSE、TUI SDK 边界、headless、Embedded
> 核心文件：`packages/core/src/session/sql.ts`、`packages/opencode/src/server/server.ts`、`packages/share/share-next.ts`、`packages/tui`

---

## 1. 存储后端

- **主存储 SQLite**（bun:sqlite / node 双驱动经 `#db` import condition 切换）+ Drizzle ORM；50+ 时间戳迁移由 core 统一应用；
- 遗留 JSON 文件存储（storage.ts，按 key-path 存 XDG data 目录）带 Migration 框架迁入 DB——平滑迁移路径示范。

### 关键表（core/src/session/sql.ts）

| 表 | 要点 |
|---|---|
| session | tokens 六列、share_url、revert/permission/model JSON 列（22-66） |
| message / part | JSON blob + 时间戳索引（68-98） |
| todo | 任务清单 |
| session_message | V2 投影，per-session 单调 seq 唯一索引（119-138） |
| **session_input** | 准入收件箱：admitted_seq/promoted_seq/delivery + 部分索引（140-166） |
| session_context_epoch | Context Epoch 快照 |
| event / event_sequence | durable 事件溯源日志 |

消息读取统一走 MessageV2.page/stream/hydrate：游标分页（base64url {id,time}，63-78）、批量 join parts。

## 2. Share 功能（share/share-next.ts）

```
创建：POST /api/shares → {id, url, secret}；URL 写入 session.share_url
同步：订阅本实例事件 → session/message/part/session_diff/model 五类数据
      按 key() 去重合并进队列(97-110) → 批量 POST /api/shares/:id/sync (124-140)
      ——增量、合并写、断网安全
开关：config share: manual|auto|disabled + OPENCODE_DISABLE_SHARE 环境变量
另有 opencode export/import CLI 做会话导出移植
```

## 3. HTTP Server（server/server.ts）

- listen() 端口策略：4096 优先、占用则随机（117-122）；可选 mDNS 广播；
- 每个 listener 装**新鲜的 ConfigProvider**——否则 Effect 默认会缓存首个 process.env 快照（108-114 注释解释得很到位）;
- Default.webHandler 使整个 API 可嵌入任意 fetch 环境（56-65）——SDK Embedded 模式基础。

## 4. API 面（Effect HttpApi 自动产 OpenAPI）

Session 组端点全集（groups/session.ts:78-105）：

```
GET  /session                        列表
GET  /session/status                 各会话 busy/idle/retry 状态图
GET  /session/:id                    详情       GET /session/:id/message   消息分页
POST /session                        创建       GET /session/:id/message/:mid
PATCH /session/:id                   更新标题等  POST /session/:id/message  ★prompt★
DELETE /session/:id                             POST /session/:id/prompt_async 异步prompt
POST /session/:id/fork | abort | init | summarize | shell | command | revert | unrevert
POST/DELETE /session/:id/share                  POST /session/:id/permissions/:pid 权限答复
PATCH/DELETE /session/:id/message/:mid/part/:pid
```

外加组：event(SSE)、global/event(SSE)、pty(WebSocket)、tui 远控、config、file/find、mcp 管理、permission、question、project、workspace、sync(durable 游标同步)、control、experimental。

## 5. TUI 与客户端形态

- TUI 是独立 SolidJS/OpenTUI 应用，**唯一后端边界是生成的 SDK**（specs/tui-package.md:16-31）：CLI 宿主 spawn server 子进程 → TUI 拿 URL 构造 createOpencodeClient → REST 命令 + useEvent().subscribe() 收 SSE 实时渲染；主题/键位配置已迁出到 tui 自有配置。
- headless：`opencode run "prompt"` 非交互发一条 prompt、流式打印、idle 即退出；--format json 输出原始事件流；--continue/--session/--fork 控制续接；也支持 attach 已运行 server。
- JS SDK：createOpencode()（sdk/js/index.ts:8-21）一行起内嵌 server+client；client 拦截器把 x-opencode-directory 头翻译成 ?directory= 查询（client.ts:17-31）实现多目录路由。
- SDK-next/Embedded：进程内执行同一个 HttpRouter（无网络 I/O），Promise 客户端零 Effect 依赖。
- 还有 ACP 协议接入（Zed 编辑器）与 VS Code 扩展（sdks/vscode）。

## 6. 自研启示

1. Server-first：核心能力全部走 HTTP API，UI 可替换、可远程、可嵌入。
2. SSE 三件套：先注册监听再开流、首帧 connected、心跳。
3. 会话数据 SQLite 单文件即可起步，事件表为同步/审计留口。

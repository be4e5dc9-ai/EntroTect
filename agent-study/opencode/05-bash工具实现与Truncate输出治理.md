# opencode bash 工具实现与 Truncate 输出治理

> 归属：`agent-study/opencode/` | 关键词：tree-sitter、路径归一化、cygpath、raceAll、环形缓冲、max_lines、截断目录
> 核心文件：`packages/opencode/src/tool/shell.ts`（645 行）、`truncate.ts`

---

## 1. 命令静态分析（tree-sitter WASM）★

全仓库最值得细读的工具。执行前先解析 AST：

1. 懒加载 `web-tree-sitter` + `tree-sitter-bash` + `tree-sitter-powershell`（311-336 行）；解析 command 节点（620-628）；
2. collect() 遍历识别触碰文件系统的命令集合（28-66 行）：POSIX `rm/cp/mv/mkdir/chmod/cat…`、CWD 类 `cd/pushd…`、Windows CMD `copy/del/dir…`；
3. 对每个路径参数做归一化（127-218 行）：去引号、`~` 展开、`${env:X}` / `$env:` / `$HOME` / `$PWD` / PSHOME 展开、`filesystem::` provider 前缀、glob 前缀截断；MSYS 路径用 `cygpath` 翻译（349-356）。

### 产出两类权限请求 ask()（263-291 行）

| 权限 | patterns | always 记忆模式 |
|---|---|---|
| external_directory | 落在实例目录之外的路径 → `<dir>/*` | — |
| bash | **命令原文 source(node)** | `BashArity.prefix(tokens) + " *"`——记住**命令前缀**而非全文 |

> 用 tree-sitter 解析提取路径做权限，而不是正则匹配——准确率完全不同量级。

## 2. 进程管理

- ChildProcessSpawner.spawn；Effect `raceAll([exitCode, abort, timeout+100ms])` 三方竞争（540-556）；
- abort/timeout 后 `handle.kill({forceKillAfter: "3 seconds"})` 强杀——先礼后兵；
- 默认超时 120000ms（flags.bashDefaultTimeoutMs ?? 120000，347 行）；
- PowerShell 以 `-NoLogo -NoProfile -NonInteractive -Command` 启动；POSIX 下 detached（293-310）。

## 3. 流式输出环形缓冲

fork 一个 fiber 消费 stdout/stderr 合并流（486-531）：

- 维护 list 环形缓冲（上限 maxBytes×2）；
- 最近 **30KB 预览**通过 `ctx.metadata({output: last})` 实时写进 ToolPart——UI 即时滚动显示;
- 全量超过 maxBytes 时把已积累内容写入截断目录文件并切到 append 流（500-523）。

## 4. 最终输出组装

- tail() 保尾部行数/字节限制（225-255）；
- 截断时附 `...output truncated... Full output saved to: <file>`；
- 超时/中止信息放 `<shell_metadata>` 块（561-584）；
- 环境注入钩子：plugin.trigger("shell.env") 允许插件注入环境变量（416-426）。

## 5. Truncate 服务（truncate.ts）——输出治理中枢

| 配置 | 默认 |
|---|---|
| MAX_LINES | 2000（tool_output.max_lines 可配） |
| MAX_BYTES | 50KB（tool_output.max_bytes） |

超限处理：

1. 全量写入共享**截断目录**（保留 7 天，每小时清理，143-148 行）；
2. 返回的提示语会判断该 agent 是否有 task 工具——有则建议 **"委派 explore 子代理去读全量文件，不要自己读"**（129-131）——上下文经济性设计：父上下文只留摘要，重活交给子代理;
3. 截断目录 glob 在所有 agent 的 external_directory 白名单中强制 allow（agent.ts:296-310），子代理能读到。

## 6. 自研启示清单

1. bash 权限判定用 AST 解析提取触碰路径，正则只配做兜底。
2. 进程终止必须"先 cancel 等 N 秒再强杀"。
3. 流式预览（30KB 环形缓冲 + metadata 回调）让长命令不再黑盒。
4. 截断不是终点：落盘 + 指引子代理去读 = 上下文与信息量的双赢。

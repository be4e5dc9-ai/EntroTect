# Codex 外壳层：exec 模式、TUI 与 npm 包装

> 归属：`agent-study/codex/` | 关键词：codex exec、JSONL 事件协议、InProcessAppServerClient、ratatui、平台二进制引导
> 核心文件：`codex-rs/exec/src/{cli.rs,lib.rs,exec_events.rs}`、`tui/src/{app,app_server_session}.rs`、`codex-cli/bin/codex.js`

---

## 1. codex exec（headless）

CLI 定义（exec/src/cli.rs:9-76）：

| 参数 | 作用 |
|---|---|
| --json | JSONL 事件输出 |
| -o/--output-last-message FILE | 最终回复写文件 |
| --ephemeral | 不落盘会话 |
| --output-schema FILE | 约束最终回复的 JSON schema |
| --skip-git-repo-check / --ignore-user-config | 跳过检查 |
| 子命令 Resume/Fork/Review | :143-153 |

执行流程（exec/src/lib.rs run_main:245 → run_exec_session:657）：

- 选择事件处理器（677-684）：EventProcessorWithHumanOutput（人类可读，ANSI 可控）或 EventProcessorWithJsonOutput;
- git repo 检查（799-805，--yolo 时豁免）;
- **同样通过 InProcessAppServerClient 启动 app-server**（808-812），随后走 thread/start(+resume/fork) 与 turn/start，把收到的 ThreadEvent 流翻译输出。

★ JSONL 事件协议独立且稳定（exec_events.rs:11-37）：
`thread.started / turn.started / turn.completed(usage) / turn.failed / item.started|updated|completed / error`
——这是脚本/CI 集成的公开契约，与内部协议解耦。

## 2. TUI 与 core 的关系

TUI（ratatui + crossterm）**不直接 import codex-core 的会话内部**，而是作为 app-server 的 JSON-RPC 客户端：

- tui/src/app_server_session.rs:263 AppServerSession；AppServerClient::{InProcess, Remote}；uses_embedded_app_server() 判定嵌入模式（375-377）;
- 主事件泵 App::handle_tui_event（app.rs:705-900）：键盘/粘贴/Draw/Resize → ChatWidget → 通过 AppServerSession 发 RPC;
- 审批弹窗由服务端反请求驱动（execCommandApproval，default_exec_approval_decisions app.rs:325）。

收益：TUI、VS Code、exec 三端行为一致；"远程 app-server"模式天然可行（ThreadParamsMode::Remote，280-282）。

## 3. codex-cli npm 包 = 平台二进制引导器（bin/codex.js，249 行）

| 环节 | 细节 |
|---|---|
| 平台映射 | 16-23 行 target triple → 可选依赖包名（@openai/codex-linux-x64 … @openai/codex-win32-arm64） |
| 定位真身 | findCodexExecutable()（79-108）在 vendor/<triple>/bin/codex[.exe] 查找 |
| **异步 spawn** | 112-116 注释：Node 必须能响应信号再转发给原生子进程——所以用 spawn 而非 spawnSync；224-226 转发 SIGINT/SIGTERM/SIGHUP；233-248 Promise 收敛退出码/信号镜像 128+n |
| 包管理探测 | 137-177 npm/pnpm/bun 启发式，设置 CODEX_MANAGED_BY_* 与 CODEX_MANAGED_PACKAGE_ROOT 供 Rust 侧参考 |

平台包由 codex-cli/scripts/build_npm_package.py 构建。另有 sdk/typescript（@openai/codex-sdk）与 Python SDK 封装 app-server 协议。

## 4. 自研启示

1. headless 输出用独立的稳定事件协议（不暴露内部类型），是 CI 集成的正确边界。
2. TUI 也走协议客户端——换 UI 零成本，远程化免费获得。
3. Node 引导器转发信号 + 镜像退出码是 CLI 分发的必修课。

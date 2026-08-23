# EntroTect

Windows 桌面 Coding Agent。设计依据见 `agent-study/`（ClaudeCode / deepseek-harness / opencode / codex 四大开源 Agent 源码学习笔记）。

## 安装

双击 `release/EntroTect-Setup-x.y.z.exe` 安装（免管理员权限），安装后从桌面快捷方式或开始菜单启动。

首次使用：打开侧栏底部 **设置**，填入：

| 字段 | 示例 |
|---|---|
| API Base URL | `https://api.deepseek.com/v1` |
| API Key | `sk-…` |
| 模型 | `deepseek-chat` |
| 工作目录 | 工具执行的基准目录（留空 = 用户主目录） |

配置保存在 `%APPDATA%\EntroTect\config.json`，也可用环境变量覆盖：`ENTROTECT_BASE_URL` / `ENTROTECT_API_KEY` / `ENTROTECT_MODEL`。

## 功能(v1)

- Agent 主循环：流式对话 → 工具调用 → 本地执行 → 结果回喂，直至无工具调用
- 6 个内置工具：`read` / `write` / `edit` / `glob` / `grep` / `bash`(PowerShell)
- 权限闸门：只读工具免审；写/改/bash 三选一审批（允许一次 / 本会话总是允许 / 拒绝并回喂理由）；超时默认拒绝
- 会话持久化：JSONL append-only 存于 `%APPDATA%\EntroTect\sessions\`，重启可续
- 输出治理：工具输出超 50KB 自动落盘换预览，防上下文爆炸
- 协议缝：OpenAI 兼容 provider（DeepSeek/OpenAI/Moonshot/Ollama 等可配）

## 结构

```
agent-study/   学习材料(四大开源 Agent 架构笔记)
tools/         Python 构建期工具链(venv 隔离)
  motion/      动效烘焙:弹簧 ODE 解算 → packages/shared/tokens/motion.{css,json}
  assets/      图标与安装包视觉资源(Pillow)
  release/     发布管线:剥注释构建 + NSIS 安装包 + SHA256
  smoke/       无头冒烟测试驱动
packages/
  shared/      core↔UI 协议 DTO(Op/EventMsg/ContentBlock) + 设计 tokens
  core/        Agent 核心(纯 TS,零 Electron 依赖,50 单测)
  app-desktop/ Electron 壳 + React UI
release/      安装包产物
```

## 开发

```powershell
pnpm install
pnpm dev          # 构建全部并启动桌面应用
pnpm test         # core 单元测试
node packages/core/scripts/e2e.mjs   # 真实 API 端到端冒烟(需已配置 key)
```

## 发布

```powershell
cd tools
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt

.venv\Scripts\python release\release.py          # 正式安装包 + SHA256SUMS.txt
.venv\Scripts\python release\release.py --version 0.2.0   # 指定版本
```

**双版本策略**：仓库源码 = 有注释版（单一事实源）；发布管线经 esbuild/vite 剥注释产出**无注释版**并打包，二者永不失同步。

动效参数只改 `tools/motion/gen_motion.py` 顶部常量后重跑，renderer 消费 `packages/shared/tokens` 下的同一份产物。

## 测试

| 命令 | 内容 |
|---|---|
| `pnpm test` | 50 个单元测试（SSE 解析/块装配/主循环闭环/6 工具/权限/会话回环） |
| `tools/smoke/smoke.py` | mock provider 全链路冒烟 |
| `node packages/core/scripts/e2e.mjs` | 真实 API 端到端 |

## 路线图(已预留接口,未实现)

MCP · LSP · 子代理 · 自动压缩(autocompact) · 沙箱 · 插件 hooks · 自动更新 · Rust sidecar 热路径

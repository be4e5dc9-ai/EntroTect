# EntroTect

Windows 桌面 Coding Agent。设计依据见 `agent-study/`（ClaudeCode / deepseek-harness / opencode / codex 四大开源 Agent 源码学习笔记）。

## 安装

从 [**GitHub Releases**](https://github.com/be4e5dc9-ai/EntroTect/releases/latest) 下载最新 `EntroTect-Setup-x.y.z.exe`，双击安装（免管理员权限），安装后从桌面快捷方式或开始菜单启动。同目录 `SHA256SUMS.txt` 可校验安装包完整性。

首次使用：打开侧栏底部 **设置**，填入：

| 字段 | 示例 |
|---|---|
| API Base URL | `https://api.deepseek.com/v1` |
| API Key | `sk-…` |
| 模型 | `deepseek-chat` |
| 工作目录 | 工具执行的基准目录（留空 = 用户主目录） |

配置保存在 `%APPDATA%\EntroTect\config.json`，也可用环境变量覆盖：`ENTROTECT_BASE_URL` / `ENTROTECT_API_KEY` / `ENTROTECT_MODEL`。

## 功能

- Agent 主循环：流式对话 → 工具调用 → 本地执行 → 结果回喂，直至无工具调用；支持子代理 `task` 委派
- 结构化需求澄清：当输入缺少关键参数、存在歧义或多条合理路径时，自动以带说明的选择题请用户确认；用户回复“你决定/随便/直接做”等放权短语则跳过澄清直接执行
- 6 个内置工具：`read` / `write` / `edit` / `glob` / `grep` / `bash`(PowerShell)，另有 `generate_image` 图片生成
- Skills 与斜杠命令：输入框以 `/` 触发本地 skills 自动补全；设置 → Skills 自动扫描 `~/.agents/skills`、`~/.claude/skills`、`~/.config/opencode/skills` 与项目 `tools/`，展示名称/来源/描述并支持刷新
- 权限闸门:输入框底栏三模式——完全访问权限(自动放行)/ 修改需批准(只读免审,写操作审批)/ 全部请求均需批准;审批超时默认拒绝
- 思考强度:输入框底栏选择 低·low / 高·high / 极高·xhigh / 最大·max；设置里可开关“显示模型思考过程”
- 上下文窗口：底栏右侧圆环显示已用占比，未知时为空环（无问号），按钮已缩小；全软件按钮圆角统一为 8px
- 会话持久化：JSONL append-only 存于 `%APPDATA%\EntroTect\sessions\`，重启可续
- 输出治理：工具输出超 50KB 自动落盘换预览，防上下文爆炸
- 外观：对话列表背景与主区一致（平坦分隔），支持日/夜间主题与强调色自定义
- 协议缝：OpenAI 兼容 provider（DeepSeek/OpenAI/Moonshot/Ollama 等可配），支持沙箱与插件 hooks

## 结构

```
agent-study/   学习材料(四大开源 Agent 架构笔记)
tools/         Python 构建期工具链(venv 隔离)
  motion/      动效烘焙:弹簧 ODE 解算 → packages/shared/tokens/motion.{css,json}
  assets/      图标与安装包视觉资源(Pillow)
  release/     发布管线:剥注释构建 + NSIS 安装包 + SHA256 (+ auto-release.ps1 一键发布)
  smoke/       无头冒烟测试驱动
packages/
  shared/      core↔UI 协议 DTO(Op/EventMsg/ContentBlock) + 设计 tokens
  core/        Agent 核心(纯 TS,零 Electron 依赖,219 单测；含 permission/sandbox/clarification)
  app-desktop/ Electron 壳 + React UI（Composer 斜杠补全、ClarificationCard、Skills 设置页）
release/      安装包产物（仅保留当前版本）
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
# 一键：自动提交 → 打包 → 清理旧包 → 静默安装 → 校验 → 推送并发布 GitHub Releases(附安装包)
powershell -ExecutionPolicy Bypass -File tools\release\auto-release.ps1
powershell -ExecutionPolicy Bypass -File tools\release\auto-release.ps1 -Version 0.2.14 -Message "feat: ..."
powershell -ExecutionPolicy Bypass -File tools\release\auto-release.ps1 -SkipGitHub   # 只本地打包安装,不上传
```

**双版本策略**：仓库源码 = 有注释版（单一事实源）；发布管线经 esbuild/vite 剥注释产出**无注释版**并打包，二者永不失同步。

动效参数只改 `tools/motion/gen_motion.py` 顶部常量后重跑，renderer 消费 `packages/shared/tokens` 下的同一份产物。

## 测试

| 命令 | 内容 |
|---|---|
| `pnpm test` | 219 个单元测试（SSE/块装配/主循环/工具/权限/会话/clarification/appearance 等） |
| `tools/smoke/smoke.py` | mock provider 全链路冒烟 |
| `node packages/core/scripts/e2e.mjs` | 真实 API 端到端 |

## 路线图

已实现：子代理、沙箱、插件 hooks、Skills/斜杠命令、结构化澄清、上下文窗口可视化
待实现：MCP · LSP · 自动压缩(autocompact) · 自动更新 · Rust sidecar 热路径

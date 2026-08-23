# EntroTect

Windows 桌面 Coding Agent。设计依据见 `agent-study/`（四大开源 Agent 源码学习笔记）。

## 结构

```
agent-study/   学习材料(ClaudeCode / deepseek-harness / opencode / codex 架构笔记)
tools/         Python 构建期工具链(motion 动效烘焙 / assets 图标 / release 发布 / smoke 冒烟)
packages/
  shared/      core↔UI 协议 DTO + 设计 tokens
  core/        Agent 核心(纯 TS,零 Electron 依赖)
  app-desktop/ Electron 壳 + React UI
```

## 开发

```powershell
pnpm install
pnpm dev        # 构建并启动桌面应用
pnpm test       # 运行 core 单元测试
```

## 构建安装包

```powershell
python tools/release/release.py
# 产物: release/EntroTect-Setup-x.y.z.exe
```

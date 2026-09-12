# EntroTect Python 工具链(构建期,不进运行时)

| 目录 | 用途 | 产出 |
|---|---|---|
| `motion/` | 动效烘焙:弹簧 ODE 数值解算 → CSS keyframes + WAAPI JSON | `packages/shared/tokens/motion.{css,json}` |
| `assets/` | 应用图标/安装包视觉资产生成(Pillow) | `packages/app-desktop/build/*` |
| `release/` | 发布编排:构建剥注释版 + NSIS 安装包 + SHA256 | `release/EntroTect-Setup-*.exe` |
| `smoke/` | 冒烟测试:驱动 core 无头脚本验证 agent 闭环 | 终端报告 |

## 使用

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt

.venv\Scripts\python motion\gen_motion.py    # 重新烘焙动效令牌
.venv\Scripts\python assets\gen_icons.py     # 重新生成图标
.venv\Scripts\python release\release.py      # 出正式安装包
.venv\Scripts\python smoke\smoke.py          # 冒烟测试
```

动效参数(duration/easing/spring)只改 `motion/gen_motion.py` 顶部常量后重跑,
renderer 消费 `shared/tokens` 下的同一份产物,保证单一事实源。

## Ultra 真实模型委派检查

在仓库根目录构建 shared/core 后运行：

```powershell
node tools/smoke/ultra-dispatch.mjs 'C:\Users\你的用户名\AppData\Roaming\@entrotect\app-desktop'
```

使用指定应用目录中的当前模型配置，分别检查复杂调研是否返回有效 `task` 调用、简单问答是否选择直接处理；模型漏掉首轮协作决定时会按正式运行时规则纠正一次。通常产生两次、最多四次真实模型请求和相应 Token 消耗，但不执行工具、不修改应用配置或会话，只输出尝试次数、工具名称和用量；失败时以非零状态退出。

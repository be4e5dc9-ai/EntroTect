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

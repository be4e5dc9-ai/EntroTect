"""EntroTect 冒烟测试。

驱动 core 的无头冒烟脚本(用 mock provider 跑一轮完整 agent 闭环),
在真机模型不可用时也能验证主循环/工具/权限链路没有回归。

用法: python tools/smoke/smoke.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SMOKE_SCRIPT = ROOT / "packages" / "core" / "scripts" / "smoke.mjs"


def main() -> None:
    if not SMOKE_SCRIPT.exists():
        print("[smoke] 跳过: core 冒烟脚本尚未就绪(将在 M2 提供)")
        sys.exit(0)

    print(f"[smoke] node {SMOKE_SCRIPT.relative_to(ROOT)}")
    result = subprocess.run(
        ["node", str(SMOKE_SCRIPT)], cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8",
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode != 0:
        print(f"[smoke] 失败(exit {result.returncode})")
        sys.exit(result.returncode)
    print("[smoke] 通过")


if __name__ == "__main__":
    main()

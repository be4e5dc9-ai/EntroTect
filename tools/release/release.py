"""EntroTect 发布管线编排。

一条命令产出正式安装包(无注释版):
  1. 构建 shared/core(tsc)
  2. 构建 app-desktop 发布版(vite 产物 + esbuild --minify 剥注释后的主进程/预加载)
  3. electron-builder 打 NSIS 安装包
  4. 计算 SHA256 校验和

用法: python tools/release/release.py [--version X.Y.Z]
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_PKG = ROOT / "packages" / "app-desktop" / "package.json"
RELEASE_DIR = ROOT / "release"


def run(cmd: list[str], cwd: Path) -> None:
    print(f"  + {' '.join(cmd)}")
    # Windows 下 pnpm 是 .cmd shim,需要 shell 解析
    result = subprocess.run(cmd, cwd=cwd, shell=(os.name == "nt"))
    if result.returncode != 0:
        print(f"[release] 失败: {' '.join(cmd)} (exit {result.returncode})")
        sys.exit(result.returncode)


def set_version(version: str) -> None:
    data = json.loads(APP_PKG.read_text(encoding="utf-8-sig"))
    data["version"] = version
    APP_PKG.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[release] 版本 -> {version}")


def checksums() -> None:
    sums = []
    for exe in sorted(RELEASE_DIR.glob("*.exe")):
        digest = hashlib.sha256(exe.read_bytes()).hexdigest()
        sums.append(f"{digest}  {exe.name}")
    (RELEASE_DIR / "SHA256SUMS.txt").write_text("\n".join(sums) + "\n", encoding="utf-8")
    print("[release] SHA256SUMS.txt 已生成")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default=None, help="覆盖版本号")
    args = parser.parse_args()

    if args.version:
        set_version(args.version)

    version = json.loads(APP_PKG.read_text(encoding="utf-8-sig"))["version"]
    print(f"[release] EntroTect {version} 开始构建")

    print("[1/4] 构建 @entrotect/shared + @entrotect/core")
    run(["pnpm", "--filter", "@entrotect/shared", "build"], ROOT)
    run(["pnpm", "--filter", "@entrotect/core", "build"], ROOT)

    print("[2/4] 构建 app-desktop 发布版(剥注释)")
    run(["pnpm", "--filter", "@entrotect/app-desktop", "build:min"], ROOT)

    print("[3/4] electron-builder -> NSIS")
    # 观察到的瞬时失败(打包目录句柄/签名工具占用)重试一次即可恢复
    builder_cmd = ["pnpm", "--filter", "@entrotect/app-desktop", "exec", "electron-builder", "--win", "nsis", "--x64"]
    for attempt in range(2):
        result = subprocess.run(builder_cmd, cwd=ROOT, shell=(os.name == "nt"))
        if result.returncode == 0:
            break
        if attempt == 0:
            print("[release] electron-builder 首次失败,重试一次…")
    else:
        print("[release] 失败: electron-builder 重试后仍失败")
        sys.exit(1)

    print("[4/4] 校验和")
    checksums()

    artifacts = [p.name for p in RELEASE_DIR.glob("EntroTect-Setup-*.exe")]
    print(f"[release] 完成: {artifacts}")


if __name__ == "__main__":
    main()

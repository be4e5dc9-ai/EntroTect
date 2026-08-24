"""EntroTect 图标与安装包视觉资产生成(Pillow)。

产出:
  packages/app-desktop/build/icon.ico        多尺寸 Windows 图标
  packages/app-desktop/build/icon.png        256px(应用内使用)
  packages/app-desktop/build/icon-full.png   1024px 母版
  packages/app-desktop/build/banner.png      600x300 宣传横幅
  packages/app-desktop/build/installerSidebarImage.bmp  164x314 NSIS 侧栏
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "packages" / "app-desktop" / "build"

BRAND_TOP = (184, 162, 255, 255)     # lavender purple #B8A2FF
BRAND_BOTTOM = (142, 120, 216, 255)  # lavender shadow
DARK_BG = (14, 14, 17, 255)
WHITE = (255, 255, 255, 255)


def _vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    for y in range(size):
        t = y / (size - 1)
        row = tuple(int(a + (b - a) * t) for a, b in zip(top, bottom))
        ImageDraw.Draw(img).line([(0, y), (size, y)], fill=row)
    return img


def _draw_mark(size: int) -> Image.Image:
    """绘制品牌符号:圆角方块渐变底 + 白色'折线闪电 E'字形。"""
    img = _vertical_gradient(size, BRAND_TOP, BRAND_BOTTOM)
    draw = ImageDraw.Draw(img)

    # 顶部左侧高光,增加立体感
    glow = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        [-size * 0.45, -size * 0.75, size * 1.05, size * 0.42],
        fill=(255, 255, 255, 34),
    )
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # 字形:三条横杠 + 折线,近似闪电化 E
    w = size / 96.0
    stroke = int(10.5 * w)
    x0 = size * 0.30
    x1 = size * 0.70
    y_top = size * 0.30
    y_mid = size * 0.50
    y_bot = size * 0.70

    draw.line([(x0, y_top), (x1, y_top)], fill=WHITE, width=stroke)
    draw.line([(x0, y_mid), (x1 * 0.94, y_mid)], fill=WHITE, width=stroke)
    draw.line([(x0, y_bot), (x1, y_bot)], fill=WHITE, width=stroke)
    draw.line([(x0, y_top - stroke / 2), (x0, y_bot + stroke / 2)],
              fill=WHITE, width=stroke)
    # 斜向切角,形成"断裂闪电"感
    draw.polygon(
        [(x1, y_top - stroke / 2 - stroke * 0.55), (x1 + stroke * 0.9, y_top + stroke * 0.9),
         (x1, y_top + stroke * 1.5)],
        fill=BRAND_TOP[:3] + (255,),
    )

    # 圆角遮罩
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * 0.225), fill=255
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def _make_ico(master: Image.Image) -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(
        OUT_DIR / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=[master.resize((s, s), Image.LANCZOS) for s in sizes[1:]],
    )


def _make_banner(mark: Image.Image) -> None:
    banner = Image.new("RGBA", (600, 300), DARK_BG)
    draw = ImageDraw.Draw(banner)
    # 右侧品牌渐变光晕
    glow = Image.new("RGBA", (600, 300), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [330, -120, 780, 420], fill=BRAND_TOP[:3] + (60,)
    )
    banner = Image.alpha_composite(banner, glow)
    draw = ImageDraw.Draw(banner)

    banner.paste(mark.resize((180, 180), Image.LANCZOS), (52, 60), mark.resize((180, 180), Image.LANCZOS))

    try:
        font_bold = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 52)
        font_light = ImageFont.truetype("C:/Windows/Fonts/segoeuil.ttf", 20)
    except OSError:
        font_bold = ImageFont.load_default()
        font_light = font_bold

    draw.text((262, 108), "EntroTect", fill=WHITE, font=font_bold)
    draw.text((264, 176), "Windows Desktop Coding Agent", fill=(255, 255, 255, 160), font=font_light)
    banner.convert("RGB").save(OUT_DIR / "banner.png")


def _make_sidebar(mark: Image.Image) -> None:
    side = Image.new("RGBA", (164, 314), BRAND_BOTTOM[:3] + (255,))
    glow = Image.new("RGBA", (164, 314), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([-80, 120, 244, 400], fill=(255, 255, 255, 46))
    side = Image.alpha_composite(side, glow)
    side.paste(mark.resize((64, 64), Image.LANCZOS), (50, 54), mark.resize((64, 64), Image.LANCZOS))
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 22)
    except OSError:
        font = ImageFont.load_default()
    ImageDraw.Draw(side).text((38, 132), "EntroTect", fill=WHITE, font=font)
    side.convert("RGB").save(OUT_DIR / "installerSidebarImage.bmp")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = _draw_mark(1024)
    master.save(OUT_DIR / "icon-full.png")
    master.resize((256, 256), Image.LANCZOS).save(OUT_DIR / "icon.png")
    _make_ico(master)
    _make_banner(master)
    _make_sidebar(master)
    print(f"assets -> {OUT_DIR}")


if __name__ == "__main__":
    main()

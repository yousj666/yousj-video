#!/usr/bin/env python3
"""生成应用图标 PNG：暖黑圆角底 + 信号绿圆 + 深色 Y。
画法与 Windows 版（../windows/src/gen_icon.py）完全一致，同一套识别；
Linux 版输出多尺寸 PNG（hicolor 图标主题用）到 src/icons/。"""
import os

from PIL import Image, ImageDraw, ImageFont

S = 256
BG = (11, 13, 12, 255)        # 暖黑 #0b0d0c
GREEN = (30, 215, 96, 255)    # 信号绿 #1ed760
INK = (4, 22, 10, 255)        # 绿底上的深字 #04160a
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# 圆角底
d.rounded_rectangle([4, 4, S - 4, S - 4], radius=52, fill=BG)
# 绿圆
d.ellipse([52, 52, S - 52, S - 52], fill=GREEN)
# 字母 Y（居中）
font = ImageFont.truetype(FONT, 118)
bbox = d.textbbox((0, 0), "Y", font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((S - tw) / 2 - bbox[0], (S - th) / 2 - bbox[1]), "Y", font=font, fill=INK)

out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(out_dir, exist_ok=True)
for size in (256, 128, 64, 48):
    out = os.path.join(out_dir, f"yousj-video-{size}.png")
    img.resize((size, size), Image.LANCZOS).save(out, format="PNG")
    print("wrote", out)

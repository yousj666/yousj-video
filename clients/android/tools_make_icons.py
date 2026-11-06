#!/usr/bin/env python3
"""生成 Yousj 短视频启动图标：深底 #0b0d0c + 信号绿圆 + 深色 Y（与网页版 auth-logo 同款）。
4x 超采样绘制后 LANCZOS 缩放，边缘平滑。各密度 mipmap 齐全。"""
from PIL import Image, ImageDraw, ImageFont
import os

BG = (11, 13, 12, 255)        # #0b0d0c
GREEN = (30, 215, 96, 255)    # #1ed760
INK = (4, 22, 10, 255)        # #04160a
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "res")

DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}
SS = 4  # supersample factor

def draw_icon(size):
    s = size * SS
    img = Image.new("RGBA", (s, s), BG)
    d = ImageDraw.Draw(img)
    # 圆角底（与系统图标裁剪兼容，圆角半径 ~22%）
    r = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=BG)
    # 绿圆居中，直径 ~78%
    m = s * 0.11
    d.ellipse([m, m, s - m, s - m], fill=GREEN)
    # 字母 Y（深墨色，粗体），字号 ~46% 画布
    font = ImageFont.truetype(FONT, int(s * 0.46))
    bbox = d.textbbox((0, 0), "Y", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (s - tw) / 2 - bbox[0]
    y = (s - th) / 2 - bbox[1]
    d.text((x, y), "Y", font=font, fill=INK)
    return img.resize((size, size), Image.LANCZOS)

for folder, size in DENSITIES.items():
    out = os.path.join(BASE, folder, "ic_launcher.png")
    draw_icon(size).save(out)
    print(out, size)
print("icons done")

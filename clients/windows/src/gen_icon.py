#!/usr/bin/env python3
"""生成 app.ico：暖黑圆角底 + 信号绿圆 + 深色 Y（与主站同一套识别）。
用 256x256 画布绘制，再由 PIL 打包多尺寸 ICO。"""
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

out = "src/app.ico"
img.save(out, format="ICO",
         sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out)

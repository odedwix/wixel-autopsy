#!/usr/bin/env python3
"""Draws the Autopsy app icon (1024x1024 PNG): a macOS-style rounded tile with a violet→indigo
gradient and a 2x2 grid of run cards — video (play), image, doc and insights (bars).
Rendered at 4x and downsampled for clean edges.  Usage: make-icon.py out.png"""
import sys
from PIL import Image, ImageDraw, ImageFilter

K = 4                      # supersampling
S = 1024 * K
M = 100 * K                # macOS icon grid: 824px body inside a 1024 canvas
R = 186 * K                # body corner radius
body = (M, M, S - M, S - M)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# Soft drop shadow under the body.
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((M, M + 18 * K, S - M, S - M + 18 * K), R, fill=(20, 12, 60, 110))
img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(28 * K)))

# Body: vertical gradient, clipped by a rounded-rect mask.
grad = Image.new('RGBA', (S, S))
gd = ImageDraw.Draw(grad)
top, bottom = (132, 116, 255, 255), (52, 38, 176, 255)
for y in range(S):
    t = max(0.0, min(1.0, (y - M) / (S - 2 * M)))
    gd.line([(0, y), (S, y)], fill=lerp(top, bottom, t))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle(body, R, fill=255)
img.paste(grad, (0, 0), mask)

# A faint top sheen and a hairline edge give it depth at small sizes.
sheen = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(sheen)
for y in range(M, M + 300 * K):
    a = int(46 * (1 - (y - M) / (300 * K)))
    sd.line([(0, y), (S, y)], fill=(255, 255, 255, a))
img.alpha_composite(Image.composite(sheen, Image.new('RGBA', (S, S), (0, 0, 0, 0)), mask))
ImageDraw.Draw(img).rounded_rectangle(body, R, outline=(255, 255, 255, 40), width=3 * K)

# ImageDraw replaces pixels (no blending), so every translucent shape is drawn on its own layer
# and alpha-composited — otherwise "glass" would punch see-through holes in the tile.
class Layered:
    def _layer(self, fn):
        layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        fn(ImageDraw.Draw(layer))
        img.alpha_composite(layer)

    def rounded_rectangle(self, box, r, fill):
        self._layer(lambda dd: dd.rounded_rectangle(box, r, fill=fill))

    def polygon(self, pts, fill):
        self._layer(lambda dd: dd.polygon(pts, fill=fill))

    def ellipse(self, box, fill):
        self._layer(lambda dd: dd.ellipse(box, fill=fill))

d = Layered()

# 2x2 run cards.
pad, gap = 196 * K, 44 * K
cw = (S - 2 * pad - gap) // 2
cr = 54 * K
cells = [(pad + c * (cw + gap), pad + r * (cw + gap)) for r in range(2) for c in range(2)]
glass = (255, 255, 255, 52)
ink = (255, 255, 255, 230)
violet = (101, 82, 245, 255)

# 1 — video: solid card with a play mark (the hero).
x, y = cells[0]
d.rounded_rectangle((x, y, x + cw, y + cw), cr, fill=(255, 255, 255, 250))
cx, cy, s = x + cw // 2 + 10 * K, y + cw // 2, 70 * K
d.polygon([(cx - s * 0.62, cy - s), (cx - s * 0.62, cy + s), (cx + s, cy)], fill=violet)

# 2 — image: sun + mountains.
x, y = cells[1]
d.rounded_rectangle((x, y, x + cw, y + cw), cr, fill=glass)
d.ellipse((x + cw * 0.58, y + cw * 0.2, x + cw * 0.78, y + cw * 0.4), fill=ink)
d.polygon([(x + cw * 0.14, y + cw * 0.8), (x + cw * 0.42, y + cw * 0.42), (x + cw * 0.64, y + cw * 0.8)], fill=ink)
d.polygon([(x + cw * 0.46, y + cw * 0.8), (x + cw * 0.66, y + cw * 0.56), (x + cw * 0.86, y + cw * 0.8)], fill=(255, 255, 255, 170))

# 3 — doc: text lines.
x, y = cells[2]
d.rounded_rectangle((x, y, x + cw, y + cw), cr, fill=glass)
for i, w in enumerate((0.72, 0.56, 0.66, 0.42)):
    ly = y + cw * (0.24 + i * 0.16)
    d.rounded_rectangle((x + cw * 0.16, ly, x + cw * (0.16 + w), ly + 26 * K), 13 * K, fill=ink if i == 0 else (255, 255, 255, 160))

# 4 — insights: bars.
x, y = cells[3]
d.rounded_rectangle((x, y, x + cw, y + cw), cr, fill=glass)
bw = cw * 0.14
for i, hgt in enumerate((0.34, 0.56, 0.44, 0.7)):
    bx = x + cw * 0.17 + i * (bw + cw * 0.06)
    d.rounded_rectangle((bx, y + cw * (0.82 - hgt), bx + bw, y + cw * 0.82), 12 * K, fill=ink if i == 3 else (255, 255, 255, 170))

img.resize((1024, 1024), Image.LANCZOS).save(sys.argv[1])

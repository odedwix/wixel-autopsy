#!/usr/bin/env python3
"""Draws the Autopsy app icon (1024x1024 PNG): a macOS-style rounded tile in cold morgue steel —
stainless drawers on the back wall, a slab with a sheet-covered body, and a violet toe tag
(with a play mark: the runs we examine). Stylized, not gory. Rendered at 4x and downsampled.
Usage: make-icon.py out.png"""
import math
import sys
from PIL import Image, ImageDraw, ImageFilter

K = 4
S = 1024 * K
M = 100 * K                # macOS icon grid: 824px body inside a 1024 canvas
R = 186 * K
body = (M, M, S - M, S - M)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle(body, R, fill=255)

def layer(fn, blur=0, clip=True):
    """Draw on a fresh layer (ImageDraw doesn't blend), optionally blur, clip to the tile, composite."""
    l = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    fn(ImageDraw.Draw(l))
    if blur:
        l = l.filter(ImageFilter.GaussianBlur(blur))
    if clip:
        l.putalpha(Image.composite(l.getchannel('A'), Image.new('L', (S, S), 0), mask))
    img.alpha_composite(l)

# Drop shadow under the tile.
layer(lambda d: d.rounded_rectangle((M, M + 18 * K, S - M, S - M + 18 * K), R, fill=(10, 16, 24, 120)), blur=28 * K, clip=False)

# Tile: cold steel-blue gradient.
grad = Image.new('RGBA', (S, S))
gd = ImageDraw.Draw(grad)
top, bottom = (92, 122, 142, 255), (26, 38, 52, 255)
for y in range(S):
    t = max(0.0, min(1.0, (y - M) / (S - 2 * M)))
    gd.line([(0, y), (S, y)], fill=lerp(top, bottom, t))
img.paste(grad, (0, 0), mask)

# Back wall: two rows of stainless morgue drawers with handles.
dx0, dy0 = 170 * K, 180 * K
dw, dh, gx, gy = 208 * K, 150 * K, 22 * K, 22 * K
for r in range(2):
    for c in range(3):
        x = dx0 + c * (dw + gx)
        y = dy0 + r * (dh + gy)
        layer(lambda d, x=x, y=y: d.rounded_rectangle((x, y, x + dw, y + dh), 18 * K, fill=(186, 204, 216, 58), outline=(220, 232, 240, 70), width=3 * K))
        layer(lambda d, x=x, y=y: d.rounded_rectangle((x + dw * 0.32, y + dh * 0.62, x + dw * 0.68, y + dh * 0.62 + 16 * K), 8 * K, fill=(230, 238, 244, 150)))
        layer(lambda d, x=x, y=y: d.rounded_rectangle((x + dw * 0.4, y + dh * 0.2, x + dw * 0.6, y + dh * 0.2 + 26 * K), 5 * K, fill=(230, 238, 244, 70)))

# Cold light from above.
layer(lambda d: d.ellipse((S * 0.18, -S * 0.25, S * 0.82, S * 0.42), fill=(255, 255, 255, 38)), blur=90 * K)

# The slab: stainless table top with a front edge, two legs and a soft shadow on the floor.
tx0, tx1 = 176 * K, S - 176 * K
ty = 654 * K
layer(lambda d: d.ellipse((tx0 + 30 * K, ty + 168 * K, tx1 - 30 * K, ty + 222 * K), fill=(0, 0, 0, 95)), blur=22 * K)
for lx in (tx0 + 64 * K, tx1 - 104 * K):
    layer(lambda d, lx=lx: d.rounded_rectangle((lx, ty + 40 * K, lx + 40 * K, ty + 196 * K), 12 * K, fill=(116, 134, 150, 255)))
layer(lambda d: d.rounded_rectangle((tx0, ty, tx1, ty + 58 * K), 24 * K, fill=(198, 212, 222, 255)))
layer(lambda d: d.rounded_rectangle((tx0, ty + 34 * K, tx1, ty + 58 * K), 14 * K, fill=(148, 166, 180, 255)))

# The body under a sheet: head, chest, belly, hips, legs and upturned feet as one soft contour.
sheet = (243, 246, 249, 255)
base = ty + 6 * K
span = tx1 - tx0
def contour(t):
    """Height of the sheet (px at 1x) along the body, t=0 at the shoulders, t=1 at the ankles."""
    return (86 * math.exp(-((t - 0.10) / 0.14) ** 2) + 58 * math.exp(-((t - 0.34) / 0.16) ** 2)
            + 64 * math.exp(-((t - 0.52) / 0.12) ** 2) + 40 * math.exp(-((t - 0.78) / 0.22) ** 2) + 22)
def body_shape(d):
    d.ellipse((tx0 + 50 * K, base - 128 * K, tx0 + 186 * K, base + 8 * K), fill=sheet)            # head
    x0, x1 = tx0 + 150 * K, tx1 - 150 * K
    pts = [(tx0 + 110 * K, base)]
    for i in range(61):
        t = i / 60
        pts.append((x0 + t * (x1 - x0), base - contour(t) * K))
    pts.append((x1 + 10 * K, base))
    d.polygon(pts, fill=sheet)
    # Feet: two rounded toes pointing up under the sheet.
    d.ellipse((x1 - 20 * K, base - 118 * K, x1 + 64 * K, base + 6 * K), fill=sheet)
    d.ellipse((x1 + 34 * K, base - 104 * K, x1 + 112 * K, base + 6 * K), fill=sheet)
    d.rounded_rectangle((tx0 + 36 * K, base - 18 * K, tx1 - 36 * K, base + 26 * K), 16 * K, fill=sheet)  # sheet on the slab
layer(body_shape)
# Gentle shading on the lower half of the sheet so the body reads as volume, not a cut-out.
def shade(d):
    x0, x1 = tx0 + 150 * K, tx1 - 150 * K
    pts = [(x0 + t / 60 * (x1 - x0), base - contour(t / 60) * K * 0.45) for t in range(61)]
    d.polygon([(tx0 + 60 * K, base)] + pts + [(x1 + 100 * K, base)], fill=(150, 170, 188, 60))
layer(shade, blur=10 * K)

# The sheet hangs over the slab's front edge.
layer(lambda d: d.polygon([(tx0 + 50 * K, ty + 20 * K), (tx1 - 50 * K, ty + 20 * K), (tx1 - 70 * K, ty + 94 * K),
                           (tx1 - 240 * K, ty + 82 * K), (S * 0.5, ty + 98 * K), (tx0 + 240 * K, ty + 84 * K), (tx0 + 70 * K, ty + 96 * K)], fill=(229, 235, 241, 255)))

# Toe tag: a dark string from the toes down past the slab, and a violet tag with an eyelet and a play mark.
fx, fy = tx1 - 110 * K, base - 96 * K
ex, ey = tx1 - 96 * K, ty + 96 * K            # the tag's eyelet (kept clear of the tile's rounded corner)
layer(lambda d: d.line([(fx, fy), (fx + 22 * K, fy + 60 * K), (ex, ey)], fill=(58, 74, 90, 255), width=6 * K, joint='curve'))
W, H = 124 * K, 168 * K
tag = Image.new('RGBA', (W, H), (0, 0, 0, 0))
td = ImageDraw.Draw(tag)
td.rounded_rectangle((0, 0, W, H), 22 * K, fill=(124, 104, 255, 255))
td.rounded_rectangle((0, 0, W, H), 22 * K, outline=(255, 255, 255, 110), width=4 * K)
td.ellipse((W / 2 - 15 * K, 16 * K, W / 2 + 15 * K, 46 * K), fill=(26, 38, 52, 255))
td.polygon([(W * 0.36, H * 0.44), (W * 0.36, H * 0.82), (W * 0.74, H * 0.63)], fill=(255, 255, 255, 255))
tag = tag.rotate(-12, resample=Image.BICUBIC, expand=True)
tl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
tl.alpha_composite(tag, (int(ex - tag.width / 2), int(ey - 34 * K)))
tl.putalpha(Image.composite(tl.getchannel('A'), Image.new('L', (S, S), 0), mask))
sh = Image.merge('RGBA', (*[Image.new('L', (S, S), 0)] * 3, tl.getchannel('A').point(lambda a: int(a * 0.4)))).filter(ImageFilter.GaussianBlur(10 * K))
img.alpha_composite(sh, (6 * K, 12 * K))
img.alpha_composite(tl)

# Hairline edge.
ImageDraw.Draw(img).rounded_rectangle(body, R, outline=(255, 255, 255, 36), width=3 * K)

img.resize((1024, 1024), Image.LANCZOS).save(sys.argv[1])

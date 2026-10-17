"""Generate the app icons: a dollar sign circled by two conversion arrows.

Writes static/icons/icon.svg plus the PNG icons from the same geometry, so the
SVG and PNG versions always match. Requires Pillow.

Usage: python scripts/generate_icons.py
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "static" / "icons"

# Geometry in a 512x512 design space.
C = 256                     # centre
CORNER = 112                # rounded-corner radius of the standard icon
TOP, BOTTOM = "#34d399", "#047857"
COIN_R = 112                # translucent coin behind the "$"
COIN_ALPHA = 0.16
ARC_R, ARC_W = 168, 30      # conversion arrows
ARCS = [(200, 320), (20, 140)]  # (start, end) degrees, clockwise from 3 o'clock
HEAD_LEN, HEAD_HALF = 40, 32
DOLLAR_W = 34
DOLLAR_S = [  # cubic bezier segments of the "S"
    ((312, 202), (300, 182), (280, 172), (256, 172)),
    ((256, 172), (224, 172), (200, 190), (200, 214)),
    ((200, 214), (200, 242), (228, 250), (256, 256)),
    ((256, 256), (284, 262), (312, 270), (312, 298)),
    ((312, 298), (312, 324), (288, 340), (256, 340)),
    ((256, 340), (228, 340), (206, 330), (196, 310)),
]
DOLLAR_BAR = ((256, 136), (256, 376))
MASKABLE_SCALE = 0.86       # keeps the artwork inside the maskable safe zone (r = 40%)
SS = 4                      # supersampling factor for the PNGs


def polar(deg, r=ARC_R):
    a = math.radians(deg)
    return C + r * math.cos(a), C + r * math.sin(a)


def arrow_head(end_deg):
    """Triangle at the end of a clockwise arc; the tip sits on the circle so it follows the curve."""
    a = math.radians(end_deg)
    nx, ny = math.cos(a), math.sin(a)  # radial normal at the base
    ex, ey = polar(end_deg)
    return [
        polar(end_deg + math.degrees(HEAD_LEN / ARC_R)),
        (ex + nx * HEAD_HALF, ey + ny * HEAD_HALF),
        (ex - nx * HEAD_HALF, ey - ny * HEAD_HALF),
    ]


def bezier_points(seg, steps=24):
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = seg
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        pts.append((
            u**3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * x3,
            u**3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * y3,
        ))
    return pts


# ---------- SVG ----------

def fmt(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


def svg(maskable=False):
    arcs = []
    for start, end in ARCS:
        sx, sy = polar(start)
        ex, ey = polar(end)
        arcs.append(f'<path d="M{fmt(sx)} {fmt(sy)}A{ARC_R} {ARC_R} 0 0 1 {fmt(ex)} {fmt(ey)}"/>')
    heads = "".join(
        '<polygon points="' + " ".join(f"{fmt(x)},{fmt(y)}" for x, y in arrow_head(end)) + '"/>'
        for _, end in ARCS
    )
    s_path = f"M{DOLLAR_S[0][0][0]} {DOLLAR_S[0][0][1]}" + "".join(
        f"C{p1[0]} {p1[1]} {p2[0]} {p2[1]} {p3[0]} {p3[1]}" for _, p1, p2, p3 in DOLLAR_S
    )
    (bx0, by0), (bx1, by1) = DOLLAR_BAR
    bg = '<rect width="512" height="512" fill="url(#g)"/>' if maskable else \
        f'<rect width="512" height="512" rx="{CORNER}" fill="url(#g)"/>'
    transform = f' transform="translate({C} {C}) scale({MASKABLE_SCALE}) translate(-{C} -{C})"' if maskable else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{TOP}"/>
      <stop offset="1" stop-color="{BOTTOM}"/>
    </linearGradient>
  </defs>
  {bg}
  <g{transform}>
    <circle cx="{C}" cy="{C}" r="{COIN_R}" fill="#fff" fill-opacity="{COIN_ALPHA}"/>
    <g fill="none" stroke="#fff" stroke-width="{ARC_W}" stroke-linecap="round">{"".join(arcs)}</g>
    <g fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round">{heads}</g>
    <g fill="none" stroke="#fff" stroke-width="{DOLLAR_W}" stroke-linecap="round" stroke-linejoin="round">
      <path d="M{bx0} {by0}V{by1}"/>
      <path d="{s_path}"/>
    </g>
  </g>
</svg>
"""


# ---------- PNG ----------

def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def gradient(size):
    small = 64
    img = Image.new("RGB", (small, small))
    px = img.load()
    a, b = hex_rgb(TOP), hex_rgb(BOTTOM)
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2 * (small - 1))
            px[x, y] = tuple(round(p + (q - p) * t) for p, q in zip(a, b))
    return img.resize((size, size), Image.BILINEAR)


def round_line(draw, pts, width, fill):
    """Round-capped stroke drawn as overlapping discs (PIL's thick curved lines are jagged)."""
    r = width / 2
    step = max(1.0, width / 10)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / step))
        for i in range(n + 1):
            x, y = x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n
            draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def draw_artwork(img, scale, offset):
    def p(x, y):
        return offset + x * scale, offset + y * scale

    coin = Image.new("RGBA", img.size, (0, 0, 0, 0))
    cx, cy = p(C, C)
    r = COIN_R * scale
    ImageDraw.Draw(coin).ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, round(255 * COIN_ALPHA)))
    img.alpha_composite(coin)

    draw = ImageDraw.Draw(img)
    for start, end in ARCS:
        steps = 64
        pts = [p(*polar(start + (end - start) * i / steps)) for i in range(steps + 1)]
        round_line(draw, pts, ARC_W * scale, "white")
        draw.polygon([p(*q) for q in arrow_head(end)], fill="white")

    round_line(draw, [p(*q) for q in DOLLAR_BAR], DOLLAR_W * scale, "white")
    s_pts = []
    for seg in DOLLAR_S:
        s_pts.extend(bezier_points(seg)[(1 if s_pts else 0):])
    round_line(draw, [p(*q) for q in s_pts], DOLLAR_W * scale, "white")


def png(size, maskable=False):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    bg = gradient(big)
    if maskable:
        img.paste(bg, (0, 0))
        scale = big / 512 * MASKABLE_SCALE
        draw_artwork(img, scale, (big - 512 * scale) / 2)
    else:
        mask = Image.new("L", (big, big), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=CORNER * big / 512, fill=255)
        img.paste(bg, (0, 0), mask)
        draw_artwork(img, big / 512, 0)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon.svg").write_text(svg())
    png(192).save(OUT / "icon-192.png")
    png(512).save(OUT / "icon-512.png")
    png(512, maskable=True).save(OUT / "icon-maskable-512.png")
    png(180, maskable=True).convert("RGB").save(OUT / "apple-touch-icon.png")
    print(f"icons written to {OUT}")

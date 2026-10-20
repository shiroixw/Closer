#!/usr/bin/env python3
"""图标渲染器：PNG 的唯一来源。

不引 Pillow —— 一个扩展的体积预算不该为了生成四张图去装依赖，
而且这个图形简单到用超采样就能画干净。

图形：取景框（四角）+ 画面（太阳 + 山）。取景框读作「凑近看」，
和 Closer 的语义一致；比通用的「图片」图标更容易在 16px 下认出来。

用法：python3 tools/icons.py
"""

import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

BG = (0x12, 0x12, 0x14)
FG = (0xF2, 0xF2, 0xF5)

SIZES = (16, 32, 48, 128)
SS = 8  # 每边子采样数，决定边缘平滑程度


def in_rrect(x, y, x0, y0, x1, y1, r):
    """圆角矩形内部判定（等价于 SDF <= 0）。"""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def in_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(x, y, a, b, c):
    def side(p, q):
        return (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1])

    d1, d2, d3 = side(a, b), side(b, c), side(c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def coverage(size, predicate):
    """返回每个像素被图形覆盖的比例（0..1），用 SS×SS 子采样估计。"""
    out = []
    step = 1.0 / SS
    for py in range(size):
        row = []
        for px in range(size):
            hit = 0
            for sy in range(SS):
                y = (py + (sy + 0.5) * step) * 128.0 / size
                for sx in range(SS):
                    x = (px + (sx + 0.5) * step) * 128.0 / size
                    if predicate(x, y):
                        hit += 1
            row.append(hit / (SS * SS))
        out.append(row)
    return out


def glyph(x, y, size):
    """128 坐标系下的前景图形。16px 下不画太阳：1.7px 的圆只会变成噪点。"""
    ring = in_rrect(x, y, 24, 24, 104, 104, 14) and not in_rrect(x, y, 38, 38, 90, 90, 7)
    hill = in_triangle(x, y, (36, 92), (64, 56), (92, 92))
    sun = size >= 32 and in_circle(x, y, 52, 54, 7)
    return ring or sun or hill


def render(size):
    bg = coverage(size, lambda x, y: in_rrect(x, y, 4, 4, 124, 124, 30))
    fg = coverage(size, lambda x, y: glyph(x, y, size))

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            cb, cg = bg[py][px], fg[py][px]
            a = cg + cb * (1 - cg)
            if a <= 0:
                row += b"\x00\x00\x00\x00"
                continue
            r = (FG[0] * cg + BG[0] * cb * (1 - cg)) / a
            g = (FG[1] * cg + BG[1] * cb * (1 - cg)) / a
            b = (FG[2] * cg + BG[2] * cb * (1 - cg)) / a
            row += bytes((round(r), round(g), round(b), round(a * 255)))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    blob = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(blob)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT, f"{size}.png")
        write_png(path, size, render(size))
        print(f"{path}  {os.path.getsize(path)} B")


if __name__ == "__main__":
    main()

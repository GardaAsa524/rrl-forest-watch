"""Remove the white background from the Ruang Riung logo and export PNGs.

The source logo is a very light grey on white, so the alpha channel is
derived from how much darker than white each pixel is, then the artwork is
recoloured to a solid colour (white for the dark header, green for light
backgrounds).

    .venv\\Scripts\\python.exe scripts\\make_logo.py "E:\\logo\\mark.jpeg" "E:\\logo\\full.jpeg"
"""
from __future__ import annotations
import sys
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / 'frontend' / 'img'


def cutout(src: Path, color: tuple[int, int, int], noise: float = 4.0, size: int = 512) -> Image.Image:
    rgb = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
    lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    darkness = 255.0 - lum
    # Ink level = darkness of the logo artwork itself (robust to JPEG noise).
    ink = np.percentile(darkness[darkness > noise * 2], 60) if (darkness > noise * 2).any() else darkness.max()
    alpha = np.clip((darkness - noise) / max(ink - noise, 1.0), 0, 1)
    ys, xs = np.nonzero(alpha > 0.15)
    pad = 6
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad, alpha.shape[0])
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad, alpha.shape[1])
    out = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
    out[..., :3] = color
    out[..., 3] = (alpha[y0:y1, x0:x1] * 255).round().astype(np.uint8)
    img = Image.fromarray(out, 'RGBA')
    img.thumbnail((size * 2, size), Image.LANCZOS)
    return img


if __name__ == '__main__':
    mark, full = map(Path, sys.argv[1:3])
    OUT.mkdir(exist_ok=True)
    for name, src, size in [('logo-mark', mark, 256), ('logo-full', full, 240)]:
        for suffix, color in [('', (255, 255, 255)), ('-green', (11, 47, 41))]:
            img = cutout(src, color, size=size)
            path = OUT / f'{name}{suffix}.png'
            img.save(path, optimize=True)
            print(path.name, img.size)

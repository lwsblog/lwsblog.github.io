#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
add-image.py — 把插图压成 WebP 放进 Hexo 站点，并打印可直接粘贴的 Markdown。

为什么需要它
------------
本站由 Cloudflare Pages 托管（2026-09-29 从 GitHub Pages 迁来）。
GitHub Pages 对超过约 100KB 的文件会限速到 ~20KB/s（实测 412KB 图片要 22 秒），
Cloudflare 没有这个限速 —— 但单图仍然越小越好，尤其是手机流量和首屏。

原图（截图 / 相机照片）动辄 1–3MB，直接进仓库既撑大仓库、拖慢部署，
也会让正文滚动时明显卡顿。这个脚本把「压缩 + 命名 + 落盘 + 生成引用」
合成一步，避免手工在多个工具之间来回倒。

用法
----
    python tools/add-image.py 截图.png --slug my-new-post
    python tools/add-image.py a.jpg b.png --slug my-new-post --width 1600 --quality 82
    python tools/add-image.py shot.png --slug my-post --dry-run    # 只看结果不落盘

产物
----
    source/images/posts/<slug>/<name>.webp

该目录在 Cloudflare Pages 上由 source/_headers 设了**一年 immutable 缓存**，
所以换图请换文件名 —— 同名覆盖不会让老访客看到新内容。

在 Markdown 里这样引用（脚本会直接把这一行打印出来给你复制）：

    ![说明](/images/posts/<slug>/<name>.webp)

依赖
----
    Pillow  →  pip install Pillow
"""

import argparse
import sys

try:  # Windows 控制台默认 GBK，会把中文输出弄成乱码
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("缺少依赖 Pillow，请先安装：pip install Pillow")

REPO = Path(__file__).resolve().parent.parent
OUT_ROOT = REPO / "source" / "images" / "posts"

# 高于这个体积就提醒一下。100KB 是 GitHub Pages 的限速门槛，现在走 Cloudflare
# 已经不卡这个数，但仍是「一篇文章十几张图」时的合理预算线。
SOFT_LIMIT = 200 * 1024


def human(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n} B"


def sanitize(name: str) -> str:
    """
    清成 URL 友好的形式。**中文保留** —— 中文博客用中文文件名更直观，
    Hexo 与 Cloudflare Pages 都能正确处理（浏览器自动做百分号编码）。
    只替换真正会破坏 URL 的字符：空格、下划线，以及 # ? % & / 等保留字。
    """
    keep = []
    for ch in name:
        if ch in " _":
            keep.append("-")
        elif ch.isalnum() or ch in "-.":  # isalnum() 对中文也返回 True
            keep.append(ch)
        # 其余（# ? % & / \ : * " < > | 等）直接丢掉
    cleaned = "".join(keep).strip("-.")
    return cleaned or "image"


def convert_one(src: Path, slug: str, width: int, quality: int, dry: bool):
    if not src.is_file():
        print(f"  x 找不到文件：{src}")
        return None

    before = src.stat().st_size
    try:
        im = Image.open(src)
        im.load()
    except Exception as exc:
        print(f"  x 读不了 {src.name}：{exc}")
        print("    （HEIC 需要先转成 JPG/PNG；Pillow 原生不支持 HEIC）")
        return None

    orig_size = im.size
    im = ImageOps.exif_transpose(im)  # 按 EXIF 摆正，否则手机照片会躺倒

    # WebP 支持 alpha，PNG 的透明能保住
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
    else:
        im = im.convert("RGB")

    # thumbnail 只在超出时才缩，不动尺寸比例
    im.thumbnail((width, width), Image.LANCZOS)
    new_size = im.size

    stem = sanitize(src.stem)
    dst_dir = OUT_ROOT / slug
    dst = dst_dir / f"{stem}.webp"

    if dry:
        # 内存里压一遍，只为报告体积，不写盘
        import io

        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=quality, method=6)
        after = buf.tell()
        existed = False
    else:
        dst_dir.mkdir(parents=True, exist_ok=True)
        existed = dst.exists()  # 必须在 save 之前判断，否则永远是「刚被自己写出来」
        im.save(dst, "WEBP", quality=quality, method=6)
        after = dst.stat().st_size

    delta = before - after  # 正数 = 变小
    if delta >= 0:
        change = f"↓{delta / before * 100:.0f}%"
    else:
        change = f"↑{abs(delta) / before * 100:.0f}%"

    rel_dir = f"source/images/posts/{slug}"
    scale = f"{orig_size[0]}x{orig_size[1]} → {new_size[0]}x{new_size[1]}"
    if orig_size == new_size:
        scale = f"{new_size[0]}x{new_size[1]}（尺寸未变）"

    print(f"  {src.name}")
    print(f"      {human(before)} → {human(after)}   {change}   {scale}")
    if not dry:
        if existed:
            print(f"      ! 覆盖了已存在的 {dst.name}")
            print("        source/_headers 给 /images/posts/* 设了一年 immutable 缓存，")
            print("        同名覆盖后老访客会继续看到旧图 —— 需要换图就换个文件名。")
        print(f"      {rel_dir}/{stem}.webp")
    if after >= before:
        print("      ! 转 WebP 反而更大（纯色 / 矢量风格图常见）—— 这类图建议直接用原格式引用")
    elif after > SOFT_LIMIT:
        print(f"      ! 仍超过 {human(SOFT_LIMIT)} —— 可考虑 --width 1200 或 --quality 75")
    print(f"      ![说明](/images/posts/{slug}/{stem}.webp)")
    print()

    return dst


def main():
    ap = argparse.ArgumentParser(
        description="把插图压成 WebP 放进 Hexo 站点，并打印 Markdown 引用。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("images", nargs="+", help="要处理的图片（可多张）")
    ap.add_argument("--slug", required=True, help="文章标识，决定存放目录（如 devlog-004-shadows）")
    ap.add_argument("--width", type=int, default=1600, help="最长边像素上限，默认 1600")
    ap.add_argument("--quality", type=int, default=82, help="WebP 质量 1-100，默认 82")
    ap.add_argument("--dry-run", action="store_true", help="只报告体积，不写文件")
    args = ap.parse_args()

    slug = sanitize(args.slug).lower()
    if slug != args.slug.lower():
        print(f"（slug 已规范化为：{slug}）")

    print()
    print(f"目标目录：source/images/posts/{slug}/")
    print(f"参数：最长边 {args.width}px，质量 {args.quality}" + ("（dry-run，不写盘）" if args.dry_run else ""))
    print()

    ok, fail = 0, 0
    for raw in args.images:
        if convert_one(Path(raw), slug, args.width, args.quality, args.dry_run):
            ok += 1
        else:
            fail += 1

    print(f"完成：{ok} 张成功" + (f"，{fail} 张失败" if fail else ""))
    if not args.dry_run and ok:
        print()
        print("下一步：")
        print("    1. 把上面打印的 ![...](...) 粘进文章")
        print("    2. git add source/images/posts/" + slug)
        print("    3. bash deploy-cf.sh")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

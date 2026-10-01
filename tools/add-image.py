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

    # 按体积上限压：自动降质量、必要时缩尺寸，直到落进 200KB
    python tools/add-image.py 大图.png --slug my-post --max-size 200

    # 剪贴板直取（截图后直接跑，不用存文件、不用敲路径）
    python tools/add-image.py --paste --slug my-new-post
    python tools/add-image.py --paste                # slug 自动取最近改动的文章

    # Markdown 自动进剪贴板，直接在编辑器里 Ctrl+V
    python tools/add-image.py 图.png --slug my-post --copy

体积上限怎么够的
----------------
`--max-size` 不保证「画质最好」，只保证「落进这个体积」。手段按损耗从小到大：

1. 先在 `--quality` 直接试 —— 够小就一个字节都不多动；
2. 不够就在 `[25, --quality]` 上**二分**，找能过线里质量最高的那档；
3. 质量压到 25 还超，才**缩尺寸**（每次 ×0.85）重来，最多 8 轮。

先把质量压到底不是好选择：质量 25 的 WebP 已经有块状伪影，而把 1920px 缩到
1400px 配 70 的质量，肉眼基本无损。压不下去会明确报错，不会偷偷写一张超标的图。

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
POSTS_DIR = REPO / "source" / "_posts"

# 高于这个体积就提醒一下。100KB 是 GitHub Pages 的限速门槛，现在走 Cloudflare
# 已经不卡这个数，但仍是「一篇文章十几张图」时的合理预算线。
SOFT_LIMIT = 200 * 1024


# --------------------------------------------------------------------------
# 剪贴板（截图直取 / Markdown 回填）
# --------------------------------------------------------------------------
def clipboard_image():
    """
    从剪贴板取出图片，存成临时 PNG 返回路径；没有图片则返回 None。

    优先用 Pillow 自带的 ImageGrab（Windows/macOS 原生支持，零依赖）。
    它只能拿「位图」；如果剪贴板里是复制的**文件**（资源管理器里 Ctrl+C），
    则走 Windows 的 PowerShell 取文件路径兜底。
    """
    try:
        from PIL import ImageGrab

        grabbed = ImageGrab.grabclipboard()
    except Exception:
        grabbed = None

    if grabbed is None:
        return None

    # grabclipboard() 在剪贴板是「文件」时返回路径列表
    if isinstance(grabbed, list):
        for item in grabbed:
            p = Path(str(item))
            if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
                return p
        print("  剪贴板里是文件，但没有可用的图片格式")
        return None

    # 位图：落成临时 PNG
    #
    # 文件名带时间戳，因为临时文件的 stem 会成为产物名
    # （source/images/posts/<slug>/<stem>.webp）。固定叫 wb-clipboard-paste 的话，
    # 同一篇文章截第二张图就会覆盖第一张 —— 而 source/_headers 给
    # /images/posts/* 设了一年 immutable 缓存，老访客永远看不到新图。
    import tempfile
    import time

    tmpdir = Path(tempfile.gettempdir())
    stamp = time.strftime("%Y%m%d-%H%M%S")
    tmp = tmpdir / f"wb-clipboard-{stamp}.png"
    n = 2
    while tmp.exists():  # 同一秒内连按两次
        tmp = tmpdir / f"wb-clipboard-{stamp}-{n}.png"
        n += 1

    if grabbed.mode in ("RGBA", "LA", "P"):
        grabbed = grabbed.convert("RGBA")
    else:
        grabbed = grabbed.convert("RGB")
    grabbed.save(tmp, "PNG")
    return tmp


def clipboard_put(text: str) -> bool:
    """
    把文本放进剪贴板（Markdown 引用自动回填）。

    直接调 Win32 的 SetClipboardData(CF_UNICODETEXT)，不走 `clip.exe` ——
    clip 按控制台代码页解释 stdin，中文引用（本站图片名允许中文）会变乱码。
    """
    try:
        import ctypes
        from ctypes import wintypes

        u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32
        u32.OpenClipboard.argtypes = [wintypes.HWND]
        u32.OpenClipboard.restype = wintypes.BOOL
        u32.EmptyClipboard.restype = wintypes.BOOL
        u32.CloseClipboard.restype = wintypes.BOOL
        u32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
        u32.SetClipboardData.restype = wintypes.HANDLE
        k32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
        k32.GlobalAlloc.restype = wintypes.HGLOBAL          # 必须显式声明，否则句柄被截断
        k32.GlobalLock.argtypes = [wintypes.HGLOBAL]
        k32.GlobalLock.restype = wintypes.LPVOID            # 64 位下必须用 LPVOID
        k32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
        k32.GlobalUnlock.restype = wintypes.BOOL
        k32.GlobalFree.argtypes = [wintypes.HGLOBAL]
        k32.GlobalFree.restype = wintypes.HGLOBAL

        buf = text.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-16-le") + b"\x00\x00"

        # 剪贴板是全局独占资源，别的程序可能正占着 → 重试几次
        import time

        opened = False
        for _ in range(8):
            if u32.OpenClipboard(None):
                opened = True
                break
            time.sleep(0.06)
        if not opened:
            raise OSError("剪贴板被其他程序占用")

        try:
            GMEM_MOVEABLE = 0x0002
            CF_UNICODETEXT = 13
            h = k32.GlobalAlloc(GMEM_MOVEABLE, len(buf))
            if not h:
                raise OSError("GlobalAlloc 失败")
            p = k32.GlobalLock(h)
            if not p:
                k32.GlobalFree(h)
                raise OSError("GlobalLock 失败")
            ctypes.memmove(p, buf, len(buf))
            k32.GlobalUnlock(h)

            u32.EmptyClipboard()
            if not u32.SetClipboardData(CF_UNICODETEXT, h):
                k32.GlobalFree(h)
                raise OSError("SetClipboardData 失败")
            # 成功后内存所有权移交系统，不能再 free
        finally:
            u32.CloseClipboard()
        return True
    except Exception:
        return False


def clipboard_seq() -> int:
    """
    剪贴板「序列号」——内容一变就 +1。轮询它比每次真去抓剪贴板便宜得多，
    适合做「监听剪贴板」的触发器。
    """
    import ctypes

    return int(ctypes.windll.user32.GetClipboardSequenceNumber())


def latest_post_slug() -> str | None:
    """
    取 source/_posts 下**最近修改**的文章文件名作为 slug。
    剪贴板传图时省掉 --slug —— 通常你刚建完文章、正在写它。
    """
    try:
        posts = [p for p in POSTS_DIR.glob("*.md") if not p.name.startswith("tmp-")]
        if not posts:
            return None
        newest = max(posts, key=lambda p: p.stat().st_mtime)
        return newest.stem
    except Exception:
        return None


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


def encode_webp(im, quality: int) -> bytes:
    """把图编码成 WebP 字节（不落盘）—— 体积上限要反复试，必须先在内存里量。"""
    import io

    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=quality, method=6)
    return buf.getvalue()


# 压到上限时的下限：质量不再低于 MIN_QUALITY，尺寸不再小于 MIN_SIDE
MIN_QUALITY = 25
MIN_SIDE = 240
FIT_STEPS = 8


def fit_under(im, max_bytes: int, quality: int):
    """
    把 im 压到 max_bytes 之内，返回 (字节, 图, 实际质量)；压不下去返回 (None, None, 0)。

    两级手段：**先降质量**（在 [25, quality] 上二分，要「能过的最小损耗」），
    质量压到底还超，才**缩尺寸**（每次 ×0.85）重来。

    为什么不是一路降质量：质量 25 的 WebP 已经能看见块状伪影，而把 1920px
    缩到 1400px 再给 70 的质量，肉眼几乎无损 —— 先动尺寸更划算。
    """
    cur = im
    for _ in range(FIT_STEPS):
        if len(encode_webp(cur, quality)) <= max_bytes:      # 上限质量就够小，直接收工
            return encode_webp(cur, quality), cur, quality

        lo, hi, best = MIN_QUALITY, quality, None
        while lo <= hi:
            mid = (lo + hi) // 2
            data = encode_webp(cur, mid)
            if len(data) <= max_bytes:
                best = (data, mid)
                lo = mid + 1                                 # 够小 → 往上试更大的质量
            else:
                hi = mid - 1
        if best:
            return best[0], cur, best[1]

        if min(cur.size) <= MIN_SIDE:                        # 已经没得缩了
            break
        cur = cur.resize((max(1, round(cur.width * 0.85)), max(1, round(cur.height * 0.85))),
                         Image.LANCZOS)
    return None, None, 0


def prepare(src: Path, width: int, quality: int, max_bytes: int = 0, emit=print):
    """
    读图 → 按 EXIF 摆正 → 缩到 width → （可选）压到 max_bytes。

    返回 dict(data/im/quality/orig/before)，失败返回 None 并自己 emit 原因。

    单独抽出来，是因为「落进 /images/posts/」和写作台的「设为文章壁纸（落进
    /images/wallpaper/）」只差一个落点名字，处理这一段必须完全一致 ——
    否则壁纸会绕过体积上限。
    """
    if not src.is_file():
        emit(f"  x 找不到文件：{src}")
        return None

    before = src.stat().st_size
    try:
        im = Image.open(src)
        im.load()
    except Exception as exc:
        emit(f"  x 读不了 {src.name}：{exc}")
        emit("    （HEIC 需要先转成 JPG/PNG；Pillow 原生不支持 HEIC）")
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

    if max_bytes > 0:
        data, fitted, quality = fit_under(im, max_bytes, quality)
        if data is None:
            emit(f"  x {src.name} 压不到 {human(max_bytes)} 以内"
                 f"（质量已到底 {MIN_QUALITY}，尺寸已缩到 {MIN_SIDE}px 下限）")
            return None
        if fitted is not None:
            im = fitted
    else:
        data = encode_webp(im, quality)

    return {"data": data, "im": im, "quality": quality, "orig": orig_size, "before": before}


def convert_one(src: Path, slug: str, width: int, quality: int, dry: bool, emit=print,
                max_bytes: int = 0):
    """压一张图落到 source/images/posts/<slug>/。emit 可换成别的输出函数（GUI 用它接日志）。

    max_bytes > 0 时改为「压到该体积以内」：质量与尺寸由 fit_under() 反推。
    """
    got = prepare(src, width, quality, max_bytes, emit)
    if got is None:
        return None

    data, im, quality = got["data"], got["im"], got["quality"]
    before, orig_size, new_size = got["before"], got["orig"], im.size
    after = len(data)
    capped = max_bytes > 0

    stem = sanitize(src.stem)
    dst_dir = OUT_ROOT / slug
    dst = dst_dir / f"{stem}.webp"

    if dry:
        existed = False
    else:
        dst_dir.mkdir(parents=True, exist_ok=True)
        existed = dst.exists()  # 必须在写盘之前判断，否则永远是「刚被自己写出来」
        dst.write_bytes(data)

    delta = before - after  # 正数 = 变小
    if delta >= 0:
        change = f"↓{delta / before * 100:.0f}%"
    else:
        change = f"↑{abs(delta) / before * 100:.0f}%"

    rel_dir = f"source/images/posts/{slug}"
    scale = f"{orig_size[0]}x{orig_size[1]} → {new_size[0]}x{new_size[1]}"
    if orig_size == new_size:
        scale = f"{new_size[0]}x{new_size[1]}（尺寸未变）"

    emit(f"  {src.name}")
    emit(f"      {human(before)} → {human(after)}   {change}   {scale}")
    if capped:
        emit(f"      已压到上限 {human(max_bytes)} 内（质量 {quality}）")
    if not dry:
        if existed:
            emit(f"      ! 覆盖了已存在的 {dst.name}")
            emit("        source/_headers 给 /images/posts/* 设了一年 immutable 缓存，")
            emit("        同名覆盖后老访客会继续看到旧图 —— 需要换图就换个文件名。")
        emit(f"      {rel_dir}/{stem}.webp")
    if after >= before:
        emit("      ! 转 WebP 反而更大（纯色 / 矢量风格图常见）—— 这类图建议直接用原格式引用")
    elif not capped and after > SOFT_LIMIT:
        emit(f"      ! 仍超过 {human(SOFT_LIMIT)} —— 可考虑 --width 1200 或 --quality 75")
    emit(f"      ![说明](/images/posts/{slug}/{stem}.webp)")

    return dst


def main():
    ap = argparse.ArgumentParser(
        description="把插图压成 WebP 放进 Hexo 站点，并打印 Markdown 引用。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("images", nargs="*", help="要处理的图片（可多张）")
    ap.add_argument("--slug", help="文章标识，决定存放目录（默认取最近改动的文章）")
    ap.add_argument("--paste", action="store_true", help="直接从剪贴板取图（截图后无需存文件）")
    ap.add_argument("--copy", action="store_true", help="把 Markdown 引用写进剪贴板，直接 Ctrl+V")
    ap.add_argument("--width", type=int, default=1600, help="最长边像素上限，默认 1600")
    ap.add_argument("--quality", type=int, default=82, help="WebP 质量 1-100，默认 82")
    ap.add_argument("--max-size", type=int, default=0, metavar="KB",
                    help="压缩后文件大小上限（KB）；给了就自动降质量/缩尺寸去够它，0=不限")
    ap.add_argument("--dry-run", action="store_true", help="只报告体积，不写文件")
    args = ap.parse_args()

    # ---- 图片来源：--paste 优先，其次命令行路径 ----
    sources = []
    if args.paste:
        got = clipboard_image()
        if got is None:
            print("x 剪贴板里没有图片。")
            print("  提示：先截图（Win+Shift+S）或复制图片，再跑 --paste。")
            return 1
        sources.append(got)
    sources.extend(Path(p) for p in args.images)

    if not sources:
        print("x 没有指定图片。给个路径，或用 --paste 从剪贴板取。")
        print("  例：python tools/add-image.py 图.png --slug my-post")
        print("      python tools/add-image.py --paste")
        return 1

    # ---- slug：参数优先，否则取最近改动的文章 ----
    if args.slug:
        slug = sanitize(args.slug).lower()
        if slug != args.slug.lower():
            print(f"（slug 已规范化为：{slug}）")
    else:
        inferred = latest_post_slug()
        if not inferred:
            print("x 没给 --slug，也推断不出文章（source/_posts 为空？）")
            return 1
        slug = sanitize(inferred).lower()
        print(f"（未指定 --slug，自动用最近修改的文章：{inferred}）")

    print()
    print(f"目标目录：source/images/posts/{slug}/")
    print(f"参数：最长边 {args.width}px，质量 {args.quality}"
          + (f"，上限 {args.max_size}KB" if args.max_size > 0 else "")
          + ("（dry-run，不写盘）" if args.dry_run else ""))
    print()

    ok, fail = 0, 0
    made = []
    for src in sources:
        dst = convert_one(src, slug, args.width, args.quality, args.dry_run,
                          max_bytes=args.max_size * 1024)
        if dst:
            ok += 1
            if not args.dry_run:
                made.append(f"![说明](/images/posts/{slug}/{dst.name})")
        else:
            fail += 1

    # --paste 落下的临时 PNG 收掉，别留在 temp 里
    if args.paste and sources and sources[0].name.startswith("wb-clipboard-"):
        try:
            sources[0].unlink()
        except Exception:
            pass

    print(f"完成：{ok} 张成功" + (f"，{fail} 张失败" if fail else ""))

    if ok and not args.dry_run:
        if args.copy and made:
            if clipboard_put("\n".join(made)):
                print()
                print("Markdown 已进剪贴板 —— 去编辑器里直接 Ctrl+V。")
            else:
                print()
                print("（剪贴板写入失败，手动复制上面的引用）")
        print()
        print("下一步：")
        print("    1. 把上面的 ![...](...) 粘进文章" + ("（已在剪贴板）" if args.copy else ""))
        print("    2. git add source/images/posts/" + slug)
        print("    3. bash publish.sh --push \"说明\"")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

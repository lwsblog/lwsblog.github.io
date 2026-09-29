---
title: DEVLOG 002：壁纸、景深与两倍速
date: 2026-09-25 19:12:00
description: 壁纸层移动速度调到网格的两倍，视差终于被眼睛读懂了；顺带修掉右边的黑边。
wallpaper: /images/wallpaper/wallpaper-default.webp
categories:
  - DEVLOG
---

景深的关键不是模糊，是速度差。壁纸 14、网格 7，两层以两倍速错开，立体感就出来了。右边的黑边是全局 `img { max-width: 100% }` 压的，`max-width: none` 解放它。

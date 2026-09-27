---
title: 用 Canvas 画一块会呼吸的网格
date: 2026-09-20 10:24:00
description: 从 requestAnimationFrame 的相位计算讲到 Path2D 缓存——把扫光光晕做稳的同时把帧率救回来的完整过程。
wallpaper: /images/wallpaper/wallpaper-default.jpg
categories:
  - FRONTEND
tags:
  - frontend
---

背景网格不是背景图，是每一帧都在重画的 Canvas。相位 `((now - sweepStart) / 4000) % 1` 决定光带扫到哪里，宽描边替代 shadowBlur 之后光晕反而更亮，因为模糊不再由合成器现场计算。

## 为什么用 Path2D

网格路径每一帧都不变，变的只有描边样式。把路径缓存成 Path2D，每帧只做 `ctx.stroke()`，CPU 占用直接砍半。

## 光晕的层数

暗色主题叠五圈描边，亮色四圈。层数再往上加，视觉收益就趋近于零了。

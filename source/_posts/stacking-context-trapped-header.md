---
title: 层叠上下文困住了我的顶栏
date: 2026-09-14 08:47:00
description: "z-index 261 失效的排查记录——凶手是 app-shell 上一个不起眼的 z-index: 1，解法是把顶栏移出容器。"
categories:
  - FRONTEND
tags:
  - frontend
---

顶栏的 z-index 是 261，转场层是 240，但它就是被压在下面。原因：`.app-shell` 上的 `z-index: 1` 创建了层叠上下文，把内部所有 z-index 都关在了自己的世界里。

## 解法

把 `<header>` 移到 `.app-shell` 外面，成为 body 的直接子元素。一行模板改动，胜过所有 z-index 军备竞赛。

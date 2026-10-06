/* ============================================================================
   穹顶相册 · 阶段 ①②
   ----------------------------------------------------------------------------
   与旧相册（相纸飞入网格 + 标题滚动渐隐）完全独立的一个实现。旧版仍在运行，
   本文件只在 `/photos/?dome=1` 时加载，方便逐阶段验收而不影响线上。

   本阶段实现：
     ① 劫持滚轮 —— 页面完全不允许滚动、无滚动条；滚轮改为驱动相机半径
     ② 穹顶 canvas —— 内壁壁纸（拼接）+ 只属于穹顶的透视线 + 沿纬度扫的光带

   几何（与样张 dome-lab 里定稿的一致）：
     * 球半径 1，**相机在球内**，半径 0.32（缩小到底）→ 0.94（放大到底）
     * 水平视场角 58° **固定**，不随缩放改变（避免边角鱼眼）
     * 球带张角 110°（上下各削 35°）
   ========================================================================= */
(function () {
  'use strict';

  var BAND_HALF = 55.0;      // 球带半张角（度）
  var FOV = 58.0;            // 水平视场角（度），固定
  var R_OUT = 0.32;          // 缩小到底（最远）
  var R_IN = 0.94;           // 放大到底（最近）

  // 颜色：照搬站上 --scene-grid / --scene-sweep，保证与其它页面的观感同源
  var GRID = 'rgba(196, 224, 236, 0.145)';
  var SWEEP = [214, 240, 255];
  var SWEEP_A = 0.5;
  // 光晕层：线宽 × 强度。与 willowxi.js:385 的数组同源。
  var GLOW = [[2.6, 0.6], [5.5, 0.42], [10, 0.26], [17, 0.14], [27, 0.07]];
  // 亮带厚度占球带张角的比例（原版是屏高的 55%）
  var BAND_FRAC = 0.55;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ---- 球面几何 ---------------------------------------------------------- */

  // 球面点（度）-> 单位向量。lon 绕竖直轴，phi 为纬度（+北）
  function sph(lon, phi) {
    var lo = lon * Math.PI / 180, ph = phi * Math.PI / 180;
    var c = Math.cos(ph);
    return [Math.sin(lo) * c, Math.sin(ph), Math.cos(lo) * c];
  }

  // 相机位于 camLon/camPhi 方向、半径 cr 处；朝向 = 由相机指向球心
  function makeCamera(camLon, camPhi, cr) {
    var p = sph(camLon, camPhi);
    var campos = [p[0] * cr, p[1] * cr, p[2] * cr];
    var L = Math.sqrt(campos[0] * campos[0] + campos[1] * campos[1] + campos[2] * campos[2]) || 1;
    var fwd = [-campos[0] / L, -campos[1] / L, -campos[2] / L];
    // right = fwd × up
    var rx = fwd[1] * 0 - fwd[2] * 1;
    var ry = fwd[2] * 0 - fwd[0] * 0;
    var rz = fwd[0] * 1 - fwd[1] * 0;
    var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    var right = [rx / rl, ry / rl, rz / rl];
    // up = right × fwd
    var up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0]
    ];
    return { pos: campos, fwd: fwd, right: right, up: up };
  }

  // 把球面点投影到屏幕；在相机后方返回 null
  function project(cam, focal, W, H, P) {
    var dx = P[0] - cam.pos[0], dy = P[1] - cam.pos[1], dz = P[2] - cam.pos[2];
    var z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
    if (z <= 0.06) return null;
    var xc = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
    var yc = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
    return [W * 0.5 + focal * xc / z, H * 0.5 - focal * yc / z];
  }

  /* ---- 扫光强度（与 willowxi.js 的渐变一致）----------------------------- */
  var STOPS = [[0, 0], [0.18, 0.38], [0.5, 1], [0.82, 0.38], [1, 0]];
  function sweepProfile(u) {
    if (u <= 0 || u >= 1) return 0;
    for (var i = 0; i < STOPS.length - 1; i++) {
      var x0 = STOPS[i][0], y0 = STOPS[i][1], x1 = STOPS[i + 1][0], y1 = STOPS[i + 1][1];
      if (u >= x0 && u <= x1) return y0 + (y1 - y0) * (u - x0) / (x1 - x0);
    }
    return 0;
  }

  /* ---- 主程序 ------------------------------------------------------------ */
  function createDome(root) {
    var canvas = root.querySelector('[data-dome-canvas]');
    if (!canvas) return null;
    var ctx = canvas.getContext('2d');
    var W = 0, H = 0, ratio = 1;
    var camLon = 0, camPhi = 0;
    var zoom = 0;            // 0 = 缩小到底（R_OUT），1 = 放大到底（R_IN）
    var target = 0;
    var phase = 0;           // 扫光相位 0..1
    var frameRequest = 0;
    var lastAt = 0;
    var wheelAccum = 0;      // 累积滚轮量，让一格 = 固定步长
    var wall = null, wallReady = false;
    var detachers = [];
    var diag = { tickN: 0, wheelN: 0, lastDelta: 0 };
    var tile = null;          // 预模糊好的壁纸瓦片（离屏）
    var wallTile = 512;       // 瓦片的基准宽度（px）

    function radius() { return R_OUT + (R_IN - R_OUT) * zoom; }

    function resize() {
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, window.innerWidth);
      H = Math.max(1, window.innerHeight);
      canvas.width = Math.round(W * ratio);
      canvas.height = Math.round(H * ratio);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
    }

    // 壁纸拼接：瓦片宽度 = 焦平面上一段世界长度 / 到墙的距离，所以贴近时瓦片变大
    function tileSize(focal) {
      return Math.max(40, focal * 0.46 / Math.max(0.12, 1 - radius()));
    }

    // 预模糊：把壁纸画进一张离屏画布并做一次 blur。之后每帧只是 drawImage 缩放，
    // 既软化了拼接缝，又避免了每帧对整屏做 filter:blur()。
    function buildTile() {
      if (!wallReady) return;
      var ar = wall.naturalHeight / wall.naturalWidth;
      var c = document.createElement('canvas');
      c.width = wallTile; c.height = Math.max(1, Math.round(wallTile * ar));
      var x = c.getContext('2d');
      x.filter = 'blur(10px)';
      // 多画一圈，模糊后边缘才不会透明
      x.drawImage(wall, -20, -20, c.width + 40, c.height + 40);
      x.filter = 'none';
      tile = c;
    }

    function drawWallpaper(focal) {
      if (!tile) return;
      var t = tileSize(focal);
      var ar = tile.height / tile.width;
      var th = t * ar;
      // 以视口中心为锚，向外铺满。每帧最多 ~ (W/t+2)*(H/th+2) 次 drawImage。
      var ox = W * 0.5, oy = H * 0.42;
      var i0 = Math.floor(-ox / t) - 1, i1 = Math.ceil((W - ox) / t) + 1;
      var j0 = Math.floor(-oy / th) - 1, j1 = Math.ceil((H - oy) / th) + 1;
      ctx.save();
      ctx.globalAlpha = 0.42;
      // 🔴 镜像拼接：相邻瓦片交替水平/垂直翻转。
      //
      // 直接把同一张图平铺会在块与块之间留下硬边 —— 每块是各自模糊的副本，边缘
      // 天然对不上。镜像之后，两块相接处是"同一列像素的镜像"，边缘必然连续，
      // 缝就没了。这是瓷砖铺法的老办法，不需要跨块模糊（那要每帧模糊整屏）。
      for (var j = j0; j <= j1; j++) {
        for (var i = i0; i <= i1; i++) {
          var px = ox + i * t, py = oy + j * th;
          var fx = (i % 2 !== 0), fy = (j % 2 !== 0);
          if (!fx && !fy) { ctx.drawImage(tile, px, py, t, th); continue; }
          ctx.save();
          ctx.translate(px + (fx ? t : 0), py + (fy ? th : 0));
          ctx.scale(fx ? -1 : 1, fy ? -1 : 1);
          ctx.drawImage(tile, 0, 0, t, th);
          ctx.restore();
        }
      }
      ctx.restore();
    }

    // 透视线：球带的纬线（整圈）与经线（弧段）。这是穹顶自己的几何。
    function traceGrid(cam, focal, onSeg) {
      var lon, phi, pts, last;
      for (phi = -BAND_HALF; phi <= BAND_HALF + 0.01; phi += 5) {
        var pv = null;
        for (lon = -180; lon <= 180; lon += 3) {
          var p = project(cam, focal, W, H, sph(lon, phi));
          if (p && pv) onSeg([pv, p], phi);
          pv = p;
        }
      }
      // 🔴 经线必须按短段输出，不能整条当一个段。
      //
      // 第一版把每条经线从 -55° 到 +55° 的点全累进一个数组，只在被遮挡时才断开；
      // 相机在球内，整条经线始终可见，于是**整条经线只拿到了它最后一个点的纬度**
      // （+55°），扫光强度被整条共享 —— 画面上就出现了跟着经线走的"竖亮条"。
      // 现在每 3° 输出一段，每段用自己的中点纬度取强度，亮带才真的是横着的一条。
      for (lon = -180; lon < 180; lon += 15) {
        var prev = null, prevPhi = 0;
        for (phi = -BAND_HALF; phi <= BAND_HALF + 0.01; phi += 3) {
          var q = project(cam, focal, W, H, sph(lon, phi));
          if (q && prev) onSeg([prev, q], (prevPhi + phi) / 2);
          prev = q; prevPhi = phi;
        }
      }
    }

    function strokeSeg(pts) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.stroke();
    }

    function render() {
      if (!W || !H) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // 底色：暗场，与站上 ink 一致
      ctx.fillStyle = '#090b0f';
      ctx.fillRect(0, 0, W, H);

      var cr = radius();
      var cam = makeCamera(camLon, camPhi, cr);
      var focal = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);

      // ① 内壁壁纸
      drawWallpaper(focal);

      // ② 透视线（底网格）
      var base = [];
      traceGrid(cam, focal, function (pts) { base.push(pts); });
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      for (var i = 0; i < base.length; i++) strokeSeg(base[i]);

      // ③ 扫光：亮带中心纬度随 phase 从下缘扫到上缘。
      //    按段的中点纬度取强度，分段归入若干档，每档一次描边 —— 这样亮带会
      //    跟着球面弯（原版是一条直带），而描边次数仍然很少。
      var half = BAND_HALF * BAND_FRAC * 0.5;
      var center = -BAND_HALF + phase * (2 * BAND_HALF);
      var lo = center - half, hi = center + half;
      var buckets = {};
      traceGrid(cam, focal, function (pts, phiMid) {
        var u = half ? (phiMid - lo) / (2 * half) : -1;
        var v = sweepProfile(u);
        if (v <= 0.01) return;
        var key = Math.round(v * 10) / 10;
        (buckets[key] || (buckets[key] = [])).push(pts);
      });
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgb(' + SWEEP[0] + ',' + SWEEP[1] + ',' + SWEEP[2] + ')';
      for (var g = 0; g < GLOW.length; g++) {
        ctx.lineWidth = GLOW[g][0];
        for (var key in buckets) {
          ctx.globalAlpha = SWEEP_A * parseFloat(key) * GLOW[g][1];
          var list = buckets[key];
          for (var n = 0; n < list.length; n++) strokeSeg(list[n]);
        }
      }
      ctx.restore();
    }

    function tick(now) {
      frameRequest = window.requestAnimationFrame(tick);
      var dt = lastAt ? Math.min(64, now - lastAt) : 16;
      lastAt = now;
      // 缩放用指数追逐，帧率无关
      var k = 1 - Math.exp(-dt / 160);
      if (Math.abs(target - zoom) > 0.0004) zoom += (target - zoom) * k;
      else zoom = target;
      // 扫光 4s 一轮（与 _config.yml 的 sweep_duration 一致）
      phase = (phase + dt / 4000) % 1;
      diag.tickN++;
      render();
    }

    function arm() {
      lastAt = 0;
      if (!frameRequest) frameRequest = window.requestAnimationFrame(tick);
    }

    /* ---- ① 劫持滚轮 + 页面不滚动 -------------------------------------- */
    function onWheel(e) {
      e.preventDefault();          // 页面永不滚动
      diag.wheelN++;
      diag.lastDelta = e.deltaY;
      wheelAccum += e.deltaY;
      // 一格滚轮（deltaY≈100）走 0.06 的缩放行程，手感偏"重"，避免一滑到底
      var step = 0.06;
      if (Math.abs(wheelAccum) >= 100) {
        var n = Math.trunc(wheelAccum / 100);
        // 往下滚 = 拉远（缩小），往上滚 = 靠近（放大）
        target = clamp01(target - n * step * 1.0);
        wheelAccum -= n * 100;
      }
      arm();
    }

    function onResize() { resize(); render(); }

    function init() {
      resize();
      // 壁纸：取站上同一张，保证和其它页面同源
      wall = new window.Image();
      wall.decoding = 'async';
      wall.onload = function () { wallReady = true; buildTile(); render(); };
      wall.onerror = function () { wallReady = false; };
      wall.src = canvas.getAttribute('data-dome-wallpaper') || '/images/wallpaper/wallpaper-default.webp';

      // 🔴 页面不滚动：给 html/body 上锁，并吃掉所有滚动入口。
      //    只在本模块挂载时加，卸载时全部还原（见 destroy）。
      document.documentElement.classList.add('is-dome');
      document.body.classList.add('is-dome');

      window.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('resize', onResize);
      detachers.push(function () { window.removeEventListener('wheel', onWheel); });
      detachers.push(function () { window.removeEventListener('resize', onResize); });

      arm();
    }

    function destroy() {
      if (frameRequest) { window.cancelAnimationFrame(frameRequest); frameRequest = 0; }
      for (var i = 0; i < detachers.length; i++) detachers[i]();
      detachers.length = 0;
      document.documentElement.classList.remove('is-dome');
      document.body.classList.remove('is-dome');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      wall = null; wallReady = false;
    }

    return {
      init: init, destroy: destroy,
      // 诊断面：只读 getter，方便探针核对，不复制状态
      state: function () {
        return {
          zoom: zoom, target: target, radius: radius(), phase: phase,
          W: W, H: H, ratio: ratio, wallReady: wallReady,
          tickN: diag.tickN, wheelN: diag.wheelN, lastDelta: diag.lastDelta,
          scrollY: window.scrollY
        };
      }
    };
  }

  window.WillowXIDome = { create: createDome };
})();

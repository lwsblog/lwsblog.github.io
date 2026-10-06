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
  // SWEEP: one full pass in ms. The original scene uses 4s, but that sits on a
  // 46px-blurred plate; the dome is a crisp field with a much wider view, so the same
  // 4s reads as a flash. User: the sweep is too fast.
  var SWEEP_MS = 9000;

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

  // 🎛️ 穹顶夸张：真球面从内部看曲率很弱（fov 58° 时可见内壁仅约 45°，几乎是平的）。
  // 原站那个"穹顶感"来自刻意把平面网格掰弯（bow .17 / hoop .13），比真实球面弯得多。
  // 所以这里在**真投影之上**再叠一层同类形变，把穹顶弯度补回来。
  // 0 = 纯真球面（很平）；越大越像原站。
  var BOW = 0.26;      // 水平"收腰"：屏幕中部往里挤
  var HOOP = 0.20;     // 横线向外"弓"

  function exaggerate(x, y, W, H) {
    if (!BOW && !HOOP) return [x, y];
    var cx = W * 0.5, cy = H * 0.5;
    var halfW = Math.max(1, W * 0.5), halfH = Math.max(1, H * 0.5);
    var ty = (y - cy) / halfH;
    var waist = 1 - BOW * Math.max(0, 1 - ty * ty);
    var x2 = cx + (x - cx) * waist;
    var tx = (x - cx) / halfW;
    var y2 = y + HOOP * tx * tx * (y - cy);
    return [x2, y2];
  }

  // 把球面点投影到屏幕；在相机后方返回 null
  function project(cam, focal, W, H, P) {
    var dx = P[0] - cam.pos[0], dy = P[1] - cam.pos[1], dz = P[2] - cam.pos[2];
    var z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
    if (z <= 0.06) return null;
    var xc = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
    var yc = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
    return exaggerate(W * 0.5 + focal * xc / z, H * 0.5 - focal * yc / z, W, H);
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

    // 🔴 半径不能线性插值。
    //
    // 视觉缩放正比于 1/(1-r)：r 从 0.32 走到 0.94 时 1-r 从 0.68 掉到 0.06，
    // 于是**最后 10% 的滚轮行程吃掉了绝大部分缩放**，前半段像是没动 ——
    // 用户："缩放范围有点小"。改成让 (1-r) 按**几何级数**衰减，等量的滚轮就得到
    // 等比例的视觉缩放，整段行程的手感才均匀。
    var D_OUT = 1 - R_OUT, D_IN = 1 - R_IN;
    function radius() {
      return 1 - D_OUT * Math.pow(D_IN / D_OUT, zoom);
    }

    function resize() {
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, window.innerWidth);
      H = Math.max(1, window.innerHeight);
      canvas.width = Math.round(W * ratio);
      canvas.height = Math.round(H * ratio);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
    }

    // WALLPAPER, drawn as a TEXTURE ON THE SPHERE -- not as a screen-space tiling.
    //
    // Every earlier version tiled the image in screen space while the grid went through
    // the real projection plus `exaggerate`. Two different geometries can never agree:
    // the grid curved and the wallpaper did not (so they did not read as one surface),
    // they scaled at different rates (the reported opposite-direction zoom), and a
    // screen-space tiling always leaves hard seams where tiles meet.
    //
    // So the wallpaper is now mapped onto the band itself: one pass of the image wraps
    // the full 360 degrees of longitude and spans the band's latitude, drawn as a mesh of
    // small quads whose corners come from the SAME `project` the grid uses. That makes the
    // two literally the same surface -- same scale, same direction, same curvature -- and
    // a single wrap has no seams to hide.
    var WALL_COLS = 36;          // quads around the sphere
    var WALL_ROWS = 8;           // quads across the band

    function drawWallpaper(cam, focal) {
      if (!wallReady) return;
      var iw = wall.naturalWidth, ih = wall.naturalHeight;
      ctx.save();
      // 一次模糊同时办两件事：抹掉仿射近似留下的块间裂缝，并得到原站那种柔和的
      // 壁纸质感（原站那层是 46px 模糊）。
      ctx.filter = 'blur(4px)';
      ctx.globalAlpha = 0.42;
      for (var r = 0; r < WALL_ROWS; r++) {
        var lat0 = -BAND_HALF + (2 * BAND_HALF) * r / WALL_ROWS;
        var lat1 = -BAND_HALF + (2 * BAND_HALF) * (r + 1) / WALL_ROWS;
        for (var ci = 0; ci < WALL_COLS; ci++) {
          var lon0 = -180 + 360 * ci / WALL_COLS;
          var lon1 = -180 + 360 * (ci + 1) / WALL_COLS;
          var p00 = project(cam, focal, W, H, sph(lon0, lat0));
          var p10 = project(cam, focal, W, H, sph(lon1, lat0));
          var p11 = project(cam, focal, W, H, sph(lon1, lat1));
          var p01 = project(cam, focal, W, H, sph(lon0, lat1));
          if (!p00 || !p10 || !p11 || !p01) continue;
          var sx = iw * ci / WALL_COLS;
          var sy = ih * (WALL_ROWS - 1 - r) / WALL_ROWS;   // image row 0 is the top
          var sw = iw / WALL_COLS, sh = ih / WALL_ROWS;
          // Affine map from the unit square to this quad: origin p00, basis p10-p00 and
          // p01-p00. `transform` (not setTransform) so the DPR scale stays in effect.
          var a = p10[0] - p00[0], b = p10[1] - p00[1];
          var c2 = p01[0] - p00[0], d2 = p01[1] - p00[1];
          // Expand a hair so neighbouring quads overlap instead of leaving hairlines.
          var ex = 0, k = 1;   // 不再向外扩（clip 用真实四边形，本来就没有缝）
          var mx = (a + c2), my = (b + d2);
          var ml = Math.sqrt(mx * mx + my * my) || 1;
          var gx = mx / ml * ex, gy = my / ml * ex;
          ctx.save();
          // 🔴 裁剪路径必须是完整的四边形（四个角）。
          // 上一版误写成 p00 -> p10 -> p10 -> p00，那是一条线、零面积，clip 之后
          // 什么都画不出来 —— 壁纸整片消失。
          // 🔴 裁剪多边形必须比真实四边形**向外放大一点点**。
          //
          // 投影后的四边形不是平行四边形，而 canvas 只能做仿射映射，所以每一块都是
          // 近似；相邻块之间必然合不严，缝里露出底色 —— 画面上就是一道道黑线。
          // 每块以重心为中心放大 2%，相邻块互相重叠，缝就被盖住了。
          var mx4 = (p00[0] + p10[0] + p11[0] + p01[0]) / 4;
          var my4 = (p00[1] + p10[1] + p11[1] + p01[1]) / 4;
          var E = 1.03;
          function gz(pt) {
            return [mx4 + (pt[0] - mx4) * E, my4 + (pt[1] - my4) * E];
          }
          var q00 = gz(p00), q10 = gz(p10), q11 = gz(p11), q01 = gz(p01);
          ctx.beginPath();
          ctx.moveTo(q00[0], q00[1]);
          ctx.lineTo(q10[0], q10[1]);
          ctx.lineTo(q11[0], q11[1]);
          ctx.lineTo(q01[0], q01[1]);
          ctx.closePath();
          ctx.clip();
          ctx.transform(a * k, b * k, c2 * k, d2 * k, p00[0], p00[1]);
          ctx.drawImage(wall, sx, sy, sw, sh, 0, 0, 1, 1);
          ctx.restore();
        }
      }
      ctx.restore();
    }

    // 透视线：球带的纬线（整圈）与经线（弧段）。这是穹顶自己的几何。
    function traceGrid(cam, focal, onSeg) {
      var lon, phi, pts, last;
      // 线太稀就读不出弯 —— 5°/15° 在 fov 58° 下每屏只有十来条，看着是平的。
      for (phi = -BAND_HALF; phi <= BAND_HALF + 0.01; phi += 2.5) {
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
      for (lon = -180; lon < 180; lon += 10) {
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
      drawWallpaper(cam, focal);

      // ② 透视线（底网格）
      var base = [];
      traceGrid(cam, focal, function (pts) { base.push(pts); });
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      for (var i = 0; i < base.length; i++) strokeSeg(base[i]);

      // ③ 扫光。
      //
      // 🔴 用**屏幕空间的线性渐变**当描边色，与原版 willowxi.js:339-344 同一手法。
      //
      // 上一版为了体现"亮带跟着球面弯"，改成按中点纬度分档、每档一个固定 alpha。
      // 只有 10 档，于是画出来是一条条台阶 —— 用户："段落感太强了，太生硬了"。
      // 那是分档本身造成的，不是球面几何的问题；**渐变是连续的，档位不是**。
      // 3D 感来自网格本身的投影，不需要靠给亮带分档来换。
      //
      // 亮带中心的屏幕 y：把"正前方墙面上、纬度等于亮带中心"的那点投影出来即得。
      var half = BAND_HALF * BAND_FRAC * 0.5;
      var centerLat = -BAND_HALF + phase * (2 * BAND_HALF);
      var midLon = camLon + 180;
      var pMid = project(cam, focal, W, H, sph(midLon, centerLat));
      var pTop = project(cam, focal, W, H, sph(midLon, Math.min(BAND_HALF, centerLat + half)));
      var pBot = project(cam, focal, W, H, sph(midLon, Math.max(-BAND_HALF, centerLat - half)));
      if (pMid && pTop && pBot) {
        var yA = pTop[1], yB = pBot[1];
        if (yB - yA < 1) yB = yA + 1;
        var grad = ctx.createLinearGradient(0, yA, 0, yB);
        for (var st = 0; st < STOPS.length; st++) {
          grad.addColorStop(STOPS[st][0],
            'rgba(' + SWEEP[0] + ',' + SWEEP[1] + ',' + SWEEP[2] + ',' +
            (SWEEP_A * STOPS[st][1]).toFixed(3) + ')');
        }
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        // 5 层光晕：逐层加宽变淡，在网格上留下柔和的拖尾（与原版同一组数字）
        for (var g = 0; g < GLOW.length; g++) {
          ctx.globalAlpha = GLOW[g][1];
          ctx.lineWidth = GLOW[g][0];
          ctx.strokeStyle = grad;
          for (var i2 = 0; i2 < base.length; i2++) strokeSeg(base[i2]);
        }
        ctx.restore();
      }
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
      phase = (phase + dt / SWEEP_MS) % 1;
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
      // 一格滚轮走 0.05 的行程。半径改成几何映射后每格都是等比例的视觉变化，
      // 所以整段行程的手感均匀，不需要再靠"重"来防一滑到底。
      var step = 0.05;
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
      wall.onload = function () { wallReady = true; render(); };
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
          bow: BOW, hoop: HOOP,
          scrollY: window.scrollY
        };
      }
    };
  }

  window.WillowXIDome = {
    create: createDome,
    // 🎛️ 实时调夸张力度（0 = 纯真球面，很平；0.25 左右明显像穹顶）
    setBow: function (v) { BOW = Number(v) || 0; },
    setHoop: function (v) { HOOP = Number(v) || 0; },
    getBow: function () { return BOW; },
    getHoop: function () { return HOOP; }
  };
})();

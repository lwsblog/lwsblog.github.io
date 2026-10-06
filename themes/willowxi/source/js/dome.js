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

var WALL_VS = [
  'attribute vec3 aPos;',
  'attribute vec2 aUV;',
  'uniform vec3 uEye, uRight, uUp, uFwd;',
  'uniform float uFocal, uHalfW, uHalfH, uBow, uHoop;',
  'varying vec2 vUV;',
  'void main() {',
  '  vec3 d = aPos - uEye;',
  '  float z = dot(d, uFwd);',
  '  float x = dot(d, uRight);',
  '  float y = dot(d, uUp);',
  '  float sx = uHalfW + uFocal * x / z;',
  '  float sy = uHalfH - uFocal * y / z;',
  // The SAME exaggeration the 2D grid applies, so the wallpaper and the grid are
  // literally the same surface. Doing it here rather than on the CPU is what keeps a
  // WebGL layer from drifting away from the 2D layer.
  '  float ty = (sy - uHalfH) / uHalfH;',
  '  float waist = 1.0 - uBow * max(0.0, 1.0 - ty * ty);',
  '  float sx2 = uHalfW + (sx - uHalfW) * waist;',
  '  float tx = (sx - uHalfW) / uHalfW;',
  '  float sy2 = sy + uHoop * tx * tx * (sy - uHalfH);',
  '  gl_Position = vec4(sx2 / uHalfW - 1.0, 1.0 - sy2 / uHalfH, 0.0, 1.0);',
  '  vUV = aUV;',
  '}'
].join('\n');

var WALL_FS = [
  'precision mediump float;',
  'uniform sampler2D uTex;',
  'uniform float uAlpha;',
  'varying vec2 vUV;',
  'void main() {',
  '  vec4 c = texture2D(uTex, vUV);',
  '  gl_FragColor = vec4(c.rgb, c.a * uAlpha);',
  '}'
].join('\n');


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
    var diag = { tickN: 0, wheelN: 0, lastDelta: 0, glReady: 0, glTex: 0, glVerts: 0, glErr: '' };

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
      if (glc) {
        glc.width = canvas.width;
        glc.height = canvas.height;
        glc.style.width = W + 'px';
        glc.style.height = H + 'px';
      }
    }

    // WALLPAPER as a REAL TEXTURE on the band, drawn with WebGL.
    //
    // Every 2D attempt failed the same way: canvas can only map a texture affinely, so a
    // projected quad is an approximation and neighbouring quads never meet -- visible
    // dark seams, and a blur cannot hide an area that was never drawn. WebGL interpolates
    // per-pixel, so the band is one continuous surface with no seams at all.
    //
    // The vertex shader applies the SAME exaggeration the 2D grid applies, so the two
    // layers are still one geometry -- that is what makes them scale and curve together.

    var glc = null, gl = null, glProg = null, glBuf = null, glTex = null;
    var glULoc = {};
    var WALL_REPEAT = 4;         // how many times the image wraps around 360 degrees

    function glCompile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        diag.glErr = String(gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    }

    function initWallGL() {
      glc = root.querySelector('[data-dome-wall]');
      if (!glc) return;
      gl = glc.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false }) ||
           glc.getContext('experimental-webgl');
      if (!gl) { diag.glErr = 'no webgl'; return; }
      // MUST size the GL canvas here.
      //
      // resize() runs BEFORE initWallGL(), so at that moment glc is still null and the
      // canvas keeps its default 300x150. The vertex shader then takes uHalfW/uHalfH from
      // glc.width/2 while uFocal is computed for 1440x900 -- two different scales, so every
      // vertex lands outside the clip volume and the wallpaper never appears at all.
      glc.width = canvas.width;
      glc.height = canvas.height;
      glc.style.width = W + 'px';
      glc.style.height = H + 'px';
      var vs = glCompile(gl.VERTEX_SHADER, WALL_VS);
      var fs = glCompile(gl.FRAGMENT_SHADER, WALL_FS);
      if (!vs || !fs) return;
      glProg = gl.createProgram();
      gl.attachShader(glProg, vs);
      gl.attachShader(glProg, fs);
      gl.linkProgram(glProg);
      if (!gl.getProgramParameter(glProg, gl.LINK_STATUS)) {
        diag.glErr = String(gl.getProgramInfoLog(glProg));
        return;
      }
      gl.useProgram(glProg);
      glULoc = {
        aPos: gl.getAttribLocation(glProg, 'aPos'),
        aUV: gl.getAttribLocation(glProg, 'aUV'),
        uEye: gl.getUniformLocation(glProg, 'uEye'),
        uRight: gl.getUniformLocation(glProg, 'uRight'),
        uUp: gl.getUniformLocation(glProg, 'uUp'),
        uFwd: gl.getUniformLocation(glProg, 'uFwd'),
        uFocal: gl.getUniformLocation(glProg, 'uFocal'),
        uHalfW: gl.getUniformLocation(glProg, 'uHalfW'),
        uHalfH: gl.getUniformLocation(glProg, 'uHalfH'),
        uBow: gl.getUniformLocation(glProg, 'uBow'),
        uHoop: gl.getUniformLocation(glProg, 'uHoop'),
        uTex: gl.getUniformLocation(glProg, 'uTex'),
        uAlpha: gl.getUniformLocation(glProg, 'uAlpha')
      };
      // Build the band mesh once: positions on the sphere, UVs across the image.
      var LON_STEP_GL = 3, LAT_STEP = 3, verts = [];
      for (var la = -BAND_HALF; la < BAND_HALF; la += LAT_STEP) {
        for (var lo = -180; lo < 180; lo += LON_STEP_GL) {
          var quad = [[lo, la], [lo + LON_STEP_GL, la],
                      [lo + LON_STEP_GL, la + LAT_STEP], [lo, la + LAT_STEP]];
          var tri = [0, 1, 2, 0, 2, 3];
          for (var t = 0; t < 6; t++) {
            var q = quad[tri[t]];
            var P = sph(q[0], q[1]);
            verts.push(P[0], P[1], P[2]);
            var u = ((q[0] + 180) / 360) * WALL_REPEAT;
            var v = 1 - (q[1] + BAND_HALF) / (2 * BAND_HALF);   // image row 0 is the top
            verts.push(u, v);
          }
        }
      }
      glBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
      var f32 = new Float32Array(verts);
      gl.bufferData(gl.ARRAY_BUFFER, f32, gl.STATIC_DRAW);
      diag.glVerts = f32.length / 5;
      gl.enableVertexAttribArray(glULoc.aPos);
      gl.vertexAttribPointer(glULoc.aPos, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(glULoc.aUV);
      gl.vertexAttribPointer(glULoc.aUV, 2, gl.FLOAT, false, 20, 12);
      gl.clearColor(0.035, 0.043, 0.059, 1);   // the site's ink, as the base colour
      diag.glReady = 1;
    }

    function uploadWallTexture() {
      if (!gl || !wallReady || glTex) return;
      glTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, wall);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      diag.glTex = 1;
    }

    function drawWallGL(cam, focal) {
      if (!gl || !glProg) return;
      uploadWallTexture();
      gl.viewport(0, 0, glc.width, glc.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!glTex) return;
      gl.useProgram(glProg);
      gl.uniform3fv(glULoc.uEye, cam.pos);
      gl.uniform3fv(glULoc.uRight, cam.right);
      gl.uniform3fv(glULoc.uUp, cam.up);
      gl.uniform3fv(glULoc.uFwd, cam.fwd);
      gl.uniform1f(glULoc.uFocal, focal * ratio);
      gl.uniform1f(glULoc.uHalfW, glc.width * 0.5);
      gl.uniform1f(glULoc.uHalfH, glc.height * 0.5);
      gl.uniform1f(glULoc.uBow, BOW);
      gl.uniform1f(glULoc.uHoop, HOOP);
      gl.uniform1f(glULoc.uAlpha, 0.62);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      gl.uniform1i(glULoc.uTex, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
      gl.enableVertexAttribArray(glULoc.aPos);
      gl.vertexAttribPointer(glULoc.aPos, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(glULoc.aUV);
      gl.vertexAttribPointer(glULoc.aUV, 2, gl.FLOAT, false, 20, 12);
      gl.drawArrays(gl.TRIANGLES, 0, diag.glVerts || 0);
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
      // ⚠️ 这里**不能**再铺不透明底色：壁纸由下面那层 WebGL canvas 画，铺了就把
      //    它盖住了。暗场底色改由 WebGL 的 clearColor 负责（见 glClearColor）。

      var cr = radius();
      var cam = makeCamera(camLon, camPhi, cr);
      var focal = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);

      // ① 内壁壁纸：交给 WebGL 做真纹理映射（见 drawWallGL）
      drawWallGL(cam, focal);

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
      wall.onload = function () { wallReady = true; glTex = null; render(); };
      wall.onerror = function () { wallReady = false; };
      wall.src = canvas.getAttribute('data-dome-wallpaper') || '/images/wallpaper/wallpaper-default.webp';

      // 🔴 页面不滚动：给 html/body 上锁，并吃掉所有滚动入口。
      //    只在本模块挂载时加，卸载时全部还原（见 destroy）。
      document.documentElement.classList.add('is-dome');
      document.body.classList.add('is-dome');

      initWallGL();          // WebGL 壁纸层
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
          bow: BOW, hoop: HOOP, gl: diag.glReady, glTex: diag.glTex, glErr: diag.glErr,
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

/* ============================================================================
   穹顶相册 · 单管线 WebGL（片元着色器里程序化生成网格与扫光）
   ----------------------------------------------------------------------------
   为什么不再用 GL_LINES：
     * WebGL 里 gl.lineWidth() 几乎被所有实现忽略，线永远是 1px
     * 片元着色器只在这 1px 上执行，**无法**把线加宽 —— 所以"靠着色器做光晕"
       在用线画的前提下根本做不到，只能反复偏移几何去伪造（画质差、开销大）
     * 于是旧版的 5 层"光晕"其实是 5 条同样粗的 1px 线，alpha 叠到 1.49 后饱和
       成纯白：光带是一条硬白线，竖线在交叉处反复叠加整条发亮

   现在把整个球带用**三角形**铺出来，网格线在片元着色器里按"当前像素离最近的
   经纬线多远"程序化生成。线宽、羽化、光晕、扫光全部是着色器里的连续量：
     * 线宽不再受 lineWidth 限制，而且天然抗锯齿
     * 扫光逐像素算，没有任何分档台阶
     * 壁纸、网格、扫光在同一个片元里合成，**一次 draw call**
   ========================================================================= */
(function () {
  'use strict';

  var BAND_HALF = 55.0;      // 球带半张角（度）
  var FOV = 58.0;            // 水平视场角（度），固定
  var R_OUT = 0.32;          // 缩小到底（最远）
  var R_IN = 0.94;           // 放大到底（最近）
  var BOW = 0.26;            // 穹顶夸张：水平收腰
  var HOOP = 0.20;           // 穹顶夸张：横线外弓
  var SWEEP_MS = 9000;       // 扫光一轮毫秒（原站 4s，穹顶视野更大故放慢）
  var BAND_FRAC = 0.55;      // 亮带厚度 / 球带张角
  var LAT_STEP = 2.5;        // 网格：纬线间距（度）
  var LON_STEP = 10.0;       // 网格：经线间距（度）
  var WALL_REPEAT = 4;       // 壁纸绕球几圈（横向）
  var WALL_AR = 1280 / 533;  // 壁纸原始宽高比，用来定纵向重复次数
  // 一个横向重复覆盖 360/WALL_REPEAT 度经度；按原图比例，它应当覆盖
  // (360/WALL_REPEAT)/WALL_AR 度纬度。球带高 2*BAND_HALF，于是纵向需要重复：
  var WALL_VREP = (2 * BAND_HALF) / ((360 / WALL_REPEAT) / WALL_AR);

  // 与站上一致的色值
  var INK = [0.035, 0.043, 0.059];
  var GRID_RGB = [196 / 255, 224 / 255, 236 / 255];
  var GRID_A = 0.5;
  var SWEEP_RGB = [214 / 255, 240 / 255, 255 / 255];
  var SWEEP_A = 0.45;
  var WALL_A = 0.55;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function sph(lon, phi) {
    var lo = lon * Math.PI / 180, ph = phi * Math.PI / 180, c = Math.cos(ph);
    return [Math.sin(lo) * c, Math.sin(ph), Math.cos(lo) * c];
  }

  function makeCamera(camLon, camPhi, cr) {
    var p = sph(camLon, camPhi);
    var pos = [p[0] * cr, p[1] * cr, p[2] * cr];
    var L = Math.sqrt(pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]) || 1;
    var fwd = [-pos[0] / L, -pos[1] / L, -pos[2] / L];
    var rx = -fwd[2], rz = fwd[0];
    var rl = Math.sqrt(rx * rx + rz * rz) || 1;
    var right = [rx / rl, 0, rz / rl];
    return {
      pos: pos, fwd: fwd, right: right,
      up: [right[1] * fwd[2] - right[2] * fwd[1],
           right[2] * fwd[0] - right[0] * fwd[2],
           right[0] * fwd[1] - right[1] * fwd[0]]
    };
  }

  // CPU 侧的投影 + 夸张。必须与顶点着色器里的公式逐字一致 —— 相纸是 DOM，
  // 网格是 WebGL，两者只有共用同一份公式才不会在缩放/移动时错开。
  function projectPoint(cam, focal, W, H, P) {
    var dx = P[0] - cam.pos[0], dy = P[1] - cam.pos[1], dz = P[2] - cam.pos[2];
    var z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
    if (z <= 0.06) return null;
    var xc = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
    var yc = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
    var sx = W * 0.5 + focal * xc / z, sy = H * 0.5 - focal * yc / z;
    var ty = (sy - H * 0.5) / (H * 0.5);
    var waist = 1 - BOW * Math.max(0, 1 - ty * ty);
    var sx2 = W * 0.5 + (sx - W * 0.5) * waist;
    var tx = (sx - W * 0.5) / (W * 0.5);
    var sy2 = sy + HOOP * tx * tx * (sy - H * 0.5);
    return [sx2, sy2];
  }
  var VS = [
    'attribute vec3 aPos;',
    'attribute float aLat;',
    'attribute float aLon;',
    'attribute vec2 aUV;',
    'uniform vec3 uEye, uRight, uUp, uFwd;',
    'uniform float uFocal, uHalfW, uHalfH, uBow, uHoop;',
    'varying float vLat;',
    'varying float vLon;',
    'varying vec2 vUV;',
    'void main() {',
    '  vec3 d = aPos - uEye;',
    '  float z = dot(d, uFwd);',
    '  float x = dot(d, uRight);',
    '  float y = dot(d, uUp);',
    '  float sx = uHalfW + uFocal * x / max(z, 0.01);',
    '  float sy = uHalfH - uFocal * y / max(z, 0.01);',
    '  float ty = (sy - uHalfH) / uHalfH;',
    '  float waist = 1.0 - uBow * max(0.0, 1.0 - ty * ty);',
    '  float sx2 = uHalfW + (sx - uHalfW) * waist;',
    '  float tx = (sx - uHalfW) / uHalfW;',
    '  float sy2 = sy + uHoop * tx * tx * (sy - uHalfH);',
    // Convert the exaggerated SCREEN position back into clip space carrying w = z.
    //
    // Dividing by z here and writing w = 1 (the previous version) told the GPU the
    // vertices were already in NDC, so it could not clip against the near plane.
    // Triangles straddling the camera -- and part of the band is always behind it --
    // blew up into huge garbage shapes across the screen. Carrying w = z hands the
    // divide and the near-plane clip back to the GPU, and the exaggeration survives
    // because it is applied before this conversion.
    '  float zc = max(z, 0.01);',
    // Real perspective depth, so overlapping geometry (the band wraps all the way
    // around the camera, and its far and near parts can land on the same pixel) is
    // resolved by the depth buffer instead of by draw order. With clip.z pinned to 0
    // and the depth test off, whichever triangle happened to be rasterised last won --
    // which is exactly what made the UV field jump along a hard line.
    '  const float NEAR = 0.02;',
    '  const float FAR = 10.0;',
    '  float ndcZ = (FAR + NEAR) / (FAR - NEAR) - 2.0 * FAR * NEAR / ((FAR - NEAR) * zc);',
    '  gl_Position = vec4((sx2 / uHalfW - 1.0) * zc, (1.0 - sy2 / uHalfH) * zc, ndcZ * zc, zc);',
    '  vLat = aLat;',
    '  vLon = aLon;',
    '  vUV = aUV;',
    '}'
  ].join('\n');

  var FS = [
    'precision highp float;',
    'uniform sampler2D uTex;',
    'uniform float uLatStep, uLonStep;',
    'uniform float uGridA, uSweepA, uWallA, uSweepOn;',
    'uniform float uBandLo, uBandHi;',
    // Degrees of arc per device pixel at the wall straight ahead. Computed on the CPU
    // instead of using fwidth(): GL_OES_standard_derivatives is not available everywhere
    // (headless/software WebGL in particular) and the shader then fails to compile, which
    // takes the whole scene down with it.
    'uniform float uDegPerPx;',
    'uniform float uDebug;',
    'uniform vec3 uGridRGB, uSweepRGB, uInk;',
    'varying float vLat;',
    'varying float vLon;',
    'varying vec2 vUV;',
    // Distance to the nearest grid line (in degrees), compared against a width expressed
    // in degrees, so the line keeps a constant on-screen width.
    'float lineMask(float v, float st, float px) {',
    '  float d = abs(fract(v / st + 0.5) - 0.5) * st;',
    '  float w = uDegPerPx * px;',
    '  return 1.0 - smoothstep(w * 0.35, w * 1.15, d);',
    '}',
    // Sweep: continuous, no banding. A core plus a halo, both smooth.
    'float profile(float u) {',
    '  if (u <= 0.0 || u >= 1.0) return 0.0;',
    '  float d = abs(u - 0.5) * 2.0;',
    '  float core = 1.0 - smoothstep(0.0, 0.5, d);',
    '  float halo = 1.0 - smoothstep(0.0, 1.0, d);',
    '  return core * 0.75 + halo * 0.25;',
    '}',
    'void main() {',
    '  vec3 col = uInk;',
    '  vec4 w = texture2D(uTex, fract(vUV));',
    '  col = mix(col, w.rgb, w.a * uWallA);',
    '  float m = max(lineMask(vLat, uLatStep, 1.15), lineMask(vLon, uLonStep, 1.15));',
    '  col += uGridRGB * m * uGridA;',
    '  float sw = profile((vLat - uBandLo) / max(uBandHi - uBandLo, 0.001)) * uSweepOn;',
    '  col += uSweepRGB * m * sw * uSweepA;',
    // The band also lifts the surface a touch, so it reads as light passing over the
    // wallpaper rather than as only the lines glowing.
    '  col += uSweepRGB * sw * 0.045;',
    '  gl_FragColor = vec4(col, 1.0);',
    '  if (uDebug > 0.5) gl_FragColor = vec4(fract(vUV.x), vUV.y, 0.0, 1.0);',
    '}'
  ].join('\n');

  function createDome(root) {
    var canvas = root.querySelector('[data-dome-canvas]');
    if (!canvas) return null;
    var gl = canvas.getContext('webgl', { alpha: false, antialias: true }) ||
             canvas.getContext('experimental-webgl');
    if (!gl) return null;

    var W = 0, H = 0, ratio = 1;
    var camLon = 0, camPhi = 0, zoom = 0, target = 0, phase = 0;
    var frameRequest = 0, lastAt = 0, wheelAccum = 0;
    var wall = null, wallReady = false, tex = null;
    var detachers = [];
    var prog = null, loc = {}, buf = null, nVerts = 0;
    var diag = { tickN: 0, wheelN: 0, verts: 0, err: '', draws: 0 };

    // ---- 相纸：贴在内壁上的照片 ----------------------------------------
    var MATTE_ARC = 13.0;        // 一张相纸占的弧长（度）—— 统一弧长
    var MATTE_AR = 1.30;         // 相纸本身的宽高比（不是照片的）
    var perRowMin = 10, perRowMax = 14;
    var photos = [];             // {el, img, lat, lon}

    // 从页面上已有的相框里取数据。旧相册的 DOM 还在（阶段④才移除），正好复用
    // 它的 data-id / --ratio / 图片地址，不必再引一份数据。
    function collectPhotos() {
      var frames = root.querySelectorAll('[data-photo-frame]');
      var out = [];
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var img = f.querySelector('img');
        if (!img) continue;
        var ratio = parseFloat(img.getAttribute('width')) /
                    parseFloat(img.getAttribute('height'));
        out.push({
          id: f.getAttribute('data-id') || String(i + 1),
          tally: f.getAttribute('data-tally') || String(i + 1),
          src: img.getAttribute('src'),
          ratio: isFinite(ratio) && ratio > 0 ? ratio : 1.5
        });
      }
      return out;
    }

    // 排数与每排张数随总数自适应，让每排落在 perRowMin..perRowMax 张之间。
    // 这与样张 dome-lab 里定稿的规则一致。
    function assignSlots(list) {
      var n = list.length;
      if (!n) return;
      var rows = 3;
      for (var r = 2; r <= 8; r++) {
        var per = n / r;
        if (per >= perRowMin - 1 && per <= perRowMax + 1) { rows = r; break; }
      }
      var base = Math.floor(n / rows);
      var counts = [], extra = n % rows;
      for (var i = 0; i < rows; i++) counts.push(base + (i < extra ? 1 : 0));
      // 行纬度必须落在**竖直视场角以内**，否则上下排整个跑到画面外。
      //
      // fov 58 是水平视场角；1440x900 下竖直视场角 = 2*atan(tan(29°)/1.6) ≈ 38°，
      // 所以行的纬度要收在 ±19° 之内。之前用 BAND_HALF*0.82 = ±45.1°，两排全在
      // 屏幕外 —— 这就是相纸一张都看不见的原因（zz 和尺寸检查都通过，只是位置在
      // 画面之外）。
      var span = Math.min(BAND_HALF * 0.82, 11);
      var lat = [], k = 0;
      for (var ri = 0; ri < rows; ri++) {
        lat.push(rows === 1 ? 0 : span - 2 * span * ri / (rows - 1));
      }
      for (var ri2 = 0; ri2 < rows; ri2++) {
        var step = 360 / counts[ri2];
        for (var j = 0; j < counts[ri2]; j++) {
          // 奇偶排错半格（交错排布）
          list[k].lat = lat[ri2];
          list[k].lon = j * step + (ri2 % 2) * step * 0.5;
          k++;
        }
      }
    }

    function buildMatte(p) {
      var el = document.createElement('div');
      el.setAttribute('data-dome-matte', '');
      el.setAttribute('data-id', p.id);
      var win = document.createElement('div');
      win.className = 'win';
      var img = document.createElement('img');
      img.src = p.src;
      img.alt = '';
      img.draggable = false;
      img.loading = 'lazy';
      img.decoding = 'async';
      win.appendChild(img);
      el.appendChild(win);
      var cap = document.createElement('span');
      cap.className = 'cap';
      cap.textContent = p.tally;
      el.appendChild(cap);
      // 照片按原比例内嵌：宽高比由图片自身决定，用 max-width/height 居中留边
      var iw = 1 - 2 * 0.055;
      if (p.ratio >= MATTE_AR * (iw / (1 - 0.055 - 0.14))) {
        img.style.width = '100%';
      } else {
        img.style.height = '100%';
      }
      p.el = el; p.img = img;
      layer.appendChild(el);
    }

    var layer = null;
    var matteWorld = 2 * Math.sin(MATTE_ARC * Math.PI / 360);

    // 每帧按与 WebGL 完全相同的投影 + 夸张写位置，所以相纸与网格不可能错位。
    function updatePhotos(cam, focal) {
      if (!layer || !photos.length) return;
      var zmin = 1e9;
      for (var i = 0; i < photos.length; i++) {
        var P = sph(photos[i].lon, photos[i].lat);
        var dx = P[0] - cam.pos[0], dy = P[1] - cam.pos[1], dz = P[2] - cam.pos[2];
        var z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
        photos[i].z = z;
        if (z > 0.06 && z < zmin) zmin = z;
      }
      if (zmin > 1e8) zmin = 1;
      for (var k = 0; k < photos.length; k++) {
        var q = photos[k];
        var Q = sph(q.lon, q.lat);
        var ex = Q[0] - cam.pos[0], ey = Q[1] - cam.pos[1], ez = Q[2] - cam.pos[2];
        var zz = ex * cam.fwd[0] + ey * cam.fwd[1] + ez * cam.fwd[2];
        if (zz <= 0.06) { q.el.style.display = 'none'; continue; }
        if (!diag.m0) diag.m0 = { lon: q.lon, lat: q.lat, zz: zz, fwd: cam.fwd.slice(), pos: cam.pos.slice() };
        var pt = projectPoint(cam, focal, W, H, Q);
        var wpx = focal * matteWorld / zz;
        if (wpx < 6) { q.el.style.display = 'none'; continue; }
        var hpx = wpx / MATTE_AR;
        if (!diag.m1) diag.m1 = { zz: zz, wpx: wpx, focal: focal, mw: matteWorld, pt: pt };
        // 侧倾：相机坐标系里该点的横向角
        var xc = ex * cam.right[0] + ey * cam.right[1] + ez * cam.right[2];
        var tilt = Math.atan2(xc, zz) * 180 / Math.PI;
        if (tilt > 40) tilt = 40; if (tilt < -40) tilt = -40;
        // 景深：按相对最近距离分档（绝对距离在相机后退时会让整屏一起糊）
        var rel = zz / zmin;
        var blur = 0, dim = 0;
        if (rel > 2.6) { blur = 7; dim = 0.42; }
        else if (rel > 1.8) { blur = 3.6; dim = 0.22; }
        else if (rel > 1.3) { blur = 1.6; dim = 0.08; }
        q.el.style.display = '';
        q.el.style.width = wpx.toFixed(1) + 'px';
        q.el.style.height = hpx.toFixed(1) + 'px';
        q.el.style.transform = 'translate(' + (pt[0] - wpx / 2).toFixed(1) + 'px,' +
          (pt[1] - hpx / 2).toFixed(1) + 'px) perspective(1500px) rotateY(' +
          tilt.toFixed(2) + 'deg)';
        q.el.style.filter = blur ? 'blur(' + blur + 'px)' : '';
        q.el.style.opacity = String(1 - dim);
        q.el.style.zIndex = String(2000 - Math.round(zz * 100));
      }
    }
    var D_OUT = 1 - R_OUT, D_IN = 1 - R_IN;
    function radius() { return 1 - D_OUT * Math.pow(D_IN / D_OUT, zoom); }

    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        diag.err = String(gl.getShaderInfoLog(sh)).slice(0, 260); return null;
      }
      return sh;
    }

    function buildMesh() {
      var v = [], LON = 2, LAT = 2;
      for (var la = -BAND_HALF; la < BAND_HALF; la += LAT) {
        for (var lo = -180; lo < 180; lo += LON) {
          var quad = [[lo, la], [lo + LON, la], [lo + LON, la + LAT], [lo, la + LAT]];
          var tri = [0, 1, 2, 0, 2, 3];
          for (var t = 0; t < 6; t++) {
            var q = quad[tri[t]], P = sph(q[0], q[1]);
            v.push(P[0], P[1], P[2], q[1], q[0],
              ((q[0] + 180) / 360) * WALL_REPEAT,
              ((q[1] + BAND_HALF) / (2 * BAND_HALF)) * WALL_VREP);
          }
        }
      }
      nVerts = v.length / 7;
      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
      diag.verts = nVerts;
    }

    function resize() {
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, window.innerWidth);
      H = Math.max(1, window.innerHeight);
      canvas.width = Math.round(W * ratio);
      canvas.height = Math.round(H * ratio);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function render() {
      if (!gl || !prog || !W || !H) return;
      gl.clearColor(INK[0], INK[1], INK[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);              // the fragment composes everything, opaque out

      var cam = makeCamera(camLon, camPhi, radius());
      var focal = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);

      gl.useProgram(prog);
      gl.uniform3fv(loc.uEye, cam.pos);
      gl.uniform3fv(loc.uRight, cam.right);
      gl.uniform3fv(loc.uUp, cam.up);
      gl.uniform3fv(loc.uFwd, cam.fwd);
      gl.uniform1f(loc.uFocal, focal * ratio);
      gl.uniform1f(loc.uHalfW, canvas.width * 0.5);
      gl.uniform1f(loc.uHalfH, canvas.height * 0.5);
      gl.uniform1f(loc.uBow, BOW);
      gl.uniform1f(loc.uHoop, HOOP);
      // 57.2958 = 180/PI：把"球面上的世界长度"换成度
      var degPerPx = 57.2958 * (1 - radius()) / (focal * ratio);
      gl.uniform1f(loc.uDegPerPx, degPerPx);
      gl.uniform1f(loc.uLatStep, LAT_STEP);
      gl.uniform1f(loc.uLonStep, LON_STEP);
      gl.uniform1f(loc.uGridA, GRID_A);
      gl.uniform1f(loc.uSweepA, SWEEP_A);
      gl.uniform1f(loc.uWallA, wallReady ? WALL_A : 0);
      gl.uniform3fv(loc.uGridRGB, GRID_RGB);
      gl.uniform3fv(loc.uSweepRGB, SWEEP_RGB);
      gl.uniform3fv(loc.uInk, INK);

      var half = BAND_HALF * BAND_FRAC * 0.5;
      var c0 = -BAND_HALF + phase * (2 * BAND_HALF);
      gl.uniform1f(loc.uBandLo, c0 - half);
      gl.uniform1f(loc.uBandHi, c0 + half);
      gl.uniform1f(loc.uSweepOn, 1);
      gl.uniform1f(loc.uDebug, /[?&]uvdebug=1/.test(location.search) ? 1 : 0);

      if (tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); }
      gl.uniform1i(loc.uTex, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      var S = 28;   // 7 floats per vertex
      gl.enableVertexAttribArray(loc.aPos);
      gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(loc.aLat);
      gl.vertexAttribPointer(loc.aLat, 1, gl.FLOAT, false, S, 12);
      gl.enableVertexAttribArray(loc.aLon);
      gl.vertexAttribPointer(loc.aLon, 1, gl.FLOAT, false, S, 16);
      gl.enableVertexAttribArray(loc.aUV);
      gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, S, 20);
      gl.drawArrays(gl.TRIANGLES, 0, nVerts);
      diag.draws++;
      updatePhotos(cam, focal);
    }

    function tick(now) {
      frameRequest = window.requestAnimationFrame(tick);
      var dt = lastAt ? Math.min(64, now - lastAt) : 16;
      lastAt = now;
      var k = 1 - Math.exp(-dt / 160);
      if (Math.abs(target - zoom) > 0.0004) zoom += (target - zoom) * k; else zoom = target;
      phase = (phase + dt / SWEEP_MS) % 1;
      tickOpening(now);
      diag.tickN++;
      render();
    }
    function arm() { lastAt = 0; if (!frameRequest) frameRequest = window.requestAnimationFrame(tick); }

    function onWheel(e) {
      e.preventDefault();
      diag.wheelN++;
      // 🔴 开屏期间滚轮不缩放。
      // Q7=C：一动滚轮就立刻收（不等 3 秒）；删除动画播放期间滚轮完全无效，
      // 删除结束后才允许缩小。
      if (!ready) {
        if (openState === 'typing' || openState === 'hold') beginDelete();
        return;
      }
      wheelAccum += e.deltaY;
      if (Math.abs(wheelAccum) >= 100) {
        var n = Math.trunc(wheelAccum / 100);
        target = clamp01(target - n * 0.05);      // scroll down = pull back
        wheelAccum -= n * 100;
      }
      arm();
    }
    function onResize() { resize(); render(); }

    function init() {
      resize();
      var vs = compile(gl.VERTEX_SHADER, VS);
      var fs = compile(gl.FRAGMENT_SHADER, FS);
      if (!vs || !fs) return;
      prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        diag.err = String(gl.getProgramInfoLog(prog)).slice(0, 260); return;
      }
      gl.useProgram(prog);
      ['aPos', 'aLat', 'aLon', 'aUV'].forEach(function (n) {
        loc[n] = gl.getAttribLocation(prog, n);
      });
      ['uEye', 'uRight', 'uUp', 'uFwd', 'uFocal', 'uHalfW', 'uHalfH', 'uBow', 'uHoop',
       'uLatStep', 'uLonStep', 'uGridA', 'uSweepA', 'uWallA', 'uSweepOn', 'uDegPerPx',
       'uBandLo', 'uBandHi', 'uGridRGB', 'uSweepRGB', 'uInk', 'uTex', 'uDebug'].forEach(function (n) {
        loc[n] = gl.getUniformLocation(prog, n);
      });
      buildMesh();
      layer = document.createElement('div');
      layer.setAttribute('data-dome-photos', '');
      // 必须挂进穹顶容器内部。挂到 body 时它的 z-index 低于 [data-dome] 的 900，
      // 会被穹顶整层盖住 —— 相纸一个都看不见。
      (canvas.parentNode || document.body).appendChild(layer);
      var list = collectPhotos();
      assignSlots(list);
      for (var pi = 0; pi < list.length; pi++) buildMatte(list[pi]);
      photos = list;
      diag.photos = photos.length;

      wall = new window.Image();
      wall.decoding = 'async';
      wall.onload = function () {
        wallReady = true;
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, wall);
        // 🔴 BOTH axes must be CLAMP_TO_EDGE.
        //
        // The wallpaper is 1280x533 -- NOT a power of two. In WebGL1 an NPOT texture
        // with REPEAT wrap is INCOMPLETE, and an incomplete texture samples as pure
        // black: that is why the wall stayed dark no matter how correct the UVs and the
        // geometry were. The tiling is done in the shader with fract() instead, which
        // needs no REPEAT mode at all.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        render();
      };
      wall.src = canvas.getAttribute('data-dome-wallpaper') ||
                 '/images/wallpaper/wallpaper-default.webp';

      document.documentElement.classList.add('is-dome');
      document.body.classList.add('is-dome');
      window.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('resize', onResize);
      detachers.push(function () { window.removeEventListener('wheel', onWheel); });
      detachers.push(function () { window.removeEventListener('resize', onResize); });
      startOpening();
      arm();
    }

    // ---- 开屏序列 ------------------------------------------------------
    //
    // 定稿（grilling）：Q4=B 先让照片铺满、再打字；Q5=A 删除是尾字先退
    // （严格倒放）；Q7=C 一动滚轮就立刻收，不动则打完停 3 秒。
    // 约束：删除动画播放期间滚轮**完全无效**，删除结束后才允许缩放。
    var TYPE_MS = 110;      // 每字毫秒
    var HOLD_MS = 3000;     // 打完停留
    var DEL_MS = 70;        // 删除每字毫秒（比打字快一点，收得干脆）
    var openState = 'idle'; // idle | image | typing | hold | deleting | done
    var openEl = null, openH1 = null, openText = '', openAt = 0;
    var ready = false;      // 建好之后才允许缩放

    function pickOpeningPhoto() {
      var frames = root.querySelectorAll('[data-photo-frame]');
      var pool = [];
      for (var i = 0; i < frames.length; i++) {
        var im = frames[i].querySelector('img');
        if (!im) continue;
        var src = im.getAttribute('data-screen-src') || im.getAttribute('src');
        if (src) pool.push(src);
      }
      if (!pool.length) return null;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    function setOpenTitle(txt) {
      if (!openH1) return;
      openH1.textContent = txt;
      var care = document.createElement('span');
      care.className = 'caret';
      care.setAttribute('aria-hidden', 'true');
      care.textContent = '_';
      openH1.appendChild(care);
    }

    function startOpening() {
      var host = canvas.parentNode || document.body;
      openEl = document.createElement('div');
      openEl.setAttribute('data-dome-open', '');
      var src = pickOpeningPhoto();
      if (src) {
        var im = document.createElement('img');
        im.className = 'shot';
        im.alt = '';
        openEl.appendChild(im);
      }
      var veil = document.createElement('div');
      veil.className = 'veil';
      openEl.appendChild(veil);
      openH1 = document.createElement('h1');
      openEl.appendChild(openH1);
      var hint = document.createElement('p');
      hint.className = 'hint2';
      hint.textContent = '滚轮进入';
      openEl.appendChild(hint);
      host.appendChild(openEl);

      // 标题原文取自页面上那个 h1（data-full 由旧脚本写入，取不到就用兜底）
      var mast = document.querySelector('[data-photo-mast-title]');
      openText = (mast && (mast.getAttribute('data-full') || mast.textContent)) ||
                 "Willow's Gallery";
      openText = openText.replace(/_+$/, '').trim();

      openState = 'image';
      var shot = openEl.querySelector('.shot');
      var begin = function () { startTypingOpen(); };
      if (shot) {
        shot.onload = function () { window.setTimeout(begin, 220); };
        shot.onerror = function () { begin(); };
        shot.src = src;
      } else {
        window.setTimeout(begin, 220);
      }
    }

    function startTypingOpen() {
      if (openState !== 'image') return;
      openState = 'typing';
      openAt = performance.now();
    }

    function tickOpening(now) {
      if (!openEl) return;
      if (openState === 'typing') {
        var n = Math.min(openText.length,
          Math.floor((now - openAt) / TYPE_MS));
        setOpenTitle(openText.slice(0, n));
        if (n >= openText.length) { openState = 'hold'; openAt = now; }
      } else if (openState === 'hold') {
        if (now - openAt >= HOLD_MS) beginDelete();
      } else if (openState === 'deleting') {
        var k = openText.length - Math.min(openText.length,
          Math.floor((now - openAt) / DEL_MS));
        setOpenTitle(openText.slice(0, k));
        if (k <= 0) finishOpening();
      }
    }

    // 尾字先退 —— 严格倒放
    function beginDelete() {
      if (openState === 'deleting' || openState === 'done') return;
      openState = 'deleting';
      openAt = performance.now();
    }

    function finishOpening() {
      openState = 'done';
      var el = openEl;
      openEl = null; openH1 = null;
      if (el) {
        el.style.transition = 'opacity 420ms linear';
        el.style.opacity = '0';
        window.setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 460);
      }
      ready = true;       // 到这里才允许缩放
    }

    function destroy() {
      if (frameRequest) { window.cancelAnimationFrame(frameRequest); frameRequest = 0; }
      for (var i = 0; i < detachers.length; i++) detachers[i]();
      detachers.length = 0;
      document.documentElement.classList.remove('is-dome');
      document.body.classList.remove('is-dome');
      if (gl) { gl.clearColor(INK[0], INK[1], INK[2], 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    }

    return {
      init: init, destroy: destroy,
      state: function () {
        return {
          zoom: zoom, target: target, radius: radius(), phase: phase,
          W: W, H: H, ratio: ratio, wallReady: wallReady,
          tickN: diag.tickN, wheelN: diag.wheelN, scrollY: window.scrollY,
          verts: diag.verts, draws: diag.draws, photos: diag.photos || 0,
          m0: diag.m0 || null, m1: diag.m1 || null,
          open: openState, ready: ready, err: diag.err, bow: BOW, hoop: HOOP
        };
      }
    };
  }

  window.WillowXIDome = {
    create: createDome,
    setBow: function (v) { BOW = Number(v) || 0; },
    setHoop: function (v) { HOOP = Number(v) || 0; },
    getBow: function () { return BOW; },
    getHoop: function () { return HOOP; }
  };
})();

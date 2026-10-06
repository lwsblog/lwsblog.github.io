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
    }

    function tick(now) {
      frameRequest = window.requestAnimationFrame(tick);
      var dt = lastAt ? Math.min(64, now - lastAt) : 16;
      lastAt = now;
      var k = 1 - Math.exp(-dt / 160);
      if (Math.abs(target - zoom) > 0.0004) zoom += (target - zoom) * k; else zoom = target;
      phase = (phase + dt / SWEEP_MS) % 1;
      diag.tickN++;
      render();
    }
    function arm() { lastAt = 0; if (!frameRequest) frameRequest = window.requestAnimationFrame(tick); }

    function onWheel(e) {
      e.preventDefault();
      diag.wheelN++;
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
      arm();
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
          verts: diag.verts, draws: diag.draws, err: diag.err, bow: BOW, hoop: HOOP
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

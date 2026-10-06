/* ============================================================================
   穹顶相册 · 全面 WebGL
   ----------------------------------------------------------------------------
   取代此前"2D canvas 画网格 + WebGL 画壁纸"的双层方案。双层是一切麻烦的根源：
     * 两层各自的投影/夸张必须手工保持一致，稍有不慎就"缩放方向不一致"
     * 2D canvas 只能做仿射映射，投影四边形合不严 -> 壁纸上一道道缝
     * 扫光在 2D 里只能按纬度分档描边 -> 台阶（"段落感"）
   现在只有一个场景、一次投影：壁纸、透视线、扫光全部由同一份球面几何和同一个
   着色器管线画出来，因此不存在"两者不同步"这回事。

   几何（与样张 dome-lab 定稿一致）：
     球半径 1，相机在球内，半径 0.32（缩小到底）→ 0.94（放大到底）
     水平视场角 58° 固定；球带张角 110°（上下各削 35°）
     真投影之上叠一层"穹顶夸张"（BOW/HOOP），把球面在视场内的弱曲率补足
   ========================================================================= */
(function () {
  'use strict';

  var BAND_HALF = 55.0;
  var FOV = 58.0;
  var R_OUT = 0.32;
  var R_IN = 0.94;
  var BOW = 0.26;
  var HOOP = 0.20;
  var SWEEP_MS = 9000;
  var BAND_FRAC = 0.55;
  var WALL_REPEAT = 4;         // 壁纸绕球几圈

  var INK = [0.035, 0.043, 0.059];
  var GRID_RGB = [196 / 255, 224 / 255, 236 / 255];
  var GRID_A = 0.145;
  var SWEEP_RGB = [214 / 255, 240 / 255, 255 / 255];
  var SWEEP_A = 0.5;
  var GLOW = [[2.6, 0.6], [5.5, 0.42], [10, 0.26], [17, 0.14], [27, 0.07]];

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
    var rx = -fwd[2], rz = fwd[0];                 // fwd x up, up = (0,1,0)
    var rl = Math.sqrt(rx * rx + rz * rz) || 1;
    var right = [rx / rl, 0, rz / rl];
    var up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0]
    ];
    return { pos: pos, fwd: fwd, right: right, up: up };
  }

  // 投影 + 夸张，与旧 2D 版同一套公式（着色器里也有一份，必须一致）
  var COMMON_GLSL = [
    'attribute vec3 aPos;',
    'uniform vec3 uEye, uRight, uUp, uFwd;',
    'uniform float uFocal, uHalfW, uHalfH, uBow, uHoop;',
    'void project(out vec4 clip) {',
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
    '  clip = vec4(sx2 / uHalfW - 1.0, 1.0 - sy2 / uHalfH, 0.0, 1.0);',
    '}'
  ];

  var VS_WALL = COMMON_GLSL.concat([
    'attribute vec2 aUV;',
    'varying vec2 vUV;',
    'void main() {',
    '  vec4 c; project(c); gl_Position = c;',
    '  vUV = aUV;',
    '}'
  ]).join('\n');

  var FS_WALL = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform float uAlpha;',
    'varying vec2 vUV;',
    'void main() {',
    '  vec4 c = texture2D(uTex, vUV);',
    '  gl_FragColor = vec4(c.rgb, c.a * uAlpha);',
    '}'
  ].join('\n');

  var VS_GRID = COMMON_GLSL.concat([
    'attribute float aLat;',
    'varying float vLat;',
    'void main() {',
    '  vec4 c; project(c); gl_Position = c;',
    '  vLat = aLat;',
    '}'
  ]).join('\n');

  // 🔴 扫光在片元里按**纬度**算，不再分档。
  //
  // 旧 2D 版为了体现"亮带跟着球面弯"，把强度按中点纬度分成十来档、每档一个固定
  // alpha —— 画出来就是一条条台阶（用户："段落感太强了，太生硬了"）。在着色器里
  // 每个像素各自算，天然连续，而且严格贴合球面。
  var FS_GRID = [
    'precision mediump float;',
    'uniform vec3 uColor;',
    'uniform float uAlpha;',
    'uniform float uBandLo, uBandHi;',   // 亮带覆盖的纬度区间
    'uniform float uSweep;',             // 0 = 只画底网格；1 = 画扫光层
    'varying float vLat;',
    'float profile(float u) {',
    '  if (u <= 0.0 || u >= 1.0) return 0.0;',
    '  if (u < 0.18) return u / 0.18 * 0.38;',
    '  if (u < 0.5)  return 0.38 + (u - 0.18) / 0.32 * 0.62;',
    '  if (u < 0.82) return 1.0 - (u - 0.5) / 0.32 * 0.62;',
    '  return 0.38 * (1.0 - (u - 0.82) / 0.18);',
    '}',
    'void main() {',
    '  float k = 1.0;',
    '  if (uSweep > 0.5) {',
    '    float u = (vLat - uBandLo) / max(uBandHi - uBandLo, 0.001);',
    '    k = profile(u);',
    '    if (k <= 0.002) discard;',
    '  }',
    '  gl_FragColor = vec4(uColor, uAlpha * k);',
    '}'
  ].join('\n');

  function createDome(root) {
    var canvas = root.querySelector('[data-dome-canvas]');
    if (!canvas) return null;
    var gl = canvas.getContext('webgl', { alpha: false, antialias: true }) ||
             canvas.getContext('experimental-webgl');
    if (!gl) return null;

    var W = 0, H = 0, ratio = 1;
    var camLon = 0, camPhi = 0;
    var zoom = 0, target = 0, phase = 0;
    var frameRequest = 0, lastAt = 0, wheelAccum = 0;
    var wall = null, wallReady = false, tex = null;
    var detachers = [];
    var diag = { tickN: 0, wheelN: 0, verts: 0, lines: 0, err: '', tris: 0 };

    var progWall = null, progGrid = null;
    var wLoc = {}, gLoc = {};
    var bufWall = null, bufGrid = null;

    var D_OUT = 1 - R_OUT, D_IN = 1 - R_IN;
    function radius() { return 1 - D_OUT * Math.pow(D_IN / D_OUT, zoom); }

    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        diag.err = String(gl.getShaderInfoLog(sh)).slice(0, 200); return null;
      }
      return sh;
    }
    function program(vs, fs) {
      var v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fs);
      if (!v || !f) return null;
      var p = gl.createProgram();
      gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        diag.err = String(gl.getProgramInfoLog(p)).slice(0, 200); return null;
      }
      return p;
    }

    function buildWallMesh() {
      var verts = [], LON = 3, LAT = 3;
      for (var la = -BAND_HALF; la < BAND_HALF; la += LAT) {
        for (var lo = -180; lo < 180; lo += LON) {
          var quad = [[lo, la], [lo + LON, la], [lo + LON, la + LAT], [lo, la + LAT]];
          var tri = [0, 1, 2, 0, 2, 3];
          for (var t = 0; t < 6; t++) {
            var q = quad[tri[t]], P = sph(q[0], q[1]);
            verts.push(P[0], P[1], P[2],
              ((q[0] + 180) / 360) * WALL_REPEAT,
              1 - (q[1] + BAND_HALF) / (2 * BAND_HALF));
          }
        }
      }
      bufWall = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufWall);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
      diag.verts = verts.length / 5;
    }

    function buildGridMesh() {
      var v = [], lon, phi, a, b;
      // 纬线
      for (phi = -BAND_HALF; phi <= BAND_HALF + 0.01; phi += 2.5) {
        for (lon = -180; lon < 180; lon += 3) {
          a = sph(lon, phi); b = sph(lon + 3, phi);
          v.push(a[0], a[1], a[2], phi, b[0], b[1], b[2], phi);
        }
      }
      // 经线
      for (lon = -180; lon < 180; lon += 10) {
        for (phi = -BAND_HALF; phi < BAND_HALF; phi += 2.5) {
          a = sph(lon, phi); b = sph(lon, phi + 2.5);
          v.push(a[0], a[1], a[2], phi, b[0], b[1], b[2], phi + 2.5);
        }
      }
      bufGrid = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufGrid);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
      diag.lines = v.length / 4 / 2;
    }

    function resize() {
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, window.innerWidth);
      H = Math.max(1, window.innerHeight);
      canvas.width = Math.round(W * ratio);
      canvas.height = Math.round(H * ratio);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function setCommon(loc, cam, focal) {
      gl.uniform3fv(loc.uEye, cam.pos);
      gl.uniform3fv(loc.uRight, cam.right);
      gl.uniform3fv(loc.uUp, cam.up);
      gl.uniform3fv(loc.uFwd, cam.fwd);
      gl.uniform1f(loc.uFocal, focal * ratio);
      gl.uniform1f(loc.uHalfW, canvas.width * 0.5);
      gl.uniform1f(loc.uHalfH, canvas.height * 0.5);
      gl.uniform1f(loc.uBow, BOW);
      gl.uniform1f(loc.uHoop, HOOP);
    }

    function render() {
      if (!gl || !W || !H) return;
      gl.clearColor(INK[0], INK[1], INK[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);

      var cam = makeCamera(camLon, camPhi, radius());
      var focal = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);

      // ---- ① 壁纸：真纹理映射在球带上 ----
      if (progWall && tex && wallReady) {
        gl.useProgram(progWall);
        setCommon(wLoc, cam, focal);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(wLoc.uAlpha, 0.62);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(wLoc.uTex, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufWall);
        gl.enableVertexAttribArray(wLoc.aPos);
        gl.vertexAttribPointer(wLoc.aPos, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(wLoc.aUV);
        gl.vertexAttribPointer(wLoc.aUV, 2, gl.FLOAT, false, 20, 12);
        gl.drawArrays(gl.TRIANGLES, 0, diag.verts);
        diag.tris++;
      }

      // ---- ② 透视线（底网格）----
      if (progGrid) {
        gl.useProgram(progGrid);
        setCommon(gLoc, cam, focal);
        gl.uniform3fv(gLoc.uColor, GRID_RGB);
        gl.uniform1f(gLoc.uAlpha, GRID_A);
        gl.uniform1f(gLoc.uSweep, 0);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufGrid);
        gl.enableVertexAttribArray(gLoc.aPos);
        gl.vertexAttribPointer(gLoc.aPos, 3, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(gLoc.aLat);
        gl.vertexAttribPointer(gLoc.aLat, 1, gl.FLOAT, false, 16, 12);
        gl.drawArrays(gl.LINES, 0, diag.lines * 2);

        // ---- ③ 扫光：同一份网格，片元按纬度算强度，多层加色叠加出光晕 ----
        var half = BAND_HALF * BAND_FRAC * 0.5;
        var c0 = -BAND_HALF + phase * (2 * BAND_HALF);
        gl.uniform1f(gLoc.uBandLo, c0 - half);
        gl.uniform1f(gLoc.uBandHi, c0 + half);
        gl.uniform1f(gLoc.uSweep, 1);
        gl.uniform3fv(gLoc.uColor, SWEEP_RGB);
        gl.blendFunc(gl.ONE, gl.ONE);        // 与原站 composite:'lighter' 一致
        gl.lineWidth(1);                     // WebGL 多数实现只支持 1，光晕靠多次描边
        for (var i = 0; i < GLOW.length; i++) {
          gl.uniform1f(gLoc.uAlpha, SWEEP_A * GLOW[i][1]);
          gl.drawArrays(gl.LINES, 0, diag.lines * 2);
        }
      }
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
        target = clamp01(target - n * 0.05);     // 往下滚 = 拉远
        wheelAccum -= n * 100;
      }
      arm();
    }
    function onResize() { resize(); render(); }

    function init() {
      resize();
      progWall = program(VS_WALL, FS_WALL);
      progGrid = program(VS_GRID, FS_GRID);
      if (progWall) {
        wLoc = { aPos: gl.getAttribLocation(progWall, 'aPos'), aUV: gl.getAttribLocation(progWall, 'aUV'),
                 uEye: gl.getUniformLocation(progWall, 'uEye'), uRight: gl.getUniformLocation(progWall, 'uRight'),
                 uUp: gl.getUniformLocation(progWall, 'uUp'), uFwd: gl.getUniformLocation(progWall, 'uFwd'),
                 uFocal: gl.getUniformLocation(progWall, 'uFocal'), uHalfW: gl.getUniformLocation(progWall, 'uHalfW'),
                 uHalfH: gl.getUniformLocation(progWall, 'uHalfH'), uBow: gl.getUniformLocation(progWall, 'uBow'),
                 uHoop: gl.getUniformLocation(progWall, 'uHoop'), uTex: gl.getUniformLocation(progWall, 'uTex'),
                 uAlpha: gl.getUniformLocation(progWall, 'uAlpha') };
        buildWallMesh();
      }
      if (progGrid) {
        gLoc = { aPos: gl.getAttribLocation(progGrid, 'aPos'), aLat: gl.getAttribLocation(progGrid, 'aLat'),
                 uEye: gl.getUniformLocation(progGrid, 'uEye'), uRight: gl.getUniformLocation(progGrid, 'uRight'),
                 uUp: gl.getUniformLocation(progGrid, 'uUp'), uFwd: gl.getUniformLocation(progGrid, 'uFwd'),
                 uFocal: gl.getUniformLocation(progGrid, 'uFocal'), uHalfW: gl.getUniformLocation(progGrid, 'uHalfW'),
                 uHalfH: gl.getUniformLocation(progGrid, 'uHalfH'), uBow: gl.getUniformLocation(progGrid, 'uBow'),
                 uHoop: gl.getUniformLocation(progGrid, 'uHoop'), uColor: gl.getUniformLocation(progGrid, 'uColor'),
                 uAlpha: gl.getUniformLocation(progGrid, 'uAlpha'), uSweep: gl.getUniformLocation(progGrid, 'uSweep'),
                 uBandLo: gl.getUniformLocation(progGrid, 'uBandLo'), uBandHi: gl.getUniformLocation(progGrid, 'uBandHi') };
        buildGridMesh();
      }
      wall = new window.Image();
      wall.decoding = 'async';
      wall.onload = function () {
        wallReady = true;
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, wall);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        render();
      };
      wall.src = canvas.getAttribute('data-dome-wallpaper') || '/images/wallpaper/wallpaper-default.webp';

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
          verts: diag.verts, lines: diag.lines, err: diag.err, bow: BOW, hoop: HOOP
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

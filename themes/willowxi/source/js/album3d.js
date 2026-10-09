/* WillowXI 相册 · 3D 版（第一步：骨架 + 运动）
 *
 * 设计要点（与用户逐条谈定）：
 *   · 背景 = 直接用站上那层 DOM 场景（[data-scene-background]），不重采样、不重复绘制
 *   · 照片 = **纯 GL**：相纸与照片都在 GL 里画，没有 DOM/GL 同步
 *   · 开屏 = 打字 110ms/字 → 停 3000ms → 删除 70ms/字；点击或滚轮可提前触发删除
 *   · 飞入 = 错峰 + 每张时长随机 ±40%，主体 ease-out-back（弹一下），
 *            约 1/4 的照片额外带旋转过冲与更长尾巴
 *   · 排布 = 一条散带：同一水平轴上，垂直 ±14% 屏高随机，**每张偏移固定**
 *   · 滚动 = 横向，真 3D 透视（近处快、远处慢是自动结果），到两端**回弹**
 *   · 景深 = 每张按 |z - 对焦面| 在"清晰贴图 / 预模糊贴图"之间插值
 *
 * 第二步（点击聚焦、整屏压暗、前排飞过时模糊淡出）不在这里。
 */
(function () {
  if (typeof window === 'undefined') return;

  var TYPE_MS = 110, HOLD_MS = 3000, DEL_MS = 70;
  var Z_COUNT = 4;             // 深度层数
  // 用户说的景深不是虚化，而是后排移动更慢：投影为 focal/(camZ - z)，
  // z 越大（越近）横向位移越快。所以要拉大 z 的跨度。
  // 注意 z 不能超过 camZ(3.2)，否则会穿过摄像机。
  var Z_SPREAD = 2.5;          // z 跨度（世界单位）
  var FOCAL = 1.0;             // 焦距（按视口高换算）
  // 用户的要求：整体小一点 = 把摄像机拉远（卡片世界尺寸不变，视觉变小）。3.2 -> 4.9。
  // 并且下面所有以世界单位计的常量都改成 CAM_DIST 的倍数 ——
  // 以后只调 CAM_DIST，其他量自己跟着缩放，不会再出现量级错。
  var CAM_DIST = 3.2;          // 摄像机到 z=0 平面的距离
  // 屏高 = 2*camZ = 6.4 世界单位。原来 CARD_H=0.62 -> 卡片只占屏高 9.7%，太小。
  // 1.9 -> 约占屏高 30%（再乘每张 0.8~1.3 的 scale）。
  var CARD_H = 1.25;           // 相纸短边（世界单位）
  // 🔴 一屏可见宽度 = (W/2)*camZ/focal = W*camZ/H ≈ 10.2 世界单位。
  // 原来 GAP=0.30 -> 整排跨度 6.3，一排全在屏内，根本没得翻。
  // 改成 1.15 -> 跨度约 24 单位 ≈ 2.4 屏。
  var GAP = 2.35;              // 水平间距（世界单位）
  // 🔴 单位注意：可见半高 = (H/2)*camZ/focal = camZ = 3.2 世界单位。
  // 原来把 JITTER 当"屏高比例"用却只给了 0.14 世界单位 —— 小了 3 倍，看不出上下分布。
  // 现在 ±1.55 世界单位 ≈ 半屏高的 48%，照片墙的高度感就出来了。
  var JITTER = 0.62;           // 上下幅度（世界单位）
  var MATTE_BORDER = 0.085;    // 相纸白边（相对相纸短边）
  // 用户定的两项：
  var TILT = 0.0;              // 每张照片的随机倾角（0 = 全部端正）。原来 0.045。
  var DOF = 0.0;               // 景深虚化强度（0 = 完全不模糊）。原来是 1.15。
  // 说明：DOF=0 时只是不做虚化，**3D 感仍在** —— 近大远小与前后遮挡照旧。
  var FLY_MS = 1900;           // 飞入基准时长（原来 1100 偏快，用户反馈飞的有点快）
  var FLY_STAGGER = 165;       // 错峰基准（ms/张）：22 张铺开约 3.6 秒，一眼能看出次序
  var BOUNCE = 0.34;           // 到端回弹强度

  function create(root) {
    var host = null, cv = null, gl = null;
    var W = 0, H = 0, dpr = 1;

    // ---------- 着色器 ----------
    function compile(t, src) {
      var sh = gl.createShader(t); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        throw new Error('album3d shader: ' + gl.getShaderInfoLog(sh));
      return sh;
    }
    function program(vs, fs) {
      var pr = gl.createProgram();
      gl.attachShader(pr, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(pr, 0, 'aXY');
      gl.bindAttribLocation(pr, 1, 'aUV');
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS))
        throw new Error('album3d link: ' + gl.getProgramInfoLog(pr));
      return pr;
    }

    // 单位四边形；顶点着色器做**真透视投影**
    var VS = [
      'attribute vec2 aXY;',      // -1..1 的单位面片
      'attribute vec2 aUV;',
      'uniform vec3 uCenter;',    // 卡片中心（世界坐标：x=横, y=纵, z=深度, 越大越近）
      'uniform vec2 uHalf;',      // 卡片半宽半高（世界单位）
      'uniform float uRot;',      // 卡片自身倾角
      'uniform float uFocal, uCamZ, uHalfW, uHalfH, uScroll;',
      'varying vec2 vUV;',
      'varying float vFade;',     // 太远就淡出，避免远处糊成一片墙
      'void main() {',
      '  vec2 p = aXY * uHalf;',
      '  float c = cos(uRot), s = sin(uRot);',
      '  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);',
      '  vec3 w = vec3(uCenter.xy + p, uCenter.z);',
      '  float zc = uCamZ - w.z;',                 // 到摄像机的深度
      '  zc = max(zc, 0.12);',                     // 别穿到摄像机后面
      '  float k = uFocal / zc;',
      '  vec2 scr = vec2(w.x - uScroll, w.y) * k;',// uScroll 走 uniform
      '  gl_Position = vec4(scr.x / (uHalfW * 0.5), scr.y / (uHalfH * 0.5), 0.0, 1.0);',
      '  vUV = aUV;',
      '  vFade = 1.0;',
      '}'
    ].join('\n');

    var FS = [
      'precision highp float;',
      'uniform sampler2D uTex, uBlur;',
      'uniform float uMix, uAlpha, uPaper, uTint;',
      'varying vec2 vUV;',
      'varying float vFade;',
      'void main() {',
      '  if (uPaper > 0.5) { gl_FragColor = vec4(vec3(0.957,0.957,0.945), uAlpha); return; }',
      '  vec4 a = texture2D(uTex, vUV);',
      '  vec4 b = texture2D(uBlur, vUV);',
      '  vec3 c = mix(a.rgb, b.rgb, uMix);',
      '  gl_FragColor = vec4(c, uAlpha);',
      '}'
    ].join('\n');

    var prog = null, quad = null, loc = {};

    // ---------- 状态 ----------
    var photos = [];        // {id, ratio, x, y, z, rot, startAt, dur, overshoot, tex, blurTex, ready}
    var scroll = 0, scrollTarget = 0, scrollMin = 0, scrollMax = 0;
  var scrollV = 0;                 // 惯性速度（只衰减、不回拉 —— 与弹簧的区别）
  var INERTIA_TAU = 480;           // 惯性衰减时间常数(ms)
  var WHEEL_IMPULSE = 0.13;        // 每格滚轮给多少速度（0.55 时 6 格就冲到底，太大）
    var camZ = CAM_DIST, focusZ = 0;
    var openState = 'idle', openAt = 0, openText = '', overlay = null, h1 = null;
    var startedAt = 0, ready = false, raf = 0;

    function collect() {
      var frames = root.querySelectorAll('[data-photo-frame]');
      var list = [];
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var id = f.getAttribute('data-id');
        var ratio = parseFloat(f.style.getPropertyValue('--ratio')) || 1.5;
        var img = f.querySelector('img');
        var src = f.getAttribute('data-screen-src') ||
                  (img && (img.getAttribute('data-src') || img.getAttribute('src'))) || '';
        if (!id || !src) continue;
        list.push({ id: id, ratio: ratio, src: src,
                    light: f.getAttribute('data-light-src') || '' });
      }
      return list;
    }

    function makeTexture() {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                    new Uint8Array([30, 36, 48, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    }

    // 预模糊版：CPU 一次真高斯（这台机器上唯一稳的连续模糊），片元里按景深插值
    function loadPhoto(p) {
      var im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = function () {
        var t = makeTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        // 🔴 必须翻转 Y：UV 的 v=0 在卡片底部，而 2D 图像第 0 行在顶部 ——
        // 不翻转就是上下颠倒（用户："照片还是倒着的"）。
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        p.tex = t;
        // 预模糊
        try {
          var bw = Math.max(48, Math.min(420, Math.round(im.naturalWidth / 3)));
          var bh = Math.max(48, Math.round(bw * im.naturalHeight / im.naturalWidth));
          var off = document.createElement('canvas');
          off.width = bw; off.height = bh;
          var octx = off.getContext('2d');
          octx.filter = 'blur(' + Math.max(3, Math.round(bw * 0.06)) + 'px)';
          octx.drawImage(im, -bw * 0.06, -bh * 0.06, bw * 1.12, bh * 1.12);
          octx.filter = 'none';
          var bt = makeTexture();
          gl.bindTexture(gl.TEXTURE_2D, bt);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, off);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          p.blurTex = bt;
        } catch (e) { p.blurTex = null; }
        p.ready = true;
      };
      im.src = p.src;
    }

    // ---------- 排布：一条散带 + 深度分层 ----------
    function layout() {
      var n = photos.length;
      if (!n) return;
      // 每张的垂直偏移固定
      var seed = 20240614;
      function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

      for (var i = 0; i < n; i++) {
        var p = photos[i];
        var layer = i % Z_COUNT;                        // 轮流分层，保证前后都有
        p.z = (layer / (Z_COUNT - 1) - 0.5) * Z_SPREAD;
        p.x = i * GAP - (n - 1) * GAP * 0.5;
        p.y = (rnd() * 2 - 1) * JITTER * 0.5 * 2;       // ±JITTER
        p.rot = (rnd() * 2 - 1) * TILT;
        p.scale = 0.78 + rnd() * 0.58;      // 大小不一（0.78~1.36），参考图就是这样
        p.startAt = i * FLY_STAGGER * (0.6 + rnd() * 0.8);
        p.dur = FLY_MS * (0.6 + rnd() * 0.8);           // 时长 ±40%
        p.overshoot = rnd() < 0.25;                     // 约 1/4 带旋转过冲
        if (p.overshoot) p.dur *= 1.35;
        // 用户要求：**全部从右边屏幕外飞进来**。
        // 可见半宽 = (W/2)*camZ/focal = camZ*(W/H) = 3.2*1.6 ≈ 5.12 世界单位，
        // 所以起点至少要 +5.12+hw 才在屏外 —— 取 7.5 起步。
        p.fromX = 7.5 + rnd() * 3.0;
        p.fromY = (rnd() * 2 - 1) * 1.1;   // 同时也从上下错开，像被撒进来
        p.fromZ = 1.6 + rnd() * 1.4;
      }
      var halfW = 0.5 * (1 + 2 * 0) * 0; // 占位，避免未用变量告警
      // 滚动范围：让首尾都能到屏幕中央
      scrollMin = photos[0].x;
      scrollMax = photos[n - 1].x;
      scroll = scrollTarget = (scrollMin + scrollMax) * 0.5;
    }

    // ---------- 缓动 ----------
    function easeOutBack(t, s) {
      t = Math.min(1, Math.max(0, t));
      var c = s === undefined ? 1.22 : s;
      return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    }
    function easeOutCubic(t) { t = Math.min(1, Math.max(0, t)); return 1 - Math.pow(1 - t, 3); }
    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

    // ---------- 摄像机聚焦面（第一步：固定在对焦中层；第二步才做点击聚焦） ----------
    focusZ = 0;

    // ---------- 渲染 ----------
    function draw() {
      if (!gl) return;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);

      var now = performance.now();
      var focal = FOCAL * H * 0.5;
      gl.uniform1f(loc.uFocal, focal);
      gl.uniform1f(loc.uCamZ, camZ);
      gl.uniform1f(loc.uHalfW, W);
      gl.uniform1f(loc.uHalfH, H);

      // 远的先画（画家算法），近的覆盖
      var order = photos.slice().sort(function (a, b) { return a.z - b.z; });
      for (var i = 0; i < order.length; i++) {
        var p = order[i];
        if (!p.ready) continue;
        // 飞入进度
        var t = ready ? clamp01((now - startedAt - p.startAt) / p.dur) : 0;
        if (t <= 0) continue;
        var e = p.overshoot ? easeOutBack(t, 1.9) : easeOutBack(t, 1.22);

        var x = p.x + (p.fromX * (1 - e));
        var y = p.y + (p.fromY * (1 - e));
        var z = p.z + (p.fromZ * (1 - e));
        var alpha = easeOutCubic(clamp01(t * 1.6));
        var rot = p.rot + (p.overshoot ? p.rot * 2.6 * (1 - e) : p.rot * 0.9 * (1 - e));

        // 卡片世界尺寸：短边固定，长边按比例
        var shortSide = CARD_H * (p.scale || 1);
        var hw, hh;
        if (p.ratio >= 1) { hh = shortSide * 0.5; hw = hh * p.ratio; }
        else { hw = shortSide * 0.5; hh = hw / p.ratio; }

        // 景深：离对焦面越远越糊
        var blur = Math.min(1, Math.abs(z - focusZ) * DOF);

        gl.uniform1f(loc.uScroll, scroll);
        // 相纸
        gl.uniform3f(loc.uCenter, x, y, z);
        var pb = 1 / (1 + 2 * MATTE_BORDER);
        gl.uniform2f(loc.uHalf, hw / pb, hh / pb);
        gl.uniform1f(loc.uRot, rot);
        gl.uniform1f(loc.uPaper, 1);
        gl.uniform1f(loc.uAlpha, alpha);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        // 照片
        gl.uniform2f(loc.uHalf, hw, hh);
        gl.uniform1f(loc.uPaper, 0);
        gl.uniform1f(loc.uMix, blur);
        gl.uniform1f(loc.uAlpha, alpha);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, p.tex);
        gl.uniform1i(loc.uTex, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, p.blurTex || p.tex);
        gl.uniform1i(loc.uBlur, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // ---------- 滚动：横向 + 到端回弹 ----------
    function onWheel(e) {
      if (!ready && (openState === 'typing' || openState === 'hold')) { beginDelete(); return; }
      if (!ready) return;
      e.preventDefault();
      var d = (e.deltaY || e.deltaX || 0) / 100;
      // 滚轮只给速度；之后由上面的惯性推进（松手后还会滑一段）
      scrollV += d * WHEEL_IMPULSE;
    }
    function tickScroll(dt) {
      // 惯性：按速度推进，速度本身指数衰减 —— 只衰减、不回拉，所以不会弹。
      // 到两端硬停（速度清零），没有任何回弹。
      // 用户先前要求删掉的是弹簧；这里保留的是惯性：滚轮给一次速度，之后滑行衰减。
      scroll += scrollV * (dt / 16);
      scrollV *= Math.exp(-dt / INERTIA_TAU);
      if (Math.abs(scrollV) < 1e-5) scrollV = 0;
      if (scroll <= scrollMin) { scroll = scrollMin; if (scrollV < 0) scrollV = 0; }
      if (scroll >= scrollMax) { scroll = scrollMax; if (scrollV > 0) scrollV = 0; }
      scrollTarget = scroll;
    }

    // ---------- 开屏打字 ----------
    function buildOpening() {
      overlay = document.createElement('div');
      overlay.setAttribute('data-album-open', '');
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:40;display:grid;place-items:center;' +
        'pointer-events:none;opacity:1;transition:opacity .42s ease;';
      var veil = document.createElement('div');
      veil.style.cssText = 'position:absolute;inset:0;background:rgba(9,11,15,0.42);';
      h1 = document.createElement('h1');
      h1.style.cssText =
        'position:relative;margin:0;font:400 clamp(52px,11vw,176px)/1.05 "Ubuntu Mono",' +
        'ui-monospace,Menlo,Consolas,monospace;color:#f2f6fb;letter-spacing:.02em;' +
        'text-shadow:0 2px 24px rgba(0,0,0,.45);white-space:nowrap;';
      overlay.appendChild(veil); overlay.appendChild(h1);
      host.appendChild(overlay);
      var mast = root.querySelector('[data-photo-masthead] h1, [data-photo-mast-title]');
      openText = (mast && (mast.getAttribute('data-full') || mast.textContent) || 'WillowXI')
                 .replace(/_+$/, '').trim();
      setTitle('');
      openState = 'typing';
      openAt = performance.now();
    }
    function setTitle(txt) {
      h1.textContent = txt;
      var c = document.createElement('span');
      c.textContent = '_';
      c.style.cssText = 'opacity:.85;animation:albumCaret 1s steps(1) infinite;';
      h1.appendChild(c);
    }
    function beginDelete() {
      startFly();                 // 跳过了打字的话，这里补上
      if (openState === 'deleting' || openState === 'done') return;
      openState = 'deleting';
      openAt = performance.now();
    }
    function tickOpening(now) {
      if (openState === 'typing') {
        var n = Math.min(openText.length, Math.floor((now - openAt) / TYPE_MS));
        setTitle(openText.slice(0, n));
        if (n >= openText.length) { openState = 'hold'; openAt = now; startFly(); }
      } else if (openState === 'hold') {
        if (now - openAt >= HOLD_MS) beginDelete();
      } else if (openState === 'deleting') {
        var k = openText.length - Math.min(openText.length, Math.floor((now - openAt) / DEL_MS));
        setTitle(openText.slice(0, k));
        if (k <= 0) finishOpening();
      }
    }
    // 飞入的起算点。放在打字结束（进入 hold）时 —— 用户要求飞入时间提前，
    // 这样文字还在停留/淡出，照片已经在进场了。只用一次。
    function startFly() {
      if (startedAt) return;
      startedAt = performance.now();
    }

    function finishOpening() {
      openState = 'done';
      if (overlay) {
        overlay.style.opacity = '0';
        setTimeout(function () { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 460);
      }
      ready = true;
      startFly();                        // 若前面没启动过，这里兜底
    }

    // ---------- 主循环 ----------
    var last = 0;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      var dt = last ? Math.min(64, now - last) : 16;
      last = now;
      tickOpening(now);
      if (ready) tickScroll(dt);
      draw();
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = cv.width = Math.floor(window.innerWidth * dpr);
      H = cv.height = Math.floor(window.innerHeight * dpr);
      cv.style.width = window.innerWidth + 'px';
      cv.style.height = window.innerHeight + 'px';
    }

    function init() {
      host = document.createElement('div');
      host.setAttribute('data-album', '');
      host.style.cssText = 'position:fixed;inset:0;z-index:35;pointer-events:none;';
      cv = document.createElement('canvas');
      cv.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;';
      host.appendChild(cv);
      document.body.appendChild(host);

      gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true }) ||
           cv.getContext('experimental-webgl');
      if (!gl) { host.remove(); return; }

      prog = program(VS, FS);
      ['uCenter','uHalf','uRot','uFocal','uCamZ','uHalfW','uHalfH','uScroll',
       'uTex','uBlur','uMix','uAlpha','uPaper','uTint'].forEach(function (n) {
        loc[n] = gl.getUniformLocation(prog, n);
      });
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      // 两个三角形，单位面片 + uv
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1,-1, 0,0,   1,-1, 1,0,  -1,1, 0,1,
        -1, 1, 0,1,   1,-1, 1,0,   1,1, 1,1
      ]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

      // 光标/系统指针保留（这一步不做自定义光标）
      photos = collect();
      layout();
      for (var i = 0; i < photos.length; i++) loadPhoto(photos[i]);

      resize();
      window.addEventListener('resize', resize);
      window.addEventListener('wheel', onWheel, { passive: false });
      document.addEventListener('mousedown', function () {
        if (openState === 'typing' || openState === 'hold') beginDelete();
      });

      // 打字机光标闪烁的 keyframes
      var st = document.createElement('style');
      st.textContent = '@keyframes albumCaret{0%,49%{opacity:.85}50%,100%{opacity:0}}';
      document.head.appendChild(st);

      buildOpening();
      raf = requestAnimationFrame(frame);
    }

    function destroy() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('wheel', onWheel);
      if (host && host.parentNode) host.parentNode.removeChild(host);
    }

    return { init: init, destroy: destroy,
             state: function () {
               return { photos: photos.length, ready: ready, openState: openState,
                        scroll: scroll, target: scrollTarget,
                        min: scrollMin, max: scrollMax, camZ: camZ, focusZ: focusZ,
                        loaded: photos.filter(function (p) { return p.ready; }).length };
             } };
  }

  window.WillowXIAlbum = { create: create };
})();

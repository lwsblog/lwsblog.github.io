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
  var FOCUS_MS = 900;          // 聚焦/退出聚焦的补间时长
  var FOCUS_FILL = 0.72;       // 聚焦后目标照片占屏高的比例
  var focusCamZ = 3.2;         // 聚焦时摄像机应到的 camZ（按目标深度算，不是固定倍数）
  var DIM_MAX = 0.55;          // 聚焦时整屏压暗的上限
  var SHOW_NUM = false;        // 是否显示照片编号（用户要求不显示；改 true 即可恢复）
  // 列表要**纵向**：列数少 -> 行数多 -> 高度溢出 -> 竖滚才有内容。
  // 6 列时 22 张只有 4 行，一屏就装下了，竖滚是空的。
  var GRID_COLS = 4;           // 网格总览的列数
  var GRID_GAPX = 0.05;        // 格位横向间隙（相对卡片宽）—— 用户反馈间距太大
  var GRID_GAPY = 0.20;        // 格位纵向间隙（相对卡片高）—— 留一点给编号就够
  var MODE_MS = 1500;          // 两个视图之间的补间总时长（用户指定 1.5 秒）
  // 进列表时按**行**逐行扫描：每行错开 MODE_MS/rows，行内同时到达。
  var ROW_STAGGER = true;
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
      'uniform float uFocal, uCamZ, uHalfW, uHalfH, uScroll, uPanY, uCamZoom;',
      'varying vec2 vUV;',
      'varying float vFade;',     // 太远就淡出，避免远处糊成一片墙
      'void main() {',
      '  vec2 p = aXY * uHalf;',
      '  float c = cos(uRot), s = sin(uRot);',
      '  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);',
      '  vec3 w = vec3(uCenter.xy + p, uCenter.z);',
            // uCamZoom 由 JS 每帧上传（原来那次误放在编号块里、SHOW_NUM=false 从不执行，
      // 所以值恒为 0 -> zc = -z -> 整排照片消失。根因是上传位置，不是编译器优化。）
      '  float zc = uCamZ * uCamZoom - w.z;',
      // 剔除越过摄像机的（聚焦到后排时前排会飞过去）。
      // 注意：阈值要小，且 zc 用的是 camZ*camZoom —— 阈值太大会把正常画面整片剔掉。
      '  zc = max(zc, 0.12);',
      '  if (uCamZ * uCamZoom - w.z < -0.35) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }',
      '  float k = uFocal / zc;',
      '  vec2 scr = vec2(w.x - uScroll, w.y - uPanY) * k;',// uScroll 走 uniform
      '  gl_Position = vec4(scr.x / (uHalfW * 0.5), scr.y / (uHalfH * 0.5), 0.0, 1.0);',
      '  vUV = aUV;',
      '  vFade = 1.0;',
      '}'
    ].join('\n');

    var FS = [
      'precision highp float;',
      'uniform sampler2D uTex, uBlur;',
      'uniform float uMix, uAlpha, uPaper, uTint;',
    'uniform vec4 uUVO;',        // xy = uv 偏移, zw = uv 缩放
    'uniform vec3 uPaperRGB;',   // 相纸/数字的颜色
      'varying vec2 vUV;',
      'varying float vFade;',
      'void main() {',
      '  vec2 uv = vUV * uUVO.zw + uUVO.xy;',
      '  if (uPaper > 0.5 && uPaper < 1.5) { gl_FragColor = vec4(uPaperRGB, uAlpha); return; }',
      '  vec4 a = texture2D(uTex, uv);',
      '  if (uPaper > 1.5) { gl_FragColor = vec4(uPaperRGB, a.a * uAlpha); return; }',
      '  vec4 bb = texture2D(uBlur, uv);',
      '  vec3 c = mix(a.rgb, bb.rgb, uMix);',
      '  gl_FragColor = vec4(c, uAlpha);',
      '}'
    ].join('\n');

    var prog = null, quad = null, loc = {};

    // ---------- 状态 ----------
    var photos = [];        // {id, ratio, x, y, z, rot, startAt, dur, overshoot, tex, blurTex, ready}
    var scroll = 0, scrollTarget = 0, scrollMin = 0, scrollMax = 0;
  var scrollV = 0;                 // 惯性速度（只衰减、不回拉 —— 与弹簧的区别）
  var gridTopY = 0, gridBottomY = 0;
  // 纵向平移（总览视图用）。一排视图下恒为 0。
  var panY = 0, panTarget = 0, panV = 0, panMin = 0, panMax = 0;
  // 视图切换时视角的补间起止（与 modeT 同一条缓动，所以不会硬切）
  var viewFrom = { scroll: 0, pan: 0 }, viewTo = { scroll: 0, pan: 0 };
  var rowDur = 375, rowCount = 1;
  // 聚焦：focusIdx = 第几张（-1 无）；focusT 0->1 补间；相机推近用 camZoom
  var focusIdx = -1, focusT = 0, focusFrom = 0, focusAt = 0, focusTo = 0;
  var focusScroll = 0, focusPan = 0, camZoom = 1, dimEl = null;
  var preScroll = 0, prePan = 0;      // 进入聚焦前的镜头位置，退出时回到它
  var INERTIA_TAU = 480;           // 惯性衰减时间常数(ms)
  var WHEEL_IMPULSE = 0.13;        // 每格滚轮给多少速度（0.55 时 6 格就冲到底，太大）
    var camZ = CAM_DIST, focusZ = 0;
    var openState = 'idle', openAt = 0, openText = '', overlay = null, h1 = null;
    var startedAt = 0, ready = false, raf = 0;
  // 双视图：row = 横向一排（浏览）；grid = 网格总览
  var mode = 0, modeT = 0, modeAt = 0, modeFrom = 0;   // modeT: 0=row 1=grid
  var numTex = null, numCell = [0, 0];                 // 数字图集


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
      // ---- 网格总览的格位 ----
      // 用户反馈列表太宽：根因是格距按**最宽的那张**算（全景图 hw≈1.8），
      // 6 列就 13.6 世界单位，而可见宽度只有 camZ*(W/H)≈10.2 -> 两边被裁。
      // 改为：格距按**卡片中位数**算；网格里所有卡片**统一大小**；
      // 再按可视范围自动算 gScale，让整块网格刚好落进屏幕（这才是总览）。
      var cols = GRID_COLS;
      var rows = Math.ceil(n / cols);
      // 中位数短边（各张的 CARD_H*scale 的中位数）
      var shorts = [];
      for (var z0 = 0; z0 < n; z0++) shorts.push(CARD_H * (photos[z0].scale || 1));
      shorts.sort(function (a, b) { return a - b; });
      var medShort = shorts[Math.floor(shorts.length / 2)] || CARD_H;
      // 用"典型卡片"的半宽半高（横竖各取一种代表，避免被极端比例带偏）
      var typHW = 0, typHH = 0;
      for (var z1 = 0; z1 < n; z1++) {
        var hh = medShort * 0.5;
        var hw = photos[z1].ratio >= 1 ? hh * photos[z1].ratio : hh;
        var hh2 = photos[z1].ratio >= 1 ? hh : (hw / photos[z1].ratio);
        if (hw > typHW) typHW = hw;
        if (hh2 > typHH) typHH = hh2;
      }
      var cellW = typHW * 2 * (1 + GRID_GAPX);
      var cellH = typHH * 2 * (1 + GRID_GAPY);
      // 可视范围（世界单位）。可见半宽 = (W/2)*camZ/focal = camZ*(W/H)；可见半高 = camZ
      var halfW = camZ * (W / Math.max(1, H));
      var halfH = camZ;
      var gw = cols * cellW, gh = rows * cellH;
      // 🔴 用户要求列表**纵向**：所以只按宽度适配，让高度溢出，纵向才滚得动。
      // （之前同时限制高度 -> 整块网格挤进一屏 -> 竖滚没有内容可滚。）
      var gScale = Math.min(1, (halfW * 1.86) / gw);
      // 🔴 格距也必须乘 gScale —— 上一版只缩了卡片没缩格子，
      // 结果是小卡片配大间隔，一屏只看得见两列。
      cellW *= gScale;
      cellH *= gScale;
      for (var m = 0; m < n; m++) {
        var r0 = Math.floor(m / cols), c0 = m % cols;
        var inRow = Math.min(cols, n - r0 * cols);
        photos[m].gx = (c0 - (inRow - 1) / 2) * cellW;
        photos[m].gy = ((rows - 1) / 2 - r0) * cellH;
        photos[m].gz = 0;
        // 统一大小：抵消各张自己的 scale，让网格里所有卡片一样大
        photos[m].gs = gScale / (photos[m].scale || 1);
      }
      gridTopY = ((rows - 1) / 2) * cellH;
      gridBottomY = -((rows - 1) / 2) * cellH;
      // 逐行扫描：总时长 MODE_MS 分摊到 rows 行，每行自己走完 rowDur
      rowCount = rows;
      rowDur = MODE_MS / Math.max(1, rows);
      var vis = camZ * 0.72;
      panMin = gridBottomY + vis;
      panMax = gridTopY - vis;
      if (panMin > panMax) { var mid = (panMin + panMax) / 2; panMin = panMax = mid; }
      panY = panTarget = panMax;

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

        // 一排的坐标（含飞入位移）
        var rx = p.x + (p.fromX * (1 - e));
        var ry = p.y + (p.fromY * (1 - e));
        var rz = p.z + (p.fromZ * (1 - e));
        var rsc = (p.scale || 1);
        // 与网格格位补间 —— modeT=0 一排，1 网格
        var mt = (p.mt === undefined) ? modeT : p.mt;   // 每张自己的进度（按行错峰）
        var x = rx * (1 - mt) + p.gx * mt;
        var y = ry * (1 - mt) + p.gy * mt;
        var z = rz * (1 - mt) + (p.gz || 0) * mt;
        var alpha = easeOutCubic(clamp01(t * 1.6));
        var rot = (p.rot + (p.overshoot ? p.rot * 2.6 * (1 - e) : p.rot * 0.9 * (1 - e))) * (1 - mt);

        // 卡片世界尺寸：短边固定，长边按比例
        var shortSide = CARD_H * (rsc * (1 - mt) + (p.gs || 1) * mt);
        var hw, hh;
        if (p.ratio >= 1) { hh = shortSide * 0.5; hw = hh * p.ratio; }
        else { hw = shortSide * 0.5; hh = hw / p.ratio; }

        // 景深：离对焦面越远越糊
        var blur = Math.min(1, Math.abs(z - focusZ) * DOF);
        // 聚焦时：比目标更近的那些（z 更大）会被镜头掠过 -> 越来越糊、越来越淡
        var fadeA = 1;
        if (focusT > 0.001 && focusIdx >= 0) {
          var zf = photos[focusIdx].z;
          if (p.z > zf) {
            var gap = (camZ * camZoom) - z;              // 到镜头的距离
            var pass = clamp01(1 - gap / 1.5);           // 越近越像"正在飞过"
            blur = Math.max(blur, pass);
            fadeA = 1 - pass * 0.95;
          }
        }

        gl.uniform1f(loc.uScroll, scroll);
        gl.uniform1f(loc.uCamZoom, camZoom);
        // 相纸
        gl.uniform4f(loc.uUVO, 0, 0, 1, 1);
        gl.uniform3f(loc.uPaperRGB, 0.957, 0.957, 0.945);
        gl.uniform3f(loc.uCenter, x, y, z);
        var pb = 1 / (1 + 2 * MATTE_BORDER);
        gl.uniform2f(loc.uHalf, hw / pb, hh / pb);
        gl.uniform1f(loc.uRot, rot);
        gl.uniform1f(loc.uPaper, 1);
        gl.uniform1f(loc.uAlpha, alpha * fadeA);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        // 照片
        gl.uniform2f(loc.uHalf, hw, hh);
        gl.uniform1f(loc.uPaper, 0);
        gl.uniform1f(loc.uMix, blur);
        gl.uniform1f(loc.uAlpha, alpha * fadeA);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, p.tex);
        gl.uniform1i(loc.uTex, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, p.blurTex || p.tex);
        gl.uniform1i(loc.uBlur, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // ---- 编号：只在网格总览里淡入 ----
        if (SHOW_NUM && numTex && mt > 0.02) {
          var idx = p.num;                       // 1 起
          var cells = 6, rowsN = 4;               // 图集布局
          var cu = (idx - 1) % cells, cv = Math.floor((idx - 1) / cells);
          var nH = CARD_H * 0.20, nW = nH * 2;    // 数字格子世界尺寸
          gl.uniform1f(loc.uScroll, scroll);
          gl.uniform1f(loc.uPanY, panY);
          gl.uniform3f(loc.uCenter, x, y - hh - nH * 0.85, z + 0.01);
          gl.uniform2f(loc.uHalf, nW * 0.5, nH * 0.5);
          gl.uniform1f(loc.uRot, 0);
          gl.uniform1f(loc.uPaper, 2);
          gl.uniform1f(loc.uAlpha, alpha * mt);
          gl.uniform3f(loc.uPaperRGB, 0.88, 0.92, 0.96);
          // 🔴 v 坐标要按**从下往上**数：图集上传时 FLIP_Y=true，
          // 画布第 0 行到了 v=1。原来用 cv/rowsN 会导致编号整体错位
          // （顶行显示 19~22，实际是第 1 行）。
          gl.uniform4f(loc.uUVO, cu / cells, (rowsN - 1 - cv) / rowsN, 1 / cells, 1 / rowsN);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, numTex);
          gl.uniform1i(loc.uTex, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.uniform4f(loc.uUVO, 0, 0, 1, 1);      // 还原，免得影响下一张
        }
      }
    }

    // ---------- 滚动：横向 + 到端回弹 ----------
    function onWheel(e) {
      if (!ready && (openState === 'typing' || openState === 'hold')) { beginDelete(); return; }
      if (!ready) return;
      e.preventDefault();
      var d = (e.deltaY || e.deltaX || 0) / 100;
      // 滚轮只给速度；之后由惯性推进（松手后还会滑一段）。
      // 用户要求：总览视图下滚轮变成**竖向**。
      // 纵向列表的方向：往下滚应当看到下面的内容，也就是 panY 减小。
      // 原来写成 += 且 panY 已在 panMax（顶部），一直被夹住 -> 滚不动。
      if (mode === 1) panV -= d * WHEEL_IMPULSE;
      else            scrollV += d * WHEEL_IMPULSE;
    }
    function tickScroll(dt) {
      // 视图切换动画期间由上面的补间接管视角，这里直接让路，免得两者打架。
      if (modeFrom !== mode) return;
      // 惯性：按速度推进，速度本身指数衰减 —— 只衰减、不回拉，所以不会弹。
      // 到两端硬停（速度清零），没有任何回弹。
      // 用户先前要求删掉的是弹簧；这里保留的是惯性：滚轮给一次速度，之后滑行衰减。
      // 横向
      scroll += scrollV * (dt / 16);
      scrollV *= Math.exp(-dt / INERTIA_TAU);
      if (Math.abs(scrollV) < 1e-5) scrollV = 0;
      if (scroll <= scrollMin) { scroll = scrollMin; if (scrollV < 0) scrollV = 0; }
      if (scroll >= scrollMax) { scroll = scrollMax; if (scrollV > 0) scrollV = 0; }
      scrollTarget = scroll;
      // 纵向（总览视图）
      panY += panV * (dt / 16);
      panV *= Math.exp(-dt / INERTIA_TAU);
      if (Math.abs(panV) < 1e-5) panV = 0;
      if (panY <= panMin) { panY = panMin; if (panV < 0) panV = 0; }
      if (panY >= panMax) { panY = panMax; if (panV > 0) panV = 0; }
      panTarget = panY;
      // 视角随视图切换而移动：一排 -> 回到 y=0 且横滚有效；总览 -> 横向归中
      if (mode === 0) { panY += (0 - panY) * (1 - Math.exp(-dt / 220)); panV = 0; }
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
      // 两个视图之间的补间
      // ---- 聚焦补间 ----
      if (focusT !== focusTo) {
        var fpr = clamp01((now - focusAt) / FOCUS_MS);
        var fe = fpr < 0.5 ? 4 * fpr * fpr * fpr : 1 - Math.pow(-2 * fpr + 2, 3) / 2;
        focusT = focusFrom + (focusTo - focusFrom) * fe;
        if (fpr >= 1) { focusT = focusTo; focusFrom = focusTo; if (focusTo === 0) focusIdx = -1; }
      }
      // 相机推近 + 居中（聚焦时）
      // 相机推近：目标 camZ 由上面按目标照片深度算出（原来用固定 0.40 倍，
      // 结果照片贴在镜头上，放大成一片糊）
      var focusZoomGoal = focusCamZ / CAM_DIST;
      var wantZoom = 1 + (focusZoomGoal - 1) * focusT;
      camZoom += (wantZoom - camZoom) * (1 - Math.exp(-dt / 140));
      // 🔴 不能只在 focusIdx>=0 时才送 —— 退出时 focusIdx 已置 -1，
      // 镜头就没人送回去了（实测：压暗退了、镜头还停在照片上）。
      if (focusT > 0.001) {
        scroll += (focusScroll - scroll) * (1 - Math.exp(-dt / 140));
        panY += (focusPan - panY) * (1 - Math.exp(-dt / 140));
        scrollTarget = scroll; panTarget = panY;
      }
      if (dimEl) dimEl.style.opacity = (DIM_MAX * focusT).toFixed(3);

      var switching = (modeFrom !== mode);
      if (switching) {
        var pr = clamp01((now - modeAt) / MODE_MS);
        var ee = pr < 0.5 ? 4 * pr * pr * pr : 1 - Math.pow(-2 * pr + 2, 3) / 2;  // easeInOutCubic
        modeT = modeFrom + (mode - modeFrom) * ee;
        // 视角与形状用同一条缓动一起走
        scroll = viewFrom.scroll + (viewTo.scroll - viewFrom.scroll) * ee;
        panY   = viewFrom.pan    + (viewTo.pan    - viewFrom.pan)    * ee;
        scrollTarget = scroll; panTarget = panY;
        // 照片：**按行逐行扫描**。行内同时到达，逐行错开一个 rowDur。
        for (var q = 0; q < photos.length; q++) {
          var ph = photos[q];
          var rowI = Math.floor((ph.num - 1) / GRID_COLS);
          var dly = ROW_STAGGER ? rowI * rowDur : 0;
          var ppr = clamp01((now - modeAt - dly) / rowDur);
          var pee = ppr < 0.5 ? 4 * ppr * ppr * ppr : 1 - Math.pow(-2 * ppr + 2, 3) / 2;
          ph.mt = modeFrom + (mode - modeFrom) * pee;
        }
        if (pr >= 1) {
          modeT = mode; modeFrom = mode;
          scroll = viewTo.scroll; panY = viewTo.pan;
          scrollTarget = scroll; panTarget = panY;
          for (var q2 = 0; q2 < photos.length; q2++) photos[q2].mt = mode;
        }
      } else {
        for (var q3 = 0; q3 < photos.length; q3++) photos[q3].mt = modeT;
      }
      draw();
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = cv.width = Math.floor(window.innerWidth * dpr);
      H = cv.height = Math.floor(window.innerHeight * dpr);
      cv.style.width = window.innerWidth + 'px';
      cv.style.height = window.innerHeight + 'px';
      if (photos.length) layout();     // W/H 变了，网格适配要重算
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
       'uTex','uBlur','uMix','uAlpha','uPaper','uTint','uUVO','uPaperRGB','uPanY','uCamZoom'].forEach(function (n) {
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
      for (var q0 = 0; q0 < photos.length; q0++) photos[q0].num = q0 + 1;
      buildNumberAtlas(photos.length);
      layout();
      for (var i = 0; i < photos.length; i++) loadPhoto(photos[i]);

      resize();
      window.addEventListener('resize', resize);
      window.addEventListener('wheel', onWheel, { passive: false });
      document.addEventListener('mousedown', function (e) {
        if (e.target && e.target.closest && e.target.closest('[data-album-toggle]')) return;
        if (openState === 'typing' || openState === 'hold') { beginDelete(); return; }
        if (!ready) return;
        if (modeFrom !== mode) return;                 // 视图补间中不接受聚焦
        // 屏幕坐标 -> NDC
        var nx = (e.clientX * dpr / W) * 2 - 1;
        var ny = 1 - (e.clientY * dpr / H) * 2;
        var hit = pickPhoto(nx, ny);
        setFocus(hit);                                 // 没命中 -> -1 = 退出聚焦
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') setFocus(-1);
      });

      // 打字机光标闪烁的 keyframes
      var st = document.createElement('style');
      st.textContent = '@keyframes albumCaret{0%,49%{opacity:.85}50%,100%{opacity:0}}';
      document.head.appendChild(st);

      buildOpening();
      buildToggle();
      // 聚焦时的整屏压暗层（用户选：整屏压暗，照片也一起暗）
      dimEl = document.createElement('div');
      dimEl.setAttribute('data-album-dim', '');
      dimEl.style.cssText = 'position:fixed;inset:0;z-index:38;pointer-events:none;' +
        'background:#05070b;opacity:0;';
      host.appendChild(dimEl);
      raf = requestAnimationFrame(frame);
    }

    // CPU 侧投影：必须与顶点着色器完全一致，否则点击会偏。
    // VS: scr = (w - (scroll,panY)) * k;  k = focal/(camZ - w.z);  ndc = scr/(half*0.5)
    function projRect(px, py, pz, hw, hh) {
      var zc = Math.max(0.12, camZ * camZoom - pz);
      var k = (FOCAL * H * 0.5) / zc;
      return {
        cx: (px - scroll) * k / (W * 0.5),
        cy: (py - panY) * k / (H * 0.5),
        hx: hw * k / (W * 0.5),
        hy: hh * k / (H * 0.5)
      };
    }
    // 每张照片当前的世界尺寸（与绘制里的算法一致）
    function worldSize(p, mt) {
      var shortSide = CARD_H * ((p.scale || 1) * (1 - mt) + (p.gs || 1) * mt);
      var hw, hh;
      if (p.ratio >= 1) { hh = shortSide * 0.5; hw = hh * p.ratio; }
      else { hw = shortSide * 0.5; hh = hw / p.ratio; }
      return { hw: hw, hh: hh };
    }
    // 拾取：命中则返回最近的（z 最大）那张的下标
    function pickPhoto(nx, ny) {
      var best = -1, bz = -1e9;
      for (var i = 0; i < photos.length; i++) {
        var ph = photos[i], mt = (ph.mt === undefined) ? modeT : ph.mt;
        var x = ph.x * (1 - mt) + ph.gx * mt;
        var y = ph.y * (1 - mt) + ph.gy * mt;
        var z = ph.z * (1 - mt) + (ph.gz || 0) * mt;
        var sz = worldSize(ph, mt);
        // 命中框用相纸尺寸（画面上看到的是相纸，比照片大一圈；
        // 用照片尺寸会导致点白边完全没反应）
        var pb = 1 / (1 + 2 * MATTE_BORDER);
        var r = projRect(x, y, z, sz.hw / pb, sz.hh / pb);
        if (Math.abs(nx - r.cx) <= r.hx && Math.abs(ny - r.cy) <= r.hy) {
          if (z > bz) { bz = z; best = i; }
        }
      }
      return best;
    }

    // 聚焦到第 i 张（-1 = 退出）。相机推近 + 整屏压暗，全部走补间。
    function setFocus(i) {
      focusIdx = i;
      focusFrom = focusT;
      focusTo = (i < 0) ? 0 : 1;
      focusAt = performance.now();
      if (i < 0) { focusScroll = preScroll; focusPan = prePan; }   // 退出：目标回到原位
      if (i >= 0) {
        var ph = photos[i], mt = (ph.mt === undefined) ? modeT : ph.mt;
        preScroll = scroll; prePan = panY;             // 先记住原位
        focusScroll = ph.x * (1 - mt) + ph.gx * mt;   // 把这页移到画面中心
        focusPan = ph.y * (1 - mt) + ph.gy * mt;
        var z0 = ph.z * (1 - mt) + (ph.gz || 0) * mt;
        var hh0 = worldSize(ph, mt).hh;
        // 屏高占比 = hh / zc -> 想要 FOCUS_FILL，则 zc = hh/FOCUS_FILL
        focusCamZ = z0 + hh0 / FOCUS_FILL;
      }
    }

    // 数字图集：6x4 格，每格 128x64，画 01..22
    function buildNumberAtlas(count) {
      var cells = 6, rowsN = 4, cw = 128, ch = 64;
      var c = document.createElement('canvas');
      c.width = cells * cw; c.height = rowsN * ch;
      var g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      g.font = '600 34px "Ubuntu Mono", ui-monospace, Menlo, Consolas, monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (var i = 1; i <= count; i++) {
        var cu = (i - 1) % cells, cv = Math.floor((i - 1) / cells);
        g.fillStyle = '#ffffff';
        g.fillText((i < 10 ? '0' : '') + i, cu * cw + cw / 2, cv * ch + ch / 2);
      }
      numTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, numTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      numCell = [cells, rowsN];
    }

    // 底部开关（简易版；用户说后期会换样式）
    function buildToggle() {
      var b = document.createElement('button');
      b.setAttribute('data-album-toggle', '');
      b.textContent = '总览';
      b.style.cssText =
        'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:41;' +
        'pointer-events:auto;cursor:pointer;padding:9px 22px;border-radius:999px;' +
        'font:400 13px/1 "Ubuntu Mono",ui-monospace,monospace;letter-spacing:.14em;' +
        'color:#eaf2fb;background:rgba(255,255,255,.08);' +
        'border:1px solid rgba(255,255,255,.34);backdrop-filter:blur(6px);' +
        'transition:background .2s,color .2s;';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        mode = mode ? 0 : 1;
        modeFrom = modeT; modeAt = performance.now();
        // 用户要求：切到总览时视角要锁定过去，**而且要有动画、不要硬切**。
        // 所以这里只记下起点与终点，实际位移交给下面那条与 modeT 同步的补间。
        viewFrom.scroll = scroll;
        viewFrom.pan = panY;
        if (mode === 1) {
          viewTo.scroll = 0;          // 总览：横向归中
          viewTo.pan = panMax;        // 纵向到网格顶部
        } else {
          viewTo.scroll = scrollTarget;   // 回一排：保持当前横向位置
          viewTo.pan = 0;                 // 纵向回中
        }
        scrollV = 0; panV = 0;
        b.textContent = mode ? '浏览' : '总览';
      });
      // 别让点击落到"跳过开屏"的处理上
      b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      host.appendChild(b);
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

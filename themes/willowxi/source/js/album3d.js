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

  // 用户反馈等太久。开屏原来 = 16*110 + 3000 + 16*70 = 5880ms，
  // 其中停留 3000ms 是纯等待，砍到 1200；删除 70 -> 50（=800ms）。
  // 现在开屏 = 1760 + 1200 + 800 = 3760ms。
  // 再压开屏：打字 80（=1280ms）、停留 700、删除 40（=640ms）。
  // 开屏合计 = 1280 + 700 + 640 = 2620ms。
  var TYPE_MS = 80, HOLD_MS = 700, DEL_MS = 40;
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
  // 构建戳：写在页面属性 + 底部按钮上，方便一眼确认浏览器跑的是哪一版。
  // 必须定义在模块级 —— 放到 init 里会导致 buildToggle() 拿不到它而抛
  // ReferenceError，整个初始化挂掉（我刚踩过）。
  var BUILD = 'focusY-4fbefdf+';
  var toggleEl = null, dimEl2 = null;
  var navPrev = null, navNext = null;   // 灯箱左右切换按钮
  // 按钮位置（可在 tune=1 面板里用滑块调）
  var NAV_INSET = 28, NAV_TOP = 50, NAV_SIZE = 56;
  var TOGGLE_BOTTOM = 26, TOGGLE_LEFT = 50;
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
  // 开屏那条不再和飞入耦合：飞入的起飞点只有一个 = finishOpening（文字消失）。
  // 所以这里用原来调好的速度，不必为了赶开屏而压缩。
  // 单张 550ms，错峰 85ms（一张接一张很清楚）。
  // 整批 = 21*85*1.4 + 550*1.4 = 3270ms。
  var FLY_MS = 550;
  var FLY_STAGGER = 85;        // 错峰基准（ms/张）—— 用户要求错峰更明显
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
      'uniform float uMix, uAlpha, uPaper, uTint, uDim;',
    'uniform vec4 uUVO;',        // xy = uv 偏移, zw = uv 缩放
    'uniform vec3 uPaperRGB;',   // 相纸/数字的颜色
      'varying vec2 vUV;',
      'varying float vFade;',
      'void main() {',
      '  vec2 uv = vUV * uUVO.zw + uUVO.xy;',
      '  if (uPaper > 0.5 && uPaper < 1.5) { gl_FragColor = vec4(uPaperRGB * (1.0 - uDim), uAlpha); return; }',
      '  vec4 a = texture2D(uTex, uv);',
      '  if (uPaper > 1.5) { gl_FragColor = vec4(uPaperRGB, a.a * uAlpha); return; }',
      '  vec4 bb = texture2D(uBlur, uv);',
      '  vec3 c = mix(a.rgb, bb.rgb, uMix);',
      '  gl_FragColor = vec4(c * (1.0 - uDim), uAlpha);',
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
  var seqDur = 600, seqGap = 40;     // 逐个飞入：单张时长 / 相邻错峰
  // 聚焦：focusIdx = 第几张（-1 无）；focusT 0->1 补间；相机推近用 camZoom
  var focusIdx = -1, focusT = 0, focusFrom = 0, focusAt = 0, focusTo = 0;
  var focusScroll = 0, focusPan = 0, camZoom = 1, dimEl = null;
  var focusFromScroll = 0, focusFromPan = 0, focusFromZoom = 1;
  var navHLast = 0;   // 聚焦补间的起始镜头位置
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
        // 🔴 data-screen-src / data-light-src 挂在 **<img>** 上，不在 <figure> 上！
        // 原来只读 figure，拿到 null，于是回退到 img.src —— 那是 **thumb 档（640px）**，
        // 所以相册一直用的是缩略图；lightSrc 也恒为空，高清图加载被直接 return。
        // 三档实测分辨率：thumb 640 / screen 900 / light 1600。
        var src = (img && (img.getAttribute('data-screen-src') || img.getAttribute('data-light-src'))) ||
                  f.getAttribute('data-screen-src') ||
                  (img && (img.getAttribute('data-src') || img.getAttribute('src'))) || '';
        var hiSrc = (img && img.getAttribute('data-light-src')) ||
                    f.getAttribute('data-light-src') || '';
        if (!id || !src) continue;
        list.push({ id: id, ratio: ratio, src: src, lightSrc: hiSrc });
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
    // 聚焦时把这张换成高清贴图。
    // 实测三档分辨率：thumb 640 / light 1600 / screen 900。
    // album3d 平时加载的是 screen(900)，所以高清其实是 light(1600)。
    // 只在聚焦那一张上加载，浏览时不加载 22 张 1600px（那会很重）。
    function loadHiRes(p) {
      if (!p || p.hiTried || !p.lightSrc) return;
      p.hiTried = true;
      var im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = function () {
        var t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (p.tex) gl.deleteTexture(p.tex);
        p.tex = t;                     // 就地换掉，正在聚焦时画面会变清晰
        dirty = true;
        console.log('[album3d] 高清图就绪 ' + p.id + ' ' + im.naturalWidth + 'x' + im.naturalHeight);
      };
      im.onerror = function () { p.hiTried = false; };
      im.src = p.lightSrc;
    }

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
        p.overshoot = false;                          // 用户要求删掉回弹，不再有过冲那一档
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
      // 一个一个飞（用户要求）：按序号错峰，一行从左到右、再下一行。
      // 网格里照片的下标本身就是这个顺序。
      seqDur = MODE_MS * 0.42;                                  // 单张自己走完的时长
      seqGap = Math.max(0, MODE_MS - seqDur) / Math.max(1, n - 1);  // 相邻两张错开的间隔
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
      // 聚焦时被聚焦那张 uDim=0（保持原亮度），其余随聚焦进度变暗。
      // 用着色器里的一个乘法实现，不增加任何几何 —— 不会像整屏四边形那样拖垮软件渲染。
      var focusNum2 = (focusT > 0.001 && focusIdx >= 0) ? photos[focusIdx].num : -1;
      for (var i = 0; i < order.length; i++) {
        var p = order[i];
        if (!p.ready) continue;
        // 飞入进度
        // 不能用 ready 当闸门！ready 只在开屏结束才为 true，
        // 于是开屏期间 t 恒为 0、结束时全部瞬间跳到 1，
        // 用户看到的就是文字消失之后照片全部一起蹦出来。
        // 飞入只由 startedAt 决定，而它在开屏一开始就已经设好。
        var t = startedAt ? clamp01((now - startedAt - p.startAt) / p.dur) : 0;
        if (t <= 0) continue;
        // 用户要求：删掉回弹动画，一步到位。
        // 原来近处用 easeOutBack(1.9)、其余 easeOutBack(1.22)，都会有回弹过冲。
        var e = easeOutCubic(t);

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
        var rot = (p.rot * 0.9 * (1 - e)) * (1 - mt);

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
        // 🔴🔴 uPanY 必须在这里上传！
        // 原来它只出现在下面那个 if (SHOW_NUM && ...) 编号块里，
        // 而 SHOW_NUM=false -> 那一行从不执行 -> 着色器里 uPanY 恒为 0
        // -> **摄像机在 GPU 上从来没有上下动过**（JS 里 panY 变化是真的，但传不到显卡）。
        gl.uniform1f(loc.uPanY, panY);
        // 相纸
        // 变暗系数：被聚焦那张为 0（保持原亮度），其余按聚焦进度变暗。
        // 只是在片元着色器里乘一下，不增加任何几何。
        var dimK = (focusNum2 >= 0 && p.num !== focusNum2) ? DIM_MAX * focusT : 0;
        gl.uniform1f(loc.uDim, dimK);
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
      // 在调参面板里滚轮时，是滚面板自己的列表，不要拿去滚相册，
      // 更不要当成跳过开屏（用户说老是点到下面的东西）。
      if (e.target && e.target.closest && e.target.closest('[data-album-tuner]')) return;
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
      // 🔴 聚焦期间纵向由聚焦补间独占，这里必须让路。
      // 否则下面的 panMin/panMax 夹取会把聚焦目标夹住：
      // 网格最下面几行的 focusPan ≈ -4.75，而 panMin = -4.7189，
      // 于是 panY 永远到不了 focusPan（实测 pan=-0.269 而 tgt=-0.584，
      // 接着后续点击的 rectOf 算偏、连锁失败）。
      var focusing = (focusTo === 1 || focusT > 0.001);
      if (!focusing) {
        panY += panV * (dt / 16);
        panV *= Math.exp(-dt / INERTIA_TAU);
        if (Math.abs(panV) < 1e-5) panV = 0;
        if (panY <= panMin) { panY = panMin; if (panV < 0) panV = 0; }
        if (panY >= panMax) { panY = panMax; if (panV > 0) panV = 0; }
        panTarget = panY;
      }
      // 视角随视图切换而移动：一排 -> 回到 y=0 且横滚有效；总览 -> 横向归中
      // 🔴 这条只在**没有聚焦**时执行。
      // 它是为'从网格退回一排时纵向回中'加的，但在一排视图里每帧把 panY 拉回 0，
      // 结果把聚焦刚刚写进去的纵向位移立刻抹掉 ——
      // 用户的原话就是'完全没有上下位移的痕迹'。
      if (mode === 0 && focusTo === 0 && focusT <= 0.001) {
        panY += (0 - panY) * (1 - Math.exp(-dt / 220)); panV = 0;
      }
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
      // 不在这里起飞。起飞点是 finishOpening（文字消失）——
      // 用户：把文字消失结束作为一个标志，然后再开始做飞入动画。
      if (openState === 'deleting' || openState === 'done') return;
      openState = 'deleting';
      openAt = performance.now();
    }
    function tickOpening(now) {
      if (openState === 'typing') {
        var n = Math.min(openText.length, Math.floor((now - openAt) / TYPE_MS));
        setTitle(openText.slice(0, n));
        if (n >= openText.length) { openState = 'hold'; openAt = now; }   // 不在这里起飞：停留阶段不能有照片在飞
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
      // 🔴 camZoom 必须和 scroll/panY 用**同一条缓动进度**，不能用指数追。
      // 原来是指数追（永远差一点），而 focusPan 是按 camZoom 已到达目标算的，
      // 于是深度对不上 -> focusNdcY 偏离目标。实测：camZoom=0.718 时 ndc=-0.045，
      // 目标 -0.071；camZoom=0.579（接近目标）时误差才变小 —— 正是这个原因。
      var wantZoom = focusTo === 0 ? 1 : focusZoomGoal;
      if (focusT > 0.001 || focusT !== focusTo) {
        var zpr = clamp01((now - focusAt) / FOCUS_MS);
        var ze = zpr < 0.5 ? 4 * zpr * zpr * zpr : 1 - Math.pow(-2 * zpr + 2, 3) / 2;
        // 🔴 起点必须是 focusFromZoom，不能写死 1。
        // 原来写 1 + (wantZoom-1)*ze：退出时 wantZoom=1 -> camZoom 恒等于 1，
        // **摄像机拉远的动画直接没了**（一帧跳回）。
        camZoom = focusFromZoom + (wantZoom - focusFromZoom) * ze;
      } else {
        camZoom += (wantZoom - camZoom) * (1 - Math.exp(-dt / 140));
      }
      // 硬夹：任何情况下 camZoom 都不能为 0 / 负数 / NaN（都会让投影爆掉）
      if (!isFinite(camZoom)) camZoom = 1;
      // 允许小值甚至负值：远处照片要求摄像机越过原点，只要目标照片的 zc>0 就合法。
      // （屏幕上会消失的是 zc<0.9 的那些近处照片 —— 那是它们从镜头旁掠过，符合预期。）
      camZoom = Math.max(-2, Math.min(1, camZoom));
      // 🔴 不能只在 focusIdx>=0 时才送 —— 退出时 focusIdx 已置 -1，
      // 镜头就没人送回去了（实测：压暗退了、镜头还停在照片上）。
      // 用聚焦补间自己的缓动进度来插值镜头位置 —— 精确落位。
      // 原来是指数追（scroll += (目标-当前)*k），永远差一点点，
      // 实测 panY 总比 focusPan 差 0.09~0.14，看着就是没对准。
      // 退出时（focusTo=0）用同一条式子从原位走回去。
      if (focusT > 0.001 || focusT !== focusTo) {
        var fpr2 = clamp01((now - focusAt) / FOCUS_MS);
        var fe2 = fpr2 < 0.5 ? 4 * fpr2 * fpr2 * fpr2 : 1 - Math.pow(-2 * fpr2 + 2, 3) / 2;
        scroll = focusFromScroll + (focusScroll - focusFromScroll) * fe2;
        panY = focusFromPan + (focusPan - focusFromPan) * fe2;
        scrollTarget = scroll; panTarget = panY;
      }
      if (dimEl) dimEl.style.opacity = (DIM_MAX * focusT).toFixed(3);
      // 灯箱左右圆形按钮：聚焦时淡入，退出时淡出
      if (navPrev && navNext) {
        var navOp = clamp01((focusT - 0.35) / 0.4);
        navPrev.style.opacity = navOp; navNext.style.opacity = navOp;
        navPrev.style.pointerEvents = navOp > 0.5 ? 'auto' : 'none';
        navNext.style.pointerEvents = navOp > 0.5 ? 'auto' : 'none';
      }
      // 调试读数：聚焦时把关键量显示在底部按钮上，用户截图即可定位问题
      if (toggleEl) {
        if (focusTo === 1 || focusT > 0.001) {
          var _fp = photos[focusIdx];
          toggleEl.textContent = 'pan ' + panY.toFixed(2) + ' / tgt ' + focusPan.toFixed(2) +
            ' / nav ' + (navHLast | 0) + ' / h ' + window.innerHeight +
            ' / z ' + camZoom.toFixed(2) + ' / y ' + (_fp ? _fp.y.toFixed(2) : '-');
        } else {
          toggleEl.textContent = (mode ? '浏览' : '总览') + ' · ' + BUILD;
        }
      }

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
          var dly = ROW_STAGGER ? q * seqGap : 0;
          var ppr = clamp01((now - modeAt - dly) / seqDur);
          var pee = ppr < 0.5 ? 4 * ppr * ppr * ppr : 1 - Math.pow(-2 * ppr + 2, 3) / 2;
          // 从该张自己的起点反向（打断时不会跳）
          var m0 = (ph.mtFrom === undefined) ? modeFrom : ph.mtFrom;
          ph.mt = m0 + (mode - m0) * pee;
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
      ['uCenter','uHalf','uRot','uFocal','uCamZ','uHalfW','uHalfH','uScroll','uDim',
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
      loadTune();     // 先把上次调好的值读回来，再 collect / layout
      photos = collect();
      for (var q0 = 0; q0 < photos.length; q0++) photos[q0].num = q0 + 1;
      buildNumberAtlas(photos.length);
      layout();
      for (var i = 0; i < photos.length; i++) loadPhoto(photos[i]);

      resize();
      window.addEventListener('resize', resize);
      window.addEventListener('wheel', onWheel, { passive: false });
      document.addEventListener('mousedown', function (e) {
        // 任何 UI 内部的点击都不要往下传。
        // 原来只挡了底部按钮，于是拖调参面板的滑块会同时触发
        // 跳过开屏 / 拾取聚焦 —— 用户说就是点到了下面的东西。
        if (e.target && e.target.closest &&
            e.target.closest('[data-album-tuner], [data-album-toggle], [data-album-nav]')) return;
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

      host.setAttribute('data-album-build', BUILD);
      console.log('[album3d] build ' + BUILD);
      // 飞入在【删除阶段】开始（beginDelete 里调用 startFly），不是开屏一开始。
      // 用户反馈：动画还没播完就开始飞了 —— 打字与停留阶段不能有照片在飞；
      // 而文字消失时它们要已经就位，所以飞入正好占满删除那一段。
      buildOpening();
      buildToggle();
      if (/[?&]tune=1/.test(location.search)) buildTuner();
      refreshGlass();   // 初始装上折射
      // 聚焦时的整屏压暗层（用户选：整屏压暗，照片也一起暗）
      dimEl = document.createElement('div');
      dimEl.setAttribute('data-album-dim', '');
      // 🔴 插在画布**之前**，所以渲染在画布下面 —— 只压主题背景，
      // 不压 GL 里的照片（照片由上面的 uDim 自己变暗）。
      // 原来它是 position:fixed 盖在最上层，所以连被聚焦那张一起压暗了。
      dimEl.style.cssText = 'position:absolute;inset:0;z-index:0;pointer-events:none;' +
        'background:#05070b;opacity:0;';
      host.insertBefore(dimEl, host.firstChild);
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
      focusFromScroll = scroll;      // 记录起点，供补间按进度精确插值
      focusFromPan = panY;
      focusFromZoom = camZoom;       // 退出时要从这里插值回 1，否则拉远动画会消失
      // 退出聚焦（用户要求）：**不要飞回原来的位置**。
      // 镜头就停在当前这张照片上（横向保持不动），只把 zoom 拉到最远（=1），
      // 纵向恢复到自然位置（0）。
      // 用户要求：聚焦灯箱时加载高清图
      if (i >= 0 && photos[i]) loadHiRes(photos[i]);
      if (i < 0) { focusScroll = scroll; focusPan = 0; }
      if (i >= 0) {
        var ph = photos[i], mt = (ph.mt === undefined) ? modeT : ph.mt;
        preScroll = scroll; prePan = panY;             // 先记住原位
        focusScroll = ph.x * (1 - mt) + ph.gx * mt;   // 把这页移到画面中心
        // 上下定位：画布铺满整个视口，但页面上方有一条导航栏，
        // 所以要把照片对到**导航栏以下的可见区域**正中，而不是画布正中。
        var navEl = document.querySelector('.site-nav, .navbar, .top-nav, header, nav');
        // 🔴 必须夹住：querySelector 有可能匹配到一个几乎满屏高的 header/nav 容器
        // （实测 navH 取到 ~966，等于整个视口），补偿量就变成 400px，
        // 照片被推到画面下方、底部被裁掉。顶部栏再高也不会超过视口的一小部分。
        var navH = navEl ? navEl.getBoundingClientRect().height : 0;
        navH = Math.max(0, Math.min(navH, window.innerHeight * 0.14));
        navHLast = navH;
        var dyNdc = -(navH / Math.max(1, window.innerHeight));   // 负 = 画面中心偏下
        // z0 必须在这里先算出来：原来我在 var z0 之前用了它，
        // 得到 camZ - undefined = NaN，panY 整条变成 NaN（画面直接乱掉）。
        var z0n = ph.z * (1 - mt) + (ph.gz || 0) * mt;
        var py0 = ph.y * (1 - mt) + ph.gy * mt;      // 该照片的世界 y
        // focusPan 留到 focusCamZ 算出之后再定（见下面）——
        // 补偿量必须用**推近之后**的深度，否则会差 camZ*zc 那个倍数。
        var z0 = ph.z * (1 - mt) + (ph.gz || 0) * mt;
        var hh0 = worldSize(ph, mt).hh;
        // 屏高占比 = hh / zc -> 想要 FOCUS_FILL，则 zc = hh/FOCUS_FILL
        focusCamZ = z0 + hh0 / FOCUS_FILL;
        // 🔴 必须夹住！聚焦**远处那一层**（z0 为负）时，
        //    focusCamZ = z0 + hh0/0.72 可能 <= 0，摄像机直接跑到照片后面，
        //    于是 camZoom 为负 -> zc = camZ*camZoom - z 为负 -> 投影彻底退化：
        //    照片被推到画面外（实测 camZoom = -0.162、panY = -0.498、照片低了 420px），
        //    严重时就是之前那个 GPU 卡死。这里保证摄像机始终在照片前面。
        if (!isFinite(focusCamZ)) focusCamZ = CAM_DIST;
        // 🔴 只需要保证摄像机在**目标照片之前**：zc = focusCamZ - z0n >= 0.35。
        // 我上一版写成 Math.max(CAM_DIST*0.5, ...)（摄像机离原点至少 1.6），
        // 对远处那层（z0 为负）来说摄像机永远到不了近处 ——
        // 表现就是**放大幅度被砍**（用户：不会写上下位移就不位移只减小放大幅度了）。
        // 注意 focusCamZ 本身可以为负：远处照片 z0=-1.25 时 focusCamZ=-0.07，
        // zc = -0.07-(-1.25) = 1.18 > 0，完全合法。
        focusCamZ = Math.max(z0n + 0.35, focusCamZ);
        // 上下定位的补偿量必须用**推近之后**的深度（focusCamZ - z0n）。
        // 之前用的是推近前的 camZ - z0n，实测差 1.67 倍（camZoom 0.756 时），
        // 照片被多推下去 1.67 倍：量出 focusNdcY = -0.1725，而目标只有 -0.1035。
        focusPan = py0 - dyNdc * (focusCamZ - z0n) / FOCAL;
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
      b.textContent = '总览 · ' + BUILD;
      // 样式交给 CSS 类 .album-glass / .album-btn-toggle（液态玻璃）
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        // 打断支持：每张照片记住自己当前的位置 mtFrom，
        // 再次点击时从**当前位置**反向走，而不是被拉回统一起点重来。
        for (var qi = 0; qi < photos.length; qi++) {
          var pq = photos[qi];
          pq.mtFrom = (pq.mt === undefined) ? modeT : pq.mt;
        }
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
        b.textContent = (mode ? '浏览' : '总览') + ' · ' + BUILD;
      });
      // 别让点击落到"跳过开屏"的处理上
      b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      host.appendChild(b);
      // 液态玻璃：给底部按钮套上玻璃类
      b.className = 'album-glass album-btn-toggle';
      toggleEl = b;   // 原来只读没赋值，导致位置滑块与逐帧文字更新都不生效

      // 灯箱左右两侧的圆形上一张 / 下一张（固定位置，聚焦时才出现）
      function makeNavBtn(dir) {
        var nb = document.createElement('button');
        nb.className = 'album-glass album-nav-btn album-nav-btn--' + (dir < 0 ? 'prev' : 'next');
        nb.setAttribute('data-album-nav', dir < 0 ? 'prev' : 'next');
        nb.setAttribute('aria-label', dir < 0 ? '上一张' : '下一张');
        nb.textContent = dir < 0 ? '\u2039' : '\u203a';
        nb.addEventListener('mousedown', function (e) { e.stopPropagation(); });
        nb.addEventListener('click', function (e) {
          e.stopPropagation();
          var n = photos.length;
          if (!n) return;
          var cur = (focusIdx >= 0) ? focusIdx : 0;
          setFocus(((cur + dir) % n + n) % n);
        });
        host.appendChild(nb);
        return nb;
      }
      navPrev = makeNavBtn(-1);
      navNext = makeNavBtn(1);
    }



    // ---------- 液态玻璃：DOM 版真实折射 ----------
    // 老 GL 版（dome3d.js 的 FS_POST）的折射算法照搬过来：
    //   在圆角矩形上求 SDF，取外法线，edge = clamp((d-(1-feather))/feather)，
    //   位移量 = pow(edge, curve) * 强度，方向 = 外法线。
    // DOM 上的做法：把上面算出的 (法线*强度) 编码成一张位移图（R/G 通道，128 为 0），
    // 用 SVG feImage + feDisplacementMap 挂到 backdrop-filter 上。
    // 实测：Edge/Chromium 支持 backdrop-filter: url(#svgFilter)，位移真实生效。
    var GLASS_DEPTH = 26;      // 折射位移（feDisplacementMap 的 scale）
    var GLASS_FEATHER = 0.34;  // 边缘羽化：只有靠边这一圈做折射
    var GLASS_CURVE = 1.6;     // 曲线指数：越大越集中在最外缘
    var GLASS_CHROMA = 0.0;    // 色散强度（0 = 关，需要三通道合成，开销更高）
    var GLASS_FROST = 6;       // 磨砂模糊 px
    var GLASS_SAT = 180;       // 聚光 saturate%
    var glassFilterSeq = 0;

    // 生成一张圆角矩形的边缘位移图（返回 dataURL 与尺寸）
    function makeDispMap(w, h, radius, feather, curve) {
      var N = 128;
      var cv = document.createElement('canvas');
      cv.width = N; cv.height = N;
      var g = cv.getContext('2d');
      var img = g.createImageData(N, N);
      var hw = w / 2, hh = h / 2;
      var r = Math.min(radius, Math.min(hw, hh));
      for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
          // 像素坐标 -> 元素坐标（单位：像素），再归一化到 [-1,1]
          var px = (x + 0.5) / N * w - hw;
          var py = (y + 0.5) / N * h - hh;
          // 圆角矩形 SDF（与老着色器一致）
          var qx = Math.abs(px) - hw + r, qy = Math.abs(py) - hh + r;
          var outside = Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0));
          var d = Math.min(Math.max(qx, qy), 0) + outside - r;   // <=0 在内部
          var i = (y * N + x) * 4;
          var amt = 0, nx = 0, ny = 0;
          if (d <= 0) {
            var inner = -d;
            var band = feather * Math.min(hw, hh);
            var edge = Math.max(0, 1 - inner / Math.max(1e-3, band));
            amt = Math.pow(edge, curve);
            // SDF 梯度 = 外法线
            var e = 1.0;
            var dx = (sdfAt(px + e, py, hw, hh, r) - sdfAt(px - e, py, hw, hh, r));
            var dy = (sdfAt(px, py + e, hw, hh, r) - sdfAt(px, py - e, hw, hh, r));
            var L = Math.sqrt(dx * dx + dy * dy);
            if (L > 1e-6) { nx = dx / L; ny = dy / L; }
          }
          img.data[i] = Math.round(128 + nx * amt * 127);
          img.data[i + 1] = Math.round(128 + ny * amt * 127);
          img.data[i + 2] = 128; img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      return cv.toDataURL('image/png');
    }
    function sdfAt(px, py, hw, hh, r) {
      var qx = Math.abs(px) - hw + r, qy = Math.abs(py) - hh + r;
      var out = Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0));
      return Math.min(Math.max(qx, qy), 0) + out - r;
    }

    var glassSvg = null;
    // 给一个元素装上折射：按它的实际尺寸与圆角生成位移图
    function applyGlassRefract(el, radius) {
      if (!el) return;
      var w = Math.max(8, Math.round(el.offsetWidth || 56));
      var h = Math.max(8, Math.round(el.offsetHeight || 56));
      if (!glassSvg) {
        glassSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        glassSvg.setAttribute('data-album-glass', '');
        glassSvg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
        host.appendChild(glassSvg);
      }
      var id = 'albumGlassF' + (++glassFilterSeq);
      var url = makeDispMap(w, h, radius, GLASS_FEATHER, GLASS_CURVE);
      var ns = 'http://www.w3.org/2000/svg';
      var f = document.createElementNS(ns, 'filter');
      f.setAttribute('id', id);
      f.setAttribute('x', '0%'); f.setAttribute('y', '0%');
      f.setAttribute('width', '100%'); f.setAttribute('height', '100%');
      f.setAttribute('color-interpolation-filters', 'sRGB');
      var im = document.createElementNS(ns, 'feImage');
      im.setAttribute('href', url);
      im.setAttribute('x', '0'); im.setAttribute('y', '0');
      im.setAttribute('width', '100%'); im.setAttribute('height', '100%');
      im.setAttribute('preserveAspectRatio', 'none');
      im.setAttribute('result', 'disp');
      f.appendChild(im);
      if (GLASS_CHROMA > 0.01) {
        // 色散：三通道用不同 scale 位移再合成（开销更高，默认关）
        var scales = [GLASS_DEPTH * (1 + GLASS_CHROMA * 0.06), GLASS_DEPTH, GLASS_DEPTH * (1 - GLASS_CHROMA * 0.06)];
        var chans = ['R', 'G', 'B'];
        var mats = ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
                    '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
                    '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'];
        var prev = null;
        for (var ci = 0; ci < 3; ci++) {
          var d = document.createElementNS(ns, 'feDisplacementMap');
          d.setAttribute('in', 'SourceGraphic'); d.setAttribute('in2', 'disp');
          d.setAttribute('scale', scales[ci]);
          d.setAttribute('xChannelSelector', 'R'); d.setAttribute('yChannelSelector', 'G');
          d.setAttribute('result', 'd' + ci);
          f.appendChild(d);
          var m = document.createElementNS(ns, 'feColorMatrix');
          m.setAttribute('in', 'd' + ci); m.setAttribute('type', 'matrix');
          m.setAttribute('values', mats[ci]); m.setAttribute('result', 'c' + ci);
          f.appendChild(m);
          if (prev === null) { prev = 'c' + ci; }
          else {
            var bl = document.createElementNS(ns, 'feBlend');
            bl.setAttribute('in', prev); bl.setAttribute('in2', 'c' + ci);
            bl.setAttribute('mode', 'screen'); bl.setAttribute('result', 'b' + ci);
            f.appendChild(bl); prev = 'b' + ci;
          }
        }
      } else {
        var dm = document.createElementNS(ns, 'feDisplacementMap');
        dm.setAttribute('in', 'SourceGraphic'); dm.setAttribute('in2', 'disp');
        dm.setAttribute('scale', GLASS_DEPTH);
        dm.setAttribute('xChannelSelector', 'R');
        dm.setAttribute('yChannelSelector', 'G');
        dm.setAttribute('result', 'd0');
        f.appendChild(dm);
      }
      glassSvg.appendChild(f);
      var bf = 'url(#' + id + ') blur(' + GLASS_FROST + 'px) saturate(' + GLASS_SAT + '%)';
      el.style.backdropFilter = bf;
      el.style.webkitBackdropFilter = bf;
      return id;
    }
    // 参数变了就重装（位移图是按尺寸生成的，必须重算）
    function refreshGlass() {
      applyGlassRefract(toggleEl, 999);
      applyGlassRefract(navPrev, Math.round(NAV_SIZE / 2));
      applyGlassRefract(navNext, Math.round(NAV_SIZE / 2));
    }

    // ---------- 调参变量读写（模块级，供面板与持久化共用）----------
    var TUNE_KEY = 'album3d-tune-v1';
    var TUNE_KEYS = ['HOLD_MS','TYPE_MS','DEL_MS','FLY_MS','FLY_STAGGER','GAP','JITTER','Z_SPREAD',
                     'CARD_H','CAM_DIST','FOCUS_FILL','DIM_MAX','FOCUS_MS','WHEEL_IMPULSE','INERTIA_TAU',
                     'NAV_INSET','NAV_TOP','NAV_SIZE','TOGGLE_BOTTOM','TOGGLE_LEFT', 'GLASS_DEPTH', 'GLASS_FEATHER', 'GLASS_CURVE', 'GLASS_CHROMA', 'GLASS_FROST', 'GLASS_SAT'];
    function getVar(k) {
      return ({ HOLD_MS: HOLD_MS, TYPE_MS: TYPE_MS, DEL_MS: DEL_MS, FLY_MS: FLY_MS,
        FLY_STAGGER: FLY_STAGGER, GAP: GAP, JITTER: JITTER, Z_SPREAD: Z_SPREAD,
        CARD_H: CARD_H, CAM_DIST: CAM_DIST, FOCUS_FILL: FOCUS_FILL, DIM_MAX: DIM_MAX,
        FOCUS_MS: FOCUS_MS, WHEEL_IMPULSE: WHEEL_IMPULSE, INERTIA_TAU: INERTIA_TAU,
        NAV_INSET: NAV_INSET, NAV_TOP: NAV_TOP, NAV_SIZE: NAV_SIZE,
        TOGGLE_BOTTOM: TOGGLE_BOTTOM, TOGGLE_LEFT: TOGGLE_LEFT,
        GLASS_DEPTH: GLASS_DEPTH, GLASS_FEATHER: GLASS_FEATHER, GLASS_CURVE: GLASS_CURVE,
        GLASS_CHROMA: GLASS_CHROMA, GLASS_FROST: GLASS_FROST, GLASS_SAT: GLASS_SAT })[k];
    }
    function setVar(k, v) {
      if (k === 'HOLD_MS') HOLD_MS = v; else if (k === 'TYPE_MS') TYPE_MS = v;
      else if (k === 'DEL_MS') DEL_MS = v; else if (k === 'FLY_MS') FLY_MS = v;
      else if (k === 'FLY_STAGGER') FLY_STAGGER = v; else if (k === 'GAP') GAP = v;
      else if (k === 'JITTER') JITTER = v; else if (k === 'Z_SPREAD') Z_SPREAD = v;
      else if (k === 'CARD_H') CARD_H = v; else if (k === 'CAM_DIST') CAM_DIST = v;
      else if (k === 'FOCUS_FILL') FOCUS_FILL = v; else if (k === 'DIM_MAX') DIM_MAX = v;
      else if (k === 'FOCUS_MS') FOCUS_MS = v; else if (k === 'WHEEL_IMPULSE') WHEEL_IMPULSE = v;
      else if (k === 'INERTIA_TAU') INERTIA_TAU = v; else if (k === 'NAV_INSET') NAV_INSET = v;
      else if (k === 'NAV_TOP') NAV_TOP = v; else if (k === 'NAV_SIZE') NAV_SIZE = v;
      else if (k === 'TOGGLE_BOTTOM') TOGGLE_BOTTOM = v; else if (k === 'TOGGLE_LEFT') TOGGLE_LEFT = v;
      else if (k === 'GLASS_DEPTH') GLASS_DEPTH = v; else if (k === 'GLASS_FEATHER') GLASS_FEATHER = v;
      else if (k === 'GLASS_CURVE') GLASS_CURVE = v; else if (k === 'GLASS_CHROMA') GLASS_CHROMA = v;
      else if (k === 'GLASS_FROST') GLASS_FROST = v; else if (k === 'GLASS_SAT') GLASS_SAT = v;
    }
    function saveTune() {
      try {
        var o = {}; TUNE_KEYS.forEach(function (k) { o[k] = getVar(k); });
        localStorage.setItem(TUNE_KEY, JSON.stringify(o));
      } catch (e) {}
    }
    function loadTune() {
      try {
        var j = JSON.parse(localStorage.getItem(TUNE_KEY) || '{}');
        TUNE_KEYS.forEach(function (k) { if (typeof j[k] === 'number') setVar(k, j[k]); });
      } catch (e) {}
    }
    function clearTune() { try { localStorage.removeItem(TUNE_KEY); } catch (e) {} }

    // ---------- 调参面板（?album=1&tune=1 才出现）----------
    // 把可调参数做成滑块，用户自己拖；拖完把面板底部那行 JSON 发我即可。
    // 这里的量都是模块级 var，所以面板能直接改到正在跑的代码上。
    var tunerEl = null;
    function buildTuner() {
      var rows = [
        ['开屏 停留 ms', 'HOLD_MS', 0, 4000, 50],
        ['开屏 打字 ms', 'TYPE_MS', 20, 200, 5],
        ['开屏 删除 ms', 'DEL_MS', 15, 150, 5],
        ['飞入 单张 ms', 'FLY_MS', 150, 3000, 25],
        ['飞入 错峰 ms', 'FLY_STAGGER', 0, 400, 5],
        ['水平间距 GAP', 'GAP', 1.0, 6.0, 0.05],
        ['上下幅度 JITTER', 'JITTER', 0, 2.0, 0.02],
        ['深度跨度 Z_SPREAD', 'Z_SPREAD', 0.5, 4.0, 0.05],
        ['卡片大小 CARD_H', 'CARD_H', 0.6, 3.0, 0.05],
        ['摄像机距离 CAM_DIST', 'CAM_DIST', 2.0, 8.0, 0.1],
        ['聚焦填充 FOCUS_FILL', 'FOCUS_FILL', 0.30, 1.20, 0.02],
        ['压暗上限 DIM_MAX', 'DIM_MAX', 0, 0.90, 0.01],
        ['聚焦时长 FOCUS_MS', 'FOCUS_MS', 200, 2500, 50],
        ['滚轮冲量 WHEEL_IMPULSE', 'WHEEL_IMPULSE', 0.02, 1.00, 0.01],
        ['惯性时间 INERTIA_TAU', 'INERTIA_TAU', 80, 1500, 20],
      ];
      var posRows = [
        ['左右按钮 边距 px', 'NAV_INSET', 0, 220, 2],
        ['左右按钮 垂直 %', 'NAV_TOP', 10, 90, 1],
        ['左右按钮 直径 px', 'NAV_SIZE', 32, 120, 2],
        ['底部按钮 底距 px', 'TOGGLE_BOTTOM', 0, 200, 2],
        ['底部按钮 左偏 %', 'TOGGLE_LEFT', 0, 100, 1],
      ];
      var panel = document.createElement('div');
      panel.setAttribute('data-album-tuner', '');
      panel.style.cssText =
        'position:fixed;right:14px;top:14px;z-index:60;width:268px;max-height:86vh;overflow:auto;' +
        'padding:12px 14px 14px;border-radius:16px;pointer-events:auto;' +
        'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#e8f0fa;' +
        'background:rgba(10,14,22,.62);backdrop-filter:blur(14px) saturate(150%);' +
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 10px 30px rgba(0,0,0,.45),0 0 0 1px rgba(150,190,255,.18);';
      var head = document.createElement('div');
      head.textContent = '调参面板 (tune=1)';
      head.style.cssText = 'font-weight:600;letter-spacing:.08em;margin-bottom:8px;opacity:.9';
      panel.appendChild(head);

      var state = {};
      function addRow(label, key, min, max, step) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'margin:7px 0';
        var lab = document.createElement('div');
        lab.style.cssText = 'display:flex;justify-content:space-between;opacity:.85';
        var name = document.createElement('span'); name.textContent = label;
        var val = document.createElement('span'); val.textContent = String(getVar(key));
        lab.appendChild(name); lab.appendChild(val);
        var r = document.createElement('input');
        r.type = 'range'; r.min = min; r.max = max; r.step = step;
        r.value = getVar(key);
        r.style.cssText = 'width:100%;margin-top:3px;accent-color:#8fc7ff';
        r.addEventListener('input', function () {
          setVar(key, parseFloat(r.value));
          val.textContent = String(getVar(key));
          dirty = true;
          if (key === 'GAP' || key === 'JITTER' || key === 'Z_SPREAD' ||
              key === 'CARD_H' || key === 'CAM_DIST') layout();
          applyPositions();
          refreshGlass();
          saveTune();          // 存起来，刷新不丢
          out.textContent = dump();
        });
        wrap.appendChild(lab); wrap.appendChild(r);
        panel.appendChild(wrap);
        state[key] = r;
        return r;
      }
      // 按钮位置（也做成滑块）
      var secG = document.createElement('div');
      secG.textContent = '玻璃折射';
      secG.style.cssText = 'margin:12px 0 2px;font-weight:600;opacity:.75';
      panel.appendChild(secG);
      [['折射位移 px(scale)','GLASS_DEPTH',0,120,1],
       ['边缘羽化 feather','GLASS_FEATHER',0.05,0.95,0.01],
       ['曲线 curve','GLASS_CURVE',0.4,5,0.1],
       ['色散 chroma','GLASS_CHROMA',0,10,0.2],
       ['磨砂 blur px','GLASS_FROST',0,24,0.5],
       ['聚光 saturate %','GLASS_SAT',100,300,5]
      ].forEach(function (r) {
        var row = addRow(r[0], r[1], r[2], r[3], r[4]);
        row.addEventListener('input', function () { refreshGlass(); });
      });

      var sec2 = document.createElement('div');
      sec2.textContent = '按钮位置';
      sec2.style.cssText = 'margin:12px 0 2px;font-weight:600;opacity:.75';
      panel.appendChild(sec2);
      posRows.forEach(function (r) { addRow(r[0], r[1], r[2], r[3], r[4]); });

      var sec1 = document.createElement('div');
      sec1.textContent = '动效与排布';
      sec1.style.cssText = 'margin:12px 0 2px;font-weight:600;opacity:.75';
      panel.appendChild(sec1);
      rows.forEach(function (r) { addRow(r[0], r[1], r[2], r[3], r[4]); });

      var out = document.createElement('div');
      out.style.cssText = 'margin-top:10px;padding:7px 8px;border-radius:8px;background:rgba(255,255,255,.07);' +
        'font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-all;user-select:all';
      panel.appendChild(out);
      function dump() {
        var keys = ['HOLD_MS','TYPE_MS','DEL_MS','FLY_MS','FLY_STAGGER','GAP','JITTER','Z_SPREAD',
                    'CARD_H','CAM_DIST','FOCUS_FILL','DIM_MAX','FOCUS_MS','WHEEL_IMPULSE','INERTIA_TAU',
                    'NAV_INSET','NAV_TOP','NAV_SIZE','TOGGLE_BOTTOM','TOGGLE_LEFT', 'GLASS_DEPTH', 'GLASS_FEATHER', 'GLASS_CURVE', 'GLASS_CHROMA', 'GLASS_FROST', 'GLASS_SAT'];
        return keys.map(function (k) { return k + '=' + getVar(k); }).join('  ');
      }
      out.textContent = dump();

      // 重放开屏：不用刷新就能再看一遍（调开屏时序用）
      var replay = document.createElement('button');
      replay.textContent = '重放开屏';
      replay.style.cssText = 'margin-top:8px;margin-right:6px;padding:5px 12px;border-radius:8px;border:0;' +
        'cursor:pointer;background:rgba(140,200,255,.22);color:#e8f0fa;font:inherit';
      replay.addEventListener('click', function () { replayOpening(); });
      panel.appendChild(replay);

      var reset = document.createElement('button');
      reset.textContent = '恢复默认';
      reset.style.cssText = 'margin-top:8px;padding:5px 12px;border-radius:8px;border:0;cursor:pointer;' +
        'background:rgba(255,255,255,.14);color:#e8f0fa;font:inherit';
      reset.addEventListener('click', function () { clearTune(); location.reload(); });
      panel.appendChild(reset);

      host.appendChild(panel);
      tunerEl = panel;
      applyPositions();
    }
    // 按钮位置滑块 -> 实际样式
    function applyPositions() {
      if (navPrev) {
        navPrev.style.left = NAV_INSET + 'px';
        navNext.style.right = NAV_INSET + 'px';
        navPrev.style.top = NAV_TOP + '%';
        navNext.style.top = NAV_TOP + '%';
        navPrev.style.width = NAV_SIZE + 'px';  navPrev.style.height = NAV_SIZE + 'px';
        navNext.style.width = NAV_SIZE + 'px';  navNext.style.height = NAV_SIZE + 'px';
      }
      if (toggleEl) {
        toggleEl.style.bottom = TOGGLE_BOTTOM + 'px';
        toggleEl.style.left = TOGGLE_LEFT + '%';
      }
    }

    // 重放开屏：把开屏状态复位并重建遮罩，照片也回到未飞入状态。
    // 这样调开屏时序时不用反复刷新。
    function replayOpening() {
      if (openState === 'typing' || openState === 'hold') return;
      setFocus(-1);
      ready = false;
      startedAt = 0;
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      for (var i = 0; i < photos.length; i++) { photos[i].mt = 0; }
      buildOpening();
      dirty = true;
    }

    function destroy() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('wheel', onWheel);
      if (host && host.parentNode) host.parentNode.removeChild(host);
    }

    // 测试辅助：第 i 张照片当前在屏幕上的矩形（CSS 像素），供自动化逐张点击
    function rectOfCss(i) {
      var ph = photos[i];
      if (!ph || !ph.ready) return null;
      var mt = (ph.mt === undefined) ? modeT : ph.mt;
      var x = ph.x * (1 - mt) + ph.gx * mt;
      var y = ph.y * (1 - mt) + ph.gy * mt;
      var z = ph.z * (1 - mt) + (ph.gz || 0) * mt;
      var sz = worldSize(ph, mt);
      var pb2 = 1 / (1 + 2 * MATTE_BORDER);
      var r = projRect(x, y, z, sz.hw / pb2, sz.hh / pb2);
      // NDC -> CSS 像素（用 CSS 视口尺寸，不是设备像素）
      var iw = window.innerWidth, ih = window.innerHeight;
      return {
        cx: (r.cx * 0.5 + 0.5) * iw,
        cy: (0.5 - r.cy * 0.5) * ih,
        w: r.hx * 0.5 * iw, h: r.hy * 0.5 * ih,
        onscreen: (Math.abs(r.cx) - r.hx < 1) && (Math.abs(r.cy) - r.hy < 1),
        idx: i, z: z
      };
    }

    return { init: init, destroy: destroy, rectOf: rectOfCss,
             // 临时测试钩子：强制设定 panY（用来验证 uPanY 真的到了 GPU）
             __setPan: function (y) { panY = y; dirty = true; },
             __mtOf: function (i) { var p = photos[i]; return (p && p.mt !== undefined) ? p.mt : modeT; },
             // 飞入进度 t（0=还没进来，1=已到位）
             __flyOf: function (i) { var p = photos[i]; if (!p) return null; return startedAt ? Math.min(1, Math.max(0, (performance.now() - startedAt - p.startAt) / p.dur)) : 0; },
             state: function () {
               return { photos: photos.length, ready: ready, openState: openState,
                        scroll: scroll, target: scrollTarget,
                        min: scrollMin, max: scrollMax, camZ: camZ, focusZ: focusZ,
                        // 聚焦相关的量：用于核对上下定位（panY 是否落到照片的 y 上）
                        panY: panY, focusPan: focusPan, focusScroll: focusScroll,
                        focusIdx: focusIdx, focusT: focusT, focusTo: focusTo,
                        camZoom: camZoom, mode: mode, modeT: modeT,
                        // 聚焦那张当前在屏幕上的实际纵向位置（NDC，0 = 正中，正 = 偏上）
                        focusNdcY: (focusIdx >= 0) ? (function () {
                          var fp = photos[focusIdx];
                          if (!fp) return null;
                          var fmt = (fp.mt === undefined) ? modeT : fp.mt;
                          var fy = fp.y * (1 - fmt) + fp.gy * fmt;
                          var fz = fp.z * (1 - fmt) + (fp.gz || 0) * fmt;
                          var fzc = Math.max(0.12, camZ * camZoom - fz);
                          var fk = (FOCAL * H * 0.5) / fzc;
                          return +(((fy - panY) * fk / (H * 0.5))).toFixed(4);
                        })() : null,
                        loaded: photos.filter(function (p) { return p.ready; }).length };
             } };
  }

  window.WillowXIAlbum = { create: create };
})();

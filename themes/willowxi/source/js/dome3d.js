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
  var FOV = 52.0;   // 收窄视场角：边缘透视更平，与弯度解耦            // 水平视场角（度），固定
  // 🎛️ 朝外看之后，r 越大离墙越近。缩小到底 = 尽量靠近球心，让面前那面墙尽量远
  // （距离 1-r），从而看到更多内壁。0.32 在旧模型里是"最远"，在新模型里其实离墙
  // 只剩 0.68，壁纸被放得很大。
  var R_OUT = 0.08;          // 缩小到底（最远）
  var R_IN = 0.94;           // 放大到底（最近）
  // 🔴 归零：这个装饰性形变正是"折线"的根源 ——
  // 它只在**顶点**上做，而三角形内部是屏幕空间线性插值的，非线性形变于是
  // 让每条网格线在三角形边界折一下（用户截图里的折角）。
  // 相机模型修正之后，真球面投影本身已经够弯，不再需要它。
  var BOW = 0.28;            // 穹顶夸张：水平收腰
  var HOOP = 0.20;           // 穹顶夸张：横线外弓
  var SWEEP_MS = 9000;       // 扫光一轮毫秒（原站 4s，穹顶视野更大故放慢）
  var BAND_FRAC = 0.55;      // 亮带厚度 / 球带张角
  var LAT_STEP = 2.0;        // 网格：纬线间距（度）
  var LON_STEP = 7.0;        // 网格：经线间距（度）
  // 壁纸只铺**一张**：横向绕球一圈、纵向铺满整条球带。
  //
  // 用户："现在壁纸分成上下两块了，我只要一块，只要一排连起来，视野里上下只塞
  // 一张图"。之前横向 3 圈、纵向按比例约 3 圈，于是纵向被切成好几块、露出拼接
  // 边界。现在两个方向都只走一遍。
  var WALL_REPEAT = 1;       // 横向绕球 1 圈
  var WALL_AR = 1280 / 533;  // 壁纸原始宽高比，用来定纵向重复次数
  // 一个横向重复覆盖 360/WALL_REPEAT 度经度；按原图比例，它应当覆盖
  // (360/WALL_REPEAT)/WALL_AR 度纬度。球带高 2*BAND_HALF，于是纵向需要重复：
  var WALL_VREP = 1;         // 纵向只 1 张（原来按比例算出来约 3，才被切成几块）

  // 与站上一致的色值
  var INK = [0.035, 0.043, 0.059];
  // 亚克力色罩，取自站上 --scene-acrylic: rgba(9,11,15,0.64)
  var ACRYLIC = [9 / 255, 11 / 255, 15 / 255, 0.64];
  var GRID_RGB = [196 / 255, 224 / 255, 236 / 255];
  var GRID_A = 0.5;
  var SWEEP_RGB = [214 / 255, 240 / 255, 255 / 255];
  // 🎛️ 只让线发亮之后，光带就只剩细线上的一点亮度，0.45 根本看不见
  // （用户："扫光怎么又没了"）。线很细，所以亮度必须给足。
  var SWEEP_A = 1.15;   // 3.2 会过曝成一整片白
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
    // 🔴 相机朝**外**看，不是朝球心看。
    //
    // 这是一个模型级的错，不是参数问题：原来 fwd = -pos（朝球心），于是可见的是
    // **对侧**球壁，距离恒为 1 + r —— r 越大离可见墙越远、东西越小，缩放方向整个
    // 是反的。用户早先说的"缩放范围有点小""网格太扁"都是它造成的，而我一直在
    // 调参数。
    //
    // 朝外看（fwd = +pos）时，面前那面墙的距离是 1 - r：r 越大离墙越近、东西越大，
    // 这才是"在穹顶里朝内壁推进"。
    var fwd = [pos[0] / L, pos[1] / L, pos[2] / L];
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
    // 球面位置也传下去。经纬度在球面上是弯的，而 varying 在三角形内是线性插值的；
    // 直接插值经纬度会让网格线在三角形边界折成折线（放大时尤其明显）。
    'varying vec3 vPos;',
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
    '  vPos = aPos;',
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
    'uniform vec4 uAcrylic;',
    'varying float vLat;',
    'varying float vLon;',
    'varying vec2 vUV;',
    'varying vec3 vPos;',
    // Distance to the nearest grid line (in degrees), compared against a width expressed
    // in degrees, so the line keeps a constant on-screen width.
    'float lineMask(float v, float st, float px) {',
    '  float d = abs(fract(v / st + 0.5) - 0.5) * st;',
    '  float w = uDegPerPx * px;',
    '  return 1.0 - smoothstep(w * 0.35, w * 1.15, d);',
    '}',
    // 光晕掩码：从线心到 w 平滑衰减（平方），是一圈光而不是一条粗线。
    'float glowMask(float v, float st, float px) {',
    '  float d = abs(fract(v / st + 0.5) - 0.5) * st;',
    '  float w = uDegPerPx * px;',
    '  float k = 1.0 - smoothstep(0.0, w, d);',
    '  return k * k;',
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
    // 由球面位置反算精确经纬度（与 JS 的 sph() 一致：y=sin(lat)、x=sin(lon)cos(lat)、
    // z=cos(lon)cos(lat)）。不直接用 vLat/vLon 是因为它们在三角形内是线性插值的，
    // 会把网格线在三角形边界折成折线。
    '  vec3 nrm = normalize(vPos);',
    '  float lat = degrees(asin(clamp(nrm.y, -1.0, 1.0)));',
    '  float lon = degrees(atan(nrm.x, nrm.z));',
    // 🔴 亚克力模糊在 **CPU 上预热一次**，不在这里做。
    //
    // 之前是着色器里 16 抽头采样。问题有两个：
    //   1) 半径有限，糊不透 —— 壁纸平铺了 7x3 份，糊不透就看出"一堆图叠在一起"的
    //      重影（用户报的正是这个）
    //   2) 每像素 16 次纹理采样，白花钱
    // 现在壁纸在加载时就被画进一张离屏画布并做一次真正的高斯模糊（ctx.filter），
    // 上传的就是那张模糊图。这里只剩 1 次采样。
    '  vec4 w = texture2D(uTex, fract(vUV));',    '  vec3 wall = mix(w.rgb, uAcrylic.rgb, uAcrylic.a);',
    '  col = mix(col, wall, w.a * uWallA);',
    '  float m = max(lineMask(lat, uLatStep, 1.9), lineMask(lon, uLonStep, 1.9));',
    '  col += uGridRGB * m * uGridA;',
    '  float sw = profile((lat - uBandLo) / max(uBandHi - uBandLo, 0.001)) * uSweepOn;',
    // 亮带经过时线也变宽一点，光带才成型（只影响扫光这一项，底网格不变）
    '  float mw = max(lineMask(lat, uLatStep, 1.15 + 1.6 * sw),',
    '                 lineMask(lon, uLonStep, 1.15 + 1.6 * sw));',
    '  col += uSweepRGB * mw * sw * uSweepA;',
    // 🔴 光晕 = 线**周围**一圈溢出的光，不是"线更亮"。
    //
    // 之前只把线本身加亮加粗，用户仍然说"看不见光晕" —— 因为那读起来只是几条
    // 亮线，没有"光"。原站的光晕是 5 层逐级加宽的描边。这里等价的做法：再算一层
    // **宽得多、也淡得多**的线掩码（8px），只乘扫光强度，于是每条线外面都有一圈晕。
    // 光晕必须**从线向外平滑衰减**，否则只是"线变粗"。
    // lineMask 的衰减 smoothstep(w*0.35, w*1.15, d) 很硬，给大了就是一坨均匀粗线。
    // 用单独的 glowMask（平方衰减 + 大半径）才是一圈光。
    '  float haloA = max(glowMask(lat, uLatStep, 44.0), glowMask(lon, uLonStep, 44.0));',
    '  col += uSweepRGB * haloA * sw * uSweepA * 0.16;',
    '  float haloB = max(glowMask(lat, uLatStep, 120.0), glowMask(lon, uLonStep, 120.0));',
    '  col += uSweepRGB * haloB * sw * uSweepA * 0.06;',
    // 只让**网格线**发亮。之前这里还给整个面片加了一点亮度（原站的做法），但在
    // 穹顶上读起来是"网格里也发亮" —— 用户："扫光做错了，连网格里都发亮，我要的
    // 是只有网格线发亮"。去掉这一项。
    '  gl_FragColor = vec4(col, 1.0);',
    '  if (uDebug > 0.5) gl_FragColor = vec4(fract(vUV.x), vUV.y, 0.0, 1.0);',
    '}'
  ].join('\n');

  // ---- 相纸：画在球面上的白纸 + 照片贴图 -------------------------------
  //
  // 用户："照片为什么很诡异的飘在空中，我要的是照片贴在墙上，像是穹顶上自带的一样"。
  // 之前相纸是 DOM，只做横向 rotateY，没有跟随球面纵向曲率，读起来就是贴在墙前的
  // 卡片 + 投影阴影。现在把相纸和照片当球面纹理画（与壁纸同一套投影），它就成为
  // 球面的一部分了。
  //
  // DOM 相纸仍保留但设为透明，只为点击命中服务（省掉自己做拾取）。
  var VS_MATTE = [
    'attribute vec3 aPos;',
    'attribute vec2 aUV;',
    'uniform vec3 uEye, uRight, uUp, uFwd;',
    'uniform float uFocal, uHalfW, uHalfH, uBow, uHoop, uBias;',
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
    '  float zc = max(z, 0.01);',
    '  const float NEAR = 0.02;',
    '  const float FAR = 10.0;',
    '  float ndcZ = (FAR + NEAR) / (FAR - NEAR) - 2.0 * FAR * NEAR / ((FAR - NEAR) * zc);',
    '  gl_Position = vec4((sx2 / uHalfW - 1.0) * zc, (1.0 - sy2 / uHalfH) * zc, ndcZ * zc + uBias, zc);',
    '  vUV = aUV;',
    '}'
  ].join(String.fromCharCode(10));
  var FS_MATTE = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform float uUseTex;',
    'uniform vec3 uPaper;',
    'varying vec2 vUV;',
    'void main() {',
    '  if (uUseTex > 0.5) {',
    '    vec4 c = texture2D(uTex, vUV);',
    '    gl_FragColor = vec4(c.rgb, 1.0);',
    '  } else {',
    '    gl_FragColor = vec4(uPaper, 1.0);',
    '  }',
    '}'
  ].join(String.fromCharCode(10));

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
    var progMatte = null, mLoc = {}, paperBuf = null, paperVerts = 0;
    var photoBuf = null, photoRanges = [];
    var diag = { tickN: 0, wheelN: 0, verts: 0, err: '', draws: 0 };

    // ---- 相纸：贴在内壁上的照片 ----------------------------------------
    var MATTE_ARC = 13.0;        // 一张相纸占的弧长（度）—— 统一弧长
    // 🔴 相纸的宽高比**由照片决定**，不是常数。
    //
    // 用户："相纸是根据照片来的为什么所有相纸都是一个比例"。之前固定 1.30，竖片
    // 被塞进横相纸里、四周一圈大白边。现在相纸 = 照片外形 + 均匀白边：设照片宽为 1
    //   相纸宽 = 1 + 2*BORDER，相纸高 = 1/ratio + 2*BORDER
    var MATTE_BORDER = 0.085;
    function matteAR(ratio) { return (1 + 2 * MATTE_BORDER) / (1 / ratio + 2 * MATTE_BORDER); }
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
          // 高分辨率档：开屏会把相纸怼到全屏，用 640 缩略图会糊，要换大图
          light: img.getAttribute('data-light-src'),
          screen: img.getAttribute('data-screen-src'),
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
      // 快速渐显：图片解码完再显示，避免"先看到空白框再蹦出图"。
      img.style.opacity = '0';
      img.style.transition = 'opacity 160ms linear';
      img.addEventListener('load', function () { img.style.opacity = '1'; });
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
      // 相纸现在就是照片的形状，照片直接铺满内框（不再有"塞进去留边"）。
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
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
        var hpx = wpx / matteAR(q.ratio);
        if (!diag.m1) diag.m1 = { zz: zz, wpx: wpx, focal: focal, mw: matteWorld, pt: pt };
        // 侧倾：相机坐标系里该点的横向角
        var xc = ex * cam.right[0] + ey * cam.right[1] + ez * cam.right[2];
        var tilt = Math.atan2(xc, zz) * 180 / Math.PI;
        if (tilt > 40) tilt = 40; if (tilt < -40) tilt = -40;
        // 不做模糊、不做压暗 —— 用户明确否掉："谁要这个模糊了"。而且那层模糊本身
        // 就是"照片飘在空中"的一部分原因：一张又虚又半透明的卡片，读起来就是浮在
        // 墙前的贴纸，不是墙上自带的东西。纵深改由透视（近大远小）自己承担。
        q.el.style.display = '';
        q.el.style.width = wpx.toFixed(1) + 'px';
        q.el.style.height = hpx.toFixed(1) + 'px';
        // 只有横向侧倾（贴球面内壁时照片本来就是竖着朝向球心的）。不再有 blur/
        // opacity —— 照片一律清晰、不透明。
        q.el.style.transform = 'translate(' + (pt[0] - wpx / 2).toFixed(1) + 'px,' +
          (pt[1] - hpx / 2).toFixed(1) + 'px) perspective(1500px) rotateY(' +
          tilt.toFixed(2) + 'deg)';
        q.el.style.filter = '';
        q.el.style.opacity = '1';
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
      // 🔴 三角形必须足够小。
      //
      // 穹顶夸张只在**顶点**上做，三角形内部是屏幕空间线性插值的，所以每条网格线
      // 都按三角形边界折成折线。三角形越小折线段越短，折角就越不可见 —— 这是
      // 保留弯度同时消掉折线的唯一办法（除非放弃夸张）。
      var v = [], LON = 1, LAT = 1;
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

    // 把每张相纸的白纸四边形与照片四边形按球面经纬度算出来。
    // 相纸宽 = MATTE_ARC 度经度；相纸高按照片宽高比换算成纬度跨度：
    //   世界高 = 世界宽 / matteAR(ratio)，而世界高 = 2*sin(dLat/2) -> 解 dLat
    function pushQuadUV(out, latTop, latBot, lonL, lonR) {
      var P1 = sph(lonL, latTop), P2 = sph(lonR, latTop);
      var P3 = sph(lonR, latBot), P4 = sph(lonL, latBot);
      // 图片行 0 在上 -> v 与纬度反向
      var tri = [[P1, 0, 0], [P2, 1, 0], [P3, 1, 1], [P1, 0, 0], [P3, 1, 1], [P4, 0, 1]];
      for (var t = 0; t < 6; t++) {
        var v = tri[t];
        out.push(v[0][0], v[0][1], v[0][2], v[1], v[2]);
      }
    }

    function buildMatteMesh() {
      var paper = [], photo = [];
      photoRanges = [];
      for (var i = 0; i < photos.length; i++) {
        var q = photos[i];
        var dLon = MATTE_ARC * 0.5;
        var ar = matteAR(q.ratio);
        var dLat = 2 * Math.asin(Math.min(0.999, (matteWorld / ar) / 2)) * 180 / Math.PI * 0.5;
        var lat0 = q.lat + dLat, lat1 = q.lat - dLat;
        var lon0 = q.lon - dLon, lon1 = q.lon + dLon;
        pushQuadUV(paper, lat0, lat1, lon0, lon1);
        var k = 1 / (1 + 2 * MATTE_BORDER);
        var la0 = (lat0 - q.lat) * k + q.lat, la1 = (lat1 - q.lat) * k + q.lat;
        var lo0 = (lon0 - q.lon) * k + q.lon, lo1 = (lon1 - q.lon) * k + q.lon;
        var start = photo.length / 5;
        pushQuadUV(photo, la0, la1, lo0, lo1);
        photoRanges.push({ p: q, start: start, count: photo.length / 5 - start });
      }
      paperBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, paperBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(paper), gl.STATIC_DRAW);
      paperVerts = paper.length / 5;
      photoBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, photoBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(photo), gl.STATIC_DRAW);
      diag.matteVerts = paperVerts + photo.length / 5;
    }

    // 每张照片的贴图。先按 640 缩略图建；聚焦时用全尺寸重建一次。
    var texOf = {};
    function ensureTexture(q, full) {
      var src = full ? (q.light || q.screen || q.src) : q.src;
      var prev = texOf[q.id];
      if (prev && prev.src === src) return prev.tex;
      var t = gl.createTexture();
      var im = new window.Image();
      // 🔴 保留旧贴图作为后备。
      //
      // 聚焦时要把贴图升级到 1600 全尺寸，但大图要加载一会儿。若这期间直接不画，
      // 画面就只剩白相纸（线上实测：聚焦后整屏纯白）。所以旧贴图先留着顶替，
      // 新贴图就绪再换。
      var rec = { tex: t, src: src, ready: false, fallback: prev || null };
      im.onload = function () {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        rec.ready = true;
        // 旧贴图不能立刻删 —— 这一帧可能还在用它顶替。延迟释放。
        if (prev) {
          window.setTimeout(function () {
            try { gl.deleteTexture(prev.tex); } catch (e) {}
          }, 1500);
        }
      };
      im.src = src;
      texOf[q.id] = rec;
      return t;
    }

    function drawMattes(cam, focal) {
      if (!progMatte || !paperBuf) return;
      gl.useProgram(progMatte);
      gl.uniform3fv(mLoc.uEye, cam.pos);
      gl.uniform3fv(mLoc.uRight, cam.right);
      gl.uniform3fv(mLoc.uUp, cam.up);
      gl.uniform3fv(mLoc.uFwd, cam.fwd);
      gl.uniform1f(mLoc.uFocal, focal * ratio);
      gl.uniform1f(mLoc.uHalfW, canvas.width * 0.5);
      gl.uniform1f(mLoc.uHalfH, canvas.height * 0.5);
      gl.uniform1f(mLoc.uBow, BOW);
      gl.uniform1f(mLoc.uHoop, HOOP);
      gl.uniform3f(mLoc.uPaper, 0.957, 0.957, 0.945);
      gl.disable(gl.BLEND);
      // 1) 所有白相纸一批画完
      // 深度偏移：相纸和照片都在同一张球面上，深度逐像素相同。相纸先画、照片后画，
      // 若深度相等则 LEQUAL 有一半像素撞不过 -> 照片画不出来（实测就是"只有白纸"）。
      // 给照片一个明确更大的前移量。
      gl.uniform1f(mLoc.uBias, -0.00002);
      gl.uniform1f(mLoc.uUseTex, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, paperBuf);
      gl.enableVertexAttribArray(mLoc.aPos);
      gl.vertexAttribPointer(mLoc.aPos, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(mLoc.aUV);
      gl.vertexAttribPointer(mLoc.aUV, 2, gl.FLOAT, false, 20, 12);
      gl.drawArrays(gl.TRIANGLES, 0, paperVerts);
      // 2) 照片逐张贴图
      gl.uniform1f(mLoc.uBias, -0.00040);
      gl.uniform1f(mLoc.uUseTex, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, photoBuf);
      gl.enableVertexAttribArray(mLoc.aPos);
      gl.vertexAttribPointer(mLoc.aPos, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(mLoc.aUV);
      gl.vertexAttribPointer(mLoc.aUV, 2, gl.FLOAT, false, 20, 12);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(mLoc.uTex, 0);
      for (var i = 0; i < photoRanges.length; i++) {
        var r = photoRanges[i];
        ensureTexture(r.p, r.p.id === focusId);
        var rec = texOf[r.p.id];
        if (!rec) continue;
        // 新贴图没就绪就先用后备（缩略图）顶替，别让照片整块消失
        var use = rec.ready ? rec
                : (rec.fallback && rec.fallback.ready ? rec.fallback : null);
        if (!use) continue;
        gl.bindTexture(gl.TEXTURE_2D, use.tex);
        gl.drawArrays(gl.TRIANGLES, r.start, r.count);
        diag.matteDraws = (diag.matteDraws || 0) + 1;
      }
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
      // 亚克力色：与站上 --scene-acrylic 同源
      gl.uniform4f(loc.uAcrylic, ACRYLIC[0], ACRYLIC[1], ACRYLIC[2], ACRYLIC[3]);

      // 🔴 亮带要在**相机当前纬度附近**扫，不能在整个球带 -55..+55 上扫。
      // 朝外看之后相机只看到一小块墙（fov 58°、墙距约 0.9），按全域扫时亮带绝大部分
      // 时间在视野之外 —— 用户："还有扫光特效去哪里了"。以相机纬度为中心、上下各
      // SWEEP_SPAN 度来回扫，亮带就始终在画面里。
      var SWEEP_SPAN = 26;
      var half = SWEEP_SPAN * BAND_FRAC * 0.5;
      var c0 = camPhi - SWEEP_SPAN + phase * (2 * SWEEP_SPAN);
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
      // 相纸与照片：同一套投影画在球面上（深度略前移，盖在墙纸之上）
      drawMattes(cam, focal);
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
      tickCamera(now);
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
       'uBandLo', 'uBandHi', 'uGridRGB', 'uSweepRGB', 'uInk', 'uTex', 'uDebug', 'uAcrylic'].forEach(function (n) {
        loc[n] = gl.getUniformLocation(prog, n);
      });
      buildMesh();
      // 相纸用的 program（白纸 + 照片贴图，uUseTex 切换）
      var vsm = compile(gl.VERTEX_SHADER, VS_MATTE);
      var fsm = compile(gl.FRAGMENT_SHADER, FS_MATTE);
      if (vsm && fsm) {
        progMatte = gl.createProgram();
        gl.attachShader(progMatte, vsm);
        gl.attachShader(progMatte, fsm);
        gl.linkProgram(progMatte);
        if (gl.getProgramParameter(progMatte, gl.LINK_STATUS)) {
          var names = ['aPos', 'aUV', 'uEye', 'uRight', 'uUp', 'uFwd', 'uFocal',
                       'uHalfW', 'uHalfH', 'uBow', 'uHoop', 'uBias', 'uTex', 'uUseTex', 'uPaper'];
          for (var mi = 0; mi < names.length; mi++) {
            var nm = names[mi];
            mLoc[nm] = nm.charAt(0) === 'a' ? gl.getAttribLocation(progMatte, nm)
                                            : gl.getUniformLocation(progMatte, nm);
          }
        } else { diag.err = String(gl.getProgramInfoLog(progMatte)).slice(0, 200); }
      } else { diag.err = 'matte shader failed'; }
      layer = document.createElement('div');
      layer.setAttribute('data-dome-photos', '');
      // 必须挂进穹顶容器内部。挂到 body 时它的 z-index 低于 [data-dome] 的 900，
      // 会被穹顶整层盖住 —— 相纸一个都看不见。
      (canvas.parentNode || document.body).appendChild(layer);
      var list = collectPhotos();
      assignSlots(list);
      for (var pi = 0; pi < list.length; pi++) buildMatte(list[pi]);
      photos = list;
      buildMatteMesh();
      for (var ti = 0; ti < photos.length; ti++) ensureTexture(photos[ti], false);
      layer.addEventListener('click', onMatteClick);
      detachers.push(function () { layer.removeEventListener('click', onMatteClick); });
      diag.photos = photos.length;

      wall = new window.Image();
      wall.decoding = 'async';
      wall.onload = function () {
        wallReady = true;
        // 预模糊：画进离屏画布并做一次真正的高斯模糊，再上传这张模糊图。
        // 半径给足（相对一张 640px 宽的缩略图），目的是把平铺的重影彻底糊成色块，
        // 而不是留下一堆可辨认的糊影。
        var bw = 1024;
        var bh = Math.max(1, Math.round(bw * wall.naturalHeight / wall.naturalWidth));
        var off = document.createElement('canvas');
        off.width = bw; off.height = bh;
        var octx = off.getContext('2d');
        octx.filter = 'blur(7px)';
        // 多画一圈，模糊后边缘才不会透
        octx.drawImage(wall, -24, -24, bw + 48, bh + 48);
        octx.filter = 'none';
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, off);
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
      window.addEventListener('keydown', onKey);
      canvas.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      detachers.push(function () { window.removeEventListener('keydown', onKey); });
      detachers.push(function () { canvas.removeEventListener('pointerdown', onPointerDown); });
      detachers.push(function () { window.removeEventListener('pointermove', onPointerMove); });
      detachers.push(function () { window.removeEventListener('pointerup', onPointerUp); });
      detachers.push(function () { window.removeEventListener('pointercancel', onPointerUp); });
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

    // 开场要怼着拍的那张：直接从已经排布好的相纸里随机挑一张（它有经纬度，
    // 相机对着它就行）。不再自己去翻 DOM、拼图片地址。
    function pickOpeningPhotoEntry() {
      // 🔴 只挑**横屏**图。
      //
      // 用户："开屏图不要选竖屏图"。竖片铺满横屏视口会被裁掉上下大半，开场第一眼
      // 就只剩中间一条，很难看。
      var land = [];
      for (var i = 0; i < photos.length; i++) {
        if (photos[i].ratio >= 1.15) land.push(photos[i]);
      }
      var pool = land.length ? land : photos;
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
      // 不塞图片：那张照片就在墙上，靠相机怼近去看（见下面）。只留标题用的覆盖层。
      var veil = document.createElement('div');
      veil.className = 'veil';
      veil.style.background = 'rgba(9, 11, 15, 0.42)';   // 比原来轻，别把照片压死
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
      // 🔴 开场不是"放一张照片盖住屏幕"，而是**镜头一开始就怼着墙上那张照片拍**。
      //
      // 用户把这一点讲透了："开屏不是让照片顺势变成一张图，这种逻辑你做不好，我要的
      // 是它本来就是在墙上的一张照片，只不过开始的时候镜头怼着那张拍"。
      // 于是这里根本不需要往覆盖层里塞图片：那张照片早就在穹顶墙上，只要把相机放到
      // 它面前、给一个很近的缩放，屏幕里自然就只有它。删除动画结束后再把镜头拉远，
      // 穹顶就"展开"了 —— 全程没有任何过渡动画要写。
      var pick = pickOpeningPhotoEntry();
      if (pick) {
        // 开屏这张要立刻显示，不能等 lazy —— 它是开场唯一的画面。
        if (pick.img) {
          pick.img.loading = 'eager';
          // 🔴 换成全尺寸（1600px 灯箱档）。开屏时相纸被怼到铺满视口，
          // 用墙上那张 640 缩略图会糊 —— 用户："开屏的时候加载全尺寸的图片，
          // 不然好糊"。其余照片仍用缩略图（它们在墙上很小，不需要大图）。
          var big = pick.light || pick.screen;
          if (big) { pick.img.style.opacity = '0'; pick.img.src = big; }
        }
        camLon = pick.lon;
        camPhi = pick.lat;
        tLon = camLon; tPhi = camPhi;
        flyFrom = null;
        // 刚好盖满视口，不怼到边角浪费（见 zoomToFill）
        zoom = target = zoomToFill(pick);
      }
      startTypingOpen();
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
      // 🔴 标题删完 = 镜头拉远。因为开场就是"怼着墙上那张拍"，这里只要把缩放拉回
      // 最远（相机位置不动），穹顶就自然展开了 —— 没有任何过渡动画要写。
      // 🔴 不要自己拉开。
      //
      // 用户："镜头开屏拉开不是动画做的，是我滚轮动的"。所以标题删完之后相机就
      // **停在照片前**，只是把缩放解锁；拉远由用户滚轮驱动。
      ready = true;
    }

    // ---- 阶段⑤：探索与聚焦 ---------------------------------------------
    //
    // 相机**位置会动、朝向不动**（Q17=A）：拖动沿环带与竖直方向平移，滚轮沿半径
    // 进出。聚焦就是让相机滑到那张照片的正对面（Q13），移动本身用非线性缓动
    // （Q18=C）—— 因为相机是连续移动的，中间的照片自然会掠过。
    var tLon = 0, tPhi = 0;        // 相机目标经纬度
    var flyFrom = null, flyAt = 0, flyMs = 0;
    var dragging = false, dragX = 0, dragY = 0, dragged = 0;
    var focusId = null;

    function animateCameraTo(lon, phi, ms) {
      // 取最短路径，避免绕远路（经度环绕）
      var d = lon - camLon;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      flyFrom = { lon: camLon, phi: camPhi };
      tLon = camLon + d;
      tPhi = phi;
      flyAt = performance.now();
      flyMs = ms || 900;
    }

    function tickCamera(now) {
      if (dragging || !flyFrom) return;
      var k = flyMs > 0 ? (now - flyAt) / flyMs : 1;
      if (k >= 1) { camLon = tLon; camPhi = tPhi; flyFrom = null; return; }
      // easeInOutCubic：起步慢、中间快、落位慢 —— 即用户要的"非线性移动"
      var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camLon = flyFrom.lon + (tLon - flyFrom.lon) * e;
      camPhi = flyFrom.phi + (tPhi - flyFrom.phi) * e;
    }

    function photoById(id) {
      for (var i = 0; i < photos.length; i++) if (photos[i].id === id) return photos[i];
      return null;
    }

    function focusOn(p, ms) {
      focusId = p.id;
      // 🔴 相机必须落在照片的**对侧**。
      //
      // makeCamera 的朝向是 "从相机位置指向球心"（fwd = -pos），所以坐在 (lon,lat)
      // 方向上时，看到的是**对侧**球壁。要让方向为 P 的那张照片出现在正前方，相机
      // 就得在 -P 处：经度 +180、纬度取反。
      //
      // 之前写成 animateCameraTo(p.lon, p.lat)，相机于是和那张照片同侧、背对着它，
      // "聚焦"之后画面里还是一堆小相纸。
      // 朝外看之后，相机就坐在照片所在的这一侧，正对看它即可。
      animateCameraTo(p.lon, p.lat, ms || 900);
      // 按相纸实际尺寸算"刚好盖满"的缩放（见 zoomToFill）
      target = zoomToFill(p);
      // 🔴 聚焦时换**全尺寸**图。
      //
      // 墙上用的是 640 缩略图（在墙上很小，够用）；聚焦会把照片放到铺满视口，
      // 640 放大到 1440 明显糊 —— 用户："聚焦时没有切换全尺寸图"。
      // 开屏已经做过同样的事，聚焦漏了。
      useFullImage(p, true);
      ensureTexture(p, true);      // WebGL 那层也换成全尺寸贴图
    }

    // 换到 1600 灯箱档 / 换回 640 缩略图。换之前先把 opacity 归 0，
    // 由 load 事件再渐显，避免看到"模糊的旧图 -> 清晰的新图"这一跳。
    function useFullImage(p, full) {
      if (!p || !p.img) return;
      var want = full ? (p.light || p.screen || p.src) : p.src;
      if (!want || p.img.getAttribute('src') === want) return;
      p.img.style.opacity = '0';
      p.img.src = want;
      p.fullLoaded = full;
    }

    // 🎯 让某张相纸**刚好盖满视口**的缩放值。
    //
    // 用户："不要拉的太近浪费了边角……铺满整个屏幕就行"。之前把 target 固定成 0.62 /
    // 0.80，是拍脑袋的常数：竖片会溢出上下、横片会溢出左右，边角白白浪费。
    // 正确做法是按相纸的真实世界尺寸反算距离：
    //   屏幕宽度 = focal * 世界宽 / d   ->   要 >= 视口宽  ->  d <= focal*世界宽/视口宽
    //   高度同理，取两者中更紧的那个（这样才能两个方向都盖住）。
    //   而 d = 1 - r（朝外看时面前那面墙的距离）。
    function zoomToFill(p) {
      // 🔴 用**照片**的尺寸，不是相纸的尺寸。
      //
      // 用户："谁要看相纸白边了？？？"。相纸白边只属于墙上；开屏与聚焦应该是照片
      // 本身铺满视口。用相纸尺寸算的话，白边正好卡在画面里 —— 所以这里按照片算，
      // 白边就被推到视口之外。
      //   相纸宽 = 照片宽 * (1 + 2*BORDER)  ->  照片宽 = matteWorld / (1 + 2*BORDER)
      var photoW = matteWorld / (1 + 2 * MATTE_BORDER);
      var focal = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);
      var dw = focal * photoW / Math.max(1, W);
      var dh = focal * (photoW / p.ratio) / Math.max(1, H);
      // 再乘 0.93：让照片**略微盖过**视口。CSS 的百分比内边距是按相纸自身宽高算
      // 的，和我这里按照片宽算的白边并不严格相等；留一点余量才能保证白边一定在
      // 画面之外，而不是露出几像素。
      var d = Math.min(dw, dh) * 0.93;
      var r = Math.max(0, Math.min(R_IN, 1 - d));
      // 反解 radius() 的几何映射：r = 1 - D_OUT*(D_IN/D_OUT)^zoom
      var z = Math.log(Math.max(0.02, (1 - r) / D_OUT)) / Math.log(D_IN / D_OUT);
      return Math.max(0, Math.min(1, z));
    }

    function leaveFocus() {
      // 换回缩略图：那张大图（1600 档，最大 349KB）在墙上用不到，
      // 留着白占内存。等它缩小到墙上的尺寸之前就换，看不出差别。
      if (focusId) {
        var prev = photoById(focusId);
        if (prev) { useFullImage(prev, false); ensureTexture(prev, false); }
      }
      focusId = null;
      target = 0;
    }

    // 同一排里左右相邻的那张（Q19=C：箭头切相邻）
    function stepFocus(dir) {
      if (!focusId) return;
      var cur = photoById(focusId);
      if (!cur) return;
      var best = null, bestD = 1e9;
      for (var i = 0; i < photos.length; i++) {
        var q = photos[i];
        if (q === cur) continue;
        if (Math.abs(q.lat - cur.lat) > 0.5) continue;   // 只在同一排里找
        var d = q.lon - cur.lon;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        if (dir > 0 ? d <= 0.5 : d >= -0.5) continue;
        if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = q; }
      }
      if (best) focusOn(best, 620);
    }

    /* ---- 指针：拖动移动视角（Q6/Q17：位置会动、朝向不动）------------ */
    // ---- 双指缩放（Q12=A）------------------------------------------------
    //
    // 用 Pointer Events 自己维护活跃指针表并算两指距离，一套代码同时覆盖鼠标拖动
    // 与触摸双指。不用 Touch 事件是为了避免和拖动分成两套；Safari 私有的
    // gesture* 只有 Safari 有，更不该用。
    var pointers = {}, pinchDist = 0, pinchZoom = 0;

    function livePointers() {
      var out = [];
      for (var id in pointers) if (pointers[id]) out.push(pointers[id]);
      return out;
    }
    function dist2(a, b) {
      var dx = a.x - b.x, dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function onPointerDown(e) {
      if (!ready || e.button !== 0) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var lp = livePointers();
      if (lp.length >= 2) {
        // 第二根手指按下 -> 切到双指缩放，并停止平移
        dragging = false;
        pinchDist = dist2(lp[0], lp[1]);
        pinchZoom = target;
        return;
      }
      dragging = true; dragged = 0;
      dragX = e.clientX; dragY = e.clientY;
      flyFrom = null;
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e) {
      if (pointers[e.pointerId]) { pointers[e.pointerId].x = e.clientX; pointers[e.pointerId].y = e.clientY; }
      var lp = livePointers();
      if (lp.length >= 2) {
        var d = dist2(lp[0], lp[1]);
        if (pinchDist > 0) {
          // 张开手指 = 靠近（放大）；捏合 = 拉远
          target = clamp01(pinchZoom + (d / pinchDist - 1) * 1.2);
        }
        return;
      }
      if (!dragging) return;
      var dx = e.clientX - dragX, dy = e.clientY - dragY;
      dragX = e.clientX; dragY = e.clientY;
      dragged += Math.abs(dx) + Math.abs(dy);
      // 转成视角：水平拖动绕竖直轴，竖直拖动改变纬度
      // 方向反过来 —— 要的是"抓住穹顶拉着走"：相机朝外看时 camLon 增加 = 视线向右
      // 转 = 墙上的东西向左跑；要让人觉得是把穹顶往右拉，camLon 就得加。
      // 竖直方向同理，并且把范围收紧（用户："上下移动范围太大了"）。
      // 🎛️ 1:1 拖拽。
      //
      // 实测：原来 0.22°/px 时，向右拖 200px 画面里的内容移动了 1313px —— 高了 6.6
      // 倍。手一动东西就飞出去，主观感受就是"方向和背景反了"。
      // 反推 1:1 的值：44° 换来 1313px，即 29.8px/度 -> 200px 需要 6.7° -> 0.0335°/px。
      // （理论上 focal 1299px 时应为 57.3/1299 = 0.044°/px，实测偏小是因为内容不在
      //  屏幕正中，还叠了 BOW/HOOP 的夸张形变，所以以实测为准。）
      var DRAG_DEG_PER_PX = 0.049;
      camLon += dx * DRAG_DEG_PER_PX;
      // 上下范围收紧：原来 ±32°、灵敏度 0.16，一拖就跑到天顶/天底（用户："上下移动
      // 范围太大了"）。改成 ±12°、灵敏度 0.09 —— 穹顶内容本来也只在球带里。
      camPhi = Math.max(-12, Math.min(12, camPhi - dy * DRAG_DEG_PER_PX));
      tLon = camLon; tPhi = camPhi;
    }
    function onPointerUp(e) {
      if (pointers[e.pointerId]) delete pointers[e.pointerId];
      if (livePointers().length < 2) pinchDist = 0;
      if (!dragging) return;
      dragging = false;
      if (canvas.releasePointerCapture && e.pointerId !== undefined) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      // 🔴 必须复位 dragged。pointerup 之后浏览器才派发 click，而 click 处理器用
      // `dragged > 6` 过滤掉"拖完就跳"的误触 —— dragged 不复位的话，一旦拖过一次，
      // 之后所有点击都会被当成拖动尾巴而丢弃，表现为"点相纸没反应"。
      window.setTimeout(function () { dragged = 0; }, 0);
    }

    // 点相纸 = 直接过去那张（Q19=C）。拖动过程里不触发，避免"拖完就跳"。
    function onMatteClick(e) {
      if (!ready) return;
      if (dragged > 6) return;
      var el = e.target;
      while (el && el !== layer && !el.getAttribute('data-id')) el = el.parentNode;
      if (!el || el === layer) return;
      var id = el.getAttribute('data-id');
      var p2 = photoById(id);
      if (p2) { e.stopPropagation(); focusOn(p2, 900); }
    }

    function onKey(e) {
      if (!ready) return;
      if (e.key === 'Escape') { leaveFocus(); return; }
      if (e.key === 'ArrowRight') { focusId ? stepFocus(1) : (animateCameraTo(camLon + 30, camPhi, 520), null); return; }
      if (e.key === 'ArrowLeft') { focusId ? stepFocus(-1) : (animateCameraTo(camLon - 30, camPhi, 520), null); return; }
      if (e.key === '+' || e.key === '=') { target = Math.min(1, target + 0.12); return; }
      if (e.key === '-' || e.key === '_') { target = Math.max(0, target - 0.12); return; }
      if (e.key === 'Enter') {
        // 聚焦视野中心最近的那张
        var best = null, bestZ = 1e9;
        for (var i = 0; i < photos.length; i++) {
          var q = photos[i];
          if (q.z > 0.06 && q.z < bestZ) { bestZ = q.z; best = q; }
        }
        if (best) focusOn(best, 900);
      }
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
          camLon: Math.round(camLon * 10) / 10, camPhi: Math.round(camPhi * 10) / 10,
          W: W, H: H, ratio: ratio, wallReady: wallReady,
          tickN: diag.tickN, wheelN: diag.wheelN, scrollY: window.scrollY,
          verts: diag.verts, draws: diag.draws, photos: diag.photos || 0,
          m0: diag.m0 || null, m1: diag.m1 || null,
          matteVerts: diag.matteVerts || 0, matteDraws: diag.matteDraws || 0,
          open: openState, ready: ready, focusId: focusId, pointers: livePointers().length, err: diag.err, bow: BOW, hoop: HOOP
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

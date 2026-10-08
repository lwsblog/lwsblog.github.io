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
  // 窄视场角 = "大半径球带"的观感。视场越窄，画面里覆盖的球面弧长越短，
  // 看上去就越像一条半径很大的缓坡，而不是一颗小球的陡壁。
  // 视场角同时决定"立体感"和"坡度"：BOW/HOOP 归零后，唯一的弯度来源就是真实
  // 球面投影，视场越窄看到的弧长越短、越平。40 太平时用户说"看不出来立体透视"，
  // 52 又偏陡，取 50。
  var FOV = 50.0;   // 收窄视场角：边缘透视更平，与弯度解耦            // 水平视场角（度），固定
  // 🎛️ 朝外看之后，r 越大离墙越近。缩小到底 = 尽量靠近球心，让面前那面墙尽量远
  // （距离 1-r），从而看到更多内壁。0.32 在旧模型里是"最远"，在新模型里其实离墙
  // 只剩 0.68，壁纸被放得很大。
  // 惯性：松手后继续漂移（用户："给这个背景加上惯性，往大了加，漂移幅度大一点"）
  var INERTIA_KEEP = 0.988;   // 每帧保留比例，越接近 1 漂得越久
  var INERTIA_MIN = 0.0004;   // 低于此速度就停
  var INERTIA_BOOST = 1.6;    // 松手瞬间把速度放大，做出"甩出去"的幅度
  var R_OUT = 0.08;          // 缩小到底（最远）
  var R_IN = 0.94;           // 放大到底（最近）
  // 🔴 归零：这个装饰性形变正是"折线"的根源 ——
  // 它只在**顶点**上做，而三角形内部是屏幕空间线性插值的，非线性形变于是
  // 让每条网格线在三角形边界折一下（用户截图里的折角）。
  // 相机模型修正之后，真球面投影本身已经够弯，不再需要它。
  // 🔴 归零。这个屏幕空间的夸张是**按顶点**作用的，而相纸四边形和照片四边形顶点不同，
  // 于是两者被不同程度地扭曲 —— 用户看到的"相框和照片不一样""相纸诡异的变形"
  // 全是它造成的。穹顶的弯度改由真实球面投影 + 窄视场角提供（见 FOV）。
  // 🎛️ 主页那套屏幕形变（willowxi.js buildGrid 里就是这两个量）。
  // 管轴朝左右时，平行于轴的直线**几何上就是直的** —— 要它弯只能靠这一层。
  var BOW = 0.17;            // 穹顶夸张：水平收腰
  var HOOP = 0.45;           // 穹顶夸张：横线外弓
  // 实际使用的强度（随缩放收放，见 render）；projectPoint 也用它，保持一致。
  var bowNow = 0, hoopNow = 0;
  var SWEEP_MS = 9000;       // 扫光一轮毫秒（原站 4s，穹顶视野更大故放慢）
  var BAND_FRAC = 0.55;      // 亮带厚度 / 球带张角
  var LAT_STEP = 5.5;        // 网格：纬线间距（度）
  var LON_STEP = 1.9;        // 网格：经线间距（度）
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

  // 🔴 轴沿 X（屏幕左右）的圆柱管。
  //
  // 用户选 B 并补齐了规格：相机只平移 + 缩放，上下靠俯仰角，照片排三排（先写死）。
  // sph(a, b)：a = 沿管轴的位置（世界单位）；b = 绕管的周向角（度，0 = 正对相机的 +z）。
  function sph(a, b) {
    var r = b * Math.PI / 180;
    return [a, Math.sin(r), Math.cos(r)];
  }

  function makeCamera(camLon, camPhi, cr) {
    // 相机位置 = (沿轴平移量, 0, 到管轴距离)。水平**只平移**，不旋转。
    // camPhi 现在是**俯仰角**（用户："上下通过调整摄像机俯仰角看"）。
    var pr = camPhi * Math.PI / 180;
    var pos = [camLon, 0, cr];
    // 🔴 相机朝**外**看，不是朝球心看。
    //
    // 这是一个模型级的错，不是参数问题：原来 fwd = -pos（朝球心），于是可见的是
    // **对侧**球壁，距离恒为 1 + r —— r 越大离可见墙越远、东西越小，缩放方向整个
    // 是反的。用户早先说的"缩放范围有点小""网格太扁"都是它造成的，而我一直在
    // 调参数。
    //
    // 朝外看（fwd = +pos）时，面前那面墙的距离是 1 - r：r 越大离墙越近、东西越大，
    // 这才是"在穹顶里朝内壁推进"。
    var fwd = [0, Math.sin(pr), Math.cos(pr)];
    // 管轴就是 X；屏幕右方向恒为 -X（维持原来的手性约定，照片才不镜像）
    var right = [-1, 0, 0];
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
    var waist = 1 - bowNow * Math.max(0, 1 - ty * ty);
    var sx2 = W * 0.5 + (sx - W * 0.5) * waist;
    var tx = (sx - W * 0.5) / (W * 0.5);
    var sy2 = sy + hoopNow * tx * tx * (sy - H * 0.5);
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
    'uniform float uYToDeg;',
    // Distance to the nearest grid line (in degrees), compared against a width expressed
    // in degrees, so the line keeps a constant on-screen width.
    'float lineMask(float v, float st, float px) {',
    '  float d = abs(fract(v / st + 0.5) - 0.5) * st;',
    '  float w = uDegPerPx * px;',
    '  return 1.0 - smoothstep(w * 0.30, w * 1.60, d);',
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
    // 圆柱管：周向角从 yz 方位角读；沿轴位置直接读 x（乘 uYToDeg 换成栅格单位）
    '  float lat = degrees(atan(vPos.y, vPos.z));',
    '  float lon = vPos.x * uYToDeg;',
    // 🔴 亚克力模糊在 **CPU 上预热一次**，不在这里做。
    //
    // 之前是着色器里 16 抽头采样。问题有两个：
    //   1) 半径有限，糊不透 —— 壁纸平铺了 7x3 份，糊不透就看出"一堆图叠在一起"的
    //      重影（用户报的正是这个）
    //   2) 每像素 16 次纹理采样，白花钱
    // 现在壁纸在加载时就被画进一张离屏画布并做一次真正的高斯模糊（ctx.filter），
    // 上传的就是那张模糊图。这里只剩 1 次采样。
    // 🔴 接缝淡化。
    //
    // 壁纸横向只绕球一圈（WALL_REPEAT = 1），u 从 0 绕回 1 的地方左边缘直接接右
    // 边缘，是一条硬缝。这里在接缝附近把它和"平移半圈"的版本交叉淡化，缝就散了。
    // 因为图片本来就重度模糊，融合后看不出重复。
    '  vec2 uvw = fract(vUV);',
    '  vec4 w = texture2D(uTex, uvw);',
    '  vec4 w2 = texture2D(uTex, fract(vUV + vec2(0.5, 0.0)));',
    '  float seam = min(uvw.x, 1.0 - uvw.x);',
    '  float seamK = smoothstep(0.0, 0.055, seam);',
    '  w = mix((w + w2) * 0.5, w, seamK);',    '  vec3 wall = mix(w.rgb, uAcrylic.rgb, uAcrylic.a);',
    '  col = mix(col, wall, w.a * uWallA);',
    // 线太细时在部分角度会细到亚像素、断成一段一段，看起来就是折线；加粗并放宽过渡。
    '  float m = max(lineMask(lat, uLatStep, 3.2), lineMask(lon, uLonStep, 3.2));',
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
  // ===== 后处理：把场景先渲染到 FBO，再用放射模糊着色器画到一个全屏四边形 =====
  //
  // 为什么必须这样：放射模糊要的是"沿半径方向拖条纹"，那是**对已合成好的整幅画面**
  // 做的后处理。在物体着色器里做，等于每张照片各算一遍，边界与相纸必然对不上；
  // 而且各向同性高斯没有方向感，做不出拉伸。
  var VS_QUAD = [
    'attribute vec2 aXY;',
    'varying vec2 vUV;',
    'void main() {',
    '  vUV = aXY * 0.5 + 0.5;',
    '  gl_Position = vec4(aXY, 0.0, 1.0);',
    '}'
  ].join('\n');

  // 把主题的背景当纹理画进我的场景：壁纸 img + 它那个网格 canvas。
  // 这样背景和照片一起进 FBO，后处理的放射模糊就能罩住**全部可见元素**。
  // 背景仍然是 willowxi.js 画的（我只是用它的输出当纹理），没有换掉那份实现。
  var FS_BG = [
    'precision highp float;',
    'uniform sampler2D uTex;',
    'uniform float uAlpha;',
    'uniform vec2 uUVK;',     // UV 缩放（cover 适配 / 仿射）
    'uniform vec2 uUVO;',
    'uniform vec4 uTint;',    // 纯色填充（亚克力层）
    'uniform float uSolid;',  // >0.5 时铺纯色
    'varying vec2 vUV;',
    'void main() {',
    '  if (uSolid > 0.5) { gl_FragColor = vec4(uTint.rgb, uTint.a * uAlpha); return; }',
    '  vec2 uv = (vUV - 0.5) * uUVK + 0.5 + uUVO;',
    '  vec4 c = texture2D(uTex, uv);',
    '  gl_FragColor = vec4(c.rgb, c.a * uAlpha);',
    '}'
  ].join('\n');

  var FS_POST = [
    'precision highp float;',
    'uniform sampler2D uSrc;',
    'uniform float uSmearPx;',   // 最外圈沿半径拖出多少像素
    'uniform float uT0;',
    'uniform float uT1;',
    'uniform float uAmt;',       // 全局强度（聚焦/开屏为 0）
    'uniform float uHalfW, uHalfH;',
    'varying vec2 vUV;',
    'void main() {',
    '  vec2 dv = gl_FragCoord.xy - vec2(uHalfW, uHalfH);',
    '  float dr = length(dv / vec2(uHalfW, uHalfH)) / 1.41421356;',
    '  float bt = smoothstep(uT0, uT1, dr) * uAmt;',
    // 采样步长：方向 = dv 的单位向量；长度 = bt*像素数，再换算成 UV
    '  vec2 stp = normalize(dv + vec2(1e-5, 1e-5))',
    '           * (bt * uSmearPx) / vec2(uHalfW * 2.0, uHalfH * 2.0);',
    '  vec4 c = texture2D(uSrc, vUV) * 0.20;',
    '  c += texture2D(uSrc, vUV + stp * 0.25) * 0.16;',
    '  c += texture2D(uSrc, vUV + stp * 0.45) * 0.14;',
    '  c += texture2D(uSrc, vUV + stp * 0.65) * 0.12;',
    '  c += texture2D(uSrc, vUV + stp * 0.85) * 0.11;',
    '  c += texture2D(uSrc, vUV + stp * 1.00) * 0.10;',
    '  c += texture2D(uSrc, vUV - stp * 0.35) * 0.09;',
    '  c += texture2D(uSrc, vUV - stp * 0.70) * 0.08;',
    '  gl_FragColor = c;',
    '}'
  ].join('\n');

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
    'precision highp float;',
    'uniform sampler2D uTexB;',   // CPU 预模糊版（unit 1）
    'uniform sampler2D uTex;',
    'uniform float uUseTex;',
    // 从屏幕中心向外发散的模糊：模糊量按像素到中心的距离给，
    // 所以是**叠在整个照片层上的一层效果**，而不是每张一个固定值。
    // 同一张照片里，靠中心的部分清楚、朝外的部分越来越糊。
    'uniform float uBlurAmt;',   // 全局强度门：聚焦/开屏时为 0（那时一点都不糊）
    'uniform float uEdgeFeather;',
    'uniform float uBlurT0;',    // 从多远开始糊（0=中心, 1=角）
    'uniform float uBlurT1;',

    'uniform vec3 uPaper;',
    // 放射状模糊要按设备像素算"离屏幕中心多远"
    'uniform float uHalfW, uHalfH;',
    'varying vec2 vUV;',
    'void main() {',
    // blur = f(该像素离屏幕中心的距离)，是叠在整层上的效果
    '  float _dx = (gl_FragCoord.x - uHalfW) / uHalfW;',
    '  float _dy = (gl_FragCoord.y - uHalfH) / uHalfH;',
    '  float _dr = sqrt(_dx * _dx + _dy * _dy) / 1.41421356;',
    '  float bt = smoothstep(uBlurT0, uBlurT1, _dr) * uBlurAmt;',
    '  if (uUseTex > 0.5) {',
    // 在清晰版与预模糊版之间插值（预模糊版是 CPU 上一次真正的高斯）。
    // 之前用 9 抽头在 UV 上拉开采样：抽头太少、间隔太大 -> 几张叠着的重影。
    '    vec4 c = mix(texture2D(uTex, vUV), texture2D(uTexB, vUV), bt);',
    '    gl_FragColor = vec4(c.rgb, 1.0);',
    '  } else {',
    // 相纸：实色 + 边缘羽化，羽化量跟同一个 bt。
    // 否则会出现"照片糊了、白框还锐利"的诡异对比。
    '    float e = min(min(vUV.x, 1.0 - vUV.x), min(vUV.y, 1.0 - vUV.y));',
    '    float a = smoothstep(0.0, max(0.0008, bt * uEdgeFeather), e);',
    '    gl_FragColor = vec4(uPaper, a);',
    '  }',
    '}',  ].join(String.fromCharCode(10));

  function createDome(root) {
    var canvas = root.querySelector('[data-dome-canvas]');
    if (!canvas) return null;
    // alpha: true —— 画布透明，露出主题自己的 [data-scene-background]（同一份 willowxi.js 画的），
// 这样相册页的背景与主页**由构造保证一模一样**，不需要我去仿。
    var gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false }) ||
             canvas.getContext('experimental-webgl');
    if (!gl) return null;

    var W = 0, H = 0, ratio = 1;
    var camLon = 0, camPhi = 0, zoom = 0, target = 0, phase = 0;
    var frameRequest = 0, lastAt = 0, wheelAccum = 0;
    var wall = null, wallReady = false, tex = null;
    var detachers = [];
    var prog = null, loc = {}, buf = null, nVerts = 0;
    var progMatte = null, mLoc = {}, paperBuf = null, paperVerts = 0;
    // 后处理：FBO（彩色纹理 + 深度 renderbuffer）与全屏四边形
    var progPost = null, pLoc = {}, quadBuf = null;
    var progBg = null, bLoc = {};
    var bgWallTex = null, bgGridTex = null;
    var bgWallEl = null, bgGridEl = null;
    var fb = null, fbTex = null, fbDepth = null, fbW = 0, fbH = 0;
    var SMEAR_PX = 130.0;     // 最外圈沿半径拖出的长度（屏幕像素）—— 要一眼看得出条纹
    var photoBuf = null, photoRanges = [];
    // 开屏那张照片的 id。它也要用全尺寸贴图，但那时还不是 focusId —— 之前只换了
    // DOM 那张 img，WebGL 贴图仍是缩略图，所以开屏是糊的。
    var openingId = null;
    var vLon = 0, vPhi = 0, gliding = false;
    // 背景驱动：把相机状态映射成"鼠标位置"派发给主题场景。
    // 主题的视差本来由 window 的 pointermove 驱动（pointer.tx/ty -> 缓动）。
    // 我们不改它的代码，只喂事件 —— 背景仍由**同一份 willowxi.js** 绘制与驱动。
    var bgSynth = false, bgLastT = 0, bgLastX = 1e9, bgLastY = 1e9;
    // 直接给背景容器一个位移。
    // 只派发 pointermove 是不够的：主题的动画循环被
    //   if (animating && visible && !document.hidden && !prefersReducedMotion())
    // 挡住 —— 系统开了"减少动态效果"时它的视差根本不跑，pointer.tx 更新了也没人绘制。
    // 所以这里自己动，保证任何环境下都看得见。
    var bgWrap = null;
    var BG_KX = 1150;    // 背景横向：px / 世界单位（照片在墙深约 16250，远层取约 7%）
    var BG_KY = 9;       // 背景纵向：px / 度
    var BG_CX = 78, BG_CY = 58;   // 位移上限（配合放大，不露边）
    var BG_SCALE = 1.16;
    // 照片占用的经度范围（assignSlots 里填），相机据此钳位
    var lonMin = 0, lonMax = 0;
    // 把经度钳在照片区域内、两边各留 LON_PAD 度余量。
    //
    // 用户："惯性滑动过程中有概率定位不到"。复现发现未命中的点击全部落在
    // lon 157~233，而照片只占 0~140（LON_SPAN = 150）—— 惯性把相机甩进了那 210 度的
    // 空墙，那里没有任何可点的东西。钳位之后就不会再漂到空区。
    // 余量要小：34 度时相机会被钉在最后一张照片外侧、视野里什么都没有。
    // 6 度以内可以保证"贴边时仍看得到照片"。
    // 现在是**世界单位**（圆柱模型）：照片只占 ±LON_SPAN/2 = ±2.5，
    // 给 6 的话相机会滑到 ±8.5，那里没有任何照片。
    var LON_PAD = 0.6;
    // 🔴 相机在**管轴上**（y=0），照片在壁上周向角 th 处。要正对它，俯仰角不是 th，
    // 而是 atan2(sin th, cos th - r)。例：th=-8.5 度、r=0.866 时需要 -50 度 ——
    // 之前直接拿 th 当俯仰角，照片全被推出视野，点击也就全丢。
    // 俯仰的允许范围随缩放收放：
    //   拉到最远（zoom 0）-> 限制 0，也就是**强制回中**，三排都在画面里；
    //   拉近（zoom >= 0.45）-> 放开到 ±75 度，可以抬头低头看某一排。
    // 不做"动画式回中"，否则会和手动俯仰打架；这样拖到最远时俯仰自然停在中位。
    function pitchLimit() { return 75 * Math.min(1, zoom / 0.45); }
    function clampPitch() {
      var lim = pitchLimit();
      if (camPhi > lim) camPhi = lim;
      if (camPhi < -lim) camPhi = -lim;
      tPhi = camPhi;
    }

    function pitchFor(thDeg, r) {
      var t = thDeg * Math.PI / 180;
      return Math.atan2(Math.sin(t), Math.cos(t) - r) * 180 / Math.PI;
    }

    function clampLon(v) {
      if (lonMax <= lonMin) return v;
      var lo = lonMin - LON_PAD, hi = lonMax + LON_PAD;
      if (v < lo) return lo;
      if (v > hi) return hi;
      return v;
    }
    var diag = { tickN: 0, wheelN: 0, verts: 0, err: '', draws: 0 };

    // ---- 相纸：贴在内壁上的照片 ----------------------------------------
    // 相纸的角宽。窄视场下它决定"一屏里墙面占多少" —— 相纸越小，看到的球面越多，
  // 穹顶就越显得大。13 在 FOV 52 下合适，FOV 收到 40 后要相应改小。
  var MATTE_ARC = 9.0;
  // 照片占用的经度跨度。原来每行铺满 360°（8 张 -> 间隔 45°），而视场角只有 40°，
  // 于是一屏只看到 1 张、其余全是空墙，"穹顶"读起来反而小。
  // 收窄到 150°（8 张 -> 间隔约 18.8°）后，窄视场下一屏能看到 2-3 张，既有"长焦看
  // 一段缓坡"的观感，又不至于空。
  var LON_SPAN = 5.0;      // 三排照片沿管轴占用的世界长度
  // 相邻两排的周向角间距。17 度时三排的屏幕 y 跨度约 1138px，超过 900 的视口，
  // 第三排被挤出画面；11 度时约 660px，三排都在画面内。
  // 边缘失焦：按"照片方向与视轴的夹角"给模糊与淡出。
  // 夹角小于 A0 全清，超过 A1 时到达最大模糊/最大淡出。
  var BLUR_T0 = 0.52;     // 到屏幕中心的归一距离，从这里开始糊（0=中心, 1=角）
  var BLUR_T1 = 1.00;     // 到这里到达最大模糊
  // 0.10（相纸宽度的 10%）太大了：相机靠近时相纸占满屏幕，那圈羽化就是一大团白雾，
  // 还会糊掉照片边缘。羽化要小到读起来是边缘失焦，而不是白雾。
  // 相纸边也要跟着一起虚化（用户要求：相纸也要模糊）。
  // 0.10 曾在近距离变成一团白雾；现在 _blurOn 随缩放收放、近处为 0，
  // 所以这个值只在远看（相纸在屏幕上很小）时生效，0.045 是安全的。
  var EDGE_FEATHER = 0.004;   // 仅保留极小的抗锯齿边；虚化交给全局层
  var ROW_ANG = 9.0;
  // 随机排布的抖动幅度
  var ROW_OFF_K = 0.55;   // 整排沿轴错开
  var COL_JIT_K = 0.50;   // 单张在槽位内左右抖
  var ANG_JIT_K = 0.60;   // 周向角抖动
  var XHALF = 6.0;         // 管子沿轴半长（世界单位）。150 环 x 220 段 = 198000 顶点。
  // 🔴 网格必须**足够密**。
  //
  // BOW/HOOP 是屏幕空间的非线性形变，**按顶点**作用、三角形内线性插值。管子网格太粗时，
  // 一条本该平滑弯曲的网格线会被折成折线（用户："为什么你还做出折线了"）。
  // 轴方向 0.25 -> 0.08（12 单位 -> 150 环），周向 1 -> 0.5 度（220 段）。
  var XPITCH = 0.08;       // 管壁沿轴的网格步长        // 一张相纸占的弧长（度）—— 统一弧长
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
      // 用户："照片不要只排一排，排三排，而且这个不定死，后期改成随机排"。
      // 先写死三排；以后改随机排只动这一段。
      var rows = 3;
      // 用户要求**先写死三排**（后期改成随机排）。
      // 原来这段自适应搜索会把 22 张算成 2 排（per=11 落在区间内），所以这里不再搜索。
      // 记录照片占用的经度范围，供相机钳位用（见 clampLon）
      lonMin = 1e9; lonMax = -1e9;
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
      // 🎲 随机排布。
      //
      // 用户："这个不定死，后期改成随机排"。
      // 仍按三排分组（保留疏密手感），但：
      //   * 每排整体沿轴错开，避免上下对齐成格子
      //   * 每张在自己的槽位内左右抖动
      //   * 每张的周向角在排基线附近抖动
      // 带种子的伪随机：一次加载内位置稳定（不会每帧乱跳），刷新才换一种。
      var seed = (Date.now() ^ (Math.random() * 1e9)) | 0;
      function rnd() {
        seed = (seed * 1664525 + 1013904223) | 0;
        return ((seed >>> 0) / 4294967296);
      }
      var k = 0;
      for (var ri2 = 0; ri2 < rows; ri2++) {
        var cnt = counts[ri2];
        var slot = LON_SPAN / Math.max(1, cnt);
        var baseAng = (ri2 - (rows - 1) / 2) * ROW_ANG;
        var rowOff = (rnd() - 0.5) * slot * ROW_OFF_K;
        for (var j = 0; j < cnt; j++) {
          var x = -LON_SPAN / 2 + slot * (j + 0.5) + rowOff
                  + (rnd() - 0.5) * slot * COL_JIT_K;
          var ang = baseAng + (rnd() - 0.5) * ROW_ANG * ANG_JIT_K;
          list[k].lon = x;
          list[k].lat = ang;
          if (x < lonMin) lonMin = x;
          if (x > lonMax) lonMax = x;
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
      // 沿轴按**世界长度**循环（原来写的是 -180..180 的角度，会把管子建成 360 单位长）
      var v = [], LON = XPITCH, LAT = 0.4;
      // 周向覆盖必须够：俯仰允许到 75 度，加视野半角约 21 度 -> 会看到约 96 度，
      // 而原来只铺 ±BAND_HALF（±55 度），越过去就是空洞。铺到 ±100 度。
      for (var la = -100; la < 100; la += LAT) {
        for (var lo = -XHALF; lo < XHALF; lo += LON) {
          var quad = [[lo, la], [lo + LON, la], [lo + LON, la + LAT], [lo, la + LAT]];
          var tri = [0, 1, 2, 0, 2, 3];
          for (var t = 0; t < 6; t++) {
            var q = quad[tri[t]], P = sph(q[0], q[1]);
            v.push(P[0], P[1], P[2], q[1], q[0],
              ((q[0] + XHALF) / (2 * XHALF)) * WALL_REPEAT,
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
    function pushQuadUV(out, latTop, latBot, lonL, lonR, rmul) {
      rmul = rmul || 1;
      // 🔴 必须细分。
      //
      // BOW/HOOP 是**屏幕空间**的非线性形变，按顶点作用、三角形内线性插值。粗分成两个
      // 三角形时，一条本该平滑弯曲的边会被折成直线，相邻四边形之间对不上 ——
      // 表现就是相纸白框被撕出缺口（管状透视一开就非常明显）。
      // 细分到 SUB x SUB 后逐段逼近一致，边框就完整了。
      var SUB = 12;   // 6 时白框边缘还会"浪"，12 平滑
      for (var ia = 0; ia < SUB; ia++) {
        for (var ib = 0; ib < SUB; ib++) {
          var v0 = ia / SUB, v1 = (ia + 1) / SUB;
          var u0 = ib / SUB, u1 = (ib + 1) / SUB;
          var la0 = latTop + (latBot - latTop) * v0, la1 = latTop + (latBot - latTop) * v1;
          var lo0 = lonL + (lonR - lonL) * u0, lo1 = lonL + (lonR - lonL) * u1;
          var P1 = sph(lo0, la0), P2 = sph(lo1, la0);
          var P3 = sph(lo1, la1), P4 = sph(lo0, la1);
          var tri = [[P1, u0, v0], [P2, u1, v0], [P3, u1, v1],
                     [P1, u0, v0], [P3, u1, v1], [P4, u0, v1]];
          for (var t = 0; t < 6; t++) {
            var q = tri[t];
            out.push(q[0][0] * rmul, q[0][1] * rmul, q[0][2] * rmul, q[1], q[2]);
          }
        }
      }
    }

    function buildMatteMesh() {
      var paper = [], photo = [];
      photoRanges = [];
      for (var i = 0; i < photos.length; i++) {
        var q = photos[i];
        var dLon = matteWorld * 0.5;   // 沿管轴：世界长度，线性
        var ar = matteAR(q.ratio);
        // 沿周向：世界高 -> 角跨度（弦长 = 2*sin(Δ/2)）
        var dLat = 2 * Math.asin(Math.min(0.999, (matteWorld / ar) / 2)) * 180 / Math.PI * 0.5;
        var lat0 = q.lat + dLat, lat1 = q.lat - dLat;
        var lon0 = q.lon - dLon, lon1 = q.lon + dLon;
        pushQuadUV(paper, lat0, lat1, lon0, lon1);
        // 🔴 白边必须按**世界长度**均匀内缩，不能让照片继承相纸的宽高比。
        //
        // 用户："你自己看你做出来把我的照片拉成什么了"。
        // 原来的写法是把相纸的经纬度偏移**乘同一个系数 k**，于是照片四边形和相纸
        // 宽高比完全相同 —— 照片被拉伸到相纸的形状：
        //   ratio 1.5 的横片：相纸 ar = 1.398，照片被画成 1.398 -> 横向拉伸 7%
        //   ratio 0.67 的竖片：相纸 ar = 0.700，照片被画成 0.700 -> 横向拉伸 5%
        // 正确做法：照片的世界宽 = 相纸宽/(1+2b)，世界高 = 照片宽/ratio，
        // 再把这两个世界长度各自换算回经纬度跨度。
        var sW = matteWorld / (1 + 2 * MATTE_BORDER);   // 照片的世界宽
        var sH = sW / q.ratio;                          // 照片的世界高（保持原比例）
        // 🔴 轴方向是**世界长度**，半宽就是 sW/2。
        // 之前这里还留着"角度->弦长"的 asin 公式，算出 4.5 个单位，
        // 于是每张照片被撑成近 9 单位宽、几乎铺满整根管子（满屏横向条纹）。
        var dLonP = sW / 2;
        var dLatP = 2 * Math.asin(Math.min(0.999, sH / 2)) * 180 / Math.PI * 0.5;
        var la0 = q.lat + dLatP, la1 = q.lat - dLatP;
        var lo0 = q.lon - dLonP, lo1 = q.lon + dLonP;
        var start = photo.length / 5;
        // 照片在几何上朝**相机**方向凸出 0.4%（相机在管内，半径更小 = 更近）：
        // 不必再靠 depthFunc(ALWAYS)（那样重叠的两张会按绘制顺序互相覆盖、切出缺口）。
        pushQuadUV(photo, la0, la1, lo0, lo1, 0.996);
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
      var rec = { tex: t, src: src, ready: false, fallback: prev || null,
                  blurTex: null };
      im.onload = function () {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        rec.ready = true;
        // 预模糊版：CPU 上一次 ctx.filter 高斯（与壁纸同一套做法）
        try {
          var bw = Math.max(48, Math.min(512, Math.round(im.naturalWidth / 3)));
          var bh = Math.max(48, Math.round(bw * im.naturalHeight / im.naturalWidth));
          var off = document.createElement('canvas');
          off.width = bw; off.height = bh;
          var octx = off.getContext('2d');
          octx.filter = 'blur(' + Math.max(4, Math.round(bw * 0.10)) + 'px)';
          octx.drawImage(im, -bw * 0.08, -bh * 0.08, bw * 1.16, bh * 1.16);
          octx.filter = 'none';
          var bt2 = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, bt2);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, off);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          rec.blurTex = bt2;
        } catch (e) { }
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

    // 把一张 DOM 图/canvas 上传为纹理（每帧调一次；内容没变时浏览器开销很小）
    function uploadTex(tex, el) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    function drawBgQuad(tex, alpha, kx, ky, ox, oy, tint, solid) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(bLoc.uTex, 0);
      gl.uniform1f(bLoc.uAlpha, alpha);
      gl.uniform2f(bLoc.uUVK, kx, ky);
      gl.uniform2f(bLoc.uUVO, ox, oy);
      gl.uniform4f(bLoc.uTint, tint ? tint[0] : 0, tint ? tint[1] : 0,
                   tint ? tint[2] : 0, tint ? tint[3] : 1);
      gl.uniform1f(bLoc.uSolid, solid ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 主题背景 = 壁纸 img 铺底 + 网格 canvas 叠加
    function drawThemeBackground() {
      if (!bgWallEl) bgWallEl = document.querySelector('[data-scene-wallpaper]');
      if (!bgGridEl) bgGridEl = document.querySelector('[data-scene-canvas]');
      gl.useProgram(progBg);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      if (bgWallEl && bgWallEl.naturalWidth) {
        uploadTex(bgWallTex, bgWallEl);
        // cover 适配：让壁纸铺满视口（与 CSS object-fit: cover 等价）
        var iw = bgWallEl.naturalWidth, ih = bgWallEl.naturalHeight;
        var vw = canvas.width, vh = canvas.height;
        var sc = Math.max(vw / iw, vh / ih);
        drawBgQuad(bgWallTex, 1.0, (iw * sc) / vw, (ih * sc) / vh, 0, 0);
      }
      // 🔴 亚克力（磨砂色罩）层。主题里壁纸上面盖着 --scene-acrylic
      // （亮色 rgba(244,245,242,.76) / 暗色 rgba(9,11,15,.64)），
      // 所以壁纸只贡献约 24%~36%。漏了这层壁纸就会**全额显示**、观感大变
      // （第一版就是这样，背景从"隐约的磨砂"变成了"一张大壁纸"）。
      if (bgWallEl && bgWallEl.naturalWidth) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        drawBgQuad(bgWallTex, 1.0, 1.0, 1.0, 0, 0,
                   [ACRYLIC[0], ACRYLIC[1], ACRYLIC[2], ACRYLIC[3]], true);
        gl.disable(gl.BLEND);
      }
      if (bgGridEl && bgGridEl.width) {
        uploadTex(bgGridTex, bgGridEl);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        drawBgQuad(bgGridTex, 1.0, 1.0, 1.0, 0, 0);
        gl.disable(gl.BLEND);
      }
      gl.enable(gl.DEPTH_TEST);
    }

    // 后处理用的离屏目标（FBO）。尺寸跟画布一致。
    function ensureFBO(w, h) {
      if (fb && fbW === w && fbH === h) return;
      if (!fb) {
        fb = gl.createFramebuffer();
        fbTex = gl.createTexture();
        fbDepth = gl.createRenderbuffer();
      }
      gl.bindTexture(gl.TEXTURE_2D, fbTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindRenderbuffer(gl.RENDERBUFFER, fbDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                              gl.TEXTURE_2D, fbTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
                                 gl.RENDERBUFFER, fbDepth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fbW = w; fbH = h;
    }

    // 全屏四边形 + 放射模糊：把 FBO 里的画面沿半径方向拖出条纹
    function drawPost(amt) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(progPost);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbTex);
      gl.uniform1i(pLoc.uSrc, 0);
      gl.uniform1f(pLoc.uSmearPx, SMEAR_PX);
      gl.uniform1f(pLoc.uT0, BLUR_T0);
      gl.uniform1f(pLoc.uT1, BLUR_T1);
      gl.uniform1f(pLoc.uAmt, amt);
      gl.uniform1f(pLoc.uHalfW, canvas.width * 0.5);
      gl.uniform1f(pLoc.uHalfH, canvas.height * 0.5);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
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
      gl.uniform1f(mLoc.uBow, bowNow);
      gl.uniform1f(mLoc.uHoop, hoopNow);
      gl.uniform3f(mLoc.uPaper, 0.957, 0.957, 0.945);
      // 逐张画（白纸 + 照片各一次），这样每张才能有自己的**边缘失焦**与淡出。
      // paperBuf / photoBuf 都是"每张一个四边形、顺序相同"，所以两者范围一致。
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(mLoc.uTex, 0);
      gl.uniform1i(mLoc.uTexB, 1);
      // 模糊已改为**全局一层**（见 CSS 的 [data-dome-blur]：backdrop-filter + 径向 mask），
      // 它作用于身后的一切（背景与照片都在内）。所以照片这一层不再自己算模糊。
      var _blurOn = 0;
      gl.uniform1f(mLoc.uBlurAmt, _blurOn);
      gl.uniform1f(mLoc.uBlurT0, BLUR_T0);
      gl.uniform1f(mLoc.uBlurT1, BLUR_T1);
      gl.uniform1f(mLoc.uEdgeFeather, EDGE_FEATHER);
      for (var i = 0; i < photoRanges.length; i++) {
        var r = photoRanges[i];
        // 该照片方向与视轴的夹角 -> 模糊量与淡出量

        gl.uniform1f(mLoc.uUseTex, 0);
        gl.uniform1f(mLoc.uBias, -0.00002);
        gl.bindBuffer(gl.ARRAY_BUFFER, paperBuf);
        gl.enableVertexAttribArray(mLoc.aPos);
        gl.vertexAttribPointer(mLoc.aPos, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(mLoc.aUV);
        gl.vertexAttribPointer(mLoc.aUV, 2, gl.FLOAT, false, 20, 12);
        gl.drawArrays(gl.TRIANGLES, r.start, r.count);

        ensureTexture(r.p, r.p.id === focusId || r.p.id === openingId);
        var rec = texOf[r.p.id];
        if (!rec) continue;
        var use = rec.ready ? rec
                : (rec.fallback && rec.fallback.ready ? rec.fallback : null);
        if (!use) continue;
        gl.uniform1f(mLoc.uUseTex, 1);
        gl.uniform1f(mLoc.uBias, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, photoBuf);
        gl.enableVertexAttribArray(mLoc.aPos);
        gl.vertexAttribPointer(mLoc.aPos, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(mLoc.aUV);
        gl.vertexAttribPointer(mLoc.aUV, 2, gl.FLOAT, false, 20, 12);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, use.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, (use.blurTex || use.tex));
        gl.activeTexture(gl.TEXTURE0);
        gl.drawArrays(gl.TRIANGLES, r.start, r.count);
        diag.matteDraws = (diag.matteDraws || 0) + 1;
      }
      gl.disable(gl.BLEND);
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
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);              // the fragment composes everything, opaque out

      // 惯性：松手后继续漂，速度按 INERTIA_KEEP 衰减（放在相机建立之前）
      if (gliding) {
        camLon = clampLon(camLon + vLon);
        camPhi = camPhi + vPhi;
        clampPitch();
        tLon = camLon; tPhi = camPhi;
        vLon *= INERTIA_KEEP; vPhi *= INERTIA_KEEP;
        if (Math.abs(vLon) < INERTIA_MIN && Math.abs(vPhi) < INERTIA_MIN) {
          gliding = false; vLon = 0; vPhi = 0;
        }
      }
      // 每帧按当前缩放夹一次俯仰：拉远自动回中、三排都在画面里
      clampPitch();
      // 形变强度随缩放收放：拉远给满强度做管状透视，放大趋近 0（看细节时是直的）。
      // 固定强度时，照片铺满屏幕后其上下边缘落在 ty=±1，那里 waist=1-BOW，
      // 等于把上下横向压掉 17%，相框被拉得很诡异。
      // 开屏期间每帧自己重算俯仰：pitchFor 依赖 radius()，而在 startOpening 里
      // 调用时 zoom 的更新时机不可靠（拿到的 radius 会是旧值，俯仰因此偏掉、照片出画面）。
      // 放在渲染循环里就永远与当前缩放一致，不依赖调用顺序。
      if (openingId && openState !== 'done') {
        var _op = photoById(openingId);
        if (_op) camPhi = pitchFor(_op.lat, radius());
      }
      // 聚焦/开屏时形变**归零**：用户要求"聚焦的时候照片应该刚好到看不出立体透视
      // 而不是弯的"。只有拉远看全局时才给满强度做管状透视。
      // 驱动主题背景：把 camLon（沿轴平移）/ camPhi（俯仰）映射成鼠标位置。
      // 主题内部是 nx=(clientX/innerWidth)*2-1，所以这里反着算即可。
      // 注意 render() 不带参数，不能用 now
      // 背景跟着相机平移（不依赖主题的动画循环）
      // 第一次用到时再取：赋值原来放在初始化靠后的位置，渲染循环早就开始跑了，
      // 于是 bgWrap 一直是 null，位移根本没写进 DOM（实测 translate 为空）。
      if (!bgWrap) bgWrap = document.querySelector('[data-scene-background]');
      if (bgWrap) {
        // 🔴 增益必须和场景同一量级，否则等于没动。
        // 原来用 -camLon*12：而一次拖动只改变约 0.07 世界单位 -> 背景动不到 1px。
        // 照片在墙深处的比例是 focal/d ≈ 16250 px/世界单位；远层取它的约 7%，
        // 这样拖动时背景明确跟着走，又明显慢于照片（有层次）。
        // 位移用 ±BG_CX 夹住，配合 scale 放大，保证不会露出边缘。
        var _bx = Math.max(-BG_CX, Math.min(BG_CX, -camLon * BG_KX));
        var _by = Math.max(-BG_CY, Math.min(BG_CY, camPhi * BG_KY));
        // 🔴 必须用**独立属性** translate/scale，不能用 transform：
        // 主题自己每帧也给这个容器写 transform（它自己的视差），用 transform 会互相覆盖，
        // 结果是主题的值赢、我的位移整个丢掉（实测：我算 ±78px，页面上只有 11px，正是主题的值）。
        // translate/scale 与 transform 是**叠加**关系，各写各的，不打架。
        bgWrap.style.translate = _bx.toFixed(1) + 'px ' + _by.toFixed(1) + 'px';
        bgWrap.style.scale = String(BG_SCALE);
      }
      var _bn = (window.performance && performance.now) ? performance.now() : Date.now();
      if (_bn - bgLastT > 50) {
        bgLastT = _bn;
        var _cx = W * 0.5 + (camLon / 3.2) * (W * 0.5);
        var _cy = H * 0.5 - (camPhi / 80) * (H * 0.5);
        // 🔴 不再派发合成 pointermove。
        // 那会让主题按"光标在屏幕上的位置"做它自己的视差（景深），
        // 于是背景同时响应光标位置**和**拖动，两个效果打架。
        // 用户："背景一边响应光标位置的景深一边好像在响应拖动，把景深删掉"。
        // 现在背景只由下面的拖动位移驱动。
        // （如果将来要恢复，取消注释即可；bgSynth 这个自激保护仍然保留。）
      }
      var _wk = (focusId || (openingId && openState !== 'done')) ? 0
               : Math.max(0, Math.min(1, 1 - zoom / 0.55));
      bowNow = BOW * _wk; hoopNow = HOOP * _wk;
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
      gl.uniform1f(loc.uBow, bowNow);
      gl.uniform1f(loc.uHoop, hoopNow);
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
      gl.uniform1f(loc.uYToDeg, 20.0);   // 沿轴 1 世界单位 = 20 个栅格单位
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
      // 球带（网格 + 壁纸 + 扫光）不再自己画 —— 主题的 [data-scene-background] 已经在下面
      // 用同一份 willowxi.js 画好了，自己再画一层反而对不上。
      // gl.drawArrays(gl.TRIANGLES, 0, nVerts);
      diag.draws++;
      // ===== 后处理管线 =====
      // ① 场景 -> FBO   ② 全屏四边形用放射模糊着色器采样它   ③ 输出到屏幕
      // 这样模糊是对**整幅已合成的画面**做的，不会有"每张照片各算一遍、
      // 相纸与照片边界对不上"的问题，也才能做出"沿半径拖条纹"的拉伸感。
      ensureFBO(canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      // 主题背景先进 FBO，于是它也一起被后处理的放射模糊罩住
      drawThemeBackground();
      drawMattes(cam, focal);
      // 放射拉伸随缩放收放：聚焦/开屏为 0（那时要绝对清晰、居中），远看时最强
      var _smearAmt = (focusId || (openingId && openState !== 'done')) ? 0
                     : Math.max(0, Math.min(1, 1 - zoom / 0.55));
      drawPost(_smearAmt);
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
       'uBandLo', 'uBandHi', 'uGridRGB', 'uSweepRGB', 'uInk', 'uTex', 'uDebug', 'uAcrylic', 'uYToDeg'].forEach(function (n) {
        loc[n] = gl.getUniformLocation(prog, n);
      });
      buildMesh();
      // 相纸用的 program（白纸 + 照片贴图，uUseTex 切换）
      var vsm = compile(gl.VERTEX_SHADER, VS_MATTE);
      var fsm = compile(gl.FRAGMENT_SHADER, FS_MATTE);
      if (vsm && fsm) {
        progPost = gl.createProgram();
      (function () {
        var vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, VS_QUAD); gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
          throw new Error('quad vs: ' + gl.getShaderInfoLog(vs));
        var fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, FS_POST); gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
          throw new Error('post fs: ' + gl.getShaderInfoLog(fs));
        gl.attachShader(progPost, vs); gl.attachShader(progPost, fs);
        gl.bindAttribLocation(progPost, 0, 'aXY');
        gl.linkProgram(progPost);
        if (!gl.getProgramParameter(progPost, gl.LINK_STATUS))
          throw new Error('post link: ' + gl.getProgramInfoLog(progPost));
        pLoc.uSrc = gl.getUniformLocation(progPost, 'uSrc');
        pLoc.uSmearPx = gl.getUniformLocation(progPost, 'uSmearPx');
        pLoc.uT0 = gl.getUniformLocation(progPost, 'uT0');
        pLoc.uT1 = gl.getUniformLocation(progPost, 'uT1');
        pLoc.uAmt = gl.getUniformLocation(progPost, 'uAmt');
        pLoc.uHalfW = gl.getUniformLocation(progPost, 'uHalfW');
        pLoc.uHalfH = gl.getUniformLocation(progPost, 'uHalfH');
        quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER,
          new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      })();

      progBg = gl.createProgram();
      (function () {
        var vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, VS_QUAD); gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
          throw new Error('bg vs: ' + gl.getShaderInfoLog(vs));
        var fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, FS_BG); gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
          throw new Error('bg fs: ' + gl.getShaderInfoLog(fs));
        gl.attachShader(progBg, vs); gl.attachShader(progBg, fs);
        gl.bindAttribLocation(progBg, 0, 'aXY');
        gl.linkProgram(progBg);
        if (!gl.getProgramParameter(progBg, gl.LINK_STATUS))
          throw new Error('bg link: ' + gl.getProgramInfoLog(progBg));
        bLoc.uTex = gl.getUniformLocation(progBg, 'uTex');
        bLoc.uAlpha = gl.getUniformLocation(progBg, 'uAlpha');
        bLoc.uUVK = gl.getUniformLocation(progBg, 'uUVK');
        bLoc.uUVO = gl.getUniformLocation(progBg, 'uUVO');
        bLoc.uTint = gl.getUniformLocation(progBg, 'uTint');
        bLoc.uSolid = gl.getUniformLocation(progBg, 'uSolid');
        bgWallTex = gl.createTexture();
        bgGridTex = gl.createTexture();
      })();

      progMatte = gl.createProgram();
        gl.attachShader(progMatte, vsm);
        gl.attachShader(progMatte, fsm);
        gl.linkProgram(progMatte);
        if (gl.getProgramParameter(progMatte, gl.LINK_STATUS)) {
          var names = ['aPos', 'aUV', 'uEye', 'uRight', 'uUp', 'uFwd', 'uFocal',
                       'uHalfW', 'uHalfH', 'uBow', 'uHoop', 'uBias', 'uTex', 'uTexB', 'uUseTex', 'uPaper', 'uBlurT0', 'uBlurT1', 'uBlurAmt', 'uEdgeFeather'];
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
      // 点击改挂 window：命中靠 pickAt 自己算，不再依赖透明且位置不准的 DOM 相纸
      window.addEventListener('click', onMatteClick);
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
      // 🔴 挂在 window，不是 canvas。
    //
    // 相纸（DOM 那层，透明但可点）盖在 canvas 之上，手指按在相纸上时事件目标是
    // 相纸、并不会经过 canvas —— 于是拖动/双指在按到照片上时完全失效（实测
    // pointers 始终是 0）。挂 window 就都能收到。
    window.addEventListener('pointerdown', onPointerDown);
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
    // 临时诊断用：把每张的高清地址暴露出来
    function lightInfo() {
      var out = [];
      for (var i = 0; i < Math.min(3, photos.length); i++) {
        out.push(photos[i].id + ':' + String(photos[i].light).slice(-18));
      }
      return out.join(' | ');
    }

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

      // 全局放射状模糊层（背景与照片一起被模糊），见 CSS [data-dome-blur]
      bgWrap = document.querySelector('[data-scene-background]');

      // 不再需要 CSS 的 [data-dome-blur]：背景已进 GL，模糊由后处理统一负责，
      // 否则会双重模糊。
      // CSS 那层已经不需要（背景进 GL 了，模糊由后处理统一负责）
      // 页面里若还残留旧的 [data-dome-blur]，一并移除，避免双重模糊
      var _oldBlur = document.querySelector('[data-dome-blur]');
      if (_oldBlur && _oldBlur.parentNode) _oldBlur.parentNode.removeChild(_oldBlur);

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
        // 🔴 顺序要紧：必须**先**定缩放，再算俯仰。
        // pitchFor 依赖 radius()，而 radius() 读的是 zoom —— 先算俯仰时 zoom 还是旧值
        // （初始化时的 0 -> r=0.08），pitchFor(th, 0.08) 约等于 th，照片被推到屏幕外。
        zoom = target = zoomOpening(pick);
        camLon = clampLon(pick.lon);
        camPhi = pitchFor(pick.lat, radius());
        tLon = camLon; tPhi = camPhi;
        flyFrom = null;
        openingId = pick.id;
        ensureTexture(pick, true);     // 开屏这张也换全尺寸贴图
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
      // 必须先停掉惯性：惯性块每帧覆盖 tLon/tPhi，会把这里的 animateCameraTo 顶掉，
        // 于是"定位到之后还在继续跑".
        gliding = false; vLon = 0; vPhi = 0;
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
      // 俯仰按"真正能看到这张"的角度算（见 pitchFor）。
      // 🔴 半径必须来自 zoomToFill **实际给出的** zoom，不能另算：
      //    原来这里内联算了个 rTarget（公式里还留着旧的 1.22，而 zoomToFill 已改成 1.38），
      //    而且传参写成 pitchFor(p.lat, 1 - rTarget) —— rTarget 本身就是半径，
      //    再取反等于把**距离 d 当成半径 r**传进去，俯仰角算错，照片因此不居中。
      target = zoomToFill(p);
      var rT = 1 - D_OUT * Math.pow(D_IN / D_OUT, target);
      animateCameraTo(p.lon, pitchFor(p.lat, rT), ms || 900);
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
    // 开屏用：照片**铺满**屏幕（边角被裁掉没关系）。这正是旧行为，用户确认"是对的"。
    function zoomOpening(p) {
      var photoW = matteWorld / (1 + 2 * MATTE_BORDER);
      var focal = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);
      var dw = focal * photoW / Math.max(1, W);
      var dh = focal * (photoW / p.ratio) / Math.max(1, H);
      // 0.93 时照片只占约 86%，四周还露相纸边；0.78 才是真正的"铺满"。
      var d = Math.min(dw, dh) * 0.66;   // min = 铺满；0.93 = 再靠近一点，确保盖过视口
      var r = Math.max(0, Math.min(R_IN, 1 - d));
      var z = Math.log(Math.max(0.02, (1 - r) / D_OUT)) / Math.log(D_IN / D_OUT);
      return Math.max(0, Math.min(1, z));
    }

    // 聚焦用：**完整看到相纸**（含白边）并留空隙。
    function zoomToFill(p) {
      // 🔴 用**照片**的尺寸，不是相纸的尺寸。
      //
      // 用户："谁要看相纸白边了？？？"。相纸白边只属于墙上；开屏与聚焦应该是照片
      // 本身铺满视口。用相纸尺寸算的话，白边正好卡在画面里 —— 所以这里按照片算，
      // 白边就被推到视口之外。
      //   相纸宽 = 照片宽 * (1 + 2*BORDER)  ->  照片宽 = matteWorld / (1 + 2*BORDER)
      // 用户："定位之后拉太近了，要完整看到相纸边框并且留有空隙"
      // 按**相纸**（不是照片）算入画距离，再往后退一截留边距。
      var ar2 = matteAR(p.ratio);
      var focal = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);
      var dw = focal * matteWorld / Math.max(1, W);
      var dh = focal * (matteWorld / ar2) / Math.max(1, H);
      // 再乘 0.93：让照片**略微盖过**视口。CSS 的百分比内边距是按相纸自身宽高算
      // 的，和我这里按照片宽算的白边并不严格相等；留一点余量才能保证白边一定在
      // 画面之外，而不是露出几像素。
      // 🔴 必须取 max，不是 min。
      //
      // dw = 相纸宽度刚好占满视口宽所需的距离；dh = 高度刚好占满视口高所需的距离。
      // 要让**两个方向都装得下**，距离必须 >= max(dw, dh)。用 min 时必然有一个方向
      // 溢出，看起来就是"拉太近"；而竖版相纸的 dh 远大于 dw，所以竖屏溢得最厉害
      // （用户："竖屏和横屏的聚焦拉近不一样，竖屏要再远一点"）。
      var d = Math.max(dw, dh) * 1.38;   // 再退远一点，四周留出空隙   // >1 = 再后退一点，留出白边与四周空隙
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
      vLon = 0; vPhi = 0; gliding = false;
      dragX = e.clientX; dragY = e.clientY;
      flyFrom = null;
      // 🔴 不要 setPointerCapture。
      //
      // pointerdown 已经改挂 window（因为透明相纸盖在 canvas 上），事件目标常常是
      // **相纸**。此时对 canvas 调 setPointerCapture 会把后续事件（包括最终的 click）
      // 全部重定向到 canvas —— 相纸的点击处理永远收不到，于是"照片点不动了"。
      // pointermove/pointerup 本来就挂在 window 上，不需要捕获。
    }
    function onPointerMove(e) {
      if (bgSynth) return;   // 我们自己派发的合成事件，不当拖动处理
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
      // 1:1 跟手：每像素拖动应当让画面里的内容正好移动一像素。
      // 视角每转 Δ 弧度，内容移动约 focal*Δ 像素 -> Δ = dx/focal（弧度）。
      // 注意**必须由当前 focal 推导**：之前写死 0.049 是按 FOV 52 标定的，
      // 后来 FOV 改成 50、焦距变了，就悄悄快了约 1.3 倍（用户又报"有点快"）。
      // K 是实测标定系数（含 BOW/HOOP 与内容不在屏幕正中的影响）。
      var K11 = 1.26;
      var focalNow = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);
      var DRAG_DEG_PER_PX = K11 * 57.2958 / Math.max(1, focalNow);
      // 平移 1:1：相机横移 Δx 让内容移动 focal*Δx/d 像素，要等于 dx 像素
      // -> Δx = dx * d / focal。
      // 之前这里还是旧的 DRAG_DEG_PER_PX（0.047 世界单位/像素），140px 就移动 6.6 个单位，
      // 而管子只有 ±3.1 —— 一拖就撞边界，惯性因此看起来是 0、1:1 也没了。
      var _dd = Math.max(0.02, 1 - radius());
      var _dx = dx * _dd / focalNow;
      camLon = clampLon(camLon + _dx);
      // 惯性速度必须是**世界单位/帧**（与 camLon 的增量同量纲）。
      // 之前用 DRAG_DEG_PER_PX（角度/像素）当世界速度，一甩就是 280 多个单位，
      // 而管子只有 ±3.1 —— 一甩立刻撞到边界，看起来就是"没有惯性"。
      vLon = _dx;   // 惯性初速 = 本帧的平移增量（世界单位/帧）
      vPhi = dy * DRAG_DEG_PER_PX;
      // 上下范围收紧：原来 ±32°、灵敏度 0.16，一拖就跑到天顶/天底（用户："上下移动
      // 范围太大了"）。改成 ±12°、灵敏度 0.09 —— 穹顶内容本来也只在球带里。
      // 上下 = 俯仰角
      // 俯仰范围由 clampPitch() 按缩放统一夹（见 pitchLimit）
      camPhi = camPhi + dy * DRAG_DEG_PER_PX;
      clampPitch();
      tLon = camLon; tPhi = camPhi;
    }
    function onPointerUp(e) {
      if (pointers[e.pointerId]) delete pointers[e.pointerId];
      vLon *= INERTIA_BOOST; vPhi *= INERTIA_BOOST;
      if (vLon !== 0 || vPhi !== 0) gliding = true;
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
    // 🎯 点击命中：用与画面**完全相同**的投影自己算。
    //
    // 之前靠 DOM 相纸的位置做命中，而 DOM 那层是另一套投影（perspective + rotateY）。
    // 探索一会儿之后两者越走越偏，于是点到空隙或点到另一张图
    // （用户："点击图片定位不对"）。
    // 临时诊断：把每张照片的投影结果列出来，用来校准命中盒
    function pickTable() {
      var cam = makeCamera(camLon, camPhi, radius());
      var focal = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);
      var out = [];
      for (var i = 0; i < photos.length; i++) {
        var q = photos[i];
        var P = sph(q.lon, q.lat);
        var pr = projectPoint(cam, focal, W, H, P);
        if (!pr) { out.push(q.id + ':-'); continue; }
        var dx = P[0] - cam.pos[0], dy = P[1] - cam.pos[1], dz = P[2] - cam.pos[2];
        var z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
        if (z <= 0.06) { out.push(q.id + ':back'); continue; }
        var wpx = focal * matteWorld / z;
        var hpx = wpx / matteAR(q.ratio);
        out.push(q.id + ':' + Math.round(pr[0]) + ',' + Math.round(pr[1]) +
                 ' ' + Math.round(wpx) + 'x' + Math.round(hpx) + ' z' + z.toFixed(2));
      }
      return out.join(' | ');
    }

    function pickAt(cx, cy) {
      var cam = makeCamera(camLon, camPhi, radius());
      var focal = (W * 0.5) / Math.tan(FOV * 0.5 * Math.PI / 180);
      var best = null, bestZ = 1e9;
      for (var i = 0; i < photos.length; i++) {
        var q = photos[i];
        var P = sph(q.lon, q.lat);
        var pr = projectPoint(cam, focal, W, H, P);
        if (!pr) continue;
        var dx = P[0] - cam.pos[0], dy = P[1] - cam.pos[1], dz = P[2] - cam.pos[2];
        var z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
        if (z <= 0.06) continue;
        var wpx = focal * matteWorld / z;
        var hpx = wpx / matteAR(q.ratio);
        var inside = Math.abs(cx - pr[0]) <= wpx * 0.5 && Math.abs(cy - pr[1]) <= hpx * 0.5;
        // 照片之间有间隔（LON_SPAN=150、每行 8 张 -> 约 18.75 度），点在空隙上时
        // 什么都不发生，用户会觉得"定位不到"。所以直接命中不到就退而取**最近**的一张，
        // 但限制在相纸尺寸的 1.6 倍以内，免得点到很远的地方也飞过去。
        var dx2 = Math.abs(cx - pr[0]) / (wpx * 0.5), dy2 = Math.abs(cy - pr[1]) / (hpx * 0.5);
        var score = inside ? (dx2 + dy2) : (dx2 + dy2) + 100;
        // 容差要够到相邻排：排距约 250px 而照片只有约 190px 高，
        // 1.6 倍容差够不到，点击就会"什么都没发生"。
        if (dx2 > 2.2 || dy2 > 2.2) continue;
        if (score < bestZ) { bestZ = score; best = q; }
      }
      return best;
    }

    function onMatteClick(e) {
      if (!ready) return;
      if (dragged > 6) return;
      var p2 = pickAt(e.clientX, e.clientY);
      if (p2) focusOn(p2, 900);
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
      if (gl) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
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
          fDraw: diag.fDraw || 0, fSkip: diag.fSkip || 0,
          ftReady: diag.ftReady, ftFb: diag.ftFb, ftUse: diag.ftUse, ftSrc: diag.ftSrc,
          lights: lightInfo(), openingId: openingId, pickDbg: pickTable(),
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

/* 液态玻璃光标 · A 路线（最终采用）
 *
 * 为什么最终是 A：
 *   B（DOM 序列化进 SVG foreignObject -> 当纹理）：实测 drawImage 报 broken state，
 *     SVG 根本渲染不出来 —— 外部字体/图片、内联 CSS 在 foreignObject 里都不可靠。
 *   C（WebGL 折射主题背景层）：能跑，但玻璃显示的是**背景层**；
 *     光标压在照片/卡片/文字上时，玻璃里透出来的是壁纸和网格 —— 直接穿帮。
 *   A（DOM 覆盖层 + backdrop-filter）：浏览器替我们拿到"光标底下真实的合成结果"，
 *     所以模糊的永远是它真正下面的东西 —— 任何页面、任何内容都不会穿帮。
 *     "没有位移弯曲"不是妥协：浏览器不给 DOM 做位移采样，这是事实的边界。
 *
 * 四条把玻璃感做足（见 willowxi.css 里 [data-glass-cursor] 那段）：
 *   1 backdrop-filter: blur + saturate   真磨砂 + 像玻璃那样聚光
 *   2 一圈内高光（上边最亮、下边次之）+ 外阴影   玻璃边的主要来源
 *   3 内侧竖向明暗（上亮下暗）   厚度感
 *   4 边缘一层极淡的冷色   色散的一点点暗示
 *
 * 行为：跟随鼠标（缓动）→ 邻近可点击元素补间成圆角矩形包住它 → 按住缩小
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;   // 触屏不做
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var SEL = 'a[href], button, input, textarea, select, [role="button"], summary';
  var SNAP = 24;      // 吸附阈值(px)：太小不吸附，太大到处吸附
  var BASE = 46;      // 常态直径
  var PAD = 10;       // 包裹元素时的内边距
  var EASE = 0.20;    // 缓动
  var SHRINK = 0.86;  // 按住时缩到多少
  var MAXW = 420, MAXH = 260;   // 比这更大的链接（整张卡片）不吸附

  var el = document.createElement('div');
  el.setAttribute('data-glass-cursor', '');
  el.setAttribute('aria-hidden', 'true');

  var t = { x: innerWidth / 2, y: innerHeight / 2, w: BASE, h: BASE, r: BASE / 2 };
  var c = { x: t.x, y: t.y, w: t.w, h: t.h, r: t.r };
  var pressed = false, started = false;

  function nearest(mx, my) {
    var list = document.querySelectorAll(SEL), best = null, bd = 1e9;
    for (var i = 0; i < list.length; i++) {
      var b = list[i].getBoundingClientRect();
      if (b.width < 12 || b.height < 12) continue;
      if (b.bottom < -20 || b.top > innerHeight + 20) continue;
      if (b.right < -20 || b.left > innerWidth + 20) continue;
      if (b.width > MAXW || b.height > MAXH) continue;   // 大卡片不吸附
      var dx = Math.max(b.left - mx, 0, mx - b.right);
      var dy = Math.max(b.top - my, 0, my - b.bottom);
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < bd) { bd = d; best = b; }
    }
    return (best && bd <= SNAP) ? best : null;
  }

  function onMove(e) {
    start();
    var mx = e.clientX, my = e.clientY, box = nearest(mx, my);
    if (box) {
      t.w = box.width + PAD * 2; t.h = box.height + PAD * 2;
      t.r = Math.min(18, t.h / 2);
      t.x = box.left + box.width / 2; t.y = box.top + box.height / 2;
    } else {
      t.w = BASE; t.h = BASE; t.r = BASE / 2; t.x = mx; t.y = my;
    }
  }

  function loop() {
    requestAnimationFrame(loop);
    c.x += (t.x - c.x) * EASE; c.y += (t.y - c.y) * EASE;
    c.w += (t.w - c.w) * EASE; c.h += (t.h - c.h) * EASE;
    c.r += (t.r - c.r) * EASE;
    var k = pressed ? SHRINK : 1, w = c.w * k, h = c.h * k;
    el.style.width = w.toFixed(2) + 'px';
    el.style.height = h.toFixed(2) + 'px';
    el.style.borderRadius = (c.r * k).toFixed(2) + 'px';
    el.style.transform = 'translate3d(' + (c.x - w / 2).toFixed(2) + 'px,'
                       + (c.y - h / 2).toFixed(2) + 'px,0)';
  }

  function start() {
    if (started) return;
    started = true;
    document.body.appendChild(el);
    document.documentElement.classList.add('has-glass-cursor');
    loop();
  }

  document.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('mousedown', function () { start(); pressed = true; });
  document.addEventListener('mouseup', function () { pressed = false; });
  document.addEventListener('mouseleave', function () { pressed = false; });
  window.addEventListener('blur', function () { pressed = false; });
})();

(function () {
  'use strict';

  var config = window.WILLOWXI_THEME || {};
  var root = document.documentElement;
  var body = document.body;
  var intro = document.getElementById('willowxi-intro');
  var introEnded = false;
  var introTimers = [];
  var pageObservers = [];
  var closeNavigation = function () {};
  var sceneBackground = null;

  function onReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  }

  function setTimer(callback, delay) {
    introTimers.push(window.setTimeout(callback, delay));
  }

  function clearIntroTimers() {
    introTimers.forEach(window.clearTimeout);
    introTimers = [];
  }

  function willRunIntro() {
    if (!intro) return false;
    if (prefersReducedMotion()) return false;
    return new URLSearchParams(window.location.search).get('nointro') !== '1';
  }

  // Wallpaper, acrylic veil and the canvas grid all live in one fixed scene.
  // The scene fades in after the page transition, then starts its sweep.
  function createSceneBackground() {
    var scene = document.querySelector('[data-scene-background]');
    var layer = document.querySelector('[data-scene-wallpaper]');
    var canvas = document.querySelector('[data-scene-canvas]');

    if (!scene || !layer || !canvas || !canvas.getContext) return null;

    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var defaultWallpaper = body.getAttribute('data-default-wallpaper') || '';
    var currentWallpaper = '';
    var width = 0;
    var height = 0;
    var ratio = 1;
    var desktop = false;
    var verticals = [];
    var horizontals = [];
    var canCachePath = typeof window.Path2D === 'function';
    var gridPath = null;
    var gridInk = 'rgba(196, 224, 236, 0.145)';
    var sweepInk = { r: 214, g: 240, b: 255, a: 0.5, composite: 'lighter' };
    var sweepDuration = Math.max(1, Number(config.sweepDuration) || 4) * 1000;
    var revealDelay = Math.max(0, Number(config.revealDelay));
    var revealDuration = Math.max(0, Number(config.revealDuration));
    var sweepDelay = Math.max(0, Number(config.sweepDelay));
    var sweepStart = 0;
    var visible = false;
    var sweepReady = false;
    var sweepActive = false;
    var revealTimer = 0;
    var rafId = 0;
    var resizeFrame = 0;
    var pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    var parallaxDirty = false;
    var sceneThrottle = false;
    var throttleTick = 0;
    var scrollIdleTimer = 0;

    if (!isFinite(revealDelay)) revealDelay = 500;
    else revealDelay *= 1000;

    if (!isFinite(revealDuration)) revealDuration = 1000;
    else revealDuration *= 1000;

    if (!isFinite(sweepDelay)) sweepDelay = 1000;
    else sweepDelay *= 1000;

    scene.style.setProperty('--scene-reveal-delay', revealDelay + 'ms');
    scene.style.setProperty('--scene-reveal-duration', revealDuration + 'ms');

    // Parallax amplitudes in px. The wallpaper travels much farther than the
    // grid, and that gap is what reads as depth between the two layers.
    var wallpaperRangeX = Number(config.parallaxWallpaper);
    if (!isFinite(wallpaperRangeX) || wallpaperRangeX <= 0) wallpaperRangeX = 14;

    var wallpaperRangeY = Number(config.parallaxWallpaperY);
    if (!isFinite(wallpaperRangeY) || wallpaperRangeY <= 0) wallpaperRangeY = 14;

    var gridRange = Number(config.parallaxGrid);
    if (!isFinite(gridRange) || gridRange <= 0) gridRange = 7;

    function parseColor(value) {
      var match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i.exec(value || '');
      if (!match) return null;

      var alpha = match[4];
      if (!alpha) {
        alpha = 1;
      } else if (alpha.indexOf('%') > -1) {
        alpha = parseFloat(alpha) / 100;
      } else {
        alpha = parseFloat(alpha);
      }

      return {
        r: Math.round(parseFloat(match[1])),
        g: Math.round(parseFloat(match[2])),
        b: Math.round(parseFloat(match[3])),
        a: Math.max(0, Math.min(1, alpha))
      };
    }

    function readTheme() {
      var styles = window.getComputedStyle(root);
      var light = root.getAttribute('data-theme') === 'light';
      var grid = styles.getPropertyValue('--scene-grid').trim();
      var sweep = parseColor(styles.getPropertyValue('--scene-sweep').trim());

      gridInk = grid || (light ? 'rgba(22, 26, 31, 0.13)' : 'rgba(196, 224, 236, 0.145)');

      if (sweep) {
        sweepInk = {
          r: sweep.r,
          g: sweep.g,
          b: sweep.b,
          a: sweep.a,
          composite: light ? 'source-over' : 'lighter'
        };
      }
    }

    function buildGrid() {
      desktop = window.innerWidth >= (Number(config.desktopMinWidth) || 769);

      var spacing = desktop
        ? Math.max(64, Number(config.gridSpacing) || 168)
        : Math.max(24, Number(config.mobileGridSpacing) || 42);
      var cx = width / 2;
      var cy = height / 2;
      var halfWidth = Math.max(1, width / 2);
      var halfHeight = Math.max(1, height / 2);
      var margin = spacing * 1.4;
      var bow = desktop ? 0.17 : 0;
      var hoop = desktop ? 0.13 : 0;
      var samples = 26;
      var x;
      var y;
      var i;
      var line;

      // A node shared by two grid lines must land on the same pixel, so both
      // families are sampled in flat space and then warped by one shared map.
      function warpX(nodeX, nodeY) {
        if (!bow) return nodeX;
        var t = (nodeY - cy) / halfHeight;
        var waist = 1 - bow * Math.max(0, 1 - t * t);
        return cx + (nodeX - cx) * waist;
      }

      function warpY(nodeX, nodeY) {
        if (!hoop) return nodeY;
        var u = (nodeX - cx) / halfWidth;
        return nodeY + hoop * u * u * (nodeY - cy);
      }

      verticals = [];
      horizontals = [];

      for (x = -margin; x <= width + margin; x += spacing) {
        line = [];
        for (i = 0; i <= samples; i++) {
          y = -margin + ((height + margin * 2) * i) / samples;
          line.push([warpX(x, y), warpY(x, y)]);
        }
        verticals.push(line);
      }

      for (y = -margin; y <= height + margin; y += spacing) {
        line = [];
        for (i = 0; i <= samples; i++) {
          x = -margin + ((width + margin * 2) * i) / samples;
          line.push([warpX(x, y), warpY(x, y)]);
        }
        horizontals.push(line);
      }

      // Cache the whole grid as one Path2D so frames no longer rebuild a few
      // hundred segments before every stroke.
      if (canCachePath) {
        gridPath = new window.Path2D();
        appendLines(gridPath, horizontals);
        appendLines(gridPath, verticals);
      }
    }

    function appendLines(path, lines) {
      for (var n = 0; n < lines.length; n++) {
        path.moveTo(lines[n][0][0], lines[n][0][1]);
        for (var k = 1; k < lines[n].length; k++) {
          path.lineTo(lines[n][k][0], lines[n][k][1]);
        }
      }
    }

    function layout() {
      width = Math.max(1, canvas.clientWidth || window.innerWidth);
      height = Math.max(1, canvas.clientHeight || window.innerHeight);
      ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      buildGrid();
    }

    function tracePath() {
      var i;
      var j;
      var line;

      ctx.beginPath();

      for (i = 0; i < horizontals.length; i++) {
        line = horizontals[i];
        ctx.moveTo(line[0][0], line[0][1]);
        for (j = 1; j < line.length; j++) ctx.lineTo(line[j][0], line[j][1]);
      }

      for (i = 0; i < verticals.length; i++) {
        line = verticals[i];
        ctx.moveTo(line[0][0], line[0][1]);
        for (j = 1; j < line.length; j++) ctx.lineTo(line[j][0], line[j][1]);
      }
    }

    function strokeGrid() {
      // Cached Path2D skips rebuilding every segment on every frame.
      if (gridPath) {
        ctx.stroke(gridPath);
        return;
      }

      tracePath();
      ctx.stroke();
    }

    function phaseAt(now) {
      var value = ((now - sweepStart) / sweepDuration) % 1;
      return value < 0 ? value + 1 : value;
    }

    function render(phase) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 1;
      ctx.strokeStyle = gridInk;
      strokeGrid();
      ctx.restore();

      if (typeof phase !== 'number') return;

      var thickness = height * 0.55;
      var center = height + thickness * 0.5 - phase * (height + thickness);
      var top = center - thickness * 0.5;
      var bottom = center + thickness * 0.5;
      var ink = sweepInk;

      function tint(scale) {
        return 'rgba(' + ink.r + ',' + ink.g + ',' + ink.b + ',' + (ink.a * scale).toFixed(3) + ')';
      }

      var gradient = ctx.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, tint(0));
      gradient.addColorStop(0.18, tint(0.38));
      gradient.addColorStop(0.5, tint(1));
      gradient.addColorStop(0.82, tint(0.38));
      gradient.addColorStop(1, tint(0));

      ctx.save();
      ctx.globalCompositeOperation = ink.composite;
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1;
      strokeGrid();

      // Halo passes: progressively wider, fainter strokes so the band leaves
      // a soft glow trail on the grid instead of a single bright line. Wide
      // strokes are far cheaper than a shadowBlur over the same path, which
      // forces a full-path blur every frame.
      //
      // NOTE: these must go through strokeGrid(). When the grid is cached as
      // a Path2D, ctx.stroke(path) does not touch the context's current path,
      // so a bare ctx.stroke() here would silently draw nothing.
      var glowPasses = ink.composite === 'lighter'
        ? [[2.6, 0.6], [5.5, 0.42], [10, 0.26], [17, 0.14], [27, 0.07]]
        : [[2.6, 0.4], [5.5, 0.26], [10, 0.15], [17, 0.08]];

      for (var g = 0; g < glowPasses.length; g++) {
        ctx.globalAlpha = glowPasses[g][1];
        ctx.lineWidth = glowPasses[g][0];
        strokeGrid();
      }

      ctx.restore();
    }

    function paint() {
      if (!desktop || !sweepActive) {
        render(null);
        return;
      }
      render(prefersReducedMotion() ? 0.62 : phaseAt(performance.now()));
    }

    function updateParallax() {
      if (!desktop) return false;

      var dx = pointer.tx - pointer.x;
      var dy = pointer.ty - pointer.y;

      // Once the pointer target is reached there is nothing to redraw.
      if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) {
        if (!parallaxDirty) return false;
        pointer.x = pointer.tx;
        pointer.y = pointer.ty;
        parallaxDirty = false;
      } else {
        pointer.x += dx * 0.075;
        pointer.y += dy * 0.075;
        parallaxDirty = true;
      }

      var gridX = pointer.x * (gridRange / wallpaperRangeX);
      var gridY = pointer.y * (gridRange / wallpaperRangeY);

      layer.style.transform =
        'translate3d(' + pointer.x.toFixed(2) + 'px,' + pointer.y.toFixed(2) + 'px,0) scale(1.02)';
      canvas.style.transform =
        'translate3d(' + gridX.toFixed(2) + 'px,' + gridY.toFixed(2) + 'px,0)';

      return true;
    }

    function frame(now) {
      rafId = 0;

      var moved = updateParallax();
      var sweeping = desktop && sweepActive && !prefersReducedMotion();
      var animating = sweeping || moved;

      if (animating) {
        render(sweeping ? phaseAt(now) : null);
      }

      // Park the loop once the scene has nothing left to move; pointer input
      // restarts it. A permanently scheduled rAF kept the compositor awake
      // for a backdrop that had already settled (the normal case on touch,
      // where there is no pointer and no sweep).
      if (animating && visible && !document.hidden && !prefersReducedMotion()) {
        rafId = window.requestAnimationFrame(frame);
      }
    }

    function play() {
      if (!visible || document.hidden) return;

      if (prefersReducedMotion()) {
        paint();
        return;
      }

      if (!rafId) rafId = window.requestAnimationFrame(frame);
    }

    function pause() {
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = 0;
    }

    function clearRevealTimer() {
      if (revealTimer) window.clearTimeout(revealTimer);
      revealTimer = 0;
    }

    function beginSweep() {
      if (!visible || !sweepReady) return;

      sweepActive = true;

      if (prefersReducedMotion()) {
        pause();
        paint();
        return;
      }

      sweepStart = performance.now();
      play();
    }

    function reveal() {
      if (visible) return;

      clearRevealTimer();
      visible = true;
      sweepReady = false;
      sweepActive = false;
      sweepStart = 0;
      scene.classList.add('is-visible');
      paint();

      if (prefersReducedMotion()) {
        sweepReady = true;
        beginSweep();
        return;
      }

      revealTimer = window.setTimeout(function () {
        revealTimer = 0;
        sweepReady = true;
        beginSweep();
      }, revealDelay + revealDuration + sweepDelay);
    }

    function hide() {
      clearRevealTimer();
      visible = false;
      sweepReady = false;
      sweepActive = false;
      scene.classList.remove('is-visible');
      pause();
    }

    function setWallpaper(url) {
      var next = url || defaultWallpaper;
      if (!next || next === currentWallpaper) return;

      currentWallpaper = next;

      layer.onerror = function () {
        layer.onerror = null;
        if (currentWallpaper === next && defaultWallpaper && next !== defaultWallpaper) {
          currentWallpaper = defaultWallpaper;
          layer.src = defaultWallpaper;
        }
      };

      layer.src = next;
    }

    function scheduleLayout() {
      if (resizeFrame) return;

      resizeFrame = window.requestAnimationFrame(function () {
        resizeFrame = 0;
        layout();
        paint();
      });
    }

    function onPointerMove(event) {
      if (!desktop) return;

      var nx = (event.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
      var ny = (event.clientY / Math.max(1, window.innerHeight)) * 2 - 1;

      pointer.tx = nx * wallpaperRangeX;
      pointer.ty = ny * wallpaperRangeY;
      parallaxDirty = true;
      play(); // the loop parks itself when the scene settles
    }

    function refresh() {
      readTheme();
      paint();
    }

    function init() {
      readTheme();
      layout();
      paint();
      setWallpaper(body.getAttribute('data-wallpaper'));

      // No load listener: the wallpaper is always opaque, so the image simply
      // appears under the plate and is revealed when the plate dissolves.
      window.addEventListener('resize', scheduleLayout, { passive: true });
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('orientationchange', scheduleLayout, { passive: true });

      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          pause();
          return;
        }
        if (visible && sweepReady) {
          sweepActive = true;
          sweepStart = performance.now();
          play();
        } else if (visible) {
          paint();
        }
      });

      var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      var onMotionChange = function () {
        if (prefersReducedMotion()) {
          pause();
          sweepActive = sweepReady;
          paint();
          return;
        }
        if (visible && sweepReady) {
          sweepActive = true;
          sweepStart = performance.now();
          play();
        }
      };

      if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);
      else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);
    }

    return {
      init: init,
      reveal: reveal,
      hide: hide,
      refresh: refresh,
      setWallpaper: setWallpaper
    };
  }

  function revealPage(options) {
    if (introEnded) return;
    introEnded = true;
    clearIntroTimers();

    body.classList.remove('intro-running');
    body.classList.add('intro-ready');

    var introLeaveDuration = options && options.instant ? 120 : 680;

    if (intro) {
      intro.classList.add('is-leaving');
      window.setTimeout(function () {
        intro.classList.add('is-hidden');
        intro.setAttribute('aria-hidden', 'true');
      }, introLeaveDuration);
    }

    if (sceneBackground) {
      if (intro && !prefersReducedMotion()) {
        setTimer(function () {
          sceneBackground.reveal();
        }, introLeaveDuration);
      } else {
        sceneBackground.reveal();
      }
    }

    if (options && options.scrollToStream) {
      window.setTimeout(function () {
        var stream = document.getElementById('stream');
        if (stream) stream.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 360);
    }
  }

  function startIntro() {
    if (!intro) {
      body.classList.add('intro-ready');
      return;
    }

    var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var noIntro = new URLSearchParams(window.location.search).get('nointro') === '1';
    var count = intro.querySelector('[data-intro-count]');
    var bar = intro.querySelector('[data-intro-bar]');
    var year = intro.querySelector('[data-intro-year]');

    if (year) year.textContent = new Date().getFullYear();

    if (reducedMotion || noIntro) {
      intro.classList.add('is-static');
      revealPage({ instant: true });
      return;
    }

    body.classList.add('intro-running');
    intro.classList.add('is-active');

    var duration = Math.max(3200, Number(config.introDuration) || 5900);
    var progressStart = Math.round(duration * 0.30);
    var progressEnd = Math.round(duration * 0.82);
    var startTime = performance.now();

    function updateProgress(now) {
      if (introEnded) return;
      var elapsed = now - startTime;
      var raw = (elapsed - progressStart) / Math.max(1, progressEnd - progressStart);
      var eased = 1 - Math.pow(1 - Math.max(0, Math.min(1, raw)), 2.4);
      var value = Math.min(100, Math.round(eased * 100));
      if (count) count.textContent = String(value).padStart(3, '0');
      if (bar) bar.style.transform = 'scaleX(' + (value / 100) + ')';
      if (value < 100) requestAnimationFrame(updateProgress);
    }

    requestAnimationFrame(updateProgress);
    setTimer(function () { intro.classList.add('phase-copy'); }, duration * 0.30);
    setTimer(function () { intro.classList.add('phase-progress'); }, duration * 0.39);
    setTimer(function () { intro.classList.add('phase-actions'); }, duration * 0.74);
    setTimer(function () { intro.classList.add('phase-exit'); }, duration * 0.90);
    setTimer(function () { revealPage(); }, duration);

    intro.addEventListener('click', function (event) {
      if (event.target.closest('a')) return;
      if (event.target.closest('[data-intro-enter]')) {
        revealPage({ scrollToStream: true });
      } else {
        revealPage();
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') revealPage();
    });
  }

  function setupHeader() {
    var header = document.querySelector('[data-header]');
    var toggle = document.querySelector('[data-nav-toggle]');
    var nav = document.querySelector('[data-nav]');

    function closeNav() {
      if (!toggle || !nav) return;
      toggle.setAttribute('aria-expanded', 'false');
      nav.classList.remove('is-open');
      body.classList.remove('nav-open');
    }

    closeNavigation = closeNav;

    if (toggle && nav) {
      toggle.addEventListener('click', function () {
        var willOpen = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(willOpen));
        nav.classList.toggle('is-open', willOpen);
        body.classList.toggle('nav-open', willOpen);
      });

      nav.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', closeNav);
      });
    }

    function onScroll() {
      if (!header) return;
      header.classList.toggle('is-scrolled', window.scrollY > 24);
    }

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function setupTheme() {
    var toggle = document.querySelector('[data-theme-toggle]');
    var themeColor = document.querySelector('meta[name="theme-color"]');
    var cover = document.querySelector('[data-theme-transition]');
    var storageKey = 'willowxi-theme';
    var currentTheme = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    var switching = false;

    function applyTheme(theme, persist) {
      var nextTheme = theme === 'light' ? 'light' : 'dark';
      var isLight = nextTheme === 'light';

      root.setAttribute('data-theme', nextTheme);
      root.style.colorScheme = nextTheme;

      if (themeColor) {
        themeColor.setAttribute('content', isLight ? '#f4f5f2' : '#090b0f');
      }

      if (toggle) {
        toggle.setAttribute('aria-pressed', String(isLight));
        toggle.setAttribute('aria-label', isLight ? '切换到深色主题' : '切换到浅色主题');
        toggle.setAttribute('title', isLight ? '切换到深色主题' : '切换到浅色主题');
      }

      if (persist) {
        try {
          window.localStorage.setItem(storageKey, nextTheme);
        } catch (error) {
          // Theme switching still works when storage is unavailable.
        }
      }
    }

    applyTheme(currentTheme, false);

    if (!toggle) return;

    function swapTheme(nextTheme) {
      applyTheme(nextTheme, true);
      if (sceneBackground) sceneBackground.refresh();
    }

    toggle.addEventListener('click', function () {
      if (switching) return;

      var nextTheme = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';

      if (!cover || prefersReducedMotion()) {
        swapTheme(nextTheme);
        return;
      }

      switching = true;

      cover.classList.remove('is-leaving');
      cover.classList.add('is-running');

      window.setTimeout(function () {
        // Hide only once the cover has closed over the scene. Doing it on
        // click showed the background dissolving behind a curtain that was
        // still rising, which read as the scene being yanked away.
        if (sceneBackground) sceneBackground.hide();
        swapTheme(nextTheme);

        cover.classList.remove('is-running');
        forceReflow(cover);
        cover.classList.add('is-leaving');

        window.setTimeout(function () {
          cover.classList.remove('is-leaving');
          switching = false;
          if (sceneBackground) sceneBackground.reveal();
        }, 520);
      }, 360);
    });
  }

  function setupReveal() {
    var items = Array.from(document.querySelectorAll('.reveal'));
    if (!items.length) return;

    if (!('IntersectionObserver' in window)) {
      items.forEach(function (item) { item.classList.add('is-visible'); });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    pageObservers.push(observer);

    items.forEach(function (item, index) {
      item.style.setProperty('--reveal-delay', Math.min(index * 55, 330) + 'ms');
      observer.observe(item);
    });
  }

  function setupDetails() {
    var reduced = prefersReducedMotion();
    document.querySelectorAll('details').forEach(function (details) {
      var bodyElement = details.querySelector('.stream-group__body, .archive-year__body');
      if (!bodyElement) return;

      var collapseFinish = null;
      var suppressToggle = false;

      function cancelCollapse() {
        if (collapseFinish) {
          bodyElement.removeEventListener('transitionend', collapseFinish);
          collapseFinish = null;
        }
        details.classList.remove('is-collapsing');
      }

      // Both directions are scripted: the summary's native toggle shows or
      // hides the content in a single frame, so neither expand nor collapse
      // would ever be seen moving. The height still comes from the grid-rows
      // transition; the attribute flips only once it has landed (close) or
      // in the same still-hidden frame (open). Row 2 is the bottom tail
      // (var(--tail)), which must collapse with the content row.
      var ROWS_OPEN = '1fr var(--tail, 0px)';
      var ROWS_CLOSED = '0fr 0px';

      details.addEventListener('click', function (event) {
        var summary = event.target.closest('summary');
        if (!summary) return;
        event.preventDefault();

        if (details.open) {
          if (collapseFinish) return; // already collapsing
          if (reduced) {
            details.open = false;
            return;
          }
          details.classList.add('is-collapsing');
          bodyElement.style.gridTemplateRows = ROWS_CLOSED;
          collapseFinish = function (e) {
            if (e && e.propertyName !== 'grid-template-rows') return;
            bodyElement.removeEventListener('transitionend', collapseFinish);
            collapseFinish = null;
            details.classList.remove('is-collapsing');
            suppressToggle = true;
            details.open = false;
          };
          bodyElement.addEventListener('transitionend', collapseFinish);
          return;
        }

        cancelCollapse();
        bodyElement.style.gridTemplateRows = ROWS_CLOSED;
        suppressToggle = true;
        details.open = true;
        if (reduced) {
          bodyElement.style.gridTemplateRows = ROWS_OPEN;
          return;
        }
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            bodyElement.style.gridTemplateRows = ROWS_OPEN;
          });
        });
      });

      // Programmatic opens still land expanded; programmatic closes snap shut.
      details.addEventListener('toggle', function () {
        if (suppressToggle) {
          suppressToggle = false;
          return;
        }
        if (collapseFinish) return;
        bodyElement.style.gridTemplateRows = details.open ? ROWS_OPEN : ROWS_CLOSED;
      });

      if (details.open) bodyElement.style.gridTemplateRows = ROWS_OPEN;
    });
  }

  function setupToc() {
    var toc = document.querySelector('[data-toc]');
    if (!toc) return;
    var list = toc.querySelector('ol, ul');
    if (!list || !list.children.length) {
      toc.hidden = true;
      // Collapse the grid to the single reading column as well.
      var layout = toc.closest('.article__layout');
      if (layout) layout.classList.add('article__layout--no-toc');
      return;
    }

    var links = Array.from(toc.querySelectorAll('a[href^="#"]'));
    var sections = links.map(function (link) {
      return document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)));
    }).filter(Boolean);

    if (!sections.length || !('IntersectionObserver' in window)) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (link) {
          link.classList.toggle(
            'is-active',
            decodeURIComponent(link.getAttribute('href').slice(1)) === entry.target.id
          );
        });
      });
    }, { rootMargin: '-12% 0px -72% 0px', threshold: 0 });
    pageObservers.push(observer);

    sections.forEach(function (section) { observer.observe(section); });
  }

  // Home stream pickers. Left column: transparent rows in a native scroll
  // area (wheel = smooth multi-row, touch = momentum); while it glides the
  // row nearest the pinned bar is the selection and the right detail panel
  // flips one notch per change (the gear-ratio pair). When scrolling goes
  // idle the view snaps onto the nearest row. Clicking an unselected row
  // glides it to the bar; clicking the selected row (the bar itself) or the
  // panel's READ opens the post — the rows are real links, so PJAX works.
  var pickerTeardowns = [];

  function setupStreamPickers() {
    var viewports = document.querySelectorAll('[data-stream-viewport]');
    Array.prototype.forEach.call(viewports, function (viewport) {
      setupStreamPicker(viewport);
    });
  }

  function setupStreamPicker(viewport) {
    var picker = viewport.closest('[data-stream-picker]');
    var list = viewport.querySelector('[data-stream-list]');
    var count = picker ? picker.querySelector('[data-stream-count]') : null;
    var track = picker ? picker.querySelector('[data-stream-track]') : null;
    var rows = Array.prototype.slice.call(list ? list.children : []);

    if (!list || !rows.length) return;

    var reduced = prefersReducedMotion();
    var index = -1;
    // aim leads the animation: rapid steps queue from where we are HEADING,
    // not from the row the lagging scroll position has reached so far.
    var aim = -1;
    var snapTimer = 0;
    var snapAnim = 0;
    var glideRaf = 0;
    var glideTarget = 0;
    // tan(7deg): the row starts follow the wrapper's left slant edge.
    var TAN7 = 0.1228;
    var PAD_BASE = 128;
    var compact = window.matchMedia('(max-width: 960px)');

    function gap() {
      var styles = window.getComputedStyle(list);
      return parseFloat(styles.rowGap || styles.gap) || 12;
    }

    // Trapezoid typesetting: a row's left inset tracks the wrapper's slant
    // edge at its CURRENT height, so the row starts form a line parallel to
    // the -7deg edge while the list glides. Mobile has no slant — clear it.
    function updateIndents() {
      var centre = viewport.scrollTop + viewport.clientHeight / 2;
      rows.forEach(function (row) {
        if (compact.matches) {
          row.style.paddingLeft = '';
          return;
        }
        var yRel = row.offsetTop + row.offsetHeight / 2 - centre;
        row.style.paddingLeft = Math.max(56, PAD_BASE - yRel * TAN7) + 'px';
      });
    }

    // Vertical centre of row i, in the scroller's content coordinates.
    // offsetParent is the (position:relative) viewport, so this is scroll-proof.
    function rowCentre(i) {
      return rows[i].offsetTop + rows[i].offsetHeight / 2;
    }

    function nearestIndex() {
      var centre = viewport.scrollTop + viewport.clientHeight / 2;
      var best = 0;
      var bestDist = Infinity;
      rows.forEach(function (row, i) {
        var dist = Math.abs(rowCentre(i) - centre);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    }

    function setActive(i) {
      if (i === index) return;
      index = i;
      // Idle drift (glide browsing) keeps aim in sync; mid-animation the aim
      // stays where the user sent it so queued steps do not collapse.
      if (!snapAnim) aim = i;
      rows.forEach(function (row, k) {
        row.classList.toggle('is-active', k === i);
      });
      if (count) count.textContent = String(i + 1).padStart(2, '0');
      // The gear ratio lives here: many rows glide past, the panel flips one
      // notch per row that takes the bar.
      if (track) track.style.transform = 'translateY(' + -i * 100 + '%)';
    }

    function centreOn(i) {
      viewport.scrollTop = rowCentre(i) - viewport.clientHeight / 2;
    }

    function cancelSnap() {
      if (snapAnim) {
        window.cancelAnimationFrame(snapAnim);
        snapAnim = 0;
      }
    }

    function cancelGlide() {
      if (glideRaf) {
        window.cancelAnimationFrame(glideRaf);
        glideRaf = 0;
      }
    }

    // The snap is the tail of the glide, not a second move: short, eased,
    // and as long as the distance actually is. A long debounce + native
    // smooth scrollTo read as a separate jump once the motion had stopped.
    function snapToRow(i) {
      cancelSnap();
      cancelGlide();
      aim = i;
      var target = rowCentre(i) - viewport.clientHeight / 2;
      var from = viewport.scrollTop;
      var dist = target - from;
      if (Math.abs(dist) < 2) {
        setActive(i);
        return;
      }
      if (reduced) {
        viewport.scrollTop = target;
        setActive(i);
        return;
      }
      var duration = Math.max(150, Math.min(400, Math.abs(dist) * 1.05));
      var start = 0;
      var step = function (ts) {
        if (!start) start = ts;
        var t = Math.min(1, (ts - start) / duration);
        var eased = 1 - Math.pow(1 - t, 3);
        viewport.scrollTop = from + dist * eased;
        updateIndents();
        snapAnim = t < 1 ? window.requestAnimationFrame(step) : 0;
      };
      snapAnim = window.requestAnimationFrame(step);
    }

    // Wheel = continuous browsing at half throttle: each notch advances the
    // target by ~one row, the view eases after it, and the snap still takes
    // over once the gesture runs out. Touch keeps native momentum untouched.
    viewport.addEventListener('wheel', function (event) {
      event.preventDefault();
      if (glideRaf) {
        window.cancelAnimationFrame(glideRaf);
        glideRaf = 0;
      } else {
        glideTarget = viewport.scrollTop; // new gesture starts from rest
      }
      cancelSnap();
      window.clearTimeout(snapTimer);
      var max = viewport.scrollHeight - viewport.clientHeight;
      glideTarget = Math.max(0, Math.min(max, glideTarget + event.deltaY * 0.5));
      var stepGlide = function () {
        var diff = glideTarget - viewport.scrollTop;
        if (Math.abs(diff) < 1) {
          glideRaf = 0;
          viewport.scrollTop = glideTarget;
          return;
        }
        viewport.scrollTop += diff * 0.18;
        glideRaf = window.requestAnimationFrame(stepGlide);
      };
      glideRaf = window.requestAnimationFrame(stepGlide);
      // Gesture end is a silence, not a position: snap 140ms after the last
      // wheel event even if the glide is still converging. Smooth wheels and
      // trackpads stream events long after the finger stopped intending.
      snapTimer = window.setTimeout(function () {
        snapToRow(nearestIndex());
      }, 140);
    }, { passive: false });

    viewport.addEventListener('touchstart', function () {
      cancelSnap();
      cancelGlide();
      window.clearTimeout(snapTimer);
    }, { passive: true });

    viewport.addEventListener('scroll', function () {
      setActive(nearestIndex());
      updateIndents();
      if (snapAnim || glideRaf) return; // our own animation feeds these events
      window.clearTimeout(snapTimer);
      // Snap as soon as the gesture runs out, so it blends into the motion.
      snapTimer = window.setTimeout(function () {
        snapToRow(index);
      }, 90);
    }, { passive: true });

    list.addEventListener('click', function (event) {
      var row = event.target.closest('[data-stream-row]');
      if (!row) return;
      var i = rows.indexOf(row);
      if (i === -1 || i === index) return; // selected row: let the link open
      // First tap on an unselected row just glides it under the bar.
      event.preventDefault();
      snapToRow(i);
    });

    viewport.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        var base = aim >= 0 ? aim : index;
        snapToRow(Math.max(0, Math.min(rows.length - 1, base + (event.key === 'ArrowDown' ? 1 : -1))));
      }
    });

    // The right panel is the small gear: one wheel notch (or one swipe)
    // advances the selection by exactly one row; the left list glides there.
    // Steps queue from `aim` (where we are heading), so fast notches keep
    // advancing instead of re-targeting the row still being animated to.
    var detail = picker ? picker.querySelector('[data-stream-detail]') : null;
    if (detail) {
      var stepLock = 0;

      function stepSelection(dir) {
        var base = aim >= 0 ? aim : index;
        var next = Math.max(0, Math.min(rows.length - 1, base + dir));
        if (next === base) return;
        snapToRow(next);
      }

      detail.addEventListener('wheel', function (event) {
        event.preventDefault(); // this panel never scrolls the page
        // 240ms: one physical notch fires several wheel events (smooth
        // scrolling), and they must all count as that single notch.
        var now = Date.now();
        if (now - stepLock < 240) return;
        stepLock = now;
        stepSelection(event.deltaY > 0 ? 1 : -1);
      }, { passive: false });

      // Touch follows the finger: every 48px of travel steps one row, and the
      // page itself never scrolls while the panel is being dragged.
      var touchY = 0;
      detail.addEventListener('touchstart', function (event) {
        if (event.touches.length === 1) touchY = event.touches[0].clientY;
      }, { passive: true });
      detail.addEventListener('touchmove', function (event) {
        event.preventDefault();
        var y = event.touches[0].clientY;
        var dy = y - touchY;
        if (Math.abs(dy) < 48) return;
        touchY = y;
        stepSelection(dy < 0 ? 1 : -1);
      }, { passive: false });
    }

    function remeasure() {
      if (viewport.clientHeight < 10) return; // details collapsed
      if (index === -1) {
        setActive(0);
        centreOn(0);
        updateIndents();
        return;
      }
      centreOn(index);
      updateIndents();
    }

    // The viewport collapses to zero height while its details is closed.
    // The toggle fires before the expand transition starts, so the real
    // measure point is the body's grid-rows transition end (the toggle
    // listener stays as a fallback for programmatic opens).
    var details = viewport.closest('details');
    var groupBody = details ? details.querySelector('.stream-group__body') : null;
    var onBodyTransition = function (event) {
      if (event.propertyName !== 'grid-template-rows') return;
      remeasure();
    };
    if (details) details.addEventListener('toggle', remeasure);
    if (groupBody) groupBody.addEventListener('transitionend', onBodyTransition);

    window.addEventListener('resize', remeasure);
    pickerTeardowns.push(function () {
      cancelGlide();
      cancelSnap();
      window.removeEventListener('resize', remeasure);
      if (details) details.removeEventListener('toggle', remeasure);
      if (groupBody) groupBody.removeEventListener('transitionend', onBodyTransition);
    });

    remeasure();
  }

  function teardownPageContent() {
    pageObservers.forEach(function (observer) { observer.disconnect(); });
    pageObservers = [];
    while (pickerTeardowns.length) {
      pickerTeardowns.pop()();
    }
  }

  function setupPageContent() {
    setupReveal();
    setupDetails();
    setupToc();
    setupCopyButtons();
    setupStreamPickers();
  }

  function setupCopyButtons() {
    function addCopyButton(container, source) {
      if (!container || container.querySelector(':scope > .code-copy')) return;

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.textContent = 'COPY';
      button.setAttribute('aria-label', '复制代码');

      button.addEventListener('click', function () {
        var text = source ? source.innerText : '';
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () {
            button.textContent = 'COPIED';
            window.setTimeout(function () { button.textContent = 'COPY'; }, 1400);
          });
        }
      });

      container.appendChild(button);
    }

    document.querySelectorAll('.prose figure.highlight').forEach(function (figure) {
      var code = figure.querySelector('.code pre code') || figure.querySelector('pre code');
      addCopyButton(figure, code);
    });

    document.querySelectorAll('.prose > pre').forEach(function (block) {
      var code = block.querySelector('code');
      addCopyButton(block, code || block);
    });
  }

  function wait(duration) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, duration);
    });
  }

  function forceReflow(element) {
    return element.offsetWidth;
  }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function isHomeUrl(url) {
    var target = new URL(url, window.location.href);
    var homePath = new URL(config.homePath || '/', window.location.origin).pathname;
    return target.pathname.replace(/\/+$/, '') === homePath.replace(/\/+$/, '');
  }

  // Reads one of the --post-* timings so JS clean-up stays in step with CSS.
  function cssDuration(name, fallback) {
    var raw = String(
      window.getComputedStyle(document.documentElement).getPropertyValue(name) || ''
    ).trim();
    var value = parseFloat(raw);

    if (!isFinite(value)) return fallback;
    return raw.indexOf('ms') > -1 ? value : value * 1000;
  }

  // Entry for every page but home, in three phases. Phase one is a flat plate
  // with only the seam: the line extends and travels up to the bar. The bar
  // drops in a beat before the line lands, then the content blocks fly in —
  // and the scene (wallpaper + grid + sweep) is the very last thing to load.
  var POST_ENTER_GRACE = 700;
  var postEnterTimers = [];

  function clearPostEnterTimers() {
    for (var i = 0; i < postEnterTimers.length; i++) {
      window.clearTimeout(postEnterTimers[i]);
    }

    postEnterTimers.length = 0;
  }

  function postEnterTimeout(fn, delay) {
    var id = window.setTimeout(fn, Math.max(0, delay));
    postEnterTimers.push(id);
    return id;
  }

  function runLineEnterTransition(transition) {
    if (prefersReducedMotion()) {
      transition.classList.remove('is-running', 'is-held', 'is-pending', 'is-home');
      transition.classList.add('is-line', 'is-complete');
      body.classList.remove('route-animating', 'route-blackout');
      body.classList.add('route-ready');
      if (sceneBackground) sceneBackground.reveal();
      return Promise.resolve();
    }

    transition.classList.remove('is-running', 'is-held', 'is-pending', 'is-home', 'is-complete');
    transition.classList.add('is-line');

    clearPostEnterTimers();

    // Dropping route-ready for one frame restarts the CSS entry animations
    // when arriving from another page that already had it.
    body.classList.remove('route-ready');
    forceReflow(body);
    body.classList.add('route-animating', 'route-blackout');
    body.classList.add('route-ready');
    transition.classList.add('is-running');

    // Summed from the parts rather than read from --post-line-landing: an
    // unregistered custom property holding calc() is returned unresolved.
    var landing =
      cssDuration('--post-line-extend-delay', 500) +
      cssDuration('--post-line-extend-duration', 900) +
      cssDuration('--post-line-travel-duration', 1400);
    var barLead = cssDuration('--post-bar-lead', 400);

    // Last block of the cascade: four stagger steps after the body, and it is
    // the short tail animation that closes the sequence.
    var flyEnd =
      cssDuration('--post-fly-delay', 2950) +
      cssDuration('--post-fly-stagger', 140) * 4 +
      cssDuration('--post-fly-duration-tail', 850);

    // The bar is allowed out before the line is done.
    postEnterTimeout(function () {
      body.classList.remove('route-blackout');
    }, landing - barLead);

    // The scene only loads once the whole article is on screen. Until then the
    // page sits on the flat plate painted in the panel colour.
    postEnterTimeout(function () {
      if (sceneBackground) sceneBackground.reveal();
    }, flyEnd);

    return wait(flyEnd + POST_ENTER_GRACE).then(function () {
      transition.classList.remove('is-running', 'is-held');
      transition.classList.add('is-complete');
      body.classList.remove('route-animating', 'route-blackout');
      body.classList.add('route-ready');
    });
  }

  function holdCurtain(transition, isLine) {
    transition.classList.remove('is-running', 'is-pending', 'is-home', 'is-complete');
    transition.classList.toggle('is-line', !!isLine);
    forceReflow(transition);
    transition.classList.add('is-held');
    body.classList.add('route-animating');
  }

  function runHomeReturnTransition(transition, homeReturn) {
    if (prefersReducedMotion()) {
      // Drop is-held too: it outranks is-complete in the cascade and would
      // otherwise leave the plate parked over the page.
      transition.classList.remove('is-held', 'is-running', 'is-pending', 'is-home', 'is-line');
      transition.classList.add('is-complete');
      homeReturn.classList.remove('is-held', 'is-running');
      homeReturn.classList.add('is-complete');
      body.classList.remove('route-animating');
      body.classList.add('route-ready');
      if (sceneBackground) sceneBackground.reveal();
      return Promise.resolve();
    }

    homeReturn.classList.remove('is-running', 'is-complete');
    homeReturn.classList.add('is-held');
    forceReflow(homeReturn);

    transition.classList.remove('is-held', 'is-running', 'is-home', 'is-line');
    transition.classList.add('is-complete');

    body.classList.add('route-animating');
    homeReturn.classList.remove('is-held');
    homeReturn.classList.add('is-running');

    return wait(1710).then(function () {
      homeReturn.classList.remove('is-running', 'is-held');
      homeReturn.classList.add('is-complete');
      transition.classList.remove('is-held', 'is-running');
      transition.classList.add('is-complete');
      body.classList.remove('route-animating');
      body.classList.add('route-ready');
      if (sceneBackground) sceneBackground.reveal();
    });
  }

  function setupRouteTransition() {
    var transition = document.querySelector('[data-route-transition]');
    var homeReturn = document.querySelector('[data-home-return-transition]');
    if (!transition) return;

    if (
      prefersReducedMotion() ||
      !body.classList.contains('is-inner') ||
      transition.classList.contains('is-complete')
    ) {
      transition.classList.remove('is-running', 'is-held', 'is-pending', 'is-home');
      transition.classList.add('is-complete');
      body.classList.remove('route-animating');
      body.classList.add('route-ready');
      if (!willRunIntro() && sceneBackground) sceneBackground.reveal();
      return;
    }

    // Only posts run the seam. Every other inner page — archive, taxonomy,
    // standalone — is uncovered by the home-return slash.
    if (body.classList.contains('is-post')) {
      runLineEnterTransition(transition);
      return;
    }

    if (homeReturn) {
      // First paint: hold the flat plate so the page never flashes before
      // the slash takes over.
      transition.classList.remove('is-running', 'is-pending', 'is-home', 'is-line', 'is-complete');
      transition.classList.add('is-held');
      runHomeReturnTransition(transition, homeReturn);
      return;
    }

    transition.classList.remove('is-running', 'is-held', 'is-pending', 'is-home');
    transition.classList.add('is-complete');
    body.classList.remove('route-animating');
    body.classList.add('route-ready');
    if (sceneBackground) sceneBackground.reveal();
  }

  function setupPjax() {
    var transition = document.querySelector('[data-route-transition]');
    var exit = document.querySelector('[data-route-exit]');
    var homeReturn = document.querySelector('[data-home-return-transition]');

    // The top progress bar was removed; nothing here depends on it any more.
    if (
      !transition ||
      !exit ||
      !homeReturn ||
      !window.fetch ||
      !window.history ||
      !window.DOMParser
    ) {
      return;
    }

    var navigating = false;
    var queuedNavigation = null;
    var renderedUrl = new URL(window.location.href);
    var scrollFrame = 0;

    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }

    try {
      var initialState = window.history.state || {};
      if (typeof initialState.willowxiScrollY !== 'number') {
        initialState.willowxiScrollY = window.scrollY;
        window.history.replaceState(initialState, '', window.location.href);
      }
    } catch (error) {
      // PJAX still works when the browser restricts history state.
    }

    function persistScroll() {
      try {
        var state = window.history.state || {};
        state.willowxiScrollY = window.scrollY;
        window.history.replaceState(state, '', window.location.href);
      } catch (error) {
        // A failed scroll checkpoint should not interrupt navigation.
      }
    }

    function sameDocument(left, right) {
      return (
        left.origin === right.origin &&
        left.pathname === right.pathname &&
        left.search === right.search
      );
    }

    function finishNavigation() {
      navigating = false;
    }

    function failNavigation(destination, error) {
      if (window.console && window.console.error) {
        window.console.error('WillowXI PJAX navigation failed.', error);
      }

      navigating = false;
      body.classList.remove('route-leaving', 'route-animating');
      body.classList.add('route-ready');
      transition.classList.remove('is-held', 'is-running', 'is-home', 'is-line');
      transition.classList.add('is-complete');
      homeReturn.classList.remove('is-held', 'is-running');
      homeReturn.classList.add('is-complete');
      if (sceneBackground) sceneBackground.reveal();
      window.location.assign(destination.href);
    }

    function fetchPage(destination) {
      return window.fetch(destination.href, {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      }).then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        return response.text();
      }).then(function (html) {
        var documentCopy = new window.DOMParser().parseFromString(html, 'text/html');
        var nextMain = documentCopy.querySelector('[data-pjax-container]');

        if (!nextMain) {
          throw new Error('PJAX container missing');
        }

        return {
          document: documentCopy,
          main: nextMain
        };
      });
    }

    function syncMeta(documentCopy) {
      [
        'meta[name="description"]',
        'meta[property="og:title"]',
        'meta[property="og:description"]',
        'meta[property="og:url"]'
      ].forEach(function (selector) {
        var source = documentCopy.querySelector(selector);
        var target = document.querySelector(selector);
        if (source && target) {
          target.setAttribute('content', source.getAttribute('content') || '');
        }
      });

      var canonical = documentCopy.querySelector('link[rel="canonical"]');
      var currentCanonical = document.querySelector('link[rel="canonical"]');
      if (canonical && currentCanonical) {
        currentCanonical.setAttribute('href', canonical.getAttribute('href') || '');
      }
    }

    function syncNavigation(destination) {
      var currentPath = destination.pathname;
      var homePath = new URL(config.homePath || '/', window.location.origin).pathname;

      document.querySelectorAll('.site-nav__link').forEach(function (link) {
        var linkUrl = new URL(link.getAttribute('href'), window.location.href);
        var linkPath = linkUrl.pathname;
        var isActive = linkPath === currentPath || (
          linkPath !== homePath &&
          linkPath !== '/' &&
          currentPath.indexOf(linkPath) === 0
        );

        link.classList.toggle('is-active', isActive);
        if (isActive) {
          link.setAttribute('aria-current', 'page');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }

    function scrollToDestination(destination, restoreScroll) {
      if (destination.hash) {
        var targetId = destination.hash.slice(1);
        try {
          targetId = decodeURIComponent(targetId);
        } catch (error) {
          // Keep the encoded fragment when it is not valid URI text.
        }

        var target = document.getElementById(targetId);
        if (target) {
          target.scrollIntoView({ block: 'start' });
          return;
        }
      }

      var top = typeof restoreScroll === 'number' ? restoreScroll : 0;
      window.scrollTo({ top: top, left: 0, behavior: 'auto' });
    }

    function applyPage(result, destination) {
      var currentMain = document.querySelector('[data-pjax-container]');
      if (!currentMain) {
        throw new Error('Current PJAX container missing');
      }

      teardownPageContent();
      currentMain.replaceWith(result.main);

      if (result.document.title) {
        document.title = result.document.title;
      }

      syncMeta(result.document);
      ['is-home', 'is-inner', 'is-post'].forEach(function (className) {
        body.classList.toggle(className, result.document.body.classList.contains(className));
      });

      if (sceneBackground) {
        sceneBackground.setWallpaper(result.document.body.getAttribute('data-wallpaper'));
      }

      config.home = isHomeUrl(destination);
      config.introEnabled = false;
      syncNavigation(destination);
      setupPageContent();
      renderedUrl = new URL(destination.href);
    }

    function navigate(destination, options) {
      if (navigating) {
        queuedNavigation = {
          destination: new URL(destination.href),
          options: options || {}
        };
        return;
      }

      var target = new URL(destination.href);
      var reducedMotion = prefersReducedMotion();
      var restoreScroll = typeof options.restoreScroll === 'number'
        ? options.restoreScroll
        : 0;

      persistScroll();
      navigating = true;
      closeNavigation();

      if (!reducedMotion) {
        body.classList.add('route-leaving');
        // Drop any post-entry timers still pending, so a delayed scene reveal
        // cannot fire after the scene has just been hidden.
        clearPostEnterTimers();
        if (sceneBackground) sceneBackground.hide();
      }

      var navigationPromise = Promise.all([
        fetchPage(target),
        reducedMotion ? Promise.resolve() : wait(680)
      ]).then(function (results) {
        if (options.mode === 'push') {
          var nextIndex = Number(window.history.state && window.history.state.willowxiIndex) || 0;
          window.history.pushState(
            {
              willowxiIndex: nextIndex + 1,
              willowxiScrollY: restoreScroll
            },
            '',
            target.href
          );
        }

        var result = results[0];
        // Posts keep the seam; home and every other listing are uncovered by
        // the slash.
        var enteringPost = result.document.body.classList.contains('is-post');

        if (!reducedMotion) {
          holdCurtain(transition, enteringPost);
        }

        applyPage(result, target);
        body.classList.remove('route-leaving');
        scrollToDestination(target, restoreScroll);

        if (reducedMotion) {
          transition.classList.add('is-complete');
          body.classList.remove('route-animating');
          body.classList.add('route-ready');
          return null;
        }

        if (enteringPost) {
          return runLineEnterTransition(transition);
        }

        return runHomeReturnTransition(transition, homeReturn);
      }).then(function () {
        finishNavigation();
      }).catch(function (error) {
        failNavigation(target, error);
      });

      navigationPromise.then(function () {
        if (!queuedNavigation) return;

        var pending = queuedNavigation;
        queuedNavigation = null;

        if (!sameDocument(new URL(window.location.href), renderedUrl)) {
          navigate(pending.destination, pending.options);
        }
      });
    }

    function getPjaxUrl(link, event) {
      if (
        !link ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return null;
      }

      if (link.target && link.target.toLowerCase() !== '_self') return null;
      if (link.hasAttribute('download') || link.dataset.pjax === 'false') return null;

      var rawHref = link.getAttribute('href');
      if (!rawHref || rawHref.charAt(0) === '#') return null;

      var destination;
      try {
        destination = new URL(rawHref, window.location.href);
      } catch (error) {
        return null;
      }

      if (destination.origin !== window.location.origin) return null;
      if (destination.protocol !== 'http:' && destination.protocol !== 'https:') return null;
      if (/\.(?:avif|css|gif|jpe?g|js|json|mp3|mp4|pdf|png|svg|webp|xml|zip)$/i.test(destination.pathname)) {
        return null;
      }
      if (sameDocument(destination, new URL(window.location.href))) return null;

      return destination;
    }

    document.addEventListener('click', function (event) {
      var link = event.target.closest('a[href]');
      var destination = getPjaxUrl(link, event);
      if (!destination) return;

      event.preventDefault();
      navigate(destination, { mode: 'push', restoreScroll: 0 });
    });

    window.addEventListener('popstate', function (event) {
      var destination = new URL(window.location.href);

      if (sameDocument(destination, renderedUrl)) {
        return;
      }

      var restoreScroll = event.state && typeof event.state.willowxiScrollY === 'number'
        ? event.state.willowxiScrollY
        : 0;

      navigate(destination, { mode: 'pop', restoreScroll: restoreScroll });
    });

    window.addEventListener('scroll', function () {
      if (navigating || scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(function () {
        scrollFrame = 0;
        persistScroll();
      });
    }, { passive: true });

    window.addEventListener('pageshow', function (event) {
      if (!event.persisted) return;

      navigating = false;
      renderedUrl = new URL(window.location.href);
      body.classList.remove('route-leaving', 'route-animating');
      body.classList.add('route-ready');
      transition.classList.remove('is-held', 'is-running', 'is-home', 'is-line');
      transition.classList.add('is-complete');
      homeReturn.classList.remove('is-held', 'is-running');
      homeReturn.classList.add('is-complete');
      if (sceneBackground) {
        sceneBackground.setWallpaper(body.getAttribute('data-wallpaper'));
        sceneBackground.reveal();
      }
    });
  }

  onReady(function () {
    sceneBackground = createSceneBackground();
    if (sceneBackground) sceneBackground.init();
    setupTheme();
    setupRouteTransition();
    startIntro();
    setupHeader();
    setupPageContent();
    setupPjax();
  });
})();

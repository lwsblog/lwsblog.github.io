/* WillowXI gallery — /photos/
 *
 * Three jobs, all scoped to the gallery root and all torn down on a PJAX
 * navigation:
 *
 *   1. Scroll-driven screen. The screen is a fixed layer that dissolves its
 *      veil, walks the title into the top-left corner, shrinks the cover into
 *      a print and hands that print back to its own cell in the grid. Each
 *      segment gets its own ease — one shared curve packed the whole thing
 *      into the first 40% of the travel, which the prototype showed plainly.
 *   2. Lightbox with progressive replacement. The 640px thumbnail is already
 *      decoded and in the page, so the first frame costs zero requests; the
 *      1600px file swaps in when it lands. Nothing is re-created per open, so
 *      walking back and forth never re-downloads.
 *   3. Drag. Session-only: the transform is never written to the post or to
 *      storage, so a reload returns the authored order.
 */
(function () {
  'use strict';

  function clamp01(value) {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
  }

  // easeInOutCubic, written out rather than reused from the scene so the two
  // never drift into each other.
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function segment(t, from, to) {
    return easeInOutCubic(clamp01((t - from) / (to - from)));
  }

  function lerp(from, to, t) {
    return from + (to - from) * t;
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function createGallery(root, options) {
    var settings = options || {};
    var screen = root.querySelector('[data-photo-screen]');
    var spacer = root.querySelector('[data-gallery-spacer]');
    var corner = root.querySelector('[data-photo-corner]');
    var main = root.querySelector('[data-photo-main]');
    var lightbox = root.querySelector('[data-photo-lightbox]');

    if (!screen || !spacer || !main) return null;

    var screenImg = root.querySelector('[data-photo-screen-img]');
    var screenVeil = root.querySelector('[data-photo-screen-veil]');
    var screenType = root.querySelector('[data-photo-screen-type]');
    var screenHint = root.querySelector('[data-photo-screen-hint]');
    var frames = Array.prototype.slice.call(root.querySelectorAll('[data-photo-frame]'));

    var reduced = prefersReducedMotion();
    var scrollRange = 1;
    // Where the print comes to rest, projected to the end of the travel.
    // Filled in by measureRange().
    var landing = null;
    var landed = false;
    var frameRequest = 0;
    var detachers = [];

    /* ---- 1. the screen ------------------------------------------------- */

    function viewport() {
      return {
        width: window.innerWidth,
        height: window.innerHeight
      };
    }

    // The print the cover shrinks into. It is a detached node until the
    // animation starts, so it never costs layout while the screen is whole.
    function buildPrint() {
      var cover = frames[0];
      if (!cover) return null;

      var print = document.createElement('figure');
      print.className = 'photo-print';
      print.setAttribute('aria-hidden', 'true');

      var img = document.createElement('img');
      img.className = 'photo-print__img';
      img.alt = '';
      img.decoding = 'async';
      var source = cover.querySelector('[data-photo-frame-img]');
      // The 900px screen file, not the thumbnail: this is the same pixels that
      // were just on screen, so the hand-off has nothing to load.
      img.src = screenImg ? screenImg.getAttribute('src') : (source ? source.getAttribute('src') : '');
      print.appendChild(img);

      var caption = document.createElement('figcaption');
      caption.className = 'photo-print__cap';
      var source2 = cover.querySelector('.photo-frame__cap');
      caption.innerHTML = source2 ? source2.innerHTML : '';
      print.appendChild(caption);

      root.appendChild(print);
      return print;
    }

    var print = null;

    function measureRange() {
      // The travel ends with the first print already on screen — the print's
      // whole point is to land on its own cell, and a cell below the fold is
      // not a landing. So the range is derived from where that cell sits, not
      // from the spacer: the grid below is far taller than the travel, so the
      // document always has room to scroll the rest of the way afterwards.
      var size = viewport();
      var first = frames[0];
      if (!first) {
        scrollRange = Math.max(1, spacer.offsetHeight - size.height);
        return;
      }
      var cellTop = first.getBoundingClientRect().top + window.scrollY;
      var wanted = cellTop - size.height * 0.42;
      var reachable = document.documentElement.scrollHeight - size.height;
      scrollRange = Math.max(1, Math.round(Math.min(wanted, reachable)));

      // The print travels to where its cell WILL BE when the travel ends, not
      // to where the cell happens to be right now. Aiming at the live position
      // sends the print down past the bottom edge for the whole second half —
      // by t=0.65 it is already at y=905 in a 900px viewport, shrinking toward
      // something the visitor cannot see. Projecting the end state instead
      // keeps it on screen for the whole approach and still lands it exactly
      // on the cell, because at t=1 the projection and the cell coincide.
      var endRect = first.getBoundingClientRect();
      landing = {
        centerX: endRect.left + endRect.width / 2,
        centerY: size.height * 0.42 + endRect.height / 2,
        width: endRect.width
      };
    }

    function render(t) {
      var size = viewport();

      // Veil 0.02 -> 0.44. The blur underneath is the scene's own, so fading
      // the veil is the whole reveal.
      var veilT = segment(t, 0.02, 0.44);
      if (screenVeil) screenVeil.style.opacity = String(1 - veilT);

      // Title walks to the top-left corner while the veil is still thinning.
      var titleT = segment(t, 0.12, 0.62);
      if (screenType) {
        var dx = lerp(0, (size.width * 0.06) - (size.width / 2), titleT);
        var dy = lerp(0, (size.height * 0.07) - (size.height / 2), titleT);
        screenType.style.transform =
          'translate(' + dx + 'px, ' + dy + 'px) scale(' + lerp(1, 0.19, titleT) + ')';
        screenType.style.opacity = String(1 - segment(t, 0.5, 0.74));
      }

      if (screenHint) screenHint.style.opacity = String(1 - segment(t, 0, 0.16));

      // Print 0.34 -> 0.80: the cover comes off the screen and becomes paper.
      var printT = segment(t, 0.34, 0.8);
      if (print) {
        var startWidth = size.width * 0.86;
        var endWidth = Math.max(160, landing ? landing.width : 220);
        var width = lerp(startWidth, endWidth, printT);
        var left = lerp(size.width / 2, landing ? landing.centerX : size.width / 2, printT);
        var top = lerp(size.height / 2, landing ? landing.centerY : size.height / 2, printT);
        // display is the switch, not opacity: the print is a fixed layer that
        // would otherwise sit over the grid from the first frame. Kept out of
        // the flow entirely until its segment starts.
        if (printT > 0) print.style.display = 'block';
        print.style.opacity = String(clamp01(printT * 3));
        print.style.width = width + 'px';
        print.style.transform = 'translate(-50%, -50%) translate(' + left + 'px, ' + top + 'px)';
      }

      // The screen image pulls back behind the print as the print comes
      // forward, so the two read as one picture changing state rather than as
      // a print sliding over a photograph. It has to start moving before the
      // print is opaque, or the swap is a hard cut.
      if (screenImg) {
        var recede = segment(t, 0.3, 0.78);
        if (recede > 0) {
          screenImg.style.opacity = String(1 - recede * 0.92);
          screenImg.style.transform = 'scale(' + lerp(1, 0.9, recede) + ')';
        }
      }

      // Screen leaves 0.72 -> 1.00.
      var exitT = segment(t, 0.72, 1);
      screen.style.opacity = String(1 - exitT);
      screen.style.pointerEvents = t > 0.9 ? 'none' : 'auto';

      if (corner) corner.style.opacity = String(segment(t, 0.78, 0.98));

      // Once the screen is gone it is display:none, which also takes its three
      // will-change layers off the compositor. They exist only for the
      // animation; leaving them promoted afterwards would be pure waste.
      if (t >= 1 && !landed) {
        landed = true;
        screen.style.display = 'none';
        if (print) print.style.display = 'none';
        document.body.classList.remove('is-gallery-screen');
      }
    }

    function onScroll() {
      if (landed) return;
      if (frameRequest) return;
      frameRequest = window.requestAnimationFrame(function () {
        frameRequest = 0;
        var t = clamp01(window.scrollY / scrollRange);
        if (settings.onProgress) settings.onProgress(t);
        render(t);
      });
    }

    function onResize() {
      // Both the range and the landing projection are viewport-relative, so a
      // resize has to recompute them before the next frame is drawn.
      measureRange();
      if (landed) {
        screen.style.display = 'none';
        document.body.classList.remove('is-gallery-screen');
        return;
      }
      onScroll();
    }

    function settle() {
      landed = true;
      if (screenVeil) screenVeil.style.opacity = '0';
      if (screenType) {
        screenType.style.opacity = '0';
        screenType.style.transform = 'translate(-50%, -50%)';
      }
      if (screenImg) {
        screenImg.style.opacity = '';
        screenImg.style.transform = '';
      }
      screen.style.display = 'none';
      if (print) print.style.display = 'none';
      if (corner) corner.style.opacity = '1';
      document.body.classList.remove('is-gallery-screen');
    }

    /* The screen is a fixed layer with nothing to wait for, but a broken
     * cover must not leave a black rectangle over the gallery. If the file
     * never arrives the screen retires itself and the grid is simply there. */
    function armScreenFallback() {
      if (!screenImg || screenImg.complete) return;
      var done = false;
      function bail() {
        if (done) return;
        done = true;
        settle();
      }
      screenImg.addEventListener('error', bail, { once: true });
      // Backstop for a request that hangs without erroring.
      window.setTimeout(bail, 6000);
    }

    function initScreen() {
      if (reduced) {
        // No travel and no layers. The screen does not disappear — it stops
        // being a screen and becomes an ordinary header in the flow, so the
        // h1 is still the page's real heading instead of vanishing with it.
        root.classList.add('is-static');
        return;
      }

      print = buildPrint();
      if (print) print.style.display = 'none';
      measureRange();
      armScreenFallback();

      // The bar is themed, the screen is not — in light mode the bar's own
      // text is dark ink, which is unreadable on a dark photograph. This class
      // flips the bar to light-on-dark for exactly as long as the screen is up.
      // The bar stays usable: hiding it (as the home intro does) would strand a
      // visitor who came here to go somewhere else.
      document.body.classList.add('is-gallery-screen');

      // scroll-behavior:smooth turns every wheel notch into a long catch-up,
      // so the screen keeps animating after the visitor has stopped. The
      // gallery opts out for as long as it is on screen.
      document.documentElement.style.scrollBehavior = 'auto';
      detachers.push(function () {
        document.documentElement.style.scrollBehavior = '';
      });

      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onResize, { passive: true });
      detachers.push(function () {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
      });

      // A deep link or a restored scroll position can land past the screen
      // before this runs; render() has to see that, not assume zero.
      onScroll();
    }

    /* ---- 2. lightbox --------------------------------------------------- */

    var lb = {
      index: -1,
      // The 1600px file per index. Kept across opens so the second visit to
      // the same frame is instant.
      loaded: {}
    };

    var lbImg = lightbox ? lightbox.querySelector('[data-photo-lightbox-img]') : null;
    var lbStage = lightbox ? lightbox.querySelector('[data-photo-lightbox-stage]') : null;
    var lbLabel = lightbox ? lightbox.querySelector('[data-photo-lightbox-label]') : null;
    var lbIndex = lightbox ? lightbox.querySelector('[data-photo-lightbox-index]') : null;

    function frameImage(index) {
      return frames[index] ? frames[index].querySelector('[data-photo-frame-img]') : null;
    }

    function fitStage(index) {
      if (!lbStage || !lbImg) return;
      var size = viewport();
      var image = frameImage(index);
      var ratio = 1.5;
      if (image) {
        var w = Number(image.getAttribute('width')) || 3;
        var h = Number(image.getAttribute('height')) || 2;
        ratio = w / h;
      }
      // The print's own padding and caption strip, added on top of the image.
      var chrome = 49;
      // The arrows are 46px wide sitting 24px from each edge, so on a pointer
      // device the stage has to keep clear of them. A touch device has no
      // arrows in the way, and reserving that gutter anyway left the stage
      // 142px wide on a 390px screen — so the gutter is breakpoint-dependent,
      // not a constant.
      var sideGutter = size.width < 760 ? 16 : 140;
      var availableW = size.width - sideGutter * 2;
      // Vertical room: the caption strip and hint live at the bottom, and the
      // close button shares the top with the bar on a phone.
      var availableH = size.height - (size.width < 760 ? 130 : 190);
      var width = Math.max(120, Math.min(availableW, availableH * ratio));
      lbImg.style.width = width + 'px';
      lbImg.style.height = Math.round(width / ratio) + 'px';
      lbStage.style.width = (width + 22) + 'px';
      lbStage.style.height = (width / ratio + chrome) + 'px';
    }

    function showIndex(index) {
      if (!lightbox || index < 0 || index >= frames.length) return;
      lb.index = index;

      var image = frameImage(index);
      if (!image || !lbImg) return;

      // First frame is the thumbnail: decoded, painted, zero requests. The
      // switch to the 1600px file is a plain src swap with no transition —
      // both images are in memory by then, so there is nothing to animate.
      lbImg.src = image.getAttribute('src');
      fitStage(index);

      var caption = frames[index].querySelector('.photo-frame__cap');
      if (lbLabel) lbLabel.textContent = caption ? caption.firstElementChild.textContent : '';
      if (lbIndex) lbIndex.textContent = caption ? caption.lastElementChild.textContent : '';

      var full = image.getAttribute('data-light-src');
      if (full && !lb.loaded[full]) {
        var probe = new Image();
        probe.onload = function () {
          lb.loaded[full] = true;
          // Only swap if the visitor is still on this frame; a fast arrow
          // walk would otherwise land the big image on the wrong one.
          if (lb.index === index && lbImg) lbImg.src = full;
        };
        probe.onerror = function () {
          // Keep the thumbnail. A missing 1600px file is not worth an error.
        };
        probe.src = full;
      } else if (full) {
        lbImg.src = full;
      }
    }

    // .app-shell is a stacking context (z-index 1), so the lightbox cannot
    // climb over the frozen bar from inside it. It is reparented to <body> for
    // as long as it is open and handed back on close, so a PJAX navigation
    // still finds it where the template put it.
    var lightboxHome = lightbox ? lightbox.parentNode : null;

    function openLightbox(index) {
      if (!lightbox) return;
      if (lightbox.parentNode !== document.body) {
        document.body.appendChild(lightbox);
      }
      lightbox.hidden = false;
      document.body.classList.add('is-gallery-open');
      showIndex(index);
      document.addEventListener('keydown', onKeydown);
    }

    function closeLightbox() {
      if (!lightbox || lightbox.hidden) return;
      lightbox.hidden = true;
      document.body.classList.remove('is-gallery-open');
      document.removeEventListener('keydown', onKeydown);
      if (lightboxHome && lightbox.parentNode !== lightboxHome) {
        lightboxHome.appendChild(lightbox);
      }
    }

    function onKeydown(event) {
      if (lightbox.hidden) return;
      if (event.key === 'Escape') {
        closeLightbox();
      } else if (event.key === 'ArrowLeft') {
        showIndex((lb.index - 1 + frames.length) % frames.length);
      } else if (event.key === 'ArrowRight') {
        showIndex((lb.index + 1) % frames.length);
      } else {
        return;
      }
      event.preventDefault();
    }

    function initLightbox() {
      if (!lightbox) return;

      // Grid clicks are delegated from the gallery root…
      root.addEventListener('click', function (event) {
        var hit = event.target.closest ? event.target.closest('.photo-frame__hit') : null;
        if (!hit || !root.contains(hit)) return;
        var frame = hit.closest('.photo-frame');
        var index = frames.indexOf(frame);
        if (index >= 0) openLightbox(index);
      });

      // …but the lightbox's own controls cannot be, because the layer is
      // reparented to <body> while it is open and would fall out of root's
      // subtree. Its listener rides on the element itself.
      lightbox.addEventListener('click', function (event) {
        var target = event.target;
        if (target.closest && target.closest('[data-photo-lightbox-close]')) {
          closeLightbox();
          return;
        }
        if (target.closest && target.closest('[data-photo-lightbox-prev]')) {
          showIndex((lb.index - 1 + frames.length) % frames.length);
          return;
        }
        if (target.closest && target.closest('[data-photo-lightbox-next]')) {
          showIndex((lb.index + 1) % frames.length);
          return;
        }
        // The veil and the caption strip are the only "outside". The stage
        // itself must not close, or a click on the photo loses the frame.
        if (target.classList && target.classList.contains('photo-lightbox__veil')) {
          closeLightbox();
        }
      });

      window.addEventListener('resize', function () {
        if (!lightbox.hidden) fitStage(lb.index);
      });
    }

    /* ---- 3. drag -------------------------------------------------------- */

    function initDrag() {
      var drag = null;

      root.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        var frame = event.target.closest ? event.target.closest('.photo-frame') : null;
        // A press on the zoom control is a click, not a drag.
        if (!frame || !root.contains(frame)) return;
        if (event.target.closest && event.target.closest('.photo-frame__hit')) return;
        if (reduced) return;

        drag = {
          frame: frame,
          startX: event.clientX,
          startY: event.clientY,
          moved: false
        };
      });

      window.addEventListener('pointermove', function (event) {
        if (!drag) return;
        var dx = event.clientX - drag.startX;
        var dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
        if (!drag.moved) {
          drag.moved = true;
          drag.frame.classList.add('is-dragging');
        }
        drag.frame.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
      });

      function endDrag() {
        if (!drag) return;
        if (drag.moved) {
          drag.frame.classList.remove('is-dragging');
          // Left where it was dropped, for this session only.
        }
        drag = null;
      }

      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
    }

    function init() {
      initScreen();
      initLightbox();
      initDrag();
    }

    function destroy() {
      if (frameRequest) {
        window.cancelAnimationFrame(frameRequest);
        frameRequest = 0;
      }
      detachers.forEach(function (fn) { fn(); });
      detachers = [];
      closeLightbox();
      root.classList.remove('is-static');
      document.body.classList.remove('is-gallery-screen');
      frames.forEach(function (frame) {
        frame.style.transform = '';
        frame.classList.remove('is-dragging');
      });
      if (print && print.parentNode) print.parentNode.removeChild(print);
      if (corner) corner.style.opacity = '';
    }

    return { init: init, destroy: destroy };
  }

  window.WillowXIGallery = { create: createGallery };
})();

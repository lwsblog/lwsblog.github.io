/* WillowXI gallery — /photos/
 *
 * Three jobs, all scoped to the gallery root and all torn down on a PJAX
 * navigation:
 *
 *   1. Scroll-driven screen. ONE print shrinks from the middle of the screen
 *      into its own cell in the grid, and ONE masthead carries the title from
 *      the middle of the screen to the top-left corner and stays there. Both
 *      are single elements scaled with a single `transform` per frame:
 *
 *        - the print's box is sized to the target cell once, in JS, and then
 *          only scaled. Same aspect ratio at every size means the crop never
 *          changes, so nothing is re-cropped and no second <img> is created.
 *          The previous build scaled a full-bleed viewport box and handed off
 *          to a fresh <img> that JS built, which read as one photo being
 *          swapped for another.
 *        - the masthead's resting state (position + 21px) lives in the
 *          stylesheet and JS only interpolates transform toward it, so the
 *          title can never disagree with where it was aimed. It is never
 *          faded to 0: the old build faded the screen's type out and faded a
 *          separate corner label in, which read as a blink.
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
    var main = root.querySelector('[data-photo-main]');
    var lightbox = root.querySelector('[data-photo-lightbox]');

    if (!screen || !spacer || !main) return null;

    // The masthead lives OUTSIDE .gallery on purpose: it has to outlive the
    // screen, which is dropped from the layer tree the moment it lands.
    var masthead = document.querySelector('[data-photo-masthead]');
    var mastLabel = document.querySelector('[data-photo-mast-label]');
    var mastSub = document.querySelector('[data-photo-mast-sub]');

    var screenImg = root.querySelector('[data-photo-screen-img]');
    var screenVeil = root.querySelector('[data-photo-screen-veil]');
    var screenHint = document.querySelector('[data-photo-screen-hint]');
    var frames = Array.prototype.slice.call(root.querySelectorAll('[data-photo-frame]'));

    var reduced = prefersReducedMotion();
    var scrollRange = 1;
    // Everything the travel needs, all measured from the target cell:
    //   cell    — the cell's size and where it will be at t=1
    //   screen  — the print's own box at scale 1, and the scale it starts at
    //   mast    — where the masthead starts and where it rests
    // Filled in by measure().
    var cell = null;
    var screenBox = null;
    var startScale = 1;
    var mastFrom = null;
    var mastTo = null;
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

    // One measurement pass per resize: the cell it lands on, the print's box
    // at scale 1, and the masthead's start and rest positions. Everything the
    // per-frame code does is interpolation between numbers captured here, so
    // a resize can never leave the animation aiming at a stale rect.
    function measure() {
      var size = viewport();
      var first = frames[0];

      // --- the print's box, sized to the cell it has to become.
      // The cell's own box already includes its 11px mat and 38px caption
      // strip, and the print uses the same padding, so at scale 1 the two are
      // the same rectangle — which is what makes the hand-off invisible.
      var cellRect = first ? first.getBoundingClientRect() : null;
      var boxW = cellRect ? cellRect.width : Math.round(size.width * 0.42);
      var boxH = cellRect ? cellRect.height : Math.round(boxW * 0.66);
      screen.style.setProperty('--screen-w', boxW + 'px');
      screen.style.setProperty('--screen-h', boxH + 'px');

      // It starts large enough to read as a screen, centred, and on a phone
      // it starts by HEIGHT. There the cell is already full-width, so a
      // width-derived scale lands at 1.0 and the print never grows — the
      // screen and the cell end up the same size and there is no travel to
      // watch. 0.42 rather than 0.52 because the mat and the caption scale
      // with the box: at 0.52 the 26px band under the photo is 100px tall
      // with the date hanging at the very edge.
      // On a desktop the width share is the binding one instead.
      startScale = size.width < 760
        ? (size.height * 0.42) / boxH
        : Math.min((size.width * 0.86) / boxW, (size.height * 0.78) / boxH);

      // --- where the cell will be when the travel ends. The travel ends
      // with the first cell already on screen — a cell below the fold is not
      // a landing — so the range is derived from that cell, not from the
      // spacer. (The grid below is far taller than the travel, so the
      // document always has room to scroll the rest of the way afterwards.)
      var cellTop = cellRect ? cellRect.top + window.scrollY : 0;
      var wanted = cellTop - size.height * 0.42;
      var reachable = document.documentElement.scrollHeight - size.height;
      scrollRange = Math.max(1, Math.round(Math.min(wanted, reachable)));

      cell = {
        // The projection, not the live rect: aiming at where the cell
        // happens to be sends the print past the bottom edge for the whole
        // second half of the travel. At t=1 the two coincide, so the landing
        // is still exact.
        x: cellRect ? cellRect.left : 0,
        y: size.height * 0.42,
        width: boxW,
        height: boxH
      };

      // --- the masthead. Its rest position is the stylesheet's; read it back
      // with the transform cleared so an in-flight frame cannot poison the
      // measurement, then compute where it starts: centred on the screen.
      if (masthead) {
        var parked = masthead.style.transform;
        masthead.style.transform = 'none';
        var rest = masthead.getBoundingClientRect();
        masthead.style.transform = parked;

        // The title reads at 21px in the corner (a stylesheet value) and at
        // 21 × bigScale on the screen, so the screen size is expressed as a
        // ratio of the resting one rather than as a second font-size written
        // from JS. transform-origin is 0 0, so the measured left/top are the
        // element's own top-left and the start offset has to cancel them out
        // — the transform is applied on top of the stylesheet's position, not
        // instead of it.
        //
        // The wish is clamped to the viewport. The block is as wide as its
        // widest line (the frame tally), and 4.2 × 253px is 1063px, which
        // fits 1440 but runs 217px off a 390px phone — the title used to sit
        // at x=-109 there.
        var wish = size.width < 760 ? 2.4 : 4.2;
        var bigScale = Math.min(wish, (size.width * 0.88) / rest.width);
        mastTo = { x: 0, y: 0, scale: 1 };
        mastFrom = {
          x: (size.width - rest.width * bigScale) / 2 - rest.left,
          y: (size.height - rest.height * bigScale) / 2 - rest.top,
          scale: bigScale
        };
      }
    }

    function render(t) {
      // Veil 0.02 -> 0.44. The blur underneath is the scene's own, so fading
      // the veil is the whole reveal.
      var veilT = segment(t, 0.02, 0.44);
      if (screenVeil) screenVeil.style.opacity = String(1 - veilT);
      if (screenHint) screenHint.style.opacity = String(1 - segment(t, 0, 0.14));

      // The print: 0.18 -> 1, one scale, one position, both interpolated
      // linearly in the same eased parameter. Nothing else is written, so the
      // photograph is the same photograph at every frame — including t=0,
      // where the transform still has to be written, because the element's
      // own top-left is 0,0 and an unwritten transform leaves a 215px print
      // sitting in the corner of the screen.
      //
      // The travel has to END at t=1, not short of it. The print's target is
      // a projection — the place the cell WILL be when the travel ends — so
      // any printT that reaches 1 before t=1 parks the print at that spot
      // while the cell is still travelling towards it, and the last stretch
      // of scrolling shows the print hanging in mid-air with the cell sliding
      // up underneath. At 0.92 that was a 97px gap over 155px of scroll, and
      // the snap only happened because the print was display:none'd on arrival.
      // Ending both at t=1 makes the two coincide at every frame's end and
      // leaves no stall to hide.
      var printT = segment(t, 0.18, 1);
      var size = viewport();
      var scale = lerp(startScale, 1, printT);
      var x = lerp((size.width - cell.width * startScale) / 2, cell.x, printT);
      var y = lerp((size.height - cell.height * startScale) / 2, cell.y, printT);
      screen.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + scale + ')';
      // A transform scales a box-shadow and a text-shadow along with their
      // box, so both are divided by the current scale in CSS. Without this
      // the print carries a 315px halo at the start of the travel.
      screen.style.setProperty('--screen-s', scale.toFixed(4));

      // The masthead: the same single transform, running slightly ahead of
      // the print so the title arrives first and waits. It is never hidden.
      if (masthead && mastFrom && mastTo) {
        var titleT = segment(t, 0.06, 0.66);
        var mScale = lerp(mastFrom.scale, mastTo.scale, titleT);
        var mx = lerp(mastFrom.x, mastTo.x, titleT);
        var my = lerp(mastFrom.y, mastTo.y, titleT);
        masthead.style.transform = 'translate(' + mx + 'px, ' + my + 'px) scale(' + mScale + ')';
        masthead.style.setProperty('--mast-s', mScale.toFixed(4));
        // The two small lines belong to the screen, not to the corner. They
        // go early and stay gone — the title is the only thing that travels.
        if (mastLabel) mastLabel.style.opacity = String(1 - segment(t, 0.04, 0.26));
        if (mastSub) mastSub.style.opacity = String(1 - segment(t, 0.04, 0.26));
      }

      // Once the print is down it is display:none, which also takes its
      // will-change layer off the compositor. The layer exists only for the
      // animation; leaving it promoted afterwards would be pure waste. The
      // masthead is untouched by this — it is what stays.
      if (t >= 1 && !landed) {
        landed = true;
        screen.style.display = 'none';
        if (screenHint) screenHint.style.display = 'none';
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
      // Every number the animation uses is viewport-relative, so a resize has
      // to re-measure before the next frame is drawn.
      measure();
      if (landed) {
        screen.style.display = 'none';
        if (screenHint) screenHint.style.display = 'none';
        document.body.classList.remove('is-gallery-screen');
        // The masthead is still on screen after landing, so a resize has to
        // re-aim it or it drifts away from its resting place.
        if (masthead && mastTo) masthead.style.transform = 'none';
        return;
      }
      onScroll();
    }

    function settle() {
      landed = true;
      if (screenVeil) screenVeil.style.opacity = '0';
      if (screenHint) screenHint.style.display = 'none';
      screen.style.display = 'none';
      document.body.classList.remove('is-gallery-screen');
      if (masthead) masthead.style.transform = 'none';
      if (mastLabel) mastLabel.style.opacity = '';
      if (mastSub) mastSub.style.opacity = '';
    }

    /* The print is a fixed layer with nothing to wait for, but a broken
     * cover must not leave a white rectangle over the gallery. If the file
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
        // No travel and no layers. The screen is dropped and the masthead
        // becomes a plain in-flow header, so the h1 is still the page's real
        // heading instead of vanishing with the screen.
        // On <body>, not on .gallery: the masthead is a sibling of .gallery
        // and a descendant selector would never reach it.
        document.body.classList.add('is-gallery-static');
        detachers.push(function () {
          document.body.classList.remove('is-gallery-static');
        });
        return;
      }

      measure();
      armScreenFallback();

      // The bar is themed, the screen is not — in light mode the bar's own
      // text is dark ink, which is unreadable on a dark photograph. This class
      // flips the bar and the masthead to light-on-dark for exactly as long as
      // the screen is up. The bar stays usable: hiding it (as the home intro
      // does) would strand a visitor who came here to go somewhere else.
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
      document.body.classList.remove('is-gallery-static');
      document.body.classList.remove('is-gallery-screen');
      frames.forEach(function (frame) {
        frame.style.transform = '';
        frame.classList.remove('is-dragging');
      });
      // The masthead lives outside .gallery, so a PJAX navigation that
      // replaces the shell would otherwise leave it stranded on the page.
      if (masthead) {
        masthead.style.transform = '';
        masthead.style.removeProperty('--mast-s');
        if (mastLabel) mastLabel.style.opacity = '';
        if (mastSub) mastSub.style.opacity = '';
      }
      screen.style.display = '';
      screen.style.transform = '';
      screen.style.removeProperty('--screen-w');
      screen.style.removeProperty('--screen-h');
      if (screenVeil) screenVeil.style.opacity = '';
      screen.style.removeProperty('--screen-s');
      if (screenHint) {
        screenHint.style.display = '';
        screenHint.style.opacity = '';
      }
    }

    return { init: init, destroy: destroy };
  }

  window.WillowXIGallery = { create: createGallery };
})();

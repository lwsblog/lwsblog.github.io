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
    var acrylic = root.querySelector('[data-photo-acrylic]');
    var spacer = root.querySelector('[data-gallery-spacer]');
    var main = root.querySelector('[data-photo-main]');
    var lightbox = root.querySelector('[data-photo-lightbox]');

    if (!screen || !spacer || !main) return null;

    // The masthead lives OUTSIDE .gallery on purpose: it has to outlive the
    // screen, which is dropped from the layer tree the moment it lands.
    var masthead = document.querySelector('[data-photo-masthead]');
    var mastTitle = document.querySelector('[data-photo-mast-title]');
    var mastLabel = document.querySelector('[data-photo-mast-label]');
    var mastSub = document.querySelector('[data-photo-mast-sub]');

    var screenImg = root.querySelector('[data-photo-screen-img]');
    var screenVeil = root.querySelector('[data-photo-screen-veil]');
    var screenHint = document.querySelector('[data-photo-screen-hint]');
    var frames = Array.prototype.slice.call(root.querySelectorAll('[data-photo-frame]'));

    var reduced = prefersReducedMotion();
    var scrollRange = 1;
    var tailRange = 1;
    // How much scroll is left over after the print has touched down, for the
    // acrylic to lift in. The print lands at t=1 (a projection, so the
    // landing is exact) and the veil then gets this many pixels of extra
    // scroll to leave in. Without the tail the veil would have to start
    // leaving while the print was still airborne, which is exactly when the
    // grid shows the print's own photograph at the spot it is flying
    // towards: one photo, two copies, both legible.
    var TAIL = 260;
    // 🔴 Where the plate closes on the way down, as fractions of the PRINT's
    // own linear parameter posT (so it is relative to the travel, not to a
    // fixed pixel count, and it retraces identically on the way up):
    //
    //   ACRYLIC_FROM — the plate starts closing, and this is the number the
    //                  "the acrylic is not on yet when I start scrolling"
    //                  report is about. Measured on a 390×844 screen: the white
    //                  paper edge comes into the viewport at scrollY 450 (t=0.32)
    //                  and is already 46px wide by scrollY 562 (t=0.40) — while
    //                  at 0.42 the plate was still at k=0.000 there, because
    //                  0.42 of the print parameter is scrollY 529. A bare white
    //                  edge over a fully sharp grid is the visible seam. 0.25
    //                  starts the fade at scrollY 433, just before the edge
    //                  appears, and the print is still covering the viewport
    //                  (its content box is 844px tall against a 844px viewport
    //                  out to t=0.30), so the opening itself stays clean.
    //   ACRYLIC_TO   — the plate is fully closed, and it has to be BEFORE the
    //                  landing cell becomes readable. Measured, the first grid
    //                  cell enters the viewport at posT 0.62 on a 360–430px
    //                  phone and at 0.845 on 1440×900, so 0.55 leaves margin at
    //                  both ends. Verified k=1.000 at the frame the cell touches
    //                  the viewport on 360, 390, 430, 768, 1024, 1280, 1440 and
    //                  1920.
    var ACRYLIC_FROM = 0.25;
    var ACRYLIC_TO = 0.55;
    // Everything the travel needs, all measured from the target cell:
    //   cell    — the cell's size and where it will be at t=1
    //   screen  — the print's own box at scale 1, and the scale it starts at
    //   start   — where the print's top-left sits at t=0 (see measure)
    //   mast    — where the masthead starts and where it rests
    // Filled in by measure().
    var cell = null;
    var screenBox = null;
    var startScale = 1;
    var startX = 0;
    var startY = 0;
    var mastFrom = null;
    var mastTo = null;
    // Not "the screen has landed" but "the screen has been retired": the print
    // stays in the layer tree once it lands so the whole travel can play again
    // on the way up. See the tail of render().
    var retired = false;
    var vacant = false;
    // Latched by the font re-measure and by teardown, so the fonts.ready
    // callback can run at most once per page and never after a PJAX navigation.
    var hasReseat = false;
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

      // --- the print opens FULL-BLEED: the photograph fills the viewport.
      // The box is the cell's aspect ratio (a 3:2 frame with its caption
      // strip is ~1.21:1), not the viewport's, and that ratio has to hold for
      // the whole travel — a non-uniform scale would re-crop the photograph
      // as it shrank and hand off to a cell showing a different crop. So
      // "full bleed" is cover, not stretch: the print is scaled until its
      // CONTENT area (box minus mat) covers the viewport, and the mat itself
      // is pushed off screen. It then slides back into view as the print
      // shrinks, so the paper edge arrives rather than being there all along.
      //
      // Measuring the mat instead of hard-coding it is what keeps this honest
      // across the phone breakpoint, where the padding is 8/8/26 rather than
      // 11/11/38. getComputedStyle reports the untransformed padding, so an
      // in-flight transform cannot poison the number.
      //
      // The box it replaced started at 86% x 78% of the viewport — a screen
      // floating in the middle of the page, which is not what the page opens
      // on. The old phone branch (height * 0.42) existed because a
      // width-derived scale hit 1.0 on a full-width cell and the print never
      // travelled; cover subsumes that case and gives it more travel, not
      // less.
      var cs = window.getComputedStyle(screen);
      var padL = parseFloat(cs.paddingLeft) || 0;
      var padT = parseFloat(cs.paddingTop) || 0;
      var contentW = Math.max(1, boxW - padL - (parseFloat(cs.paddingRight) || 0));
      var contentH = Math.max(1, boxH - padT - (parseFloat(cs.paddingBottom) || 0));
      startScale = Math.max(size.width / contentW, size.height / contentH);
      // The CONTENT area is centred in the viewport, not the box: the mat is
      // asymmetric (11 top / 38 bottom for the caption strip), so centring
      // the box would leave that strip hanging inside the frame and push the
      // photograph off-centre. Offsetting by the mat puts the photograph
      // exactly on the viewport and the paper edge out of sight.
      startX = (size.width - contentW * startScale) / 2 - padL * startScale;
      startY = (size.height - contentH * startScale) / 2 - padT * startScale;

      // --- the landing spot, and the two ranges the travel is measured in.
      // The travel ends with the first cell already on screen (a cell below
      // the fold is not a landing), so the range comes from that cell, not
      // from the spacer.
      var cellTop = cellRect ? cellRect.top + window.scrollY : 0;
      var reachable = document.documentElement.scrollHeight - size.height;
      // A PROJECTION held constant for the whole travel, not the cell's live
      // position. Aiming at the live position makes the print chase a cell
      // that is still below the fold: at t=0.7 that cell is at 959 on a 900px
      // viewport, so the print followed it off the bottom edge and the middle
      // of the travel showed nothing but acrylic. A fixed spot keeps the print
      // on screen from the first frame to the last, and it is still exact,
      // because at t=1 the cell arrives at that spot by construction.
      //
      // Clamped HERE rather than on the range afterwards, and with max not
      // min: 0.42*vh is the spot we want, but if the document is too short
      // to scroll the cell that far up then the deepest position it can
      // reach (cellTop - reachable) is the landing spot instead. Either way
      // print and cell coincide at t=1, which is what makes the landing
      // exact rather than merely close.
      var landY = Math.max(size.height * 0.42, cellTop - reachable);
      scrollRange = Math.max(1, Math.round(cellTop - landY));
      tailRange = Math.max(1, Math.round(Math.min(TAIL, reachable - scrollRange)));

      cell = {
        x: cellRect ? cellRect.left : 0,
        // The projection (see above). Past the landing the per-frame code
        // subtracts the travelled tail from this, which is arithmetically the
        // same as following the cell and keeps the two welded.
        y: landY,
        width: boxW,
        height: boxH
      };

      // --- the masthead. Its rest position is the stylesheet's; read it back
      // with the transform cleared so an in-flight frame cannot poison the
      // measurement, then compute where it starts: centred on the screen.
      //
      // 🔴 What is measured is the title's GLYPH box, via a Range. Neither the
      // element's own box nor the masthead's box will do:
      //   - the masthead's box is as wide as its widest line (the caption,
      //     253.1px) while the title's glyphs are 168px on the desktop, so
      //     centring that box centres the caption's box, not the title;
      //   - the title element is a block, so its box is its parent's content
      //     width, not its text. Measured: 253.1px again.
      // The glyph box is the only honest number, and it is what has to fit the
      // viewport. The stylesheet centres the type inside the box
      // (.photo-masthead is text-align: center), so a measure anchored on the
      // glyphs puts the glyphs on the screen's centre line exactly.
      var anchor = mastTitle || masthead;
      if (masthead && anchor) {
        // 🔴 Measured in TWO steps, and the second one is the one that matters.
        //
        // Step 1, transform cleared: the title's GLYPH box. Neither the
        // masthead's box nor the title's own box will do — the masthead is
        // sized to its widest line (253.1px, the caption) and the title is a
        // block, so its box is that same 253.1px, while the glyphs are 164.6px.
        // The clamp has to be expressed against what actually has to fit: on
        // the box it put the phone title at 1.356× (28px, caption-sized, which
        // is the "not enlarged" report) instead of 2.084× (43.8px).
        //
        // Step 2, transform APPLIED: where the glyphs actually land. A scale
        // does not merely multiply the offset of a left-aligned run — the text
        // is laid out again inside the scaled border box, so it re-centres
        // inside a box that is now s·253.1 wide. Multiplying the untransformed
        // glyph offset by the scale gets this wrong by 141.5px on a 1440px
        // viewport (predicted 779.15 against an actual landing of 814.06), and
        // the error scales with the applied size, so no fixed correction
        // exists. Doing it the other way round — pick the scale, ask the
        // browser where the glyphs landed, then translate by the difference —
        // cannot be wrong about any layout rule.
        var parked = masthead.style.transform;
        masthead.style.transform = 'none';
        // Force a synchronous layout before reading: a rect read in the same
        // task as the transform change can still describe the previous layout.
        void masthead.offsetWidth;
        var rest = anchor.getBoundingClientRect();
        if (mastTitle) {
          var probe = document.createRange();
          probe.selectNodeContents(mastTitle);
          var originGlyphs = probe.getBoundingClientRect();
          // A zero-width glyph box means the title is empty or not laid out;
          // the element box is then the better of the two bad options.
          if (originGlyphs.width) rest = originGlyphs;
        }

        // The clamp protects the margin and is measured against the glyphs:
        // 390×0.88/164.6 = 2.084 on a phone, and 1440×0.88/164.6 = 7.7 on the
        // desktop, where the wish of 4.2 binds instead.
        var wish = size.width < 760 ? 2.4 : 4.2;
        var bigScale = Math.min(wish, (size.width * 0.88) / rest.width);

        masthead.style.transform = 'scale(' + bigScale + ')';
        void masthead.offsetWidth;
        var landed = anchor.getBoundingClientRect();
        if (mastTitle) {
          var probe2 = document.createRange();
          probe2.selectNodeContents(mastTitle);
          var landedGlyphs = probe2.getBoundingClientRect();
          if (landedGlyphs.width) landed = landedGlyphs;
        }
        masthead.style.transform = parked;

        mastTo = { x: 0, y: 0, scale: 1 };
        // translation = target centre − where the scaled glyphs actually are.
        mastFrom = {
          x: size.width / 2 - (landed.left + landed.width / 2),
          y: size.height / 2 - (landed.top + landed.height / 2),
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

      // The print: 0.18 -> 1, one scale, one position, both interpolated in
      // the same eased parameter. Nothing else is written, so the photograph
      // is the same photograph at every frame, including t=0, where the
      // transform still has to be written: the element's own top-left is 0,0
      // and an unwritten transform leaves a 215px print in the corner.
      //
      // `after` is how far past the landing the page has scrolled. For that
      // stretch the print rides its cell — the cell's viewport top is exactly
      // (cell.y - after) — which is what lets the landing stay exact while the
      // acrylic lifts afterwards.
      var after = Math.max(0, window.scrollY - scrollRange);
      // Position runs LINEARLY, scale stays eased. The cell climbs at a
      // constant rate (the page scrolls at one rate), so a print that eases
      // into its position lags the scroll for the whole approach and then has
      // to catch up in the last few percent. At t=0.7 the eased parameter was
      // already 0.99, which pinned the print to a cell still 59px BELOW the
      // fold: the print left the viewport entirely and the middle of the
      // travel showed nothing but acrylic. Linear position keeps the print
      // moving with the scroll from the first frame. Both parameters still
      // finish together at t=1, so the landing is exact either way.
      var posT = clamp01((t - 0.18) / 0.82);
      var printT = segment(t, 0.18, 1);
      var scale = lerp(startScale, 1, printT);
      var x = lerp(startX, cell.x, posT);
      var y = lerp(startY, cell.y, posT) - after;
      screen.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + scale + ')';
      // A transform scales a box-shadow and a text-shadow along with their
      // box, so both are divided by the current scale in CSS. Without this
      // the print carries a 315px halo at the start of the travel.
      screen.style.setProperty('--screen-s', scale.toFixed(4));

      // The masthead runs 0.18 -> 0.62, inside the print's own stretch. It used
      // to run 0.06 -> 0.66 and that start is why the reversal was broken even
      // after the layers stopped being destroyed: coming back up from the
      // landing spot the very first pixel of scroll moved the title, so the
      // header detached from its corner while the print was still sitting at
      // rest on its cell and the acrylic had not begun to move. Starting it at
      // the print's own 0.18 welds the two: nothing moves until the print does,
      // in either direction, and both settle together before the landing.
      // It is never faded: it goes from centred-and-large to parked at its
      // stylesheet position and stays there for the rest of the page. Only the
      // label and the tally leave, and they leave early — they belong to the
      // splash, not to the header.
      if (masthead && mastFrom && mastTo) {
        var titleT = segment(t, 0.18, 0.62);
        var mScale = lerp(mastFrom.scale, mastTo.scale, titleT);
        var mx = lerp(mastFrom.x, mastTo.x, titleT);
        var my = lerp(mastFrom.y, mastTo.y, titleT);
        masthead.style.transform = 'translate(' + mx + 'px, ' + my + 'px) scale(' + mScale + ')';
        masthead.style.setProperty('--mast-s', mScale.toFixed(4));
        if (mastLabel) mastLabel.style.opacity = String(1 - segment(t, 0.04, 0.26));
        if (mastSub) mastSub.style.opacity = String(1 - segment(t, 0.04, 0.26));
      }

      // The acrylic exists for the moment the grid comes into view under the
      // print. Its envelope is a function of the PRINT's own linear parameter,
      // NOT of the acrylic's own progress through the tail.
      //
      // Both ways of driving it from the tail were tried and both are wrong:
      //   - linear in the tail (1 - after/tailRange): a full-strength plate
      //     3px after the landing, so it snapped off the instant the print
      //     touched down and the visitor never saw it;
      //   - eased in the tail (what shipped in f1ab3e8): the easing put the
      //     plate at 0.98 while the print was still at scale 1.93, so by the
      //     time the grid entered the viewport (measured at 90% of the travel,
      //     1743px of 1937px) only the last 10% of the scroll was left to see
      //     anything at all.
      // Driven from the print, the plate is exactly as visible as the print's
      // own approach is long: it closes over the first 10% of the travel (while
      // the print fills the viewport anyway) and holds full strength for the
      // remaining 72% — the whole stretch where the grid is on screen. Then it
      // lifts over the tail once the print has touched down, so the grid is
      // never bare while the print is airborne beside it.
      //
      // A function of t rather than of a one-way flag is also what makes the
      // whole thing reversible for free: scrolling up retraces the envelope
      // exactly, so the plate comes back before the print leaves its cell.
      if (acrylic) {
        // The inverse of the curve below, so the plate's motion and the print's
        // motion stay locked to the same parameter in both directions. Easing a
        // tail-derived value instead would put the two on different clocks and
        // the reversal would run at the wrong speed.
        var kIn = Math.pow(clamp01((posT - ACRYLIC_FROM) / (ACRYLIC_TO - ACRYLIC_FROM)), 1 / 3);
        acrylic.style.setProperty('--acrylic-k', (kIn * (1 - segment(after, 0, tailRange))).toFixed(4));
      }

      // The cell the print is flying towards is EMPTY until the print is
      // sitting on it: with its own photograph on show there, the travel reads
      // as two copies of one image. Not "after it has landed" — AT the landing,
      // where the print covers the cell and the swap happens underneath it, so
      // the print takes over from the cell rather than appearing beside it.
      // One-way on the way down, one-way on the way up, and derived purely from
      // scroll position, so there is no state to drift.
      if (frames.length) {
        var wantVacant = after < 1;
        if (wantVacant !== vacant) {
          vacant = wantVacant;
          frames[0].classList.toggle('is-vacant', vacant);
        }
      }

      // Once the print is down it is taken off the layer tree with
      // `visibility: hidden`, which is what retires its will-change layer: the
      // layer exists for the animation and leaving it promoted afterwards is
      // pure waste. It used to be `display: none` plus a `return` in onScroll,
      // which is what made the travel a one-way trip — after landing there was
      // no print and no listener left, so scrolling back up showed a still
      // page. visibility (not display) keeps the element in the layout and
      // keeps the frame loop running, so the same code both keeps it retired at
      // rest and brings it back the moment the visitor scrolls up: the print
      // rises out of its cell, the cell empties again and the plate closes over
      // the grid before the print is clear of it.
      var wantRetired = after >= tailRange;
      if (wantRetired !== retired) {
        retired = wantRetired;
        screen.style.visibility = retired ? 'hidden' : '';
        // The plate's last job is covering the print's own cell on the way
        // down; once the print is retired there is nothing left for it to hide.
        // Dropped so it cannot sit over the grid while the visitor reads it —
        // and it is put back before the print comes out again, because the
        // class only goes away at rest.
        if (acrylic) acrylic.style.visibility = retired ? 'hidden' : '';
        if (screenHint) screenHint.style.visibility = retired ? 'hidden' : '';
        document.body.classList.toggle('is-gallery-screen', !retired);
      }
    }

    function onScroll() {
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
      onScroll();
    }

    function settle() {
      // The screen's image never loaded. Retire the layers without turning the
      // travel one-way: `retired` stays tied to scroll position, so scrolling
      // up still hands the page back to the masthead and the grid.
      retired = true;
      if (screenVeil) screenVeil.style.opacity = '0';
      if (screenHint) screenHint.style.visibility = 'hidden';
      screen.style.visibility = 'hidden';
      if (acrylic) acrylic.style.visibility = 'hidden';
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

      // The first measure() can in principle run before the web font has
      // landed, and a font swap changes the title's width — which is what the
      // clamp and the centring are measured against. In practice the
      // `void masthead.offsetWidth` above makes the first pass correct even on
      // a cold cache (verified: at 1440×900 and 390×844 with caching disabled
      // the very first frame already reads the real face's 164.6px glyph box),
      // so this is a safety net rather than a fix. It is coalesced into one
      // pass, and `hasReseat` is the teardown latch so a PJAX navigation cannot
      // leave a timer running against a replaced shell.
      detachers.push(function () { hasReseat = true; });
      window.setTimeout(function () {
        if (hasReseat) return;
        hasReseat = true;
        measure();
        onScroll();
      }, 1200);
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
        // The vacant class is scroll state, not authored markup: a PJAX
        // navigation that reuses this DOM must not hand a hidden cell to the
        // next page.
        frame.classList.remove('is-vacant');
      });
      vacant = false;
      retired = false;
      // The masthead lives outside .gallery, so a PJAX navigation that
      // replaces the shell would otherwise leave it stranded on the page.
      if (masthead) {
        masthead.style.transform = '';
        masthead.style.removeProperty('--mast-s');
        if (mastLabel) mastLabel.style.opacity = '';
        if (mastSub) mastSub.style.opacity = '';
      }
      screen.style.display = '';
      screen.style.visibility = '';
      screen.style.transform = '';
      screen.style.removeProperty('--screen-w');
      screen.style.removeProperty('--screen-h');
      if (screenVeil) screenVeil.style.opacity = '';
      screen.style.removeProperty('--screen-s');
      if (acrylic) {
        acrylic.style.display = '';
        acrylic.style.visibility = '';
        acrylic.style.removeProperty('--acrylic-k');
      }
      if (screenHint) {
        screenHint.style.display = '';
        screenHint.style.visibility = '';
        screenHint.style.opacity = '';
      }
    }

    return { init: init, destroy: destroy };
  }

  window.WillowXIGallery = { create: createGallery };
})();

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
    // The exact fractional scroll position at which the print is standing on its
    // cell. Not scrollRange: that is rounded for the progress maths, and the
    // print has to be pinned to the un-rounded spot (see render()).
    var landScroll = 0;
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
    // own linear parameter posT (so it is relative to the travel, not to a fixed
    // pixel count, and it retraces identically on the way up).
    //
    // What this layer is FOR, because that decides when it has to be on: it sits
    // BETWEEN the grid and the print (z-index 20 against the print's 30), so it
    // never dims the print — it blurs and dims everything BEHIND the print, so a
    // photograph in flight does not bleed into the page behind it. The opening
    // is exactly when that matters most, so:
    //
    //   ACRYLIC_FROM / TO — the travel window in which the plate LIFTS. It is
    //     closed over the first fifth of the print's own timeline and open by
    //     posT 0.22 (t=0.36), and it lifts along the print's timeline so the two
    //     are on one clock.
    //
    //     🔴 `FROM` is NOT 0. Forcing the plate to full strength on the opening
    //     frame was tried and reverted: on the light theme the plate's wash is
    //     `rgba(244,245,242,0.78)`, which reads as "the gallery opens on a sheet
    //     of white" as soon as anything is visible under it, and the visitor sees
    //     the grid fade in behind the photograph while they scroll. The opening
    //     frame has the photograph covering the viewport anyway, so a plate there
    //     buys nothing and costs the light theme its opening.
    var ACRYLIC_FROM = 0.06;
    var ACRYLIC_TO = 0.22;
    // Everything the travel needs, all measured from the target cell:
    //   cell    — the cell's size and where it will be at t=1
    //   screen  — the print's own box at scale 1, and the scale it starts at
    //   start   — where the print's top-left sits at t=0 (see measure)
    //   mast    — where the masthead starts and where it rests
    // Filled in by measure().
    var cell = null;
    var screenBox = null;
    // The print's mat, at the two ends of the travel. Written by measure(); the
    // live value is interpolated in render() (see there for why).
    var padStart = null;
    var padRest = null;
    var startScale = 1;
    var startX = 0;
    var startY = 0;
    var mastFrom = null;
    var mastTo = null;
    // Not "the screen has landed" but "the screen has been retired": the print
    // stays in the layer tree at rest so the page can hand over to the grid.
    var retired = false;
    var vacant = false;
    // The pin. Once the acrylic has dissolved there is nothing left for the
    // travel to do, so the page is held there and the animation's layers are
    // erased for good — no reverse playback, so the print can never "suddenly
    // come back and grow" when the visitor scrolls up. `pinEngaged` is the
    // one-way door; `atLimit` is the live lock, released by scrolling down away
    // from the limit and re-armed by coming back up to it.
    var pinEngaged = false;
    var atLimit = false;
    // Last observed scroll position, so the pin can tell UP from DOWN.
    var pinPrevY = 0;
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
      // The cell's own box already includes its mat and caption strip, and the
      // print uses the same padding, so at scale 1 the two are the same
      // rectangle — which is what makes the hand-off invisible.
      var cellRect = first ? first.getBoundingClientRect() : null;
      var shapeW = cellRect ? cellRect.width : Math.round(size.width * 0.42);
      var shapeH = cellRect ? cellRect.height : Math.round(shapeW * 0.66);

      // 🔴 Every number below comes from the CELL, never from the print's own
      // current style. The print's mat is animated (see render), so its padding
      // is a function of the last frame it drew — measuring it here made
      // `startScale` a function of its own previous output and it ran away:
      // re-measuring fed the inflated padding back in as if it were the box, and
      // the scale went 7.45 → 900 → 817 → 360 … (measured), which blew the print
      // up to 132 million pixels wide and left it 10,595px off screen.
      //
      // `getComputedStyle` on the cell reports the stylesheet's padding, because
      // the cell is never written to inline. Clearing the print's own inline
      // padding first gives the same guarantee if it ever is.
      var cellStyle = first ? window.getComputedStyle(first) : null;
      padRest = cellStyle
        ? { l: parseFloat(cellStyle.paddingLeft) || 0,
            t: parseFloat(cellStyle.paddingTop) || 0,
            r: parseFloat(cellStyle.paddingRight) || 0,
            b: parseFloat(cellStyle.paddingBottom) || 0 }
        : { l: 11, t: 11, r: 11, b: 38 };
      var contentW = Math.max(1, shapeW - padRest.l - padRest.r);
      var contentH = Math.max(1, shapeH - padRest.t - padRest.b);
      // The print's box is the CELL's box: content + the mat at its resting size.
      // The mat is written as `rest / scale` every frame (see render), but the
      // BOX never changes — the mat lives inside it, so its size is the resting
      // one throughout and nothing here has to track the animation.
      var boxW = contentW + padRest.l + padRest.r;
      var boxH = contentH + padRest.t + padRest.b;
      screenBox = { contentW: contentW, contentH: contentH };
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
      // 11/11/38.
      //
      // The box it replaced started at 86% x 78% of the viewport — a screen
      // floating in the middle of the page, which is not what the page opens
      // on. The old phone branch (height * 0.42) existed because a
      // width-derived scale hit 1.0 on a full-width cell and the print never
      // travelled; cover subsumes that case and gives it more travel, not
      // less.
      startScale = Math.max(size.width / contentW, size.height / contentH);
      // The mat is counter-scaled every frame so its DRAWN thickness is constant
      // (see render). At scale 1 that is exactly its resting value, so the
      // offsets below are the resting mat times the starting scale — the mat as
      // it is actually drawn on the first frame.
      padStart = { l: padRest.l * startScale, t: padRest.t * startScale,
                   r: padRest.r * startScale, b: padRest.b * startScale };
      // The CONTENT area is centred in the viewport, not the box: the mat is
      // asymmetric (11 top / 38 bottom for the caption strip), so centring
      // the box would leave that strip hanging inside the frame and push the
      // photograph off-centre. Offsetting by the mat puts the photograph
      // exactly on the viewport and the paper edge out of sight.
      startX = (size.width - contentW * startScale) / 2 - padRest.l * startScale;
      startY = (size.height - contentH * startScale) / 2 - padRest.t * startScale;

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
      // 🔴 landY is the print's resting TOP, so the scroll position at which the
      // cell sits there is (cellTop - landY) — and that is NOT an integer
      // (measured: 2315.5 - 378 = 1937.5). Rounding it into scrollRange left the
      // print stuck 0.5px short of its cell at the hand-off: `after` could only
      // reach 0.5 of the tail, so the print froze half a pixel above the cell
      // and the swap on the next frame was a visible jump — half a CSS pixel at
      // dpr 1, a whole DEVICE pixel at dpr 2. Reported as "the print does not
      // reach the frame, so the switch jumps, and it is obvious even when
      // scrolling fast". landScroll keeps the fraction for the pin.
      landScroll = Math.max(0, cellTop - landY);
      scrollRange = Math.max(1, Math.round(landScroll));
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

        // The clamp protects the margin and is measured against the glyphs.
        // Desktop wish 6.5 (was 4.2): the eyebrow and the caption are gone from
        // the opening now, so the heading is the only thing on the photograph
        // and it should read as the opening rather than as a header. The wish is
        // only a ceiling — the 0.88-of-viewport clamp still binds whenever the
        // title is long, which is what keeps a longer title off the edges.
        var wish = size.width < 760 ? 2.4 : 6.5;
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
      // `after` is how far past the LANDING the page has scrolled. Two things
      // about it are load-bearing:
      //   - it is measured from the fractional landScroll, not from the rounded
      //     scrollRange. From scrollRange the value can only reach 0.5 at the
      //     moment the cell arrives (1937 of 1937.5), so the print stopped half
      //     a pixel short and the hand-off was a visible jump;
      //   - the travel is written with the same fractional origin, so at that
      //     scroll position the print's top is exactly cellTop - landY, i.e. the
      //     cell's own top, whatever the scroll fraction or the device pixel
      //     ratio happens to be.
      var after = Math.max(0, window.scrollY - landScroll);
      // Position runs LINEARLY, scale stays eased. The cell climbs at a
      // constant rate (the page scrolls at one rate), so a print that eases
      // into its position lags the scroll for the whole approach and then has
      // to catch up in the last few percent. At t=0.7 the eased parameter was
      // already 0.99, which pinned the print to a cell still 59px BELOW the
      // fold: the print left the viewport entirely and the middle of the
      // travel showed nothing but acrylic. Linear position keeps the print
      // moving with the scroll from the first frame.
      //
      // 🔴 Scale is linear too, on the SAME parameter. Easing it while position
      // ran straight left the print still 1.19× its cell size at the hand-off —
      // measured 40px too wide and 16px too tall against the cell it was supposed
      // to be covering, which is the leftover half of "it sticks and then jumps
      // to the left". Position and size have to arrive together; the easing only
      // changes the shape of the size ramp, and at these scales (7.45 → 1) that
      // is not worth a 40px mismatch on the last frame.
      var posT = clamp01((t - 0.18) / 0.82);
      var scale = lerp(startScale, 1, posT);
      var x = lerp(startX, cell.x, posT);
      var y = lerp(startY, cell.y, posT) - after;
      screen.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + scale + ')';
      // A transform scales a box-shadow and a text-shadow along with their
      // box, so both are divided by the current scale in CSS. Without this
      // the print carries a 315px halo at the start of the travel.
      screen.style.setProperty('--screen-s', scale.toFixed(4));

      // 🔴 The mat is written every frame so that its DRAWN thickness stays put,
      // and this is what fixes "the print is fine and then it sticks and jumps
      // to the left". The transform scales the mat along with the box, so a
      // fixed 11px mat is drawn 11 × 7.45 = 82px thick at the opening — and the
      // photograph's centre then slides 498px sideways in the last 40px of
      // scroll as the mat snaps back to 11px.
      //
      // Counter-scaling it (`rest / scale`) keeps `padding × scale` ≈ rest for
      // the whole travel, so the mat is the same thickness on screen from the
      // first frame to the last. The print's box does not move or resize at all
      // — only the mat inside it — which is why this needs no height maths.
      //
      // At scale 1 the values are the stylesheet's own, so the mat and the
      // cell's mat are the same box and the hand-off is invisible.
      if (padRest) {
        var ms = scale > 0.05 ? scale : 0.05;
        var padT = padRest.t / ms;
        var padR = padRest.r / ms;
        var padB = padRest.b / ms;
        var padL = padRest.l / ms;
        screen.style.padding = (padT.toFixed(2) + 'px ' + padR.toFixed(2) + 'px ' +
          padB.toFixed(2) + 'px ' + padL.toFixed(2) + 'px');
      }

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
        // Two envelopes, and the plate is the STRONGER of them. They cover the
        // two ends of the travel and are measured on different clocks:
        //
        //   1. the OPENING, closed at t=0 and lifted over the print's own
        //      timeline. Driven from the print rather than from the tail: a
        //      tail-derived curve put the plate at 0.98 while the print was still
        //      at scale 1.93, so by the time the grid entered the viewport (90%
        //      of the travel) there was nothing left of the scroll to see it in.
        //      Closed at the very first frame, because the photograph fills the
        //      viewport there and the grid behind it would otherwise be sharp —
        //      the photo then reads as mixed into the page instead of sitting on
        //      it. Reported as "the acrylic is not strong enough on the opening".
        //   2. the TAIL, which lifts the plate once the print has landed so the
        //      grid is never bare while the print is airborne beside it.
        //
        // 🔴 `max`, not a product. The tail envelope is 0 at t=0 (nothing has
        // been scrolled yet) and the opening envelope is 1 there, so multiplying
        // them cancelled the opening completely — measured k=0.0000 with
        // `blur(0px)` on the opening frame, which is exactly the bug being fixed.
        // The two never need to be strong at once, so the stronger one wins.
        //
        // 🔴 And the inverse has to be a real inverse. `start` is clamped at 0,
        // and the visible value it feeds is `start³`, so recovering the un-eased
        // fraction is `plate^⅓` — the cube reads the curve backwards and would
        // force the plate to 0 on the opening frame all over again.
        var aFrom = ACRYLIC_FROM;
        var aTo = ACRYLIC_TO;
        var start;
        if (posT <= aFrom) {
          start = 0;
        } else if (posT < aTo) {
          start = Math.cbrt(clamp01((posT - aFrom) / (aTo - aFrom)));
        } else {
          start = 1;
        }
        var tailK = 1 - segment(after, 0, tailRange);
        acrylic.style.setProperty('--acrylic-k', Math.max(start, tailK).toFixed(4));
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
      // pure waste. `visibility` (not `display`) keeps the element in the layout
      // and keeps the frame loop running so the plate can finish dissolving.
      //
      // 🔴 One-way. It used to come back on the way up (the whole travel was
      // replayable), which is what produced "the print suddenly reappears and
      // grows". The page is pinned at the end of the dissolve (see engagePin),
      // so once that has happened the layers are erased for good.
      var wantRetired = after >= tailRange - 0.001 || pinEngaged;
      if (wantRetired !== retired) {
        retired = wantRetired;
        screen.style.visibility = retired ? 'hidden' : '';
        // The plate's last job is covering the print's own cell on the way
        // down; once the print is retired there is nothing left for it to hide.
        if (acrylic) acrylic.style.visibility = retired ? 'hidden' : '';
        if (screenHint) screenHint.style.visibility = retired ? 'hidden' : '';
        document.body.classList.toggle('is-gallery-screen', !retired);
      }
    }

    /* ---- the pin: no way back into the animation ------------------------ */

    // Where the page is held.
    //
    // 🔴 One pixel past the end of the tail, and the reason is rounding.
    // `landScroll` is fractional (1936.5 here) while `scrollY` is an integer, so
    // at a limit of exactly `landScroll + tailRange` the closest the page can get
    // is 0.5px short of it — `after` stalled at 259.5 of 260, which left the
    // plate at k=0.20 instead of 0. The pin therefore sits at ceil(landScroll +
    // tail) and the erase test uses the same generous comparison.
    //
    // It is NOT scrollRange + tailRange: `tailRange` is clamped to whatever
    // scroll the document has left (`reachable - scrollRange` measured 450px
    // against a requested 260), so adding the raw TAIL could pin past the end of
    // the document — which silently disables the pin, because the browser clamps
    // scrollY to the document end before any handler runs.
    function pinLimit() {
      return Math.ceil(landScroll + Math.min(TAIL, tailRange));
    }

    function engagePin() {
      pinEngaged = true;
      atLimit = true;
      pinPrevY = window.scrollY;
      erase();
    }

    // Erase the travel's layers for good. Nothing puts them back: this runs once.
    function erase() {
      retired = true;
      screen.style.visibility = 'hidden';
      if (acrylic) {
        acrylic.style.visibility = 'hidden';
        // Back to its neutral value as well as off screen: the element is out of
        // the layer tree either way, and a stale 0.2 left on it is a trap for
        // anything that measures the plate instead of looking at it.
        acrylic.style.setProperty('--acrylic-k', '0');
      }
      if (screenHint) screenHint.style.visibility = 'hidden';
      document.body.classList.remove('is-gallery-screen');
      if (masthead) masthead.style.transform = '';
      if (mastLabel) mastLabel.style.opacity = '';
      if (mastSub) mastSub.style.opacity = '';
    }

    // Holding the page is the one interaction that cannot be done by writing
    // styles: every scroll gesture defaults to moving the viewport. There are no
    // global wheel listeners on this site (verified), so a non-passive listener
    // on window can consume the gesture before the browser scrolls — which a
    // `scroll`-event handler cannot, since by then the viewport has already moved
    // and the only cure would be a visible snap back.
    //
    // 🔴 One atomic action per crossing gesture, and NO state to get stale.
    // `atLimit` used to gate this, which left two holes:
    //   - a gesture big enough to clear the limit in one event (measured
    //     deltaY 1600 landing on 2079 against a limit of 2197) was never seen by
    //     this handler, because `atLimit` was still false when it ran;
    //   - swallowing the gesture without moving left the page wherever the last
    //     allowed step had put it.
    // Both are gone if the decision is made from the CURRENT position: any
    // upward gesture within half a viewport of the limit is consumed and the page
    // is placed exactly on the limit, and the gesture is only left to the browser
    // while the page is far enough below it that no part of the step can cross.
    function onWheel(event) {
      if (!pinEngaged) return;
      if ((event.deltaY || 0) >= 0) return;            // downward is free
      var lim = pinLimit();
      var y = window.scrollY;
      if (y <= lim) {
        event.preventDefault();                        // already held: stand still
        return;
      }
      var step = Math.abs(event.deltaY);
      if (y - step < lim + 4) {
        event.preventDefault();
        window.scrollTo(0, lim);
        pinPrevY = lim;
        atLimit = true;
      } else if (y - step < lim + window.innerHeight * 0.5) {
        // Close enough that the browser's own scroll would cross in one go.
        event.preventDefault();
        window.scrollTo(0, lim);
        pinPrevY = lim;
        atLimit = true;
      }
    }

    // The keyboard reaches the same place without a wheel: Home, PageUp and the
    // arrows all scroll up. Blocked only while the lock is armed, so they behave
    // normally anywhere else on the page.
    function onPinKey(event) {
      if (!atLimit || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      var k = event.key;
      if (k === 'Home' || k === 'PageUp' || k === 'ArrowUp') {
        event.preventDefault();
      }
    }

    function onScroll() {
      // 🔴 The pin is checked HERE, on the event, not inside the animation frame.
      // render() only runs on the first frame after a burst of scroll events
      // (`frameRequest` coalesces them), so a check living there never fired for
      // the frame that actually crossed the limit: measured, the page sailed on
      // to y=3000 while the pin sat at 2197 and nothing was ever blocked.
      if (pinEngaged) {
        // The limit constrains UPWARD motion only — it is a "you cannot go back
        // into the animation" rule, not a position the page is glued to:
        //   - scrolling DOWN, past the limit is where the visitor wants to be
        //     (the gallery continues under the fold), so nothing happens;
        //   - scrolling UP, the page is brought back onto the limit and held.
        var y = window.scrollY;
        if (y > pinLimit() && y < pinPrevY) {
          window.scrollTo(0, pinLimit());
          y = pinLimit();
        }
        pinPrevY = y;
        atLimit = y <= pinLimit() + 1;
        return;                          // nothing left to animate
      }
      if (window.scrollY >= pinLimit()) {
        engagePin();
        return;
      }
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
      // Not passive: this one has to be able to consume the gesture (see onWheel).
      window.addEventListener('wheel', onWheel, { passive: false });
      document.addEventListener('keydown', onPinKey);
      detachers.push(function () {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('wheel', onWheel);
        document.removeEventListener('keydown', onPinKey);
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

    // Set once here rather than in the template: this is the only image whose src
    // is written by JS, so its markup cannot carry draggable="false" (it has no
    // src until a frame is opened). An <img> is a native drag source, and a
    // press-and-move on it starts an image drag that opens the file in a new tab
    // instead of doing nothing — the same thing the grid images needed.
    if (lbImg) lbImg.draggable = false;

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
      // Set while a drag is in flight so the click that follows the pointerup
      // does not ALSO open the lightbox. A press on the photograph now starts a
      // drag as well as being the zoom control, and the browser fires `click` on
      // the button after a drag unless something consumes it: measured, moving a
      // frame 150px opened the lightbox at the end of the gesture.
      var swallowClick = false;

      root.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        var frame = event.target.closest ? event.target.closest('.photo-frame') : null;
        if (!frame || !root.contains(frame)) return;
        if (reduced) return;

        // 🔴 The frame's OWN offset has to be read back here, because the
        // transform below is absolute (`translate(dx, dy)`) and a dragged frame
        // already carries one. Writing the bare pointer delta discarded the
        // previous drag: drag it 120×40, drag again 100×30, and it snapped back
        // through the origin to 100×30 — reported as "drag a picture and then
        // drag it again and it teleports back to where it was". `getComputedStyle`
        // is read rather than the inline string so a frame that was never dragged
        // (and so has no transform) reads as 0,0 through the `none` matrix.
        var baseX = 0;
        var baseY = 0;
        var matrix = window.getComputedStyle(frame).transform;
        if (matrix && matrix !== 'none') {
          var parts = matrix.match(/matrix(?:3d)?\(([^)]+)\)/);
          if (parts) {
            var n = parts[1].split(',');
            baseX = parseFloat(n[4]) || 0;
            baseY = parseFloat(n[5]) || 0;
          }
        }

        drag = {
          frame: frame,
          startX: event.clientX,
          startY: event.clientY,
          baseX: baseX,
          baseY: baseY,
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
        drag.frame.style.transform = 'translate(' + (drag.baseX + dx) + 'px, ' +
          (drag.baseY + dy) + 'px)';
      });

      function endDrag() {
        if (!drag) return;
        if (drag.moved) {
          drag.frame.classList.remove('is-dragging');
          // Left where it was dropped, for this session only. The click that the
          // browser is about to deliver must not reach the zoom control.
          swallowClick = true;
          window.setTimeout(function () { swallowClick = false; }, 0);
        }
        drag = null;
      }

      // Capture phase, on the root: the delegated zoom handler is also on the
      // root (bubble phase), so this runs first and stops a drag's tail click.
      root.addEventListener('click', function (event) {
        if (!swallowClick) return;
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
      }, true);

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
      // The pin is state for THIS visit to the gallery: a PJAX navigation must
      // not leave the next page unable to scroll up.
      pinEngaged = false;
      atLimit = false;
      pinPrevY = 0;
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
      // The mat is written inline every frame (see render); hand it back to the
      // stylesheet so the next page in a PJAX navigation starts from its own
      // padding rather than this gallery's last frame.
      screen.style.padding = '';
      screen.style.removeProperty('--screen-w');
      screen.style.removeProperty('--screen-h');
      screen.style.removeProperty('--screen-min-h');
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

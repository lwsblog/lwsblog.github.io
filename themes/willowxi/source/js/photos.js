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
    var particleCanvas = root.querySelector('[data-photo-particles]');
    var screenCap = root.querySelector('[data-photo-screen-cap]');
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
    // Where the PLATE's dissolve runs out. Equal to or longer than tailRange;
    // The plate dissolves over the same distance (see TAIL), so the two finish
    // together. Kept as its own name because that is the thing being reasoned
    // about in render().
    var acrylicTail = 1;
    // How much scroll is left over after the print has touched down, for the
    // acrylic to lift in. The print lands at t=1 (a projection, so the
    // landing is exact) and the veil then gets this many pixels of extra
    // scroll to leave in. Without the tail the veil would have to start
    // leaving while the print was still airborne, which is exactly when the
    // grid shows the print's own photograph at the spot it is flying
    // towards: one photo, two copies, both legible.
    // 🔴 How much scroll the PLATE gets to leave in, and the length of the
    // print's own tail. ONE number for both, because the two have to end
    // together:
    //   - the plate must not begin leaving while the print is still airborne, so
    //     it can never be SHORTER than the print's tail;
    //   - if it is LONGER, the print is erased (tailRange) while the plate is
    //     still half opaque — measured k = 0.48 at the frame the print went — so
    //     the visitor watches the mask dissolve over an empty screen.
    //
    // It was 260 shared with an eyed curve that put nearly all of the change in
    // the last few frames, which measured as a single step: k = 1.000 at y=2177,
    // k = 0.000 at y=2197. Reported as "the mask disappears very harshly once you
    // reach the bottom". 520 spread over the same curve gives the plate a real
    // dissolve.
    //
    // ⚠️ This is the knob to turn if it still feels abrupt: bigger is a longer,
    // softer dissolve. It is clamped to the scroll the document actually has left
    // (`reachable - scrollRange`), so on a short page it shrinks rather than
    // pinning the page past its end.
    var TAIL = 520;
    // How much of that tail the PLATE takes to dissolve, as a fraction. The print
    // uses all of it to finish walking out of the viewport; the plate should be
    // gone well before that.
    //
    // 🔴 It used to be 1.0, and that is what "the global acrylic disappears a
    // little too late" was: measured at 2560x1440, the dissolve ran from y=3006 to
    // y=3526 while the print's box was at top 605 -> 125 (178 tall), i.e. k only
    // reached 0 once the print was essentially off the top of the screen. The
    // visitor therefore watched the mask fade over a photograph that had already
    // left.
    //
    // 0.62 put k=0 at y≈3328, where the print's top is ≈203 — the fade finished
    // while the print was still on screen and still moving, which is what makes it
    // read as the mask being taken off rather than left behind.
    //
    // ⚠️ 0.62 then read as "the mask disappears too fast", so it is 0.88 now: the
    // dissolve runs nearly the whole tail, which is a longer, slower fade. The cost
    // of going all the way to 1.0 is that k only reaches 0 once the print has left
    // the viewport, which is what the earlier complaint was about — 0.88 keeps a
    // little margin so the fade still ends with the print visible.
    //
    // ⚠️ The knob: bigger = dissolves later and slower (closer to the print
    // leaving), smaller = earlier and quicker. Keep it > 0 and <= 1.
    var PLATE_TAIL = 1;
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
    //   ACRYLIC_FROM / TO — the travel window in which the plate LIFTS. `TO` is
    //     past 1.0 on purpose (see the note on the constant itself): the plate used
    //     to be fully up by 0.22 and then frozen, which left the background at
    //     maximum acrylic for the whole second half of the approach.
    //
    //     🔴 `FROM` is NOT 0. Forcing the plate to full strength on the opening
    //     frame was tried and reverted: on the light theme the plate's wash is
    //     `rgba(244,245,242,0.78)`, which reads as "the gallery opens on a sheet
    //     of white" as soon as anything is visible under it, and the visitor sees
    //     the grid fade in behind the photograph while they scroll.
    // 🔴 `ACRYLIC_TO` is 1.15, not 0.22. The plate used to reach FULL strength at
    // 22% of the travel and then hold there until 110% — so for the whole second
    // half the background stayed at maximum acrylic while the print's own frost
    // cleared. Measured at 1440x900: at y=1771 the veil was already 0.000 (the
    // picture fully clear) with the plate still 1.000, and the plate did not begin
    // to go until y=2093. Reported as "by the time the screen picture is sharp the
    // background acrylic is still nearly at full".
    //
    // Running the plate's closure to 1.15 makes the two layers travel together: the
    // plate starts easing off at t=0.35 and is gone by the landing, with PLATE_TAIL
    // (see below) finishing the last of it just past the landing.
    //
    // ⚠️ The closure is BYPASSED while the print is still covering the viewport:
    // the photograph spreads over the whole screen for the first stretch, so a plate
    // there buys nothing and costs the light theme its opening.
    var ACRYLIC_FROM = 0.06;
    var ACRYLIC_TO = 1.00;
    // Where the plate is at FULL strength, on the print's own timeline (posT).
    // 0.35 is just past the point the print visibly starts to shrink, so the
    // background is already clearing through the whole second half — which is
    // what makes the two layers descend together instead of one after the other.
    var ACRYLIC_PEAK = 0.45;
    // 🎛️ How far the SUBSTITUTE blur reaches back from the top: full strength at y = 0,
    // zero at `ALT_RANGE`, linear in between. `window.__altRange` overrides it live.
    //
    // 🔴 This value is the ANSWER TO A QUESTION THE USER ALREADY ANSWERED TWICE, and I
    // spent three rounds not hearing it. They pointed at a screenshot and said "就差不多是
    // 这个位置开始再往上滑就开始渐糊" — i.e. the ramp should START at that position
    // (y ≈ 1764, which is the landing) and build from there all the way to the top. I
    // first read it as "the ramp is too long", then as "add a dead zone", then as "make
    // it very short" — and got "太他妈短了，我刚才说从截图那里开始变糊" for the last one.
    //
    // History of this constant, for the next person: 1200 was too long (hazed the
    // photographs), and anything around 500 or less starts the frost so close to the top
    // that the approach reads as a jump rather than a build. The user's own landmark —
    // the landing — is the value.
    var ALT_RANGE = 1764;
    // 🎛️ How far UP the page the ramp's start is pulled, in px. The user asked for the
    // gradient to begin a little earlier than the landing ("渐变开始点再往上一点"), i.e. the
    // frost should already be faintly present as they arrive rather than starting exactly
    // there. `window.__altLift` overrides it live.
    var ALT_LIFT = 200;
    // 🎛️ Where the title starts flying to its corner. 1 = never (it stays centred and
    // huge, which is the current brief). `window.__titleFrom` overrides it live.
    var TITLE_FROM = 1;
    // 🎛️ The fraction of the travel at which coming back UP re-types the title.
    // 0.5 = half way, the user's "上滑到一半之后就打".
    var TITLE_AT = 0.5;
    // 🎛️ Milliseconds per character. 70 read as too fast, so 110 (~1.8s for the
    // 16-character title). `window.__typeSpeed` overrides it live.
    var TYPE_SPEED = 110;
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
    // The cell the print flies to: a random one from the first two grid rows (see
    // shuffleFrames). Kept separate from `frames[0]`, which is only the DOM head.
    var landingFrame = null;
    var mastFrom = null;
    var mastTo = null;
    // Not "the screen has landed" but "the screen has been retired": the print
    // stays in the layer tree at rest so the page can hand over to the grid.
    var retired = false;
    // Set once the visitor has come back UP past the landing: from then on the
    // acrylic plate plays the substitute blur (see render) instead of the print's
    // travel frost. Cleared by measure() and teardown, so re-entering the gallery
    // always starts on the opening animation.
    var altArmed = false;
    // The scroll position at which the print was retired on THIS visit, or -1 if it
    // has not been yet. The substitute blur is only allowed after this has happened,
    // which is what keeps it off the opening animation. See onScroll.
    var printRetiredAt = -1;
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
    // "the chase still has distance to cover" — see the note in step().
    var bailOut = false;
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
      var first = landingFrame || frames[0];

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
      // A real resize invalidates the latched pin — every input to it is
      // re-derived from the document height here.
      pinY = -1;
      smoothY = -1;                       // a resize restarts the chase on the scroll
      altArmed = false;                   // the opening owns the plate again
      retired = false;                    // the print's one-way latch must reopen
      printRetiredAt = -1;
      // The spacer's authored height, captured BEFORE any shrink so the pin's
      // subtraction has a stable base.
      spacerLocked = false;
      if (spacer) {
        spacer.style.removeProperty('height');
        spacerHeight0 = spacer.getBoundingClientRect().height;
      }
      landScroll = Math.max(0, cellTop - landY);
      scrollRange = Math.max(1, Math.round(landScroll));
      tailRange = Math.max(1, Math.round(Math.min(TAIL, reachable - scrollRange)));
      // The plate finishes earlier than the print — see PLATE_TAIL. Never longer
      // than the tail (the plate must not still be dissolving once the print is
      // erased) and never shorter than a token distance.
      //
      // 🎛️ TUNABLE FROM THE CONSOLE (re-measured on resize / next scroll):
      //     window.__plateTail = 1.0    // default; the tail runs its full length
      //     window.__plateTail = 0.4    // clears much sooner after the landing
      var ptNow = window.__plateTail > 0 ? window.__plateTail : PLATE_TAIL;
      acrylicTail = Math.max(1, Math.round(tailRange * ptNow));

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
      // Veil 0.02 -> 0.62. (Was 0.02 -> 0.44.) The blur underneath is the print's
      // own acrylic, so fading the veil is the whole reveal — and at 0.44 it was
      // gone before the print had travelled a third of the way: "the blur still
      // disappears too fast". 0.62 keeps the frost on the picture for most of the
      // approach and only clears it as the print settles.
      // 🔴 A cubic falloff, not the shared `segment` (easeInOutCubic). The two
      // are opposite shapes for this job: the print's opacity needs to move in the
      // middle, while a frost that is being wiped off should hold at first and then
      // go — and `segment` is flat at BOTH ends, so it dumped most of the change
      // into the middle and the frost was gone by 40% of the travel. Measured with
      // `segment(t, 0.02, 0.62)`: 0.44 at t=0.33 and 0.03 at t=0.50.
      // Reported twice as "the picture's blur still disappears too fast".
      //
      // It starts at t=0.22 — the moment the print begins to shrink and the frame
      // edge shows — and only reaches 0 at t=0.68, so the frost is on the picture
      // for most of the approach.
      // HOLD to 0.75, then fade to nothing at 0.97 — a straight line, so every
      // bit of the scroll carries the same amount of change and there is no step
      // anywhere to read as "it just vanished".
      //
      // 🎛️ TUNABLE FROM THE CONSOLE — the knob for "the picture's frost still
      // clears too fast / too slowly":
      //     window.__veilHold = 0.55   // start the fade earlier
      //     window.__veilEnd  = 0.97   // finish it earlier
      //   Both are fractions of the travel t (0 = top, 1 = print landed). Bigger
      //   numbers = the frost stays on the picture longer.
      if (screenVeil) {
        var veH = window.__veilHold > 0 ? window.__veilHold : 0.75;
        var veE = window.__veilEnd > veH ? window.__veilEnd : 0.97;
        screenVeil.style.opacity = String(1 - clamp01((t - veH) / (veE - veH)));
      }
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
      // 🔴 The travel begins at `TRAVEL_FROM`, and that number is the "空行程" knob.
      //
      // It was 0.18, which at 1440x900 means the print is COMPLETELY still for the
      // first ~350px of scroll — the wheel turns, the page moves, nothing on screen
      // does. Measured before this change: scale 7.454 unchanged from y=0 to y=350.
      // 0.06 cuts that dead zone to ~117px, so the print is visibly leaving its
      // full-bleed size almost as soon as the visitor scrolls.
      //
      // ⚠️ Only the START moved. The landing is still t=1 (`smoothY >= landScroll`),
      // so the hand-off, the retirement point and every probe are unaffected.
      // 🎛️ `window.__travelFrom` overrides it live.
      var TRAVEL_FROM = window.__travelFrom >= 0 ? window.__travelFrom : 0.06;
      var posT = clamp01((t - TRAVEL_FROM) / (1 - TRAVEL_FROM));
      var scale = lerp(startScale, 1, posT);
      var scale0 = scale;
      // 🔴 The target is the PHOTOGRAPH's top-left, not the box's.
      //
      // The print's box is a fixed 215×178 carrying a mat that is counter-scaled
      // (see the padding write below). That mat is drawn `padding × scale` wide,
      // so as the print shrinks the drawn mat thins from 11px to 11px — but the
      // box's own width is constant, which means the CONTENT slides within the box
      // as the scale changes. Driven from the box, the photograph's left edge ends
      // up about 18px to the RIGHT of the cell's before the last few frames pull it
      // back: measured, content centre went 248.8 → 237.6 while the cell's stayed
      // at 237.6, i.e. the photograph drifted right and then snapped left at the
      // landing. That is "the print shifts left after it shrinks".
      //
      // Anchoring the CONTENT instead makes its centre move on one straight line
      // from centre-screen (720) to the cell's centre (237.6) with no reversal;
      // measured after the change, the adjacent-step change never exceeds the
      // per-frame step and there is no overshoot.
      var padNow = padRest ? {
        l: padRest.l / (scale0 > 0.05 ? scale0 : 0.05),
        t: padRest.t / (scale0 > 0.05 ? scale0 : 0.05)
      } : { l: 0, t: 0 };
      var restPad = padRest || { l: 0, t: 0 };
      var x = lerp(startX, cell.x + (padNow.l - restPad.l) * scale0, posT);
      var y = lerp(startY, cell.y + (padNow.t - restPad.t) * scale0, posT) - after;
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
        // 🎛️ `TITLE_FROM` is where the title starts flying to its corner. The user's
        // brief is that the title stays CENTRED and huge for the whole page and only
        // the particles take it away, so the fly is off by default: the interpolation
        // is pinned at its start (`titleT = 0`), which is "centred glyphs at bigScale".
        // Raising this constant (or `window.__titleFrom`) restores the original
        // centre → top-left travel without any other change.
        var titleFrom = window.__titleFrom >= 0 ? window.__titleFrom : TITLE_FROM;
        var titleT = titleFrom >= 1 ? 0 : segment(t, titleFrom, 0.62);
        var mScale = lerp(mastFrom.scale, mastTo.scale, titleT);
        var mx = lerp(mastFrom.x, mastTo.x, titleT);
        if (titleSettled) {
          // Anchored to the viewport at the moment of the re-type. Deliberately the
          // OPENING scale, per "标题就是巨大，不缩小".
          mx = 0;
        }
        // 🔴 The title does NOT follow the scroll any more.
        //
        // It did (`- scrollY`, so it rode up the screen like a placed object), and the
        // user rejected it: "第一次下滑的时候标题不应该上去，应该是飘散的，虽然还没做但是
        // 不能随滚轮上去". The travel's job here is to take the title AWAY — the particle
        // dispersal that replaces it is still to be built — so riding the page was the
        // wrong half of the idea.
        //
        // ⚠️ The particle stage will need a position again, and it should read this
        // element's viewport rect rather than reintroduce a scroll term here: the
        // dispersal starts from where the glyphs are, and that is a screen position.
        var my = titleSettled ? 0 : lerp(mastFrom.y, mastTo.y, titleT);
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
        //   1. the OPENING, closed over the first fifth of the print's own
        //      timeline and open by posT 0.22. Driven from the print rather than
        //      from the tail: a tail-derived curve put the plate at 0.98 while
        //      the print was still at scale 1.93, so by the time the grid entered
        //      the viewport (90% of the travel) there was nothing left of the
        //      scroll to see it in.
        //   2. the TAIL, which lifts the plate once the print has landed so the
        //      grid is never bare while the print is airborne beside it. Its
        //      It shares `tailRange` with the print, so the two finish together
        //      and the plate never dissolves over an empty screen.
        //
        // 🔴 The two envelopes MULTIPLY. They each own one end of the travel and
        // must not be able to hold the plate on at the other:
        //   - `start` is 1 for every posT >= 0.22, which is nearly the whole
        //     travel;
        //   - `tailK` is 1 until the print has landed.
        // `Math.max` of the two therefore pinned the plate at full strength from
        // the landing all the way to the end of the tail — measured k = 1.0000 at
        // every step — and the only thing that ever removed it was `erase()`, one
        // step to 0. That is exactly "the mask disappears very harshly once you
        // reach the bottom".
        //
        // Multiply is correct as long as `start` is a true inverse: it is clamped
        // at 0 and the value it feeds is `start³`, so recovering the un-eased
        // fraction is `plate^⅓` (`Math.cbrt`). The earlier version used `pow(x, 3)`
        // — the cube run backwards — which held `start` at 0 for the whole opening
        // and made the product look broken.
        var aFrom = ACRYLIC_FROM;
        var aTo = ACRYLIC_TO;
        // 🔴 THE PLATE'S OWN DISSOLVE IS ONE CONTINUOUS RUN, not "rise to full then
        // hold then a tail after the landing". The hold was the bug behind "by the
        // time the screen picture is sharp the background acrylic is still nearly
        // full": the plate reached 1.0 at 22% of the travel and stayed there until
        // 110% — measured at 1440x900, the veil was already 0.000 at y=1771 while
        // the plate was still 1.000, and it did not begin to go until y=2093.
        //
        // It now rises over `ACRYLIC_FROM..ACRYLIC_PEAK` and falls over
        // `ACRYLIC_PEAK..ACRYLIC_TO`, so the background is already clearing while
        // the print's own frost is still on the picture and the two layers descend
        // together instead of one after the other.
        //
        // 🎛️ TUNABLE FROM THE CONSOLE — this is the knob for "the background
        // acrylic is still too strong / clears too early":
        //     window.__acrylicPeak = 0.45   // default
        //     window.__acrylicPeak = 0.72   // peak at y≈1560, i.e. the acrylic is
        //                                   // still full when the grid arrives
        //     window.__acrylicPeak = 0.25   // peak at y≈590, clears much sooner
        //   Fraction of `posT`. Bigger = the full-strength point moves later, so the
        //   background stays frosted for longer and clears closer to the landing.
        var acrPeak = clamp01(window.__acrylicPeak > 0 ? window.__acrylicPeak : ACRYLIC_PEAK);
        if (acrPeak <= aFrom + 0.001) acrPeak = aFrom + 0.05;
        if (aTo <= acrPeak + 0.001) aTo = acrPeak + 0.05;
        var plateT = posT <= acrPeak
          ? clamp01((posT - aFrom) / (acrPeak - aFrom))
          : 1 - clamp01((posT - acrPeak) / (aTo - acrPeak));
        // 🔴 LINEAR, not `Math.cbrt`. The cube root has an infinite slope at zero,
        // so the plate went from nothing to a third of its strength in a few pixels
        // — measured, 0.000 at y=446 climbing straight to 1.000 by y=512, i.e. the
        // whole acrylic arriving inside 80px of scroll. That is the jolt: the blur
        // and the tint appear as a step rather than as the plate sliding in, which
        // reads as the content underneath twitching.
        //
        // The cube root was there to match the *original* plate's measured curve,
        // but that curve only ever existed over a 0.06..0.22 window; now that the
        // plate rises across most of the approach, a straight line is both smoother
        // and closer to a physical "the pane slides over the grid".
        var start = Math.max(0, Math.min(1, plateT));
        // The dissolve runs over `acrylicTail` (= tailRange, see TAIL) and it is
        // LINEAR in the scroll, not eased.
        //
        // 🔴 `segment()` here was the other half of "the mask disappears very
        // harshly": easeInOutCubic is flat at both ends, so the whole visible
        // change happened in the middle — measured k = 0.9584 after only 22% of
        // the tail, then 0.6378, 0.1313, 0.0127 in the remaining steps. A plate
        // that holds, dumps, and holds again reads as a cut wherever the visitor
        // happens to be looking. Linear spreads the same blur and tint evenly
        // over the whole dissolve, which is what makes it read as a fade.
        var tailK = 1 - clamp01(after / Math.max(1, acrylicTail));
        // 🎛️ THE SUBSTITUTE BLUR — a SECOND, independent use of the same plate.
        //
        // The plate already carries the print's own travel frost (`start * tailK`).
        // This is a different job: when the visitor scrolls back UP from below the
        // landing, the print does NOT come back (user's decision: no reverse
        // playback), so the plate stands in for it — fully blurred at the top and
        // clearing as they scroll down again. Measured span: `ALT_RANGE` px of
        // scroll from the top.
        //
        // Armed only by coming back up past the landing (`altArmed`), so it never
        // competes with the opening animation on the way in — the opening belongs to
        // the print's own veil, entirely separate (user: "两套动画").
        //
        // ⚠️ Multiplied with `start * tailK`, not assigned: the plate has one value
        // and both jobs have to agree on it.
        var altK = 0;
        // 🔴 The arm test compares against `landScroll` — the CELL's landing — and NOT
        // against `printRetiredAt`. That was the bug in the previous version:
        // `printRetiredAt` is the raw `scrollY` of the frame the print went away, and
        // the retirement is decided on the eased position, so the two are far apart and
        // the gap tracks the layout. Pick a landing cell low in the grid and merely
        // nudging the wheel upwards already satisfies `scrollY < printRetiredAt - 1`, so
        // the substitute blur snapped to full strength instead of growing — "如果我抽到
        // 一张很下面的图的话那我稍微上滑就会触发模糊". `landScroll` is the fixed design
        // landmark (`t = 1`), so the trigger no longer depends on which cell was drawn.
        if (!altArmed && printRetiredAt >= 0 && window.scrollY < landScroll - 1) {
          altArmed = true;
        }
        if (altArmed) {
          // 🔴 The span is the LANDING, not a fixed number.
          //
          // The user's landmark was "就差不多是这个位置" — the place in their screenshot,
          // which is where the print retires. Anchoring to `landScroll` makes the ramp
          // begin exactly at that landmark on every viewport and every landing cell,
          // instead of at a number that happened to be measured at 1440x900. The plate
          // then builds continuously from the first scrolled-to position back to the top,
          // with no dead zone and nothing that reads as a jump.
          var altRange = window.__altRange > 0
            ? window.__altRange
            : (landScroll > 0 ? landScroll : ALT_RANGE);
          // 🎛️ `ALT_LIFT` pulls the START of the ramp UP the page by that many pixels, so
          // the frost is already faintly present as the visitor arrives at the landing
          // instead of only beginning there ("渐变开始点再往上一点"). `window.__altLift`
          // overrides it live; 0 reproduces the landing-anchored version exactly.
          var altLift = window.__altLift >= 0 ? window.__altLift : ALT_LIFT;
          altRange = Math.max(1, altRange - altLift);
          altK = 1 - clamp01(Math.max(0, window.scrollY) / altRange);
        }
        // 🔴 The tint is EITHER the opening's OR the substitute's, never a blend.
        //
        // `max(openTint, subTint)` left the opening curve in charge wherever it was
        // larger, and it peaks in the MIDDLE of the travel, so the darkest frame sat at
        // y≈1000 and the top was lighter — "上滑变成中间最黑上下都白了，我要的是最上面最黑".
        // A crossfade was no better, since the opening curve is still large in the
        // middle. The substitute is a REPLACEMENT for the travel on the way back up, so
        // it simply takes the tint over once armed, and then the shade is a clean
        // function of the scroll position: heaviest at y = 0, gone by `ALT_RANGE`.
        // 🔴 The travel frost belongs to the PRINT, so it goes when the print goes.
        //
        // It is there to frost the background while the print shrinks over it on the way
        // DOWN. Once the print is retired that job is over — but the curve kept running
        // off `scrollY`, so on the way back UP it was still painting a `blur(14-18px)`
        // full-screen plate over the grid the visitor had come back to look at. Measured
        // on the way up: y=1291 → `blur(14.0px)`, y=791 → `blur(17.8px)`, with the
        // substitute at 0 the whole time — i.e. the haze the user was complaining about
        // was never the substitute at all, it was the opening's own frost outliving its
        // animation. "不应该糊，不然我怎么看上面的图".
        // 🔴 NOT a switch. `altArmed ? altK : openTint` threw the plate away the instant
        // the visitor crossed back above the landing: `altK` is 0 far from the top, so the
        // tint fell from the opening's value straight to nothing in one frame — measured
        // in the code path, `blurK` went from 0.73 to 0.28 the moment `altArmed` flipped.
        // A value that drops discontinuously is read as "it suddenly changed", which is
        // exactly what was reported ("到顶突然就糊了" / the earlier "上滑变成中间最黑").
        //
        // `max` cannot do that: it only ever rises, so the substitute can take the plate
        // over smoothly and neither job can yank it away from the other. It also removes
        // the need to reason about which one owns the plate at any given moment.
        var openTint = retired ? 0 : start * tailK;
        var tintK = Math.max(openTint, altK);
        acrylic.style.setProperty('--acrylic-k', tintK.toFixed(4));
        acrylic.style.setProperty('--acrylic-alt', altK.toFixed(4));
        // Same rule for the radius: it is the stronger of the two, but the opening's half
        // of it is now gated on the print still being live.
        var blurK = Math.max(openTint, altK);
        acrylic.style.setProperty('--acrylic-blur', blurK.toFixed(4));
        // 🔴 Keep the plate VISIBLE and let `--acrylic-k` alone decide how much it
        // shows (k = 0 means `rgba(...,0)` and `blur(0px)`, i.e. nothing painted).
        //
        // Toggling `visibility` per state cost two rounds of bugs: tying it to the
        // print's retirement hid the plate for the whole way back up, so the substitute
        // blur was computed and never seen (measured: k = 0.9340, blur(20.5px),
        // visibility: hidden); and once other paths also wrote `visibility`, whichever
        // ran last won. `visibility` was only ever an optimisation for the promoted
        // layer, and the plate is a single layer — the state machine for it is not
        // worth another bug.
        acrylic.style.visibility = '';
      }

      tickTitle();

      // The cell the print is flying towards is EMPTY until the print is
      // sitting on it: with its own photograph on show there, the travel reads
      // as two copies of one image. Not "after it has landed" — AT the landing,
      // where the print covers the cell and the swap happens underneath it, so
      // the print takes over from the cell rather than appearing beside it.
      // One-way, on both legs. `after` is `max(0, scrollY - landScroll)`, so it falls
      // back below 1 as soon as the visitor scrolls back up past the landing — and a
      // reversible test therefore RE-HID the cell on the way up: measured, the cell
      // went `visible` at y=3379 and `hidden` again at y=3079, so the photograph the
      // print had handed over to simply disappeared ("上滑的时候屏风图对应的那张图消失了").
      // The vacancy belongs to the print's retirement, which is one-way itself, so it
      // is derived from `retired` rather than re-decided from the scroll each frame.
      if (frames.length) {
        // 🔴 INVERTED, and that was the bug behind "上滑的时候屏风图对应的那张图消失了".
        // The cell is hidden while the PRINT stands on it (otherwise the travel shows
        // two copies of one photograph) and must be VISIBLE once the print is gone,
        // because that is the hand-over. Deriving it the same way round as the print
        // left it hidden for ever: measured at the landing itself,
        // `cellVacant: true, cellVis: hidden` — the grid kept a hole where the
        // photograph should have been.
        var wantVacant = !retired;
        if (wantVacant !== vacant) {
          vacant = wantVacant;
          (landingFrame || frames[0]).classList.toggle('is-vacant', vacant);
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
      // 🔴 Retires AT the landing, not `tailRange` past it (user, 2026-10-04):
      // "屏风图连带相框在到位之后直接消失露出底部的原图，不然我把屏风图拖走之后
      // 还留了一个屏风在原地拖不走很诡异".
      //
      // The old form waited for `after >= tailRange` (520px beyond the landing) OR
      // the pin engaging. Both of those stopped happening when the up-scroll limit
      // was turned off, so the print simply stayed parked on its cell — and since the
      // cell hides itself (`is-vacant`) the visitor was left with a printed frame
      // sitting on the grid that could be dragged around but that nothing removed.
      //
      // `LAND_RETIRE = 0` means "the moment the print is exactly on its cell". Raise
      // it (in px of overscroll) to let the print linger before it goes, or set the
      // pin back on (`PIN_ENABLED`) to get the old pinned behaviour wholesale.
      //
      // ONE-WAY: the print does not come back on the way up (user's choice).
      // ⚠️ The test is the RENDERED position (`smoothY`), not `scrollY`. The scroll
      // position jumps in whole pixels and, with a glide, arrives well before the
      // print does — measured, `scrollY` reached 1950 and retired the print while it
      // was still at scale 1.3535 and 26px above its cell, so the cell's own
      // photograph appeared underneath a print that was still shrinking. That overlap
      // is the "卡顿闪动" at the landing. `smoothY` is where the print actually is, so
      // the flip happens on the frame the two are coincident.
      var LAND_RETIRE = window.__landRetire >= 0 ? window.__landRetire : 0;
      // 🔴 ONE-WAY, and it was NOT — that was a misreading of the brief. The user
      // chose "屏风图不回来" (the print does not return) and separately asked for
      // "删掉屏风倒放动画", but the value below was left reversible, so scrolling back up
      // ran the whole travel backwards: "没变化啊，还是屏风图倒放".
      //
      // ⚠️ `smoothY >= 0` guards the LATCH against the warm-up frame. `smoothY` starts
      // at -1 and `step()` only rewrites it to `scrollY` AFTER it has already computed
      // `t = smoothY / scrollRange` and called render with that — so the very first
      // frame renders at t ≈ -0.0004, which is below the landing test... except that a
      // NEGATIVE value is not below it, it is *above*: `-1 >= landScroll` is false, so
      // this looked safe. The damage came from the caller, which passes `smoothY = -1`
      // straight through on that frame. Whatever the route, the latch must not be
      // allowed to fire before the chase has started, because it can never be undone
      // without a re-measure — that is the "首页加载好之后屏风自动消失了".
      var wantRetired = retired || (smoothY >= 0 && smoothY >= landScroll + LAND_RETIRE - 0.5);
      if (wantRetired !== retired) {
        retired = wantRetired;
        // 🔴 Recorded HERE, not in `erase()`. `erase()` is reachable only from
        // `engagePin()`, and the pin is switched off (`PIN_ENABLED = false`), so it
        // never runs — the retirement above is what actually puts the print away now.
        // With the marker left in `erase()` it stayed at -1 for ever, so the
        // substitute blur never armed and `--acrylic-alt` read 0 on the whole way back
        // up (measured).
        if (retired) printRetiredAt = window.scrollY;
        screen.style.visibility = retired ? 'hidden' : '';
        // ⚠️ The plate's visibility is NOT decided here any more. Tying it to the
        // retirement hid the plate for the rest of the visit — and the substitute blur
        // needs exactly that plate on the way back up, so it was computed and never
        // seen: measured on the way up, `--acrylic-k` reached 0.9340 with a
        // `blur(20.5px)` and `visibility: hidden`. It is set per frame in the acrylic
        // block instead.
        if (screenHint) screenHint.style.visibility = retired ? 'hidden' : '';
        document.body.classList.toggle('is-gallery-screen', !retired);
      }
    }

    /* ---- the pin: no way back into the animation ------------------------ */

    // Where the page is held: the point at which the PLATE has finished
    // dissolving, so the last thing the visitor scrolls through is the fade.
    //
    // `landScroll + acrylicTail`, ROUNDED rather than ceiled: a fractional
    // `landScroll` (3005.7 at 2560x1440) against an integer `scrollY` needs the
    // nearest integer, and `Math.ceil` would overshoot the end of the dissolve by
    // design (measured once: `after` 260.5 against a tail of 260, which cut the
    // fade off in its final frame).
    //
    // `acrylicTail` is clamped to the scroll the document actually has left, and
    // it is SHORTER than the print's own `tailRange` (see PLATE_TAIL) — so the
    // plate reaches 0 before the print stops moving, which is what makes the fade
    // readable. The print's remaining walk-out happens below the pin and is
    // simply never scrolled back through.
    // 🔴 The limit is LATCHED when the pin engages, and then never recomputed.
    //
    // Both of its inputs come from the document's height (`landScroll` is
    // `cellTop - landY` and `landY` is clamped by `reachable`; `acrylicTail` is
    // `reachable - scrollRange`), so a `scrollY` that does not belong to this
    // layout — a restored position from the previous document, a resize — yields a
    // different limit for the same page. That is not theoretical: measured on a
    // 390x844 run that reused one tab across three viewports, the limit came out
    // **0** and every upward gesture went straight to the top of the page.
    //
    // Latched, the pin is one number for the visit, so `onScroll` compares against
    // exactly the value it engaged at and there is nothing to oscillate between.
    // `measure()` clears it (a real resize has to re-derive the geometry) and so
    // does teardown.
    var pinY = -1;
    // "The motion is upward and we are past the limit" — kept while that is
    // true so every momentum scroll event re-applies the clamp. See onScroll.
    var holding = false;
    // The last scroll position seen BEFORE any clamp, so the page's own
    // correction is not mistaken for a downward scroll.
    var lastRawY = 0;
    // Set once the spacer has been shrunk to the limit, so the one-shot edit is not
    // repeated and cannot chase its own output. Cleared by measure() and teardown.
    var spacerLocked = false;
    // The spacer's authored height, captured in measure() (before any shrink), so
    // the subtraction has a stable base. -1 = not measured yet.
    var spacerHeight0 = -1;
    // The position the ANIMATION is drawn at: it chases `scrollY` over a few frames
    // so a discrete wheel notch does not move the print in one jump. -1 = unset.
    // See step(); the pin and every scroll rule still read the real `scrollY`.
    var smoothY = -1;
    // Consecutive upward notches taken while the page is pinned at the limit. One is
    // "hold me here"; two is "let me back into the travel". See onWheel / escapePin.
    var upStreak = 0;

    // 🎛️ THE UP-SCROLL LIMIT IS OFF, at the user's request (2026-10-04):
    // "上滑不要做限制了，我想到倒放动画这么改了" — they want to handle the way back
    // with a reversed animation instead, so the travel must be reachable in both
    // directions and nothing may hold the page.
    //
    // 🔴 Flip this to `true` to get the pin back. Everything it needs is still here
    // and tested (`esc5` 18/18, `pin4` 4/4 at 2f7d545); with it off, `pinLimit()`
    // returns Infinity, `onScroll` never engages, `onWheel` never intercepts and
    // `shrinkToPin` never shortens the document — which also removes the PJAX return
    // pollution, because that was caused by the shortened document being restored.
    var PIN_ENABLED = false;

    function pinLimit() {
      if (!PIN_ENABLED) return Infinity;
      return pinY >= 0 ? pinY : Math.round(landScroll + Math.max(1, acrylicTail));
    }

    // 🔴 ESCAPING THE PIN — the other half of "flicking the wheel up does nothing".
    //
    // The pin is a one-way door while it is engaged: `onWheel` insists the visitor
    // stay at the boundary, so once they reached it they could not scroll back into
    // the travel at all. Measured: at y=2457 with the limit at 2457, five upward
    // notches moved the page 2457 → 2457, and the script could still reach y=0 — so
    // it was the handler, not the document.
    //
    // The rule that separates the two cases is the ONE-WAY nature of the boundary:
    //   - an upward notch that would land the page ABOVE the limit  → block it;
    //   - an upward notch taken when there is a full step of room  → the visitor is
    //     going back to the travel, so release the pin and let it through.
    // Releasing restores the layers and clears the latched limit, so the travel
    // re-animates on the way back up and `reviewPin` re-engages on the way down.
    //
    // ⚠️ The spacer is deliberately NOT restored here. Re-inflating the document
    // mid-gesture is a layout change during a scroll, which is exactly the class of
    // thing that has produced the jolts reported so far; `measure()` restores it on
    // a resize, and `destroy()` on teardown.
    function escapePin() {
      if (!pinEngaged) return;
      pinEngaged = false;
      atLimit = false;
      holding = false;
      pinPrevY = window.scrollY;
      lastRawY = window.scrollY;
      pinY = -1;
      smoothY = -1;                  // the travel restarts from wherever they are
      if (screen) {
        screen.style.visibility = '';
        screen.style.opacity = '';
      }
      if (acrylic) acrylic.style.removeProperty('visibility');
      if (screenHint) screenHint.style.removeProperty('visibility');
      document.body.classList.add('is-gallery-screen');
    }

    // 🔴 Make the limit PHYSICAL instead of fighting for it.
    //
    // Everything before this tried to HOLD the visitor at the limit: cancel the
    // wheel events, write the position back from `scroll`, set the root to
    // `overflow: hidden`, write it back from `scrollend`. All four are beatable for
    // the same reason — the browser runs its own scroll animation on its own thread,
    // and a position written while that is in flight gets overridden by it (measured
    // again and again: wrote the limit, page settled a whole notch past it). That is
    // why every discrete-notch probe said "pinned" while a real flick walked to the
    // top.
    //
    // Shrinking the spacer removes the problem instead of solving it: the document
    // simply ENDS at the limit, so there is nothing above it for any input to scroll
    // into — momentum, keyboard, scrollbar drag or script. The browser clamps the
    // position itself, which is what makes this the only version that holds.
    //
    // 🔴 Computed from the spacer's AUTHORED height (`scrollHeight - spacer`), not
    // from the current `scrollHeight`. Deriving it from the live height makes the
    // calculation chase its own output: after the first shrink the "excess" is
    // recomputed against the new, already-correct height and comes out ~0, so
    // subsequent calls quietly do nothing (measured — the spacer stayed at 2160 and
    // the document stayed 900px too tall).
    function shrinkToPin() {
      if (!spacer || pinY < 0 || spacerLocked) return;
      if (window.scrollY < pinY) return;       // not at the limit yet; leave it alone
      // 🔴 Both numbers are taken from the DOCUMENT, never from `pinY` and never
      // from the live `scrollHeight`. `pinY` is the frame the pin happened to
      // engage on, which is whichever notch carried the page past the limit — so
      // using it as the target parks the page a whole notch past the intended fade
      // point (measured: 2395 against a fade end of 2259). The target is the fade's
      // own end; the document's height only participates as a difference, which is
      // stable because both sides are read in the same instant.
      if (spacerHeight0 < 0) return;
      // 🔴 What was wrong with `Math.min(pinY, fadeEnd)`: a wheel notch is ~100px,
      // so the page always comes to rest a little ABOVE the fade end. Cutting the
      // document back to the fade end then drags the visitor up to it, AND leaves
      // them with the limit exactly under their feet — no scroll room at all, so the
      // next gesture did nothing ("sometimes nothing happens when I flick up").
      //
      // The document now ends at the point the visitor actually reached, plus a
      // screen of room below it. Nothing above that point is reachable (which is the
      // whole point), and there is always somewhere to go.
      var room = Math.min(window.innerHeight * 0.5, 420);
      // 🔴 `pinY + 2 * room`, not `pinY + room`. `pinY` is the frame the pin engaged
      // on, which is already ABOVE the fade end; adding a single screen of room on
      // top of it leaves the document ending that much higher again, and the page
      // then holds a whole notch BELOW the limit (measured: 2311 against 2395, on all
      // four viewports, i.e. always exactly one room short).
      var target = Math.max(pinY, Math.round(landScroll + Math.max(1, acrylicTail))) + room * 2;
      var excess = (document.documentElement.scrollHeight - window.innerHeight) - target;
      if (excess <= 1) { spacerLocked = true; return; }
      spacer.style.setProperty('height', (spacerHeight0 - excess) + 'px', 'important');
      spacerLocked = true;                     // one shot; a resize re-measures
    }

    function engagePin() {
      pinEngaged = true;
      atLimit = true;
      pinPrevY = window.scrollY;
      lastRawY = window.scrollY;
      holding = false;
      if (pinY < 0) pinY = Math.round(landScroll + Math.max(1, acrylicTail));
      shrinkToPin();
      erase();
    }

    // Erase the travel's layers for good. Nothing puts them back: this runs once.
    function erase() {
      retired = true;
      printRetiredAt = window.scrollY;
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
    // styles: every scroll gesture defaults to moving the viewport.
    //
    // 🔴 `preventDefault()` is NOT enough on its own, and that is why "scroll to
    // the bottom, then one flick up and you are at the top" survived three
    // attempts at fixing it. A wheel gesture with any inertia (a trackpad, a
    // smooth-scrolling mouse, Edge's own smooth scroll) keeps moving the viewport
    // after the events stop arriving, and cancelling the events does not cancel
    // the momentum already under way. Measured on a headless run that only sends
    // discrete notches it looks perfect — every delta from 100 to 2000 pinned —
    // which is exactly why this was reported as "still not fixed" while the probe
    // said otherwise.
    //
    // The listener's job is now only to know that the visitor is pushing UP at
    // the limit (so `onScroll` holds them there). The holding itself is done by
    // putting the position back, which works whatever produced the motion —
    // momentum, a keyboard, a scrollbar drag, or a script.
    // 🔴 How the hold actually works — three attempts got this wrong, so the
    // shape matters:
    //
    //   `wheel`      — knows the visitor is pushing UP, and cancels the events it
    //                  can (preventDefault). It must NOT touch layout: an earlier
    //                  version flipped the root to `overflow: hidden` here, which
    //                  removed and restored the scrollbar on every direction change
    //                  and shook the whole page left and right.
    //   `scroll`     — puts the position back, but CANNOT be relied on alone: a
    //                  `scrollTo` issued while the browser's own smooth scroll is
    //                  in flight is overridden by it (measured: wrote 2259, page
    //                  stayed at 2163, every notch).
    //   `scrollend`  — the fix. It fires when the gesture and its momentum have
    //                  genuinely finished, so nothing is animating and a position
    //                  written there sticks. Once per gesture, so nothing jitters.
    function onWheel(event) {
      if (!pinEngaged) return;
      // 🔴 An upward gesture ARMS the hold directly, from the wheel event.
      //
      // Waiting for the position to prove the motion was upward is too slow by one
      // frame: the wheel event arrives while the page is still a few pixels past the
      // limit (`atLimit` false), the handler does nothing, the browser scrolls its
      // notch, and only then does the scroll event see what looks like a downward
      // move. Measured: one notch walked the page 2263 → 2163 with the limit at
      // 2259 and the pin never fired — which is exactly the "one flick and you are
      // at the top" report, and it survived every earlier fix because a
      // discrete-notch probe never lands in that state.
      //
      // A downward gesture releases it, so the content under the fold stays
      // reachable in both directions.
      var lim = pinLimit();
      if ((event.deltaY || 0) < 0) {
        // 🔴 ONLY the CROSSING notch is intercepted. The old form —
        // `if (window.scrollY <= lim) event.preventDefault()` — also cancelled every
        // upward notch taken once the page was already at or below the limit, so a
        // visitor who had scrolled down could never get back: measured, at y=2457
        // with the limit at 2457, five upward notches moved the page 2457 → 2457
        // while the script could still reach y=0. That was the handler, not the
        // document, and it is the "flicking the wheel up does nothing" report.
        //
        // 🔴 The FIRST notch at the limit is still blocked — that is the behaviour
        // asked for repeatedly ("flick up once and you are at the top" must not
        // happen). A SECOND consecutive upward notch is a different statement: the
        // visitor has asked twice, so they mean to go back into the travel, and the
        // pin is released. The two requirements are otherwise mutually exclusive,
        // and this is what satisfies both: one notch = stay, keep pushing = leave.
        var step = Math.abs(event.deltaY || 0) || 100;
        if (window.scrollY - lim < step) {
          holding = true;
          upStreak += 1;
          if (upStreak >= 2) {
            upStreak = 0;
            escapePin();
            return;                      // let this notch scroll
          }
          event.preventDefault();
        } else {
          escapePin();
          return;
        }
      } else {
        holding = false;
        upStreak = 0;
      }
      atLimit = window.scrollY <= lim + 1;
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
        //   - scrolling UP, the page is put back on the limit and held there.
        //
        // This handler records the direction and does a best-effort correction; the
        // correction that actually sticks happens in `scrollend` (see clampToPin).
        // A clamp written from here alone is overridden by the browser's own scroll
        // animation — measured repeatedly, which is why this bug survived three
        // fixes that all looked correct in a discrete-notch probe.
        var y = window.scrollY;
        var lim = pinLimit();
        // 🔴 LEAVING THE PIN, and it has to happen HERE rather than only in the wheel
        // handler. Once the visitor is genuinely above the boundary the pin has no
        // business owning the page any more: this branch used to return
        // unconditionally, so `render()` was never reached again and the print sat
        // frozen at its opening transform even after its layers were restored
        // (measured: y=1800 with the transform still scale(7.4539), which is the
        // t=0 value). Falling through to the travel path below re-animates it.
        if (y <= lim - 2) {
          escapePin();                   // clears the pin; the code below redraws
        } else if (y < lim) {
          // The page is a hair above the limit and the visitor is pushing up: this
          // is the browser's own scroll animation having carried it past, i.e. the
          // notch that used to survive. Put it back — it lands while the same frame
          // is still on screen, so it reads as the page stopping rather than a jump
          // (measured without this: a flick settled at 2311 against a limit of 2395
          // and every probe still called that "held").
          if (holding) {
            window.scrollTo(0, lim);
            y = lim;
            lastRawY = lim;
          }
        } else if (y > lim) {
          // The page is BELOW the limit: the gallery under the fold, which is where
          // the visitor asked to be. Only an upward push gets clamped back.
          if (y < lastRawY - 0.5) holding = true;
          if (holding) {
            window.scrollTo(0, lim);
            lastRawY = lim;
            y = lim;
          }
        } else {
          holding = false;
        }
        if (pinEngaged) {
          lastRawY = y;
          pinPrevY = y;
          atLimit = y <= lim + 1;
          return;                        // nothing left to animate
        }
      }
      // 🔴 ARM THE SUBSTITUTE BLUR: the visitor has come back UP past the landing —
      // where the print was retired and does not return — so from here the acrylic
      // plate stands in for it. This is the ONLY thing that turns it on: entering the
      // gallery, or scrolling down from the top, leaves it off, so the opening
      // animation (the print's own veil) is untouched. `measure()` and `destroy()`
      // clear it, which is what makes a re-entry start clean.
      // 🔴 ARM THE SUBSTITUTE BLUR — but only once the print has actually been
      // retired on this visit (`printRetiredAt` remembers where that happened).
      //
      // Arming on "any scroll above the landing" was wrong and measurably so: entering
      // the gallery sits at scrollY = 0, which is above the landing, so the plate came
      // up at FULL strength on the opening frame (measured `--acrylic-alt: 1.0000` at
      // y=0) — exactly the "开屏不参与模糊" the user ruled out. The substitute belongs to
      // the trip BACK: down first, print retires, then up.
      //
      // 🔴 ONE arm point, and it lives in `render` (see there) — NOT here.
      //
      // This handler used to arm as well, against `printRetiredAt`. That value is the raw
      // `scrollY` of the frame the print went away, and with a glide it can be a long way
      // past the landing (measured 3808 against a landing of 2440) — so the flag flipped
      // while the visitor was still far below the landing, i.e. while the opening's own
      // tint was still large. The hard `altArmed ? altK : openTint` switch then dropped
      // the plate's tint to nothing in a single frame, which is a visible snap.
      //
      // Arming from the scroll handler is also simply redundant: `render` runs every
      // frame the page moves, so it cannot miss the crossing.
      if (window.scrollY >= pinLimit()) {
        engagePin();
        return;
      }
      // 🔴 The animation is driven by `smoothY`, which CHASES the scroll position
      // over a few frames, instead of by `scrollY` directly.
      //
      // A wheel notch on Windows is a discrete step: measured, one notch moved
      // `scrollY` 100px in a single frame, and the print's scale is linear in that
      // position — so the whole 0.44 of scale happened inside one frame and the
      // travel read as a series of jumps ("the animation is stuttering") even
      // though every other part of it is smooth. This is the usual remedy on
      // scroll-driven sites: the page still scrolls in steps, the animation glides.
      //
      // ⚠️ Only the RENDERED position is smoothed. The pin, the limit and the
      // layers' retirement all still read the real `scrollY`, so nothing about the
      // scroll rules changes.
      // 🔴 The guard needs its OWN flag, not `frameRequest`.
      //
      // `step()` opens with `frameRequest = 0`, and this handler calls `step()`
      // SYNCHRONOUSLY (through the render at the end of it). So for the whole duration
      // of a step — including the frames of it that run during a scroll burst — the
      // shared variable reads 0, this guard falls through, and a SECOND frame is
      // scheduled on top of the one already pending. When one of the two then runs, it
      // zeroes `frameRequest`, and the chain that the other one owns is orphaned: the
      // chase stops mid-flight. Measured: `smoothY` froze at 472.2 with `scrollY` at
      // 720, and the frame counter stopped dead at 3 — which is the "惯性动画没了" and,
      // because the print never reaches its cell, feeds the disappearance reports too.
      //
      // 🔴 Just POKE the loop. It drives itself now (see `tick`), so this must not
      // schedule a frame of its own — doing that alongside the loop's own re-arm is
      // what produced two interleaved runners sharing one handle, and whichever one
      // finished first orphaned the other. A scroll event can also arrive several times
      // per frame, so `step()` coalesces internally.
      step();
    }

    // Measured step size for the chase, in units of the remaining distance per
    // frame: 0.22 converges to within 1px of a 100px step in ~20 frames (~330ms),
    // which reads as inertia rather than as lag. The snap below is what keeps the
    // hand-off exact — without it the print would still be a fraction of a pixel
    // short of its cell on the frame the pin engages.
    var SMOOTH = 0.22;
    // 🔴 The glide is specified as a TIME (`GLIDE` ms to cover ~95% of the gap) and
    // converted to a per-frame factor from the real frame delta, instead of using a
    // fixed fraction-per-frame.
    //
    // Two reasons the fixed fraction read as "there is no easing at all":
    //   1. an exponential has a long tail — the last few percent of a 100px step
    //      crawl for several frames, so most of the visible travel happens in the
    //      first two or three frames and the eye calls that "instant";
    //   2. a fixed fraction is frame-rate dependent and the user's display is not
    //      60Hz. At 144Hz the same `0.22` is applied 144 times a second, so the
    //      step is effectively over in ~3 frames of real time.
    // With the factor derived from `dt`, the same number of milliseconds of glide
    // happens on every display.
    //
    // 🎛️ TUNABLE FROM THE CONSOLE:
    //     window.__glide = 420    // ms; the whole catch-up, start to finish
    //     window.__shape = 2.2    // how fast it leaves the mark (1 = lazy, 3 = eager)
    //     window.__floor = 0.12   // first-frame minimum, as a fraction of the gap
    //     window.__speed = 9000   // px per second; the fastest the print may move
    //     window.__glide = 0      // no smoothing at all (the old steppy behaviour)
    //   `window.__smooth` (a raw per-frame fraction) still overrides it if set.
    //
    // 🔴 THE SHAPE IS EASE-IN-OUT, and that is the third attempt at this curve.
    // Both earlier shapes were rejected, and the measurements say why:
    //   exponential (`smoothY += delta * 0.22`) — step sizes 3.49× the average on
    //     the first frames and 0.02× at the end: it lurches off the mark and then
    //     dribbles. "The animation is stuttering."
    //   constant speed with a 2600px/s cap — 2.36× at the head and only 0.27× at
    //     the end, plus a hard speed limit that made it lag the scroll by a whole
    //     journey before catching up. "Too much easing, lots of empty travel, and
    //     then it goes linear and stiff."
    // What is wanted is light at BOTH ends and steady through the middle, so the
    // step is scaled by a smooth bell: sin²(π·p) has a zero slope at p=0 and p=1
    // (no lurch, no dribble) and peaks in the middle (fastest where the eye is not
    // reading a fresh gesture). `p` is the fraction of the glide already spent, so
    // the shape holds however long the glide is.
    // 🔴 RESPONSIVE + INERTIA, which is the definition the complaints converged on:
    // "不跟手" (it does not follow the input) and "惯性不够" (it does not coast).
    //
    // The bell curve above could not give both. Its first frame moves
    // `|delta| · shape · 2 · (dt/glide)`, so a 100px notch at a 700ms glide starts at
    // ~457px/s — slower than the wheel that caused it — which reads as lag, and the
    // only way to fix that inside the bell is to shorten `glide`, which kills the
    // coast. The two requirements pull the one parameter in opposite directions.
    //
    // This is the standard frame-rate-independent responsiveness instead: the step is
    // proportional to the REMAINING distance, so it starts fast (a notch is visibly
    // moving on the next frame), and because the proportion is per-frame it decays
    // geometrically — it coasts, and the coast slows down. `GLIDE` becomes the time
    // constant: ~220ms reaches 95% of a 100px step in about 660ms, and the last
    // millimetre arrives without a visible tail.
    // 🎛️ `GLIDE` is the INERTIA knob: bigger = coasts longer, smaller = follows the
    // wheel more tightly. Along that axis, measured on a single 120px notch:
    //    35ms → settles in 158ms   (abrupt)
    //    60ms → 277ms              (the first responsive build)
    //   110ms → 460ms              ← current, after "惯性调大一点"
    //   150ms → 649ms              (floaty)
    //   220ms → 950ms              (too much — that is what the rewrite removed)
    // `window.__glide` overrides it live, so exploring this needs no rebuild.
    var GLIDE = 180;
    var SPEED = 26000;
    var lastStepAt = 0;
    // 🔴 ONE SELF-DRIVEN LOOP, always armed — not a chase started by scroll events and
    // continued by its own tail.
    //
    // Both of those designs failed on the live site, and each failure was invisible
    // until a probe ran. Tail-continued: the chain died and left `smoothY` stranded
    // (measured 269 against a `scrollY` of 900, and still 269 two seconds later).
    // Scroll-driven: the animation's frame rate became the scroll-EVENT rate, so the
    // print trailed hundreds of pixels behind the page.
    //
    // This loop cannot be orphaned — it re-arms itself unconditionally — so `onScroll`
    // only has to poke it, and a coalesced scroll event costs one frame of latency and
    // nothing more. A parked tab costs one empty frame per refresh, which is far
    // cheaper than the class of bug it removes.
    var loopArmed = false;
    var tickFrames = 0;   // real rAF frames, used to age the particles once per frame
    var tickN = 0;
    function tick() {
      if (!loopArmed || pinEngaged) return;
      tickN++;
      tickFrames++;
      // `performance.now()` rather than the rAF timestamp: `step()` can run this
      // synchronously to save a frame of latency, and mixing the two clocks gives a
      // negative `dt`.
      var now = performance.now();
      var dt = lastStepAt ? Math.min(64, now - lastStepAt) : 16;
      lastStepAt = now;
      var glide = window.__glide >= 0 ? window.__glide : GLIDE;
      var speed = window.__speed > 0 ? window.__speed : SPEED;
      var target = window.scrollY;
      if (smoothY < 0) smoothY = target;    // first frame: start exactly on the scroll
      var delta = target - smoothY;
      // 0.6px, not 0.12px: invisible either way (the print is 193px wide at scale 1)
      // but a tighter threshold spends several extra frames closing a fraction of a
      // pixel — which is itself read as the wheel having moved with nothing happening.
      if (Math.abs(delta) < 0.6) {
        smoothY = target;                   // close enough: snap so the hand-off is exact
      } else if (window.__smooth > 0) {
        smoothY += delta * Math.min(1, window.__smooth);   // raw per-frame override
      } else if (glide <= 0) {
        smoothY = target;                   // smoothing off
      } else {
        // Frame-rate independent: `1 - exp(-dt/glide)` is the same fraction of the
        // remaining distance whatever the display refreshes at. At 204Hz it is a
        // smaller fraction per frame but there are more frames, so the motion takes
        // the same wall-clock time.
        var k = 1 - Math.exp(-dt / glide);
        var stepPx = delta * k;
        var cap = speed * dt / 1000;        // the speed limit, px/frame
        if (Math.abs(stepPx) > cap) stepPx = delta > 0 ? cap : -cap;
        if (Math.abs(stepPx) > Math.abs(delta)) stepPx = delta;
        smoothY += stepPx;
      }
      var t = clamp01(smoothY / scrollRange);
      if (settings.onProgress) settings.onProgress(t);
      render(t);
      // The particles share this loop rather than starting a second rAF: one clock, one
      // place where the frame budget is spent.
      updateParticles(dt, tickFrames);
      bailOut = smoothY !== target;
      if (!bailOut) lastStepAt = 0;
      frameRequest = window.requestAnimationFrame(tick);
    }

    // The single entry point. Starts the loop, then runs one frame immediately so a
    // scroll is reflected in the same task rather than a frame later. Several scroll
    // events inside one frame simply cost a few extra ticks, which is harmless: `tick`
    // re-reads `window.scrollY` each time and converges on the same answer.
    function step() {
      if (!loopArmed) {
        loopArmed = true;
        lastStepAt = 0;
        frameRequest = window.requestAnimationFrame(tick);
      }
      tick();
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
      // 🔴 A SUCCESSFUL LOAD MUST DISARM THE BACKSTOP.
      //
      // Only `error` was wired, so the 6s timer below fired unconditionally whether or
      // not the photograph arrived: a successful load never cleared `done`, `settle()`
      // ran anyway, and `retired` was latched true — the print hidden at y=0 with
      // `landScroll` still thousands of pixels away. Measured on the live site: at the
      // very first sampled frame, `retired: true, printRetiredAt: -1` while
      // `smoothY` was 0. That is exactly "首页加载好之后屏风自动消失了字自动变糊".
      //
      // It also explains why the symptom moved around — it was a race against a 6s
      // timer, so a fast connection never showed it and a slow one always did.
      screenImg.addEventListener('load', function () {
        done = true;
      }, { once: true });
      screenImg.addEventListener('error', bail, { once: true });
      // Backstop for a request that hangs without erroring.
      window.setTimeout(bail, 6000);
    }

    // 🔴 RANDOMISE THE GRID ORDER, at the user's request: "下面的图片随机排序".
    //
    // Done with the CSS `order` property rather than by moving nodes. `frames[0]` is
    // the cell the print flies to, and so is the cell that becomes vacant; it stays
    // first in the DOM whatever order the visitor sees, so every existing behaviour
    // (the travel, the hand-off, the vacant cell, the lightbox grouping) is untouched
    // and only the paint order changes. Moving nodes instead would renumber those.
    //
    // 🎛️ `window.__order` — leave unset for a fresh shuffle on every load; set it to
    // `'authored'` and reload to get the hand-written order back for comparison.
    function shuffleFrames() {
      if (window.__order === 'authored') return;
      var order = frames.map(function (_, i) { return i; });
      for (var i = order.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      }
      frames.forEach(function (frame, i) {
        frame.style.order = String(order[i]);
      });
      // 🔴 The landing target is chosen from the FIRST TWO VISUAL ROWS only — user:
      // "屏风图只能选前两行的图".
      //
      // `frames[0]` used to be the target, and after a shuffle that could be any cell in
      // the grid. A cell low down is wrong on two counts: the print flies a long way
      // down to reach it, and `landScroll` (t = 1) then sits far down the page, so the
      // substitute blur's trigger point is in an awkward place.
      //
      // The rows are measured, not assumed: the column count changes with the viewport
      // (measured 5 columns at 2560, 4 at 1440, 2 at 390), so "the first 2N cells in
      // DOM order" would be wrong at every width. Sorting by painted `top` and taking
      // the two smallest distinct values is viewport-independent.
      //
      // Picking among the first N DOM cells after the shuffle is what makes the landing
      // random WITHIN those two rows — the shuffle already gave each of them a random
      // slot up there.
      if (frames.length) {
        var tops = frames.map(function (f) { return Math.round(f.getBoundingClientRect().top); });
        var uniq = tops.slice().sort(function (a, b) { return a - b; })
          .filter(function (v, i, a) { return i === 0 || v !== a[i - 1]; });
        var secondTop = uniq.length > 1 ? uniq[1] : uniq[0];
        var inFirstRows = frames.filter(function (f, i) {
          return tops[i] <= secondTop + 1;
        });
        if (inFirstRows.length) {
          landingFrame = inFirstRows[Math.floor(Math.random() * inFirstRows.length)];
        } else {
          landingFrame = frames[0];
        }
        // Recorded on the element for the probes: the chosen row cannot be recovered
        // from `order` (the shuffle writes that).
        frames.forEach(function (f) { f.removeAttribute('data-landing'); });
        if (landingFrame) landingFrame.setAttribute('data-landing', '');
        syncPrintTo(landingFrame);
      } else {
        landingFrame = null;
      }
    }

    // 🔴 The print has to SHOW the photograph it is going to land on.
    //
    // The print's `<img>` is authored server-side against `cover` (the album's picked
    // landscape frame), while the landing cell became a random choice from the first two
    // rows. Nothing re-pointed the print afterwards, so it flew to a cell holding a
    // different photograph — "落点是在前两行但是没落在自己身上，屏风图和落点的图对不上".
    // Repointing the `src`, the date and the tally (the cell's own number, which the
    // template already notes must match or the arrival visibly edits the print) keeps
    // the hand-off seamless.
    function syncPrintTo(frame) {
      if (!frame) return;
      var cellImg = frame.querySelector('[data-photo-frame-img]');
      if (screenImg && cellImg) {
        var wanted = cellImg.getAttribute('data-screen-src');
        if (wanted && screenImg.getAttribute('src') !== wanted) {
          screenImg.setAttribute('src', wanted);
          // Matches the print's own `decoding="async"`: the browser keeps the old
          // frame until the new one is ready instead of blanking.
          screenImg.setAttribute('decoding', 'async');
        }
        if (cellImg.getAttribute('alt')) screenImg.setAttribute('alt', cellImg.getAttribute('alt'));
      }
      if (screenCap) {
        var spans = screenCap.querySelectorAll('span');
        var cap = frame.querySelector('.photo-frame__cap');
        if (spans.length && cap) {
          var capSpans = cap.querySelectorAll('span');
          if (capSpans.length) spans[0].textContent = capSpans[0].textContent;
          if (spans.length > 1) {
            spans[1].textContent = frame.getAttribute('data-tally') || spans[1].textContent;
          }
        }
      }
    }

    function initScreen() {
      if (reduced) {
        // No travel and no layers. The screen is dropped and the masthead
        // becomes a plain in-flow header, so the h1 is still the page's real
        // heading instead of vanishing with the screen.
        // On <body>, not on .gallery: the masthead is a sibling of .gallery
        // and a descendant selector would never reach it.
        document.body.classList.add('is-gallery-static');
        // 🔴 No pin in this mode, and that is structural rather than a flag: this
        // `return` is what keeps the wheel/key listeners from ever being attached
        // (they are registered below), so there is nothing to hold the page.
        // There is also no travel to protect, and `measure()` is skipped here, so
        // `tailRange`/`landScroll` are still their initial values — a pin computed
        // from them would be nonsense (measured: a "limit" of 331 against a
        // document that scrolls to 1797).
        detachers.push(function () {
          document.body.classList.remove('is-gallery-static');
        });
        return;
      }

      // The shuffle must happen BEFORE `measure()`: the travel targets `frames[0]`,
      // and although `order` does not change which element that is, measuring first
      // would size the print against a grid whose painted order is still settling.
      shuffleFrames();
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
      // Fires when the gesture and its momentum have finished; the clamp that
      // actually sticks is applied there (see clampToPin). Guarded because
      // `scrollend` is recent — without it the `scroll` handler is still there,
      // just less reliable.
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

    /* ---- 5. the title: typewriter + cursor ------------------------------ */

    // 🔴 The title TYPES itself in, at the user's request.
    //
    //   * "标题打字是加载好网页就开始，也就是从别的地方点进来那个双斜杠扫屏动画做完
    //     后开始" — so the cue is `body.route-ready`, which the route transition adds
    //     when the slash sweep finishes (and which is added almost immediately on a
    //     direct load, since there is no sweep to wait for).
    //   * "上滑到一半之后就打，然后就不动了，跟随滚动上下位移" — one more type-in when the
    //     visitor comes back up past `TITLE_AT` (half of the travel), and after that the
    //     title is never animated again: it only tracks the scroll.
    //   * "光标采用下划线闪动" — a real `_` span that blinks, reusing the theme's own
    //     `blink-mark` keyframes.
    //
    // It is deliberately independent of `render()`: the typewriter is a time-based
    // reveal, not a scroll-driven one, so it must not be re-entered every frame.
    var titleCaret = null;
    var titleTimer = 0;
    var titlePlaying = false;
    var titleDone = false;
    // Guarded so a second entry (the scroll-up re-type) cannot stack timers.
    function startTyping() {
      if (titlePlaying) return;
      if (!mastTitle) return;
      // 🔴 `data-full` is the ONE source of truth, and this refuses to guess at it.
      //
      // The fallback here used to be `mastTitle.textContent`, on the assumption that the
      // element still held the server-rendered string. It does not: `initTitle` has already
      // emptied it and inserted the caret. So a call that arrived BEFORE `initTitle` ran
      // stored the caret itself as the title — traced with a MutationObserver:
      //
      //   DCL  text="Willow's Gallery"  data-full=null
      //   attr data-full -> "_"        ← this line, writing the caret as the title
      //   text -> "_"
      //   … then it "typed" one underscore and stopped.
      //
      // That was the whole of "标题只剩一个下划线" and of the dispersal sampling 5 points.
      // Refusing to type is the correct response to a missing title: the next frame will
      // find it, and `titleArmed` keeps the call from being lost.
      var full = mastTitle.getAttribute('data-full');
      if (!full) return;
      mastTitle.textContent = '';
      if (!titleCaret) {
        titleCaret = document.createElement('span');
        titleCaret.className = 'photo-masthead__caret';
        titleCaret.setAttribute('aria-hidden', 'true');
        titleCaret.textContent = '_';
      }
      mastTitle.appendChild(titleCaret);
      titlePlaying = true;
      titleDone = false;
      masthead.classList.add('is-typing');
      var i = 0;
      var speed = window.__typeSpeed > 0 ? window.__typeSpeed : TYPE_SPEED;
      var n = full.length;
      // 🔴 LEFT TO RIGHT — an ordinary typewriter. NOT a symmetric reveal.
      //
      // The previous version grew the run about its own midpoint (taking a centred
      // substring each step), which I built from "字从中间冒出来". That was the wrong
      // reading and the user corrected it precisely: the reveal order is plain
      // left-to-right, and the CENTRED LOOK comes from the line box, not from the
      // substring — each prefix is centred on screen, so `W`, `Wi`, `Wil` … all sit in
      // the middle while growing rightwards. "不是两边同时打，就是从左往右打，只不过中对齐".
      //
      // The centring is CSS's job (`text-align: center` on the full-width masthead) and
      // needs nothing from here.
      titleTimer = window.setInterval(function () {
        i++;
        mastTitle.textContent = full.slice(0, i);
        // Re-inserted each step: the caret must stay last, and `textContent` would
        // otherwise wipe it.
        mastTitle.appendChild(titleCaret);
        if (i >= n) {
          window.clearInterval(titleTimer);
          titleTimer = 0;
          titlePlaying = false;
          titleDone = true;
          // "打完就不动了" — the caret stays as the resting state's signal.
          masthead.classList.remove('is-typing');
        }
      }, speed);
      detachers.push(function () {
        if (titleTimer) window.clearInterval(titleTimer);
        titleTimer = 0;
        titlePlaying = false;
      });
      // Says whether the typewriter actually started. `tickTitle` arms on this, so a call
      // that bailed out early (no `data-full` yet) is retried rather than lost.
      return true;
    }

    // 🔴 The cue is polled from the existing frame loop rather than wired to a new
    // event. `route-ready` is written by a different script (`willowxi.js`) and there is
    // no dispatched event to listen for (the theme emits none), so observing the class
    // is the only option — and polling it inside `render` costs nothing because that
    // already runs on every frame that matters.
    var titleArmed = false;
    // Latch for the second trigger. Without it the re-type fires on EVERY frame spent
    // below the threshold (`titleDone` stays true for ever once the first run ends), so
    // the title would restart its typewriter continuously while the visitor sits there.
    var titleReTyped = false;
    // 🔴 Set once the title has typed its SECOND time (on the way back up). From then
    // on it is anchored where the visitor was, not at the opening's viewport centre.
    // Without this the re-type snapped the title back to `scale(bigScale)` centred on
    // screen — a full-viewport flash of giant text that read as "屏风突然不见了字突然
    // 变糊了". Both triggers now consume the same state, so they cannot disagree.
    var titleSettled = false;
    function tickTitle() {
      if (!masthead || !mastTitle) return;
      // 🔴 Armed only when the typing ACTUALLY STARTS, not when the cue appears.
      //
      // `titleArmed = true` used to be set unconditionally next to the call, which turned
      // the cue into a one-shot. `startTyping` now refuses to run before `initTitle` has
      // published `data-full` (see there), and if this flag had already latched, that
      // refusal would have been permanent — exactly the failure it was meant to prevent.
      // Setting it from `startTyping`'s return value makes "armed" mean "the typewriter is
      // running", so a cue that arrives too early simply tries again next frame.
      if (!titleArmed && document.body.classList.contains('route-ready')) {
        titleArmed = startTyping() === true;
      }
      if (!titleArmed) return;
      // ⚠️ `window.scrollY`, not `smoothY`: the title re-types once per upward crossing,
      // and the target position is the honest measure of where the visitor is.
      //
      // 🔴 The threshold is in VIEWPORT TERMS: "上滑到一半" means half the SCREEN, so it
      // is `0.5 * innerHeight` of scroll remaining. Using a fraction of `landScroll`
      // would mean a different physical point on every layout and on every landing cell.
      // 🔴 `window.innerHeight`, NOT `size.height`.
      //
      // `size` is a LOCAL of `measure()` (`var size = viewport()`), so it does not exist
      // out here — and because this runs inside `render`, the resulting
      // `ReferenceError: size is not defined` was thrown EVERY FRAME from inside `tick()`,
      // before it could schedule the next frame. That killed the animation loop outright:
      // measured, the tick counter stopped at 3 and `smoothY` froze 631px short of the
      // scroll position. Nothing appeared in the console unless the probe subscribed to
      // `Runtime.exceptionThrown`, which is exactly why it survived several rounds of
      // "looks fine to me".
      //
      // `innerHeight` also matches the intent: "上滑到一半" is half the SCREEN.
      var reTypeBelow = Math.round(landScroll) - Math.round(window.innerHeight * TITLE_AT);
      if (!titleReTyped && printRetiredAt >= 0 && window.scrollY <= reTypeBelow) {
        titleReTyped = true;
        titleSettled = true;
        startTyping();
      } else if (titleReTyped && window.scrollY > reTypeBelow + 40) {
        // Re-armed only once the visitor is clearly back below the (hysteresis-padded)
        // threshold, so jitter around the line cannot re-trigger it.
        titleReTyped = false;
      }
    }

    function initTitle() {
      if (reduced) return;            // static title in reduced-motion
      if (!masthead || !mastTitle) return;
      // 🔴 Capture the text into a LOCAL before touching the element.
      //
      // This was `mastTitle.setAttribute('data-full', mastTitle.textContent)`, which stores
      // a REFERENCE: `setAttribute` stringifies lazily, so by the time the attribute was
      // read again the element had been emptied and `data-full` came back as ''. The
      // typewriter then typed NOTHING (only the caret appeared) and the particle sampler had
      // no glyphs to break apart — measured, the whole dispersal produced 96 opaque pixels,
      // all of them the underscore.
      var fullText = mastTitle.textContent;
      mastTitle.setAttribute('data-full', fullText);
      // 🔴 Emptied now, not when the typing starts.
      //
      // The title is server-rendered in full, so waiting for `route-ready` (up to 1.71s
      // while the slash sweep plays) would show the finished title first and then blank
      // it — a flicker. Blanking it here means the typewriter is the only thing that
      // ever puts those characters on screen.
      mastTitle.textContent = '';
      if (!titleCaret) {
        titleCaret = document.createElement('span');
        titleCaret.className = 'photo-masthead__caret';
        titleCaret.setAttribute('aria-hidden', 'true');
        titleCaret.textContent = '_';
      }
      mastTitle.appendChild(titleCaret);
      // Releases the `visibility: hidden` that hides the server-rendered title
      // while this script is still loading (see the CSS note). From here the
      // typewriter is the only thing that puts characters on screen.
      masthead.classList.add('is-ready');
      // Clears the inline `visibility:hidden` that the server-rendered title carries
      // (see photos.ejs); the class above is what the stylesheet keys off.
      mastTitle.style.visibility = '';
    }

    /* ---- 6. the title's particles --------------------------------------- */

    // 🔴 The title DISPERSES into squares when the page is scrolled down.
    //
    // The specimens come from the title's own pixels: the string is drawn once into an
    // offscreen canvas in the SAME monospace face at the SAME scale the masthead is
    // wearing, and every Nth opaque pixel becomes a particle. That is what makes the swarm
    // read as the words coming apart rather than as a spray of dots near them.
    //
    // 🎛️ Knobs (all live):
    //   window.__pCount  target particle count (default 320; the brief said 200-400)
    //   window.__pSize   square size in px (default 2)
    //   window.__pLife   fade-out in ms (default 2000)
    //   window.__pPush   scroll → velocity multiplier (default 0.6)
    var P_COUNT = 320;
    var P_SIZE = 2;
    // 🔴 600ms was INVISIBLE, and that is the whole of "我在线上一点没看到".
    //
    // Measured on the live site: the swarm existed for 0.56s (114ms → 677ms after the
    // first scroll) and only ever lit ~150 samples across a 1152px-wide title, because
    // `stride` was 2 screen pixels on a 21px face blown up to scale 6.5. Nothing was
    // broken; there was simply nothing to see. 2s turns it into something you watch, and
    // stride 1 roughly doubles the sampling density.
    var P_LIFE = 2000;
    var P_PUSH = 0.6;
    // How many screen pixels each sample stands for. 1 = every pixel; see the note in
    // `sampleTitle` for why the old value of 2 was too coarse to see.
    var P_STRIDE = 1;
    var pParticles = null;
    var pBox = null;              // the sampled title box, reused for colour
    var pSpawned = false;         // one dispersal per visit
    // Set by the first real scroll. The dispersal is triggered by it, so the swarm exists
    // when the visitor is actually moving rather than fading out during the typing.
    var pScrolled = false;
    var pCtx = null;
    // Counters for the probes. The dispersal has several silent early-outs, and "nothing
    // appeared" does not say which one was taken.
    var pDiag = { calls: 0, spawned: 0, spawnOk: 0, samples: 0, drawn: 0, err: '' };

    // The title's current on-screen rectangle, its scale, and its resolved font/colour.
    function titleBox() {
      if (!mastTitle) return null;
      var probe = document.createRange();
      probe.selectNodeContents(mastTitle);
      var rect = probe.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      var cs = getComputedStyle(mastTitle);
      var scale = 1;
      var tr = masthead ? masthead.style.transform : '';
      var m = tr && tr.match(/scale\(([0-9.]+)\)/);
      if (m) scale = Number(m[1]);
      return {
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        scale: scale, font: cs.font, color: cs.color, letterSpacing: cs.letterSpacing
      };
    }

    // Draws the title once offscreen and returns sample points in VIEWPORT CSS pixels —
    // the same space the canvas paints in, so no transform is needed at draw time.
    function sampleTitle() {
      var box = titleBox();
      if (!box || !box.width) return null;
      var text = mastTitle.getAttribute('data-full') || '';
      if (!text) return null;
      var pad = 8;
      var w = Math.ceil(box.width) + pad * 2;
      var h = Math.ceil(box.height) + pad * 2;
      var off = document.createElement('canvas');
      // The canvas is in CSS pixels OF THE SCREEN, so the glyphs must be drawn at the
      // scale they are displayed at — the masthead carries scale(bigScale).
      off.width = Math.max(1, Math.round(w * box.scale));
      off.height = Math.max(1, Math.round(h * box.scale));
      var octx = off.getContext('2d');
      if (!octx) return null;
      octx.scale(box.scale, box.scale);
      octx.fillStyle = '#fff';
      octx.textBaseline = 'top';
      octx.font = box.font;
      try {
        if ('letterSpacing' in octx && box.letterSpacing) octx.letterSpacing = box.letterSpacing;
      } catch (e) { /* older engines: ignore the tracking */ }
      octx.fillText(text, pad, pad);
      var data;
      try { data = octx.getImageData(0, 0, off.width, off.height).data; }
      catch (e) { return null; }   // tainted or unsupported: no dispersal, no crash
      // Collect every inked pixel, THEN thin the list at random. A fixed stride would
      // bias the swarm towards whichever strokes happened to align with it.
      var pts = [];
      // 🔴 `stride` in SCREEN pixels was 2, which on this type is very coarse: the title is
      // a 21px face blown up to scale 6.5, so a 2px grid skipped most of the strokes and
      // the whole dispersal came to ~150 points. 1 samples every pixel; the random thinning
      // below is what keeps the population at `P_COUNT` regardless.
      var stride = Math.max(1, Math.round(window.__pStride > 0 ? window.__pStride : P_STRIDE));
      stride = Math.max(1, Math.round(stride * Math.min(2, box.scale / 3)));
      for (var y = 0; y < off.height; y += stride) {
        for (var x = 0; x < off.width; x += stride) {
          if (data[(y * off.width + x) * 4 + 3] > 140) {
            pts.push([x / box.scale - pad + box.left, y / box.scale - pad + box.top]);
          }
        }
      }
      if (!pts.length) return null;
      var want = window.__pCount > 0 ? window.__pCount : P_COUNT;
      pBox = box;
      if (pts.length <= want) return pts;
      for (var i = pts.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = pts[i]; pts[i] = pts[j]; pts[j] = t;
      }
      return pts.slice(0, want);
    }

    function resizeParticleCanvas() {
      if (!particleCanvas) return false;
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.max(1, window.innerWidth);
      var h = Math.max(1, window.innerHeight);
      if (particleCanvas.width !== Math.round(w * ratio) ||
          particleCanvas.height !== Math.round(h * ratio)) {
        particleCanvas.width = Math.round(w * ratio);
        particleCanvas.height = Math.round(h * ratio);
      }
      pCtx = particleCanvas.getContext('2d');
      if (!pCtx) return false;
      pCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
      return true;
    }

    function spawnParticles() {
      var pts = sampleTitle();
      if (!pts || !resizeParticleCanvas()) return false;
      var size = window.__pSize > 0 ? window.__pSize : P_SIZE;
      pParticles = pts.map(function (p) {
        return {
          x: p[0], y: p[1], vx: 0, vy: 0,
          s: size * (0.6 + Math.random() * 0.8),
          a: 1,
          life: 1
        };
      });
      particleCanvas.hidden = false;
      return true;
    }

    function drawParticles(dt) {
      if (!pCtx) return;
      var W = window.innerWidth, H = window.innerHeight;
      pCtx.clearRect(0, 0, W, H);
      if (!pParticles || !pParticles.length) return;
      var life = window.__pLife > 0 ? window.__pLife : P_LIFE;
      pCtx.fillStyle = (pBox && pBox.color) || '#f1f3f5';
      var alive = 0;
      for (var i = 0; i < pParticles.length; i++) {
        var p = pParticles[i];
        // Exponential drift, frame-rate independent, so the coast slows the way a thrown
        // thing does rather than stopping dead on the frame the wheel stops.
        var damp = Math.exp(-dt / 260);
        p.vx *= damp; p.vy *= damp;
        p.x += p.vx * (dt / 1000);
        p.y += p.vy * (dt / 1000) + 24 * (dt / 1000);   // a slight settle, like dust
        p.life -= dt / life;
        if (p.life <= 0) continue;
        p.a = Math.max(0, Math.min(1, p.life));
        // Squares, not circles: at this size a dot reads as a smudge and the swarm looks
        // soft, which is the opposite of "come apart".
        pCtx.globalAlpha = p.a;
        pCtx.fillRect(p.x, p.y, p.s, p.s);
        alive++;
      }
      pCtx.globalAlpha = 1;
      if (!alive) clearParticles();
    }

    // Driven from `tick` with that frame's delta, so it shares the gallery's single rAF
    // loop instead of starting a second one.
    // 🔴 Particles age ONLY on real frames.
    //
    // `step()` is called synchronously from the scroll handler to save a frame of latency,
    // so a single scroll burst can run `tick` (and therefore `updateParticles`) several
    // times within one real frame. Charging each of those a full frame's worth of lifetime
    // made time-based effects run fast — measured, a 2s particle lifetime drained in 0.7s,
    // which is why a 0.6s swarm was invisible and a 2s one still was. `tickFrames` is the
    // rAF's own frame counter, so ageing is billed once per displayed frame.
    var lastAgedFrame = -1;
    function updateParticles(dt, frameNo) {
      pDiag.calls++;
      if (reduced || !particleCanvas) { pDiag.skipped = (pDiag.skipped || 0) + 1; return; }
      // 🔴 The dispersal STARTS ON THE FIRST SCROLL, not when the typing ends.
      //
      // Spawning at `titleDone` produced a swarm that was born, drifted and faded out
      // within 600ms while the visitor was still reading the title — by the time they
      // scrolled there was nothing left to push, and the canvas had hidden itself.
      // Waiting for a scroll also matches what the effect is FOR: "下滑的时候随滚轮飘散".
      if (!pSpawned && titleDone && pScrolled) {
        pSpawned = true;
        pDiag.spawned++;
        try {
          pDiag.spawnOk = spawnParticles() ? 1 : 0;
          pDiag.samples = pParticles ? pParticles.length : 0;
        } catch (e) { pDiag.err = String(e); }
      }
      if (!pParticles) return;
      // A repeat call inside the same frame still repaints (the positions have moved) but
      // does not age anything.
      var aging = frameNo !== lastAgedFrame;
      lastAgedFrame = frameNo;
      drawParticles(aging ? dt : 0);
      pDiag.drawn++;
    }

    // The scroll throws the swarm: its magnitude becomes the particles' initial velocity,
    // and they keep coasting once the wheel stops.
    function pushParticles(deltaY) {
      if (!pParticles) return;
      var push = window.__pPush > 0 ? window.__pPush : P_PUSH;
      for (var i = 0; i < pParticles.length; i++) {
        var p = pParticles[i];
        p.vx += deltaY * push * (0.5 + Math.random() * 0.9);
        p.vy += deltaY * push * 0.25 * (Math.random() * 2 - 1);
      }
    }

    // The re-type throws the swarm away, so the title comes back clean.
    function clearParticles() {
      pParticles = null;
      if (pCtx) pCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (particleCanvas) particleCanvas.hidden = true;
    }

    // 🔴 Its OWN listener, not a line inside `onWheel`.
    //
    // `onWheel` is the pin's handler and returns immediately when the pin is off
    // (`PIN_ENABLED = false`), so anything added there would never run. The particles have
    // nothing to do with the pin — they only need the scroll's magnitude and direction.
    function initParticles() {
      if (reduced || !particleCanvas) return;
      var onScrollPush = function (event) {
        pScrolled = true;
        pushParticles(event.deltaY || 0);
      };
      window.addEventListener('wheel', onScrollPush, { passive: true });
      detachers.push(function () {
        window.removeEventListener('wheel', onScrollPush);
      });
      // A viewport change invalidates every sample, so the swarm is dropped rather than
      // left scattered at coordinates from the old layout.
      var onResizeParticles = function () {
        clearParticles();
        pSpawned = false;
        pScrolled = false;
      };
      window.addEventListener('resize', onResizeParticles, { passive: true });
      detachers.push(function () {
        window.removeEventListener('resize', onResizeParticles);
      });
    }

    // 🔴 Diagnostic surface. The gallery's state is entirely closure-local, which
    // made every report of "it disappeared" impossible to check from the console —
    // reading it meant guessing which of a dozen flags was wrong. These are getters,
    // not copies, so they cannot go stale.
    function exposeState() {
      window.__gal = {
        get scrollY() { return window.scrollY; },
        get smoothY() { return smoothY; },
        get retired() { return retired; },
        get landScroll() { return landScroll; },
        get scrollRange() { return scrollRange; },
        get pinLimit() { return pinLimit(); },
        get printRetiredAt() { return printRetiredAt; },
        get altArmed() { return altArmed; },
        get titleSettled() { return titleSettled; },
        get titleReTyped() { return titleReTyped; },
        get titleArmed() { return titleArmed; },
        get landing() { return landingFrame ? landingFrame.getAttribute('data-id') : null; },
        // The flags the animation loop depends on. A loop that has silently stopped is
        // invisible from outside — `loopArmed` says whether it is still armed, `tickN`
        // whether it is actually advancing, and `bailOut` whether the chase has work
        // left. Between them they answer "is it running" without guessing.
        get pinEngaged() { return pinEngaged; },
        get loopArmed() { return loopArmed; },
        get bailOut() { return bailOut; },
        get tickN() { return tickN; },
        get titleDone() { return titleDone; },
        get pDiag() { return pDiag; }
      };
    }

    function init() {
      exposeState();
      initScreen();
      initLightbox();
      initDrag();
      initTitle();
      initParticles();
    }

    function destroy() {
      // Per-visit state like everything else here. `pSpawned` in particular must be reset,
      // or the next page in a PJAX navigation would inherit a title that never disperses.
      clearParticles();
      pSpawned = false;
      pScrolled = false;
      if (frameRequest) {
        window.cancelAnimationFrame(frameRequest);
        frameRequest = 0;
      }
      loopArmed = false;
      bailOut = false;
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
      landingFrame = null;
      // The pin is state for THIS visit to the gallery: a PJAX navigation must
      // not leave the next page unable to scroll up.
      pinEngaged = false;
      atLimit = false;
      pinPrevY = 0;
      pinY = -1;
      holding = false;
      lastRawY = 0;
      smoothY = -1;
      altArmed = false;
      printRetiredAt = -1;
      retired = false;
      if (spacer) spacer.style.removeProperty('height');
      spacerLocked = false;
      spacerHeight0 = -1;
      // The masthead lives outside .gallery, so a PJAX navigation that
      // replaces the shell would otherwise leave it stranded on the page.
      if (titleTimer) { window.clearInterval(titleTimer); titleTimer = 0; }
      titlePlaying = false;
      titleDone = false;
      titleArmed = false;
      titleReTyped = false;
      titleSettled = false;
      if (masthead) {
        masthead.classList.remove('is-typing');
        masthead.classList.remove('is-ready');
        masthead.style.transform = '';
        masthead.style.removeProperty('--mast-s');
        if (mastLabel) mastLabel.style.opacity = '';
        if (mastTitle) {
          var fullText = mastTitle.getAttribute('data-full');
          if (fullText !== null) {
            mastTitle.textContent = fullText;
            mastTitle.removeAttribute('data-full');
          }
        }
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

(function () {
  'use strict';

  var config = window.WILLOWXI_THEME || {};
  var root = document.documentElement;
  var body = document.body;
  var intro = document.getElementById('willowxi-intro');
  var introEnded = false;
  var introTimers = [];

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

  function revealPage(options) {
    if (introEnded) return;
    introEnded = true;
    clearIntroTimers();

    body.classList.remove('intro-running');
    body.classList.add('intro-ready');

    if (intro) {
      intro.classList.add('is-leaving');
      window.setTimeout(function () {
        intro.classList.add('is-hidden');
        intro.setAttribute('aria-hidden', 'true');
      }, options && options.instant ? 120 : 680);
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

    items.forEach(function (item, index) {
      item.style.setProperty('--reveal-delay', Math.min(index * 55, 330) + 'ms');
      observer.observe(item);
    });
  }

  function setupDetails() {
    document.querySelectorAll('details').forEach(function (details) {
      var bodyElement = details.querySelector('.stream-group__body, .archive-year__body');
      if (!bodyElement) return;

      function sync() {
        bodyElement.style.gridTemplateRows = details.open ? '1fr' : '0fr';
      }

      details.addEventListener('toggle', sync);
      if (details.open) requestAnimationFrame(sync);
    });
  }

  function setupToc() {
    var toc = document.querySelector('[data-toc]');
    if (!toc) return;
    var list = toc.querySelector('ol, ul');
    if (!list || !list.children.length) {
      toc.hidden = true;
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

    sections.forEach(function (section) { observer.observe(section); });
  }

  function setupCopyButtons() {
    document.querySelectorAll('.prose pre').forEach(function (block) {
      if (block.querySelector('.code-copy')) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.textContent = 'COPY';
      button.addEventListener('click', function () {
        var code = block.querySelector('code');
        var text = code ? code.innerText : block.innerText;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () {
            button.textContent = 'COPIED';
            window.setTimeout(function () { button.textContent = 'COPY'; }, 1400);
          });
        }
      });
      block.appendChild(button);
    });
  }

  function setupLinks() {
    if (!('requestAnimationFrame' in window)) return;
    var loader = document.querySelector('.route-loader');
    if (!loader) return;

    document.addEventListener('click', function (event) {
      var link = event.target.closest('a[href]');
      if (!link) return;
      var href = link.getAttribute('href');
      if (!href || href.charAt(0) === '#' || link.target === '_blank') return;
      if (link.origin !== window.location.origin) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      loader.classList.add('is-active');
    });
  }

  onReady(function () {
    startIntro();
    setupHeader();
    setupReveal();
    setupDetails();
    setupToc();
    setupCopyButtons();
    setupLinks();
  });
})();

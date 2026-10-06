// Webview / standalone page script for the beamer preview.
// Works in a VS Code webview (acquireVsCodeApi present) and in a plain browser (static export).
(function () {
  'use strict';
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const SLIDE_PX = 455.244 * 96 / 72; // slide width in CSS px at zoom 1
  const deck = document.getElementById('deck');
  const cfg = window.__BEAMER_CFG__ || {};
  let state = Object.assign({ cols: 1, overlays: 'last', scroll: 0 }, (vscode && vscode.getState()) || {});
  let frames = [];
  let presenting = -1;
  const log = (msg) => { if (vscode) vscode.postMessage({ type: 'log', msg: String(msg) }); else console.warn(msg); };
  window.addEventListener('error', (e) => log(`webview error: ${e.message} @${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log(`webview rejection: ${e.reason && e.reason.message || e.reason}`));

  // ---------------- pdf.js (lazy) ----------------
  let pdfjsPromise = null;
  let pdfOk = 0;
  const pdfDocs = new Map();
  function pdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(cfg.pdfjs).then(async (lib) => {
        // Workers from webview resource URIs are cross-origin: load via blob URL.
        try {
          const code = await (await fetch(cfg.pdfjsWorker)).text();
          lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        } catch (e) {
          lib.GlobalWorkerOptions.workerSrc = cfg.pdfjsWorker;
        }
        return lib;
      });
    }
    return pdfjsPromise;
  }
  function loadPdf(url) {
    if (!pdfDocs.has(url)) {
      pdfDocs.set(url, pdfjs().then((lib) => lib.getDocument({
        url, isEvalSupported: false, cMapUrl: cfg.cMapUrl, cMapPacked: true, standardFontDataUrl: cfg.standardFontDataUrl,
      }).promise));
    }
    return pdfDocs.get(url);
  }

  // pdf.js refuses concurrent render() calls on one canvas: serialise per canvas,
  // keeping only the latest request (animations simply skip frames while busy).
  function renderPdfCanvas(cv, url, skipIfBusy) {
    if (cv._busy) {
      if (!skipIfBusy) cv._next = url || cv.dataset.src;
      return cv._busy;
    }
    cv._busy = renderPdfCanvasNow(cv, url).finally(() => {
      cv._busy = null;
      if (cv._next) { const u = cv._next; cv._next = null; renderPdfCanvas(cv, u); }
    });
    return cv._busy;
  }

  async function renderPdfCanvasNow(cv, url) {
    url = url || cv.dataset.src;
    const pageNo = parseInt(cv.dataset.page || '1', 10);
    try {
      const doc = await loadPdf(url);
      const page = await doc.getPage(Math.min(pageNo, doc.numPages));
      const vp1 = page.getViewport({ scale: 1 });
      // natural size in pt; pdf.js scale 1 is 1/72 in = 1pt
      cv.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
      if (cv.dataset.scale) {
        const k = parseFloat(cv.dataset.scale) || 1;
        if (!/width/.test(cv.getAttribute('style') || '') || cv.dataset.sized) {
          cv.style.width = `${vp1.width * k}pt`;
          cv.dataset.sized = '1';
        }
      }
      fitAncestorBoxes(cv);
      const rect = cv.getBoundingClientRect();
      const cssW = Math.max(rect.width, 50);
      const dpr = (window.devicePixelRatio || 1) * 1.5;
      const scale = (cssW * dpr) / vp1.width;
      const vp = page.getViewport({ scale });
      const key = `${url}#${pageNo}@${Math.round(vp.width)}`;
      if (cv.dataset.rendered === key) return;
      cv.width = Math.round(vp.width);
      cv.height = Math.round(vp.height);
      const ctx = cv.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
      cv.dataset.rendered = key;
      pdfOk++;
    } catch (e) {
      if (e && /multiple render|cancel/i.test(e.message || '')) return;
      log(`PDF ${url}: ${e && e.message || e}`);
      cv.replaceWith(Object.assign(document.createElement('span'), { className: 'img-missing', textContent: 'PDF: ' + (e && e.message || e) }));
    }
  }

  // ---------------- size fixes ----------------
  function fitAncestorBoxes(el) {
    const rb = el.closest('.resizebox');
    if (rb) requestAnimationFrame(() => fitResizebox(rb));
  }
  function fitResizebox(rb) {
    const inner = rb.querySelector('.rb-inner');
    if (!inner) return;
    inner.style.transform = '';
    const target = rb.clientWidth;
    const w = inner.scrollWidth;
    if (rb.dataset.fitw && w > 0) {
      const k = target / w;
      inner.style.transform = `scale(${k})`;
      rb.style.height = `${inner.scrollHeight * k}px`;
    }
  }
  function fixImg(img) {
    const apply = () => {
      if (img.dataset.scale && img.naturalWidth) {
        const k = parseFloat(img.dataset.scale) || 1;
        // LaTeX assumes 72 dpi for bitmaps without resolution info
        img.style.width = `${img.naturalWidth * k}pt`;
        img.style.maxWidth = '100%';
      }
      fitAncestorBoxes(img);
    };
    if (img.complete) apply(); else img.addEventListener('load', apply, { once: true });
  }

  // ---------------- animations ----------------
  const anims = new Set();
  function startAnim(el) {
    if (el._anim) return;
    let list;
    try { list = JSON.parse(el.dataset.frames || '[]'); } catch (e) { list = []; }
    if (list.length < 2) return;
    const fps = Math.min(parseFloat(el.dataset.fps) || 10, 12);
    let k = 0;
    // preload
    if (el.tagName === 'IMG') list.forEach((u) => { const i = new Image(); i.src = u; });
    el._anim = setInterval(() => {
      if (!document.body.contains(el)) { clearInterval(el._anim); anims.delete(el); return; }
      k = (k + 1) % list.length;
      if (el.tagName === 'IMG') el.src = list[k];
      else renderPdfCanvas(el, list[k], true);
    }, 1000 / fps);
    anims.add(el);
  }
  function stopAnim(el) { if (el._anim) { clearInterval(el._anim); el._anim = null; anims.delete(el); } }

  // ---------------- lazy activation ----------------
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const card = e.target;
      if (e.isIntersecting) activate(card);
      else card.querySelectorAll('.anim').forEach(stopAnim);
    }
  }, { rootMargin: '400px 0px' });

  function activate(card) {
    card.querySelectorAll('canvas.pdfimg:not(.anim)').forEach((cv) => { if (!cv.dataset.rendered) renderPdfCanvas(cv); });
    card.querySelectorAll('canvas.pdfimg.anim').forEach((cv) => { if (!cv.dataset.rendered) renderPdfCanvas(cv).then(() => startAnim(cv)); else startAnim(cv); });
    card.querySelectorAll('img.ig').forEach(fixImg);
    card.querySelectorAll('img.anim').forEach(startAnim);
    card.querySelectorAll('.resizebox').forEach(fitResizebox);
  }

  // ---------------- overlays ----------------
  function inSpec(spec, k) {
    for (const part of String(spec).split(',')) {
      const p = part.trim();
      if (!p) continue;
      const m = /^(\d*)(-?)(\d*)$/.exec(p);
      if (!m) continue;
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? (m[3] ? +m[3] : Infinity) : a;
      if (k >= a && k <= b) return true;
    }
    return false;
  }
  function applyStep(slide, k) {
    slide.querySelectorAll('[data-only],[data-notonly],[data-uncover],[data-invisible]').forEach((el) => {
      const d = el.dataset;
      el.classList.remove('ov-hide', 'ov-invis');
      if (d.only !== undefined && !inSpec(d.only, k)) el.classList.add('ov-hide');
      if (d.notonly !== undefined && inSpec(d.notonly, k)) el.classList.add('ov-hide');
      if (d.uncover !== undefined && !inSpec(d.uncover, k)) el.classList.add('ov-invis');
      if (d.invisible !== undefined && inSpec(d.invisible, k)) el.classList.add('ov-invis');
    });
  }
  function setStep(card, k) {
    const n = +card.dataset.steps || 1;
    k = Math.max(1, Math.min(n, k));
    card.dataset.step = k;
    applyStep(card.querySelector('.slide'), k);
    card.querySelectorAll('.stepdot').forEach((d, i) => d.classList.toggle('on', i + 1 === k));
    activate(card);
  }
  function defaultStep(n) { return state.overlays === 'first' ? 1 : n; }

  // ---------------- building cards ----------------
  function buildCard(f, i, step) {
    const card = document.createElement('div');
    card.className = 'card';
    fillCard(card, f, i, step);
    io.observe(card);
    return card;
  }
  function fillCard(card, f, i, step) {
    card.dataset.i = i;
    card.dataset.id = f.id;
    card.dataset.steps = f.steps;
    card.dataset.file = f.file || '';
    card.dataset.line = f.line;
    card.dataset.endLine = f.endLine;
    const dots = f.steps > 1 && !step
      ? `<div class="steps">${Array.from({ length: f.steps }, (_, k) => `<span class="stepdot" data-k="${k + 1}" title="overlay ${k + 1}">${k + 1}</span>`).join('')}</div>`
      : '';
    card.innerHTML = `<div class="scaler">${f.html}</div>${dots}`;
    setStep(card, step || defaultStep(f.steps));
    if (step) card.dataset.fixedStep = step;
  }

  function cardsFor(f, i) {
    if (state.overlays === 'all' && f.steps > 1) {
      return Array.from({ length: f.steps }, (_, k) => ({ key: `${f.id}#${k + 1}`, f, i, step: k + 1 }));
    }
    return [{ key: f.id, f, i, step: 0 }];
  }

  function render(newFrames) {
    frames = newFrames;
    const want = frames.flatMap((f, i) => cardsFor(f, i));
    const existing = new Map();
    for (const c of Array.from(deck.children)) {
      const key = c.dataset.fixedStep ? `${c.dataset.id}#${c.dataset.fixedStep}` : c.dataset.id;
      if (!existing.has(key)) existing.set(key, c);
    }
    const used = new Set();
    let prev = null;
    for (const w of want) {
      let card = existing.get(w.key);
      if (card && !used.has(card)) {
        // keep DOM (and rendered canvases); update metadata only
        card.dataset.i = w.i; card.dataset.file = w.f.file || ''; card.dataset.line = w.f.line; card.dataset.endLine = w.f.endLine;
      } else {
        card = buildCard(w.f, w.i, w.step);
      }
      used.add(card);
      const next = prev ? prev.nextSibling : deck.firstChild;
      if (next !== card) deck.insertBefore(card, next);
      prev = card;
    }
    for (const c of Array.from(deck.children)) if (!used.has(c)) { io.unobserve(c); c.remove(); }
    relayout();
    const n = document.getElementById('count');
    if (n) n.textContent = `${frames.length} slides`;
  }

  function relayout() {
    const cols = state.cols || 1;
    deck.style.setProperty('--cols', cols);
    const gap = 12;
    const w = (deck.clientWidth - gap * (cols - 1)) / cols;
    deck.style.setProperty('--zoom', Math.max(0.1, w / SLIDE_PX));
    if (presenting >= 0) {
      const z = Math.min(window.innerWidth / SLIDE_PX, window.innerHeight / (SLIDE_PX * 9 / 16));
      document.documentElement.style.setProperty('--pzoom', z);
    }
    document.querySelectorAll('.resizebox').forEach(fitResizebox);
  }
  window.addEventListener('resize', () => {
    relayout();
    // re-render visible PDFs at the new resolution
    clearTimeout(relayout._t);
    relayout._t = setTimeout(() => document.querySelectorAll('canvas.pdfimg[data-rendered]').forEach((cv) => {
      const r = cv.getBoundingClientRect();
      if (r.bottom > -200 && r.top < window.innerHeight + 200) renderPdfCanvas(cv);
    }), 300);
  });

  // ---------------- interaction ----------------
  deck.addEventListener('click', (e) => {
    const dot = e.target.closest('.stepdot');
    const card = e.target.closest('.card');
    if (!card) return;
    if (dot) { setStep(card, +dot.dataset.k); e.stopPropagation(); return; }
    document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel'));
    card.classList.add('sel');
    if (vscode) {
      // jump to the closest source line of the clicked element, else the frame
      const el = e.target.closest('[data-line]');
      const line = el && card.contains(el) ? +el.dataset.line : +card.dataset.line;
      vscode.postMessage({ type: 'reveal', file: card.dataset.file, line });
    }
  });
  deck.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) present(Array.from(deck.children).indexOf(card));
  });

  function cursorTo(file, line) {
    const cards = Array.from(deck.children).filter((c) => c.dataset.file === file);
    let best = null;
    for (const c of cards) {
      if (+c.dataset.line <= line && line <= +c.dataset.endLine) { best = c; break; }
      if (+c.dataset.line <= line) best = c;
    }
    if (!best) return;
    document.querySelectorAll('.card.cur').forEach((c) => c.classList.remove('cur'));
    best.classList.add('cur');
    // choose overlay step that shows the element under the cursor
    if (!best.dataset.fixedStep && +best.dataset.steps > 1) {
      let el = null, elLine = -1;
      best.querySelectorAll('[data-line]').forEach((x) => { const l = +x.dataset.line; if (l <= line && l >= elLine) { el = x; elLine = l; } });
      if (el) {
        const n = +best.dataset.steps;
        for (let k = 1; k <= n; k++) {
          applyStep(best.querySelector('.slide'), k);
          if (isShown(el)) { setStep(best, k); break; }
          if (k === n) setStep(best, defaultStep(n));
        }
      }
    }
    if (presenting >= 0) { present(Array.from(deck.children).indexOf(best)); return; }
    const r = best.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) best.scrollIntoView({ block: 'center', behavior: Math.abs(r.top) > 3000 ? 'auto' : 'smooth' });
  }
  function isShown(el) {
    for (let x = el; x && !x.classList.contains('slide'); x = x.parentElement) {
      if (x.classList.contains('ov-hide') || x.classList.contains('ov-invis')) return false;
    }
    return true;
  }

  // ---------------- presentation mode ----------------
  function present(idx) {
    const cards = Array.from(deck.children);
    if (idx < 0 || idx >= cards.length) return;
    cards.forEach((c) => c.classList.remove('presenting'));
    presenting = idx;
    document.body.classList.add('present');
    cards[idx].classList.add('presenting');
    relayout();
    activate(cards[idx]);
  }
  function endPresent() {
    document.body.classList.remove('present');
    const c = deck.children[presenting];
    if (c) c.classList.remove('presenting');
    presenting = -1;
    relayout();
    if (c) c.scrollIntoView({ block: 'center' });
  }
  function advance(dir) {
    const cards = Array.from(deck.children);
    const c = cards[presenting];
    if (!c) return;
    const n = +c.dataset.steps || 1;
    const k = +c.dataset.step || 1;
    if (!c.dataset.fixedStep && dir > 0 && k < n) return setStep(c, k + 1);
    if (!c.dataset.fixedStep && dir < 0 && k > 1) return setStep(c, k - 1);
    const j = presenting + dir;
    if (j < 0 || j >= cards.length) return;
    present(j);
    const cj = cards[j];
    if (!cj.dataset.fixedStep) setStep(cj, dir > 0 ? 1 : +cj.dataset.steps);
  }
  window.addEventListener('keydown', (e) => {
    if (presenting >= 0) {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { advance(1); e.preventDefault(); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { advance(-1); e.preventDefault(); }
      else if (e.key === 'Escape') endPresent();
      else if (e.key === 'Home') present(0);
      else if (e.key === 'End') present(deck.children.length - 1);
    } else if (e.key === 'p' || e.key === 'F5') {
      const sel = document.querySelector('.card.sel') || document.querySelector('.card.cur') || deck.firstChild;
      present(Array.from(deck.children).indexOf(sel));
    }
  });

  // ---------------- toolbar ----------------
  function saveState() { if (vscode) vscode.setState(state); }
  document.getElementById('tb-cols')?.addEventListener('change', (e) => { state.cols = +e.target.value; saveState(); relayout(); });
  document.getElementById('tb-ov')?.addEventListener('change', (e) => { state.overlays = e.target.value; saveState(); deck.innerHTML = ''; render(frames); });
  document.getElementById('tb-present')?.addEventListener('click', () => {
    const sel = document.querySelector('.card.sel') || document.querySelector('.card.cur') || deck.firstChild;
    present(Math.max(0, Array.from(deck.children).indexOf(sel)));
  });
  const colsSel = document.getElementById('tb-cols'); if (colsSel) colsSel.value = String(state.cols);
  const ovSel = document.getElementById('tb-ov'); if (ovSel) ovSel.value = state.overlays;

  function setVars(vars) {
    for (const k in vars) document.documentElement.style.setProperty(k, vars[k]);
  }
  function showDiag(list) {
    const el = document.getElementById('diag');
    if (!el) return;
    el.textContent = list && list.length ? `${list.length} note${list.length > 1 ? 's' : ''}` : '';
    el.title = (list || []).slice(0, 40).map((d) => `${d.file ? d.file.split(/[\\/]/).pop() + ':' + (d.line + 1) + ' ' : ''}${d.msg}`).join('\n');
  }

  // ---------------- messages ----------------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.type) return;
    if (m.type === 'update') {
      setVars(m.cssVars || {});
      render(m.frames || []);
      showDiag(m.diagnostics);
      if (m.cursor) cursorTo(m.cursor.file, m.cursor.line);
      setTimeout(() => vscode && vscode.postMessage({
        type: 'stats', cards: deck.children.length, pdfOk, imgs: document.querySelectorAll('img.ig').length,
        katex: document.querySelectorAll('.katex').length, missing: document.querySelectorAll('.img-missing').length,
        fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight).filter((v, i, a) => a.indexOf(v) === i),
        cur: document.querySelector('.card.cur') ? document.querySelector('.card.cur').dataset.i : null,
      }), 2500);
    } else if (m.type === 'cursor') {
      cursorTo(m.file, m.line);
    } else if (m.type === 'snippet') {
      document.querySelectorAll(`.snippet[data-key="${m.key}"]`).forEach((ph) => {
        if (m.uri) {
          const cv = document.createElement('canvas');
          cv.className = 'pdfimg snippet-img';
          cv.dataset.src = m.uri; cv.dataset.page = '1'; cv.dataset.scale = '1'; cv.dataset.key = m.key;
          ph.replaceWith(cv);
          renderPdfCanvas(cv);
        } else {
          ph.classList.remove('pending');
          ph.classList.add('failed');
          ph.title = m.error || 'LaTeX snippet failed';
          const lbl = ph.querySelector('.snip-label');
          if (lbl && !lbl.dataset.err) { lbl.dataset.err = '1'; lbl.textContent += ` — not compiled: ${m.error || 'LaTeX error'}`; }
        }
      });
    }
  });

  // static export: data embedded in page
  if (window.__BEAMER_DATA__) {
    const d = window.__BEAMER_DATA__;
    setVars(d.cssVars || {});
    render(d.frames || []);
    showDiag(d.diagnostics);
  }
  if (vscode) vscode.postMessage({ type: 'ready' });
})();

'use strict';
// Beamer overlay specs and per-step variants of raw LaTeX (for snippets compiled outside beamer).

/** Is step k inside an overlay spec like "2", "2-", "-3", "1,3-4"? */
function inSpec(spec, k) {
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d*)\s*(-?)\s*(\d*)\s*$/.exec(part);
    if (!m || (!m[1] && !m[3] && !m[2])) continue;
    const a = m[1] ? +m[1] : 1;
    const b = m[2] ? (m[3] ? +m[3] : Infinity) : a;
    if (k >= a && k <= b) return true;
  }
  return false;
}

const OV_RE = /\\(only|visible|uncover|onslide|invisible|alt)\s*<([^>]*)>/g;

/**
 * Resolve incremental specs (<+->, <+>, <.>, <+(1)->) in order of appearance, like beamer's
 * beamerpauses counter. `start` is the frame's current counter; returns the new source and counter.
 */
function resolveIncremental(src, start) {
  let cur = start;
  const out = src.replace(OV_RE, (m, cmd, spec) => {
    if (!/[+.]/.test(spec)) return m;
    let usedPlus = false;
    const r = spec.replace(/\+(?:\((-?\d+)\))?|\.(?:\((-?\d+)\))?/g, (t, o1, o2) => {
      if (t[0] === '+') { usedPlus = true; return String(cur + (parseInt(o1, 10) || 0)); }
      return String(Math.max(1, cur - 1 + (parseInt(o2, 10) || 0)));
    });
    if (usedPlus) cur++;
    return `\\${cmd}<${r}>`;
  });
  OV_RE.lastIndex = 0;
  return { src: out, next: cur };
}

/** Highest step number used by overlay commands in a LaTeX source (0 if none). */
function overlaySteps(src) {
  let n = 0;
  for (const m of src.matchAll(OV_RE)) for (const d of m[2].match(/\d+/g) || []) n = Math.max(n, +d);
  return n;
}

function readGroup(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { body: src.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

/**
 * The source as it looks on overlay step k. Hidden \visible/\uncover parts are kept but made
 * transparent inside TikZ (so the bounding box and node names stay), and dropped elsewhere.
 */
function overlayVariant(src, k, tikz) {
  let out = '';
  let i = 0;
  OV_RE.lastIndex = 0;
  const hide = (body) => (tikz ? `\\begin{scope}[opacity=0,text opacity=0,draw opacity=0,fill opacity=0]${body}\\end{scope}` : '');
  for (;;) {
    OV_RE.lastIndex = i;
    const m = OV_RE.exec(src);
    if (!m) { out += src.slice(i); break; }
    out += src.slice(i, m.index);
    const [, cmd, spec] = m;
    const g1 = readGroup(src, m.index + m[0].length);
    if (!g1) { i = m.index + m[0].length; continue; } // \onslide<..> without braces: ignore the switch
    const on = inSpec(spec, k);
    if (cmd === 'alt') {
      const g2 = readGroup(src, g1.end);
      out += overlayVariant(on ? g1.body : g2 ? g2.body : '', k, tikz);
      i = g2 ? g2.end : g1.end;
      continue;
    }
    const body = overlayVariant(g1.body, k, tikz);
    if (cmd === 'only') out += on ? body : '';
    else if (cmd === 'invisible') out += on ? hide(body) : body;
    else out += on ? body : hide(body);
    i = g1.end;
  }
  return out.replace(/\\pause\b(\[\d+\])?/g, '');
}

module.exports = { inSpec, overlaySteps, overlayVariant, resolveIncremental };

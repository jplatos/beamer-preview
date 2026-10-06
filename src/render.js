'use strict';
// Beamer (metropolis) -> HTML renderer. Approximates the look; it is not TeX.

const path = require('path');
const crypto = require('crypto');
const katex = require('katex');
const { tokenize, lineIndex, offsetToLine } = require('./tokenizer');
const { ColorTable, toCss, mix } = require('./colors');
const { overlaySteps, overlayVariant, resolveIncremental } = require('./overlays');

// ---------- geometry (16:9, 11pt, measured from beamer + metropolis) ----------
const GEOM = {
  paperW: 455.244, paperH: 256.075, textW: 398.339, textH: 224.789, margin: 28.453,
};
const SIZES = {
  tiny: 6, scriptsize: 8, footnotesize: 9, small: 10, normalsize: 11, large: 12, Large: 14.4, LARGE: 17.28, huge: 20.74, Huge: 24.88,
};

// ---------- token stream ----------
class Stream {
  constructor(toks) { this.t = toks; this.i = 0; }
  eof() { return this.i >= this.t.length; }
  peek(k = 0) { return this.t[this.i + k]; }
  next() { return this.t[this.i++]; }
  insert(toks) { this.t = this.t.slice(0, this.i).concat(toks, this.t.slice(this.i)); }
  rest() { const r = this.t.slice(this.i); this.i = this.t.length; return r; }
}

const isSpace = (t) => t && t.type === 'char' && (t.ch === ' ');
function skipSpaces(s, alsoPar = false) {
  while (!s.eof() && (isSpace(s.peek()) || (alsoPar && s.peek().type === 'par'))) s.i++;
}

/** Read a TeX argument: a balanced {group} or a single token. Returns token array. */
function readArg(s) {
  skipSpaces(s, true);
  const t = s.peek();
  if (!t) return [];
  if (t.type !== 'bgroup') { s.i++; return [t]; }
  s.i++;
  let depth = 1;
  const out = [];
  while (!s.eof()) {
    const u = s.next();
    if (u.type === 'bgroup') depth++;
    else if (u.type === 'egroup') { depth--; if (depth === 0) break; }
    out.push(u);
  }
  return out;
}

/** Read [optional] argument. Returns tokens or null. */
function readOpt(s) {
  const save = s.i;
  skipSpaces(s);
  const t = s.peek();
  if (!t || t.type !== 'char' || t.ch !== '[') { s.i = save; return null; }
  s.i++;
  let depth = 0;
  const out = [];
  while (!s.eof()) {
    const u = s.next();
    if (u.type === 'bgroup') depth++;
    else if (u.type === 'egroup') depth--;
    else if (depth === 0 && u.type === 'char' && u.ch === ']') return out;
    out.push(u);
  }
  return out;
}

/** Read <overlay spec>. Returns string or null. */
function readOverlay(s) {
  const save = s.i;
  skipSpaces(s);
  const t = s.peek();
  if (!t || t.type !== 'char' || t.ch !== '<') { s.i = save; return null; }
  s.i++;
  let out = '';
  while (!s.eof()) {
    const u = s.next();
    if (u.type === 'char' && u.ch === '>') return out.replace(/\s+/g, '');
    out += texOf([u]);
  }
  return out;
}

function readStar(s) {
  const t = s.peek();
  if (t && t.type === 'char' && t.ch === '*') { s.i++; return true; }
  return false;
}

/** Reconstruct TeX source from tokens (for lengths, keys, math macros, snippets). */
function texOf(toks) {
  let out = '';
  for (const t of toks) {
    switch (t.type) {
      case 'char': out += t.ch === ' ' ? '~' : t.ch; break;
      case 'cs': out += '\\' + t.name + (t.sym ? '' : ' '); break;
      case 'bgroup': out += '{'; break;
      case 'egroup': out += '}'; break;
      case 'align': out += '&'; break;
      case 'param': out += '#' + t.n; break;
      case 'par': out += '\n\n'; break;
      case 'math': out += t.env ? `\\begin{${t.env}}${t.src}\\end{${t.env}}` : t.display ? `\\[${t.src}\\]` : `$${t.src}$`; break;
      case 'begin': out += `\\begin{${t.name}}`; break;
      case 'end': out += `\\end{${t.name}}`; break;
      case 'raw': out += t.src; break;
      case 'verb': out += `\\begin{${t.env}}${t.src}\\end{${t.env}}`; break;
      case 'verbinline': out += `\\verb|${t.src}|`; break;
      default: break;
    }
  }
  return out.replace(/\\([a-zA-Z@]+) (?=[^a-zA-Z@])/g, '\\$1');
}

/** Collect an environment body up to the matching \end{name}. */
function readEnvBody(s, name) {
  let depth = 1;
  const out = [];
  while (!s.eof()) {
    const u = s.next();
    if (u.type === 'begin' && u.name === name) depth++;
    else if (u.type === 'end' && u.name === name) { depth--; if (depth === 0) return out; }
    out.push(u);
  }
  return out;
}

const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseKeyVals(str) {
  const out = {};
  if (!str) return out;
  let depth = 0, cur = '';
  const parts = [];
  for (const ch of str) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const k = p.indexOf('=');
    if (k < 0) { if (p.trim()) out[p.trim()] = true; continue; }
    out[p.slice(0, k).trim()] = p.slice(k + 1).trim().replace(/^\{(.*)\}$/s, '$1');
  }
  return out;
}

// ---------- lengths ----------
const UNIT_PT = { pt: 1, mm: 2.84528, cm: 28.4528, in: 72.27, bp: 1.00375, pc: 12, sp: 1 / 65536, px: 0.75 };
/**
 * Convert a TeX length to CSS. `axis` w = horizontal (relative widths become %), v = vertical.
 */
function cssLength(str, axis = 'w') {
  if (!str) return null;
  str = String(str).replace(/\s+/g, '').replace(/plus.*$/, '');
  const m = /^(-?[0-9]*\.?[0-9]*)\\?([a-zA-Z@]+)$/.exec(str);
  if (!m) return null;
  let k = m[1] === '' || m[1] === '-' ? (m[1] === '-' ? -1 : 1) : parseFloat(m[1]);
  const u = m[2];
  if (UNIT_PT[u] !== undefined) return `${+(k * UNIT_PT[u]).toFixed(3)}pt`;
  if (u === 'em' || u === 'ex') return `${k}${u}`;
  switch (u) {
    case 'textwidth': case 'linewidth': case 'columnwidth': case 'hsize': case 'textwidth@':
      return axis === 'w' ? `${+(k * 100).toFixed(3)}%` : `${+(k * GEOM.textW).toFixed(2)}pt`;
    case 'paperwidth': return `${+(k * GEOM.paperW).toFixed(2)}pt`;
    case 'textheight': case 'vsize': return `${+(k * GEOM.textH).toFixed(2)}pt`;
    case 'paperheight': return `${+(k * GEOM.paperH).toFixed(2)}pt`;
    case 'baselineskip': return `${+(k * 1.42).toFixed(3)}em`;
    case 'parskip': return `${k * 0.5}em`;
    case 'fill': case 'stretch': return null;
    default: return null;
  }
}

// ---------- overlays ----------
function maxInSpec(spec) {
  let m = 0;
  for (const x of spec.match(/\d+/g) || []) m = Math.max(m, +x);
  return m;
}

// ---------- accents ----------
const ACCENTS = { "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇',
  u: '̆', v: '̌', H: '̋', c: '̧', d: '̣', b: '̱', r: '̊', k: '̨' };
const SYMBOLS = {
  ldots: '…', dots: '…', textbullet: '•', textendash: '–', textemdash: '—', copyright: '©', textcopyright: '©', S: '§', P: '¶',
  dag: '†', ddag: '‡', textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textregistered: '®', texttrademark: '™',
  pounds: '£', euro: '€', EUR: '€', checkmark: '✓', textless: '<', textgreater: '>', textbar: '|', slash: '/', textdegree: '°',
  textquotedblleft: '“', textquotedblright: '”', textquoteleft: '‘', textquoteright: '’', guillemotleft: '«', guillemotright: '»',
  i: 'ı', j: 'ȷ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å',
  textperiodcentered: '·', textellipsis: '…', textunderscore: '_', textminus: '−', texttimes: '×', textpm: '±',
  LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX2ε', ccbysa: '🅭', ccby: '🅭', dingarrow: '➜',
  '&': '&', '%': '%', '$': '$', '#': '#', '_': '_', '{': '{', '}': '}', ' ': ' ', ',': ' ', ';': ' ', ':': ' ',
  '!': '', '/': '', '-': '', '@': '', quad: ' ', qquad: '  ', enspace: ' ', thinspace: ' ',
  enskip: ' ', space: ' ', nobreakspace: ' ', textvisiblespace: '␣',
};

const FONT_WRAP = {
  textbf: ['<b>', '</b>'], textit: ['<i>', '</i>'], textsl: ['<i>', '</i>'], emph: ['<em>', '</em>'],
  texttt: ['<code class="tt">', '</code>'], textsc: ['<span class="sc">', '</span>'], underline: ['<u>', '</u>'],
  uline: ['<u>', '</u>'], textsf: ['<span>', '</span>'], textrm: ['<span class="rm">', '</span>'],
  textnormal: ['<span class="nf">', '</span>'], textmd: ['<span class="md">', '</span>'], textup: ['<span class="up">', '</span>'],
  mbox: ['<span class="nobr">', '</span>'], hbox: ['<span class="nobr">', '</span>'], makebox: ['<span class="nobr">', '</span>'],
  alert: ['<span class="alert">', '</span>'], structure: ['<span class="structure">', '</span>'],
  textsuperscript: ['<sup>', '</sup>'], textsubscript: ['<sub>', '</sub>'], sout: ['<s>', '</s>'], st: ['<s>', '</s>'],
  hl: ['<mark>', '</mark>'], fbox: ['<span class="fbox">', '</span>'], framebox: ['<span class="fbox">', '</span>'],
  text: ['<span>', '</span>'], ensuremath: ['<span>', '</span>'], titlecap: ['<span>', '</span>'], phantom: ['<span class="phantom">', '</span>'],
};
const SWITCHES = {
  bfseries: 'font-weight:400', bf: 'font-weight:400', itshape: 'font-style:italic', it: 'font-style:italic',
  slshape: 'font-style:italic', em: 'font-style:italic', ttfamily: 'font-family:var(--mono)', tt: 'font-family:var(--mono)',
  scshape: 'font-variant:small-caps', mdseries: 'font-weight:300', upshape: 'font-style:normal', normalfont: 'font-weight:300;font-style:normal',
  rmfamily: '', sffamily: '', raggedright: 'text-align:left', raggedleft: 'text-align:right', boldmath: '', unboldmath: '',
};
// commands silently ignored together with N mandatory args (and optional args)
const IGNORE = {
  label: 1, ref: -1, cite: -1, index: 1, hypertarget: 1, hypersetup: 1, setcounter: 2, addtocounter: 2, stepcounter: 1,
  refstepcounter: 1, setbeamertemplate: -2, setbeamerfont: 2, usebeamercolor: 1, usebeamerfont: 1, usebeamertemplate: 1,
  setbeamersize: 1, usetikzlibrary: 1, tikzset: 1, pgfplotsset: 1, presetkeys: 3, graphicspath: 1,
  arrayrulecolor: 0, noindent: 0, indent: 0, protect: 0, relax: 0, centering: 0, nobreak: 0, sloppy: 0, fussy: 0,
  frenchspacing: 0, nointerlineskip: 0, strut: 0, null: 0, leavevmode: 0, ignorespaces: 0, unskip: 0, maketitle: 0,
  tableofcontents: 0, AtBeginSection: 1, AtBeginSubsection: 1, appendix: 0, setlength: 2, addtolength: 2,
  SetAlgoLined: 0, DontPrintSemicolon: 0, SetKwInOut: 2, SetKw: 2, SetKwBlock: 3, SetFuncSty: 1, SetDataSty: 1,
  metroset: 1, linespread: 1, selectfont: 0, fontsize: 2, usepackage: 1, captionsetup: 1, newpage: 0, clearpage: 0,
  pagebreak: 0, framebreak: 0, allowbreak: 0, hyphenation: 1, includeonlyframes: 1, beamertemplatenavigationsymbolsempty: 0,
  thispagestyle: 1, pagestyle: 1, footnotemark: 0, newline: 0, cline: 1, cmidrule: 1, toprule: 0, midrule: 0, bottomrule: 0,
  hline: 0, addlinespace: 0, specialrule: 3, rowcolors: 3, tabularnewline: 0, Hline: 0, hdashline: 0, vline: 0,
  newcounter: 1, inputencoding: 1, selectlanguage: 1, foreignlanguage: 1, resetcounteronoverlays: 1,
};

// ---------- the renderer ----------
class Renderer {
  /**
   * @param {object} opts
   *  - readFile(absPath) -> string|null
   *  - resolveImage(absPath) -> {uri, kind:'img'|'pdf'} | null   (absPath without guaranteed ext)
   *  - snippet(rawTex, ctx) -> {key, uri|null}   (optional; LaTeX-rendered fallback)
   */
  constructor(opts) {
    this.opts = opts;
    this.colors = new ColorTable();
    this.macros = Object.create(null); // name -> {n, def: tokens|null, body: tokens}
    this.envs = Object.create(null);   // name -> {n, def, begin, end}
    this.lets = Object.create(null);
    this.katexMacros = Object.create(null);
    this.info = { title: '', subtitle: '', author: '', date: '', institute: '', titlegraphic: null };
    this.metro = { progressbar: 'none', numbering: 'counter', block: 'transparent', sectionpage: 'progressbar', background: 'light', subsectionpage: 'none' };
    this.beamerColors = Object.create(null);
    this.preambleLines = [];
    this.tikzLibs = new Set();
    this.packages = [];
    this.figureNo = 0;
    this.tableNo = 0;
    this.diagnostics = [];
    this.frameFooter = '';
    this.arrayRuleColor = null;
    this.lineCache = new Map();
    this.fileStack = [];
    this.fontSizePt = 11;
  }

  diag(msg, tok) {
    if (this.diagnostics.length < 200) this.diagnostics.push({ msg, file: tok && tok.file, line: tok ? this.lineOf(tok) : 0 });
  }

  lineOf(tok) {
    if (!tok || tok.pos === undefined || !tok.file) return 0;
    let li = this.lineCache.get(tok.file);
    if (!li) {
      const src = this.opts.readFile(tok.file) || '';
      li = lineIndex(src);
      this.lineCache.set(tok.file, li);
    }
    return offsetToLine(li, tok.pos);
  }

  // ======================= document level =======================

  /**
   * Render a document.
   * @param {string} rootFile absolute path of file with \documentclass
   * @param {{focusFile?: string}} o if focusFile is a subfile, only frames from it are rendered (lecture mode)
   */
  renderDocument(rootFile, o = {}) {
    const src = this.opts.readFile(rootFile);
    if (src == null) throw new Error('Cannot read ' + rootFile);
    this.rootDir = path.dirname(rootFile);
    const toks = tokenize(src, { file: rootFile, rawEnvs: this.opts.rawEnvs });
    const bd = toks.findIndex((t) => t.type === 'begin' && t.name === 'document');
    const pre = bd < 0 ? toks : toks.slice(0, bd);
    this.preambleSrc = bd < 0 ? src : src.slice(0, toks[bd].pos);
    this.processPreamble(new Stream(pre), this.rootDir);
    this.finishTheme();

    // pass 1: collect a linear list of document items (title, section pages, frames)
    const items = [];
    if (bd >= 0) {
      const body = toks.slice(bd + 1);
      const ed = body.findIndex((t) => t.type === 'end' && t.name === 'document');
      this.collect(new Stream(ed < 0 ? body : body.slice(0, ed)), this.rootDir, items, { section: '', subsection: '' });
    }

    let list = items;
    const focus = o.focusFile && path.resolve(o.focusFile) !== path.resolve(rootFile) ? path.resolve(o.focusFile) : null;
    if (focus) {
      const inFocus = items.filter((it) => it.file && path.resolve(it.file) === focus);
      const first = inFocus[0];
      const sectionTitle = first ? first.section : '';
      list = [];
      const title = items.find((it) => it.kind === 'title');
      if (title) list.push({ ...title, subtitleOverride: sectionTitle || null });
      const secPage = first && items.find((it) => it.kind === 'section' && it.section === sectionTitle && it.file !== focus);
      if (secPage) list.push(secPage);
      list.push(...inFocus);
      // closing frames of the root document (e.g. a final standout "Questions?" frame)
      const lastIdx = items.reduce((m, it, i) => (it.file && path.resolve(it.file) !== path.resolve(rootFile) ? i : m), -1);
      list.push(...items.slice(lastIdx + 1).filter((it) => it.kind === 'frame' && path.resolve(it.file) === path.resolve(rootFile)));
    }

    // numbering
    let fn = 0;
    for (const it of list) {
      if (it.kind === 'frame' && !it.noNumber) fn++;
      it.frameNumber = Math.max(fn, 1);
    }
    const total = Math.max(fn, 1);
    const sections = list.filter((x) => x.kind === 'section');

    const frames = [];
    for (const it of list) {
      let r;
      try {
        r = this.renderItem(it, total, sections);
      } catch (e) {
        r = { html: `<section class="slide err"><div class="errbox">Render error: ${esc(e.message)}</div></section>`, steps: 1 };
        this.diag('render error: ' + e.message, it.tok);
      }
      frames.push({
        kind: it.kind, file: it.file, line: it.line, endLine: it.endLine, steps: r.steps || 1,
        html: r.html, id: crypto.createHash('sha1').update(r.html).digest('hex').slice(0, 12), title: it.title || '',
      });
    }
    return { frames, cssVars: this.cssVars, diagnostics: this.diagnostics, title: this.info.title };
  }

  // ---------- preamble ----------
  processPreamble(s, dir) {
    while (!s.eof()) {
      const t = s.next();
      if (t.type !== 'cs') continue;
      if (this.handleDefinition(t, s, dir)) continue;
      switch (t.name) {
        case 'documentclass': {
          const o = readOpt(s); readArg(s);
          const kv = parseKeyVals(o ? texOf(o) : '');
          if (kv['10pt']) this.fontSizePt = 10;
          if (kv['12pt']) this.fontSizePt = 12;
          break;
        }
        case 'usetheme': {
          const o = readOpt(s); readArg(s);
          if (o) this.metroset(texOf(o));
          break;
        }
        case 'usepackage': case 'RequirePackage': {
          const o = readOpt(s); const a = texOf(readArg(s));
          this.packages.push({ opt: o ? texOf(o) : '', name: a });
          break;
        }
        case 'usetikzlibrary': { this.preambleLines.push('\\usetikzlibrary{' + texOf(readArg(s)) + '}'); break; }
        case 'usepgfplotslibrary': { this.preambleLines.push('\\usepgfplotslibrary{' + texOf(readArg(s)) + '}'); break; }
        case 'tikzset': case 'pgfplotsset': { this.preambleLines.push(`\\${t.name}{${texOf(readArg(s))}}`); break; }
        case 'tikzstyle': { break; }
        case 'title': case 'subtitle': case 'author': case 'date': case 'institute': {
          readOpt(s); this.info[t.name] = readArg(s); break;
        }
        case 'titlegraphic': { this.info.titlegraphic = readArg(s); this.info.titlegraphicDir = dir; break; }
        case 'setbeamertemplate': {
          const name = texOf(readArg(s)).trim();
          const o = readOpt(s);
          if (name === 'frame footer') { const a = readArg(s); this.frameFooter = a; } else if (!o) readArg(s);
          break;
        }
        case 'arrayrulecolor': { this.arrayRuleColor = texOf(readArg(s)).trim(); break; }
        case 'lstset': { this.lstDefaults = Object.assign(this.lstDefaults || {}, parseKeyVals(texOf(readArg(s)))); break; }
        case 'graphicspath': { const a = texOf(readArg(s)); this.graphicsPath = (a.match(/\{([^}]*)\}/g) || []).map((x) => x.slice(1, -1)); break; }
        case 'input': case 'include': {
          const f = texOf(readArg(s)).trim();
          const toks = this.loadTex(path.resolve(dir, f));
          if (toks) s.insert(toks);
          break;
        }
        default: break;
      }
    }
  }

  metroset(str) {
    const kv = parseKeyVals(str);
    for (const k in kv) if (k in this.metro || k === 'titleformat') this.metro[k] = kv[k];
  }

  /** Handle definitions valid in preamble and body. Returns true if consumed. */
  handleDefinition(t, s, dir) {
    switch (t.name) {
      case 'newcommand': case 'renewcommand': case 'providecommand': case 'DeclareRobustCommand': {
        readStar(s);
        let nameToks = readArg(s);
        const name = nameToks.find((x) => x.type === 'cs');
        const n = readOpt(s);
        const def = readOpt(s);
        const body = readArg(s);
        if (!name) return true;
        if (t.name === 'providecommand' && this.macros[name.name]) return true;
        this.macros[name.name] = { n: n ? parseInt(texOf(n), 10) || 0 : 0, def, body };
        this.addKatexMacro(name.name, body);
        (this.defLines = this.defLines || []).push(
          `\\providecommand{\\${name.name}}${n ? `[${texOf(n)}]` : ''}${def ? `[${texOf(def)}]` : ''}{${texOf(body)}}`);
        return true;
      }
      case 'def': case 'gdef': case 'edef': case 'xdef': {
        const name = s.next();
        const params = [];
        while (!s.eof() && s.peek().type !== 'bgroup') params.push(s.next());
        const body = readArg(s);
        if (name && name.type === 'cs') {
          const n = params.filter((p) => p.type === 'param').length;
          const delimited = params.some((p) => p.type !== 'param');
          if (!delimited) { this.macros[name.name] = { n, def: null, body }; this.addKatexMacro(name.name, body); }
        }
        return true;
      }
      case 'let': {
        const a = s.next(); skipSpaces(s);
        if (s.peek() && s.peek().type === 'char' && s.peek().ch === '=') s.i++;
        skipSpaces(s);
        const b = s.next();
        if (a && b && a.type === 'cs' && b.type === 'cs') this.lets[a.name] = b.name;
        return true;
      }
      case 'DeclareMathOperator': {
        const star = readStar(s);
        const nm = readArg(s).find((x) => x.type === 'cs');
        const body = texOf(readArg(s));
        if (nm) this.katexMacros['\\' + nm.name] = `\\operatorname${star ? '*' : ''}{${body}}`;
        return true;
      }
      case 'newenvironment': case 'renewenvironment': {
        readStar(s);
        const name = texOf(readArg(s)).trim();
        const n = readOpt(s); const def = readOpt(s);
        const begin = readArg(s); const end = readArg(s);
        this.envs[name] = { n: n ? parseInt(texOf(n), 10) || 0 : 0, def, begin, end };
        return true;
      }
      case 'newtheorem': {
        readStar(s);
        const name = texOf(readArg(s)).trim(); readOpt(s);
        const title = texOf(readArg(s)).trim(); readOpt(s);
        this.theorems = this.theorems || {};
        this.theorems[name] = title;
        return true;
      }
      case 'definecolor': case 'providecolor': {
        readOpt(s);
        const name = texOf(readArg(s)).trim(); const model = texOf(readArg(s)).trim(); const spec = texOf(readArg(s));
        this.colors.define(name, model, spec);
        this.preambleLines.push(`\\definecolor{${name}}{${model}}{${spec}}`);
        return true;
      }
      case 'colorlet': {
        readOpt(s);
        const name = texOf(readArg(s)).trim(); const expr = texOf(readArg(s)).trim();
        const c = this.colors.parse(expr);
        if (c) this.colors.user[name] = c;
        this.preambleLines.push(`\\colorlet{${name}}{${expr}}`);
        return true;
      }
      case 'setbeamercolor': {
        readStar(s);
        const name = texOf(readArg(s)).trim();
        const kv = parseKeyVals(texOf(readArg(s)));
        this.beamerColors[name] = Object.assign(this.beamerColors[name] || {}, kv);
        if (this.cssVars) this.finishTheme();
        return true;
      }
      case 'metroset': { this.metroset(texOf(readArg(s))); return true; }
      case 'usecolortheme': case 'usefonttheme': case 'useinnertheme': case 'useoutertheme': {
        readOpt(s); readArg(s); return true;
      }
      default: return false;
    }
  }

  addKatexMacro(name, bodyToks) {
    let b = texOf(bodyToks);
    // strip text-only switches that KaTeX does not know
    b = b.replace(/\\(xspace|protect|bfseries|itshape|ttfamily)\b/g, '');
    this.katexMacros['\\' + name] = b;
  }

  /** compute theme colors as CSS variables (metropolis color theme semantics) */
  finishTheme() {
    const C = this.colors;
    const bc = this.beamerColors;
    const get = (name, key) => bc[name] && bc[name][key];
    const dark = this.metro.background === 'dark';
    const nfg = C.parse(get('normal text', 'fg') || (dark ? 'black!2' : 'mDarkTeal'));
    const nbg = C.parse(get('normal text', 'bg') || (dark ? 'mDarkTeal' : 'black!2'));
    const sp = { fg: nfg, bg: nbg, 'normal text.fg': nfg, 'normal text.bg': nbg };
    const alert = C.parse(get('alerted text', 'fg') || 'mLightBrown', sp);
    const example = C.parse(get('example text', 'fg') || 'mLightGreen', sp);
    const ppFg = C.parse(get('palette primary', 'fg') || 'x', sp) || nbg;
    const ppBg = C.parse(get('palette primary', 'bg') || 'x', sp) || nfg;
    sp['palette primary.bg'] = ppBg; sp['palette primary.fg'] = ppFg;
    const ftFg = C.parse(get('frametitle', 'fg') || 'x', sp) || ppFg;
    const ftBg = C.parse(get('frametitle', 'bg') || 'x', sp) || ppBg;
    sp['alerted text.fg'] = alert;
    const pbFg = C.parse(get('progress bar', 'fg') || 'x', sp) || alert;
    const pbBg = C.parse(get('progress bar', 'bg') || 'x', sp) || mix(mix(alert, [0, 0, 0], 0.5), [1, 1, 1], 0.3);
    const btBg = C.parse(get('block title', 'bg') || 'x', sp) || mix(nbg, nfg, 0.8);
    const bbBg = C.parse(get('block body', 'bg') || 'x', sp) || mix(btBg, nbg, 0.5);
    const structure = C.parse(get('structure', 'fg') || 'x', sp) || nfg;
    const canvas = C.parse(get('background canvas', 'bg') || 'x', sp) || nbg;
    const fill = this.metro.block === 'fill';
    this.cssVars = {
      '--fg': toCss(nfg), '--bg': toCss(canvas), '--alert': toCss(alert), '--example': toCss(example),
      '--ft-fg': toCss(ftFg), '--ft-bg': toCss(ftBg), '--pp-fg': toCss(ppFg), '--pp-bg': toCss(ppBg),
      '--pb-fg': toCss(pbFg), '--pb-bg': toCss(pbBg), '--structure': toCss(structure),
      '--bt-bg': fill ? toCss(btBg) : 'transparent', '--bb-bg': fill ? toCss(bbBg) : 'transparent',
      '--block-pad': fill ? '1' : '0', '--rule': this.arrayRuleColor ? (C.css(this.arrayRuleColor) || 'currentColor') : 'currentColor',
      '--fn-fg': toCss(mix(nfg, nbg, 0.9)),
    };
  }

  loadTex(abs) {
    const cands = [abs, abs + '.tex'];
    for (const f of cands) {
      const src = this.opts.readFile(f);
      if (src != null) return tokenize(src, { file: f, rawEnvs: this.opts.rawEnvs });
    }
    this.diag('Cannot find input file ' + abs);
    return null;
  }

  // ---------- body collection (outside frames) ----------
  collect(s, dir, items, st) {
    while (!s.eof()) {
      const t = s.next();
      if (t.type === 'begin' && t.name === 'frame') {
        items.push(this.readFrame(s, t, dir, st, false));
        continue;
      }
      if (t.type === 'raw' || t.type === 'math') continue;
      if (t.type !== 'cs') continue;
      if (this.handleDefinition(t, s, dir)) continue;
      switch (t.name) {
        case 'maketitle': case 'titlepage':
          items.push({ kind: 'title', file: t.file, line: this.lineOf(t), endLine: this.lineOf(t), tok: t, noNumber: true });
          break;
        case 'frame': {
          // \frame{...} or \frame[opts]{...}
          items.push(this.readFrame(s, t, dir, st, true));
          break;
        }
        case 'section': {
          readStar(s); const short = readOpt(s); const a = readArg(s);
          st.section = this.inlineText(a);
          st.subsection = '';
          if (this.metro.sectionpage !== 'none') {
            items.push({ kind: 'section', section: st.section, file: t.file, line: this.lineOf(t), endLine: this.lineOf(t), tok: t, noNumber: true, title: st.section });
          }
          void short;
          break;
        }
        case 'subsection': case 'subsubsection': {
          readStar(s); readOpt(s); const a = readArg(s);
          if (t.name === 'subsection') st.subsection = this.inlineText(a);
          break;
        }
        case 'subimport': case 'import': case 'subimport*': case 'inputfrom': case 'subinputfrom': {
          readStar(s);
          const d = texOf(readArg(s)).trim(); const f = texOf(readArg(s)).trim();
          const nd = path.resolve(dir, d);
          const toks = this.loadTex(path.resolve(nd, f));
          if (toks) this.collect(new Stream(toks), nd, items, st);
          break;
        }
        case 'input': case 'include': case 'subfile': {
          const f = texOf(readArg(s)).trim();
          const toks = this.loadTex(path.resolve(dir, f));
          if (toks) this.collect(new Stream(toks), path.dirname(path.resolve(dir, f)), items, st);
          break;
        }
        case 'appendix': this.metro.numbering = 'none'; break;
        case 'setbeamertemplate': {
          const name = texOf(readArg(s)).trim(); const o = readOpt(s);
          if (name === 'frame footer') this.frameFooter = readArg(s); else if (!o) readArg(s);
          break;
        }
        case 'title': case 'subtitle': case 'author': case 'date': case 'institute': {
          readOpt(s); this.info[t.name] = readArg(s); break;
        }
        case 'iffalse': {
          let depth = 1;
          while (!s.eof()) {
            const u = s.next();
            if (u.type === 'cs' && /^if/.test(u.name)) depth++;
            if (u.type === 'cs' && u.name === 'fi') { depth--; if (!depth) break; }
          }
          break;
        }
        default: break;
      }
    }
  }

  readFrame(s, t, dir, st, cmdForm) {
    let ov = readOverlay(s);
    const o = readOpt(s);
    if (!ov) ov = readOverlay(s);
    const opts = parseKeyVals(o ? texOf(o) : '');
    let body;
    if (cmdForm) body = readArg(s);
    else {
      const save = s.i;
      const fragile = opts.fragile;
      body = readEnvBody(s, 'frame');
      void save; void fragile;
    }
    // title & subtitle args directly after \begin{frame}[..]
    const bs = new Stream(body);
    let title = null, subtitle = null;
    skipSpaces(bs);
    if (bs.peek() && bs.peek().type === 'bgroup') {
      title = readArg(bs);
      const save = bs.i;
      skipSpaces(bs);
      if (bs.peek() && bs.peek().type === 'bgroup') subtitle = readArg(bs); else bs.i = save;
    }
    const last = s.t[s.i - 1] || t;
    return {
      kind: 'frame', tok: t, file: t.file, line: this.lineOf(t), endLine: this.lineOf(last), dir,
      opts, body: bs.t.slice(bs.i), titleToks: title, subtitleToks: subtitle,
      noNumber: !!(opts.noframenumbering || opts.standout),
      numbering: this.metro.numbering, progressbar: this.metro.progressbar,
      section: st.section, subsection: st.subsection, title: '',
      footer: this.frameFooter,
    };
  }

  // ======================= item rendering =======================
  renderItem(it, total, sections) {
    if (it.kind === 'title') return this.renderTitle(it, total);
    if (it.kind === 'section') return this.renderSectionPage(it, total);
    return this.renderFrame(it, total);
  }

  newCtx(dir, frame) {
    return {
      dir, frame, pause: 0, maxStep: 1, plus: 1, footnotes: [], fnNo: 0, ov: [], listDepth: 0, inColumn: false,
      itemsep: null, mode: 'text', arraystretch: 1,
    };
  }

  renderTitle(it, total) {
    const ctx = this.newCtx(this.rootDir, it);
    const I = this.info;
    const h = (toks, dir) => (toks ? this.convert(toks, Object.assign(ctx, { dir: dir || this.rootDir })) : '');
    const subtitle = it.subtitleOverride != null ? esc(it.subtitleOverride) : h(I.subtitle);
    const date = I.date && texOf(I.date).trim() === '\\today' ? esc(todayString()) : h(I.date);
    const html = `<section class="slide title-page">
<div class="tp">
${I.titlegraphic ? `<div class="tp-graphic">${h(I.titlegraphic, I.titlegraphicDir)}</div>` : ''}
<div class="tp-fill"></div>
${I.title ? `<div class="tp-title">${h(I.title)}</div>` : ''}
${subtitle ? `<div class="tp-subtitle">${subtitle}</div>` : ''}
<div class="tp-sep"></div>
${I.author ? `<div class="tp-author">${h(I.author)}</div>` : ''}
${date ? `<div class="tp-date">${date}</div>` : ''}
${I.institute ? `<div class="tp-institute">${h(I.institute)}</div>` : ''}
<div class="tp-fill"></div>
</div></section>`;
    return { html, steps: 1 };
  }

  renderSectionPage(it, total) {
    const frac = Math.min(1, (it.frameNumber || 0) / total);
    const html = `<section class="slide section-page"><div class="sp">
<div class="sp-title">${esc(it.section)}</div>
<div class="sp-bar"><div style="width:${(frac * 100).toFixed(2)}%"></div></div>
</div></section>`;
    return { html, steps: 1 };
  }

  renderFrame(it, total) {
    const ctx = this.newCtx(it.dir, it);
    const o = it.opts;
    let body = this.convert(it.body, ctx);
    let title = it.titleToks ? this.convert(it.titleToks, ctx) : '';
    if (ctx.frametitle) title = ctx.frametitle;
    it.title = it.titleToks ? this.inlineText(it.titleToks) : (ctx.frametitleText || '');
    const standout = !!o.standout;
    const valign = o.t ? 'top' : o.b ? 'bottom' : 'center';
    const plain = !!o.plain;
    const showTitle = title && !plain && !standout;
    const frac = Math.min(1, it.frameNumber / total);
    const pb = it.progressbar === 'frametitle' && showTitle
      ? `<div class="pb"><div style="width:${(frac * 100).toFixed(2)}%"></div></div>` : '';
    const headPb = it.progressbar === 'head' ? `<div class="pb pb-head"><div style="width:${(frac * 100).toFixed(2)}%"></div></div>` : '';
    const footPb = it.progressbar === 'foot' ? `<div class="pb pb-foot"><div style="width:${(frac * 100).toFixed(2)}%"></div></div>` : '';
    const num = !standout && !plain && it.numbering !== 'none'
      ? (it.numbering === 'fraction' ? `${it.frameNumber}/${total}` : String(it.frameNumber)) : '';
    const footer = it.footer && it.footer.length ? this.convert(it.footer, ctx) : '';
    const fns = ctx.footnotes.length
      ? `<div class="footnotes"><div class="fn-rule"></div>${ctx.footnotes.join('')}</div>` : '';
    const html = `<section class="slide frame${standout ? ' standout' : ''}${plain ? ' plain' : ''}" data-steps="${ctx.maxStep}">
${headPb}${showTitle ? `<div class="frametitle"><span>${title}</span></div>${pb}` : ''}
<div class="content v-${valign}${showTitle ? '' : ' notitle'}"><div class="inner">${body}</div></div>
${fns}
${(num || footer) ? `<div class="footline"><span class="ffoot">${footer}</span><span class="fnum">${num}</span></div>` : ''}${footPb}
</section>`;
    return { html, steps: ctx.maxStep };
  }

  // plain text of tokens (for titles in outline / section pages)
  inlineText(toks) {
    const ctx = this.newCtx(this.rootDir, null);
    const html = this.convert(toks, ctx);
    return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
  }

  // ======================= content conversion =======================

  /** Convert a token array to HTML. */
  convert(toks, ctx) {
    return this.convertStream(new Stream(toks.slice()), ctx);
  }

  overlayAttr(kind, spec, ctx) {
    spec = this.resolvePlus(spec, ctx);
    ctx.maxStep = Math.max(ctx.maxStep, maxInSpec(spec));
    return ` data-${kind}="${esc(spec)}"`;
  }

  /** Wrap converted tokens in an overlay span; nested footnotes inherit the overlay. */
  ovWrap(kind, spec, toks, ctx, tag = 'span') {
    const attr = this.overlayAttr(kind, spec, ctx);
    ctx.ov.push(attr);
    const inner = this.convert(toks, ctx);
    ctx.ov.pop();
    return `<${tag} class="ov"${attr}>${inner}</${tag}>`;
  }

  resolvePlus(spec, ctx) {
    if (!/[+.]/.test(spec)) return spec;
    let used = false;
    const r = spec.replace(/\+\(?(-?\d*)\)?|\.(?:\((-?\d+)\))?/g, (m, off1, off2) => {
      if (m.startsWith('+')) { used = true; return String(ctx.plus + (parseInt(off1, 10) || 0)); }
      return String(Math.max(1, ctx.plus - 1 + (parseInt(off2, 10) || 0)));
    });
    if (used) ctx.plusUsed = true;
    return r;
  }

  convertStream(s, ctx) {
    let out = '';
    let text = '';
    const flush = () => {
      if (text) { out += this.textHtml(text); text = ''; }
    };
    while (!s.eof()) {
      const t = s.next();
      switch (t.type) {
        case 'char': text += t.ch; continue;
        case 'par': flush(); out += '<span class="par"></span>'; continue;
        case 'bgroup': {
          flush();
          s.i--;
          const g = readArg(s);
          const p0 = ctx.pause;
          out += this.convert(g, ctx);
          out += this.afterPause(p0, s, ctx);
          continue;
        }
        case 'egroup': continue;
        case 'align': text += ' '; continue;
        case 'param': continue;
        case 'math': flush(); out += this.math(t, ctx); continue;
        case 'verb': flush(); out += this.verbatim(t, ctx); continue;
        case 'verbinline': flush(); out += `<code class="tt">${esc(t.src)}</code>`; continue;
        case 'raw': flush(); out += this.rawEnv(t, ctx); continue;
        case 'begin': {
          flush();
          const p0 = ctx.pause;
          out += this.environment(t, s, ctx);
          out += this.afterPause(p0, s, ctx);
          continue;
        }
        case 'end': continue; // stray
        case 'cs': {
          if (SYMBOLS[t.name] !== undefined && !this.macros[t.name]) {
            if (t.name === '/' || t.name === '-' || t.name === '@' || t.name === '!') continue;
            text += SYMBOLS[t.name];
            continue;
          }
          flush();
          out += this.command(t, s, ctx);
          continue;
        }
        default: continue;
      }
    }
    flush();
    return out;
  }

  /** If nested content contained \pause, everything after it in this group appears later too. */
  afterPause(p0, s, ctx) {
    if (ctx.pause <= p0 || s.eof()) return '';
    return this.ovWrap('uncover', `${ctx.pause + 1}-`, s.rest(), ctx);
  }

  textHtml(text) {
    text = text.replace(/---/g, '—').replace(/--/g, '–').replace(/``/g, '“').replace(/''/g, '”')
      .replace(/`/g, '‘').replace(/(\w)'(\w)/g, '$1’$2').replace(/'/g, '’').replace(/!`/g, '¡').replace(/\?`/g, '¿');
    return esc(text);
  }

  math(t, ctx, extraClass = '') {
    let src = t.src;
    // resolve user colors (KaTeX knows CSS colors only)
    src = src.replace(/\\(color|textcolor|colorbox)\s*\{([^}]*)\}/g, (m, cmd, name) => {
      const c = this.colors.css(name);
      return c ? `\\${cmd}{${c}}` : m;
    });
    // beamer overlay commands inside math: drop overlay specs
    src = src.replace(/\\(only|uncover|visible|onslide|alert)\s*<[^>]*>/g, '\\$1');
    let display = t.display;
    let tex = src;
    if (t.env) {
      const env = t.env;
      const base = env.replace('*', '');
      if (base === 'equation' || base === 'displaymath' || base === 'math') tex = src;
      else if (base === 'eqnarray') tex = `\\begin{array}{rcl}${src}\\end{array}`;
      else if (base === 'multline') tex = `\\begin{gathered}${src}\\end{gathered}`;
      else tex = `\\begin{${base}*}${src}\\end{${base}*}`;
      display = env !== 'math';
    }
    try {
      const html = katex.renderToString(tex, {
        displayMode: !!display, throwOnError: false, strict: 'ignore', trust: false, output: 'html',
        macros: Object.assign({
          '\\alert': '\\textcolor{' + (this.cssVars ? this.cssVars['--alert'] : '#EB811B') + '}{#1}',
          '\\only': '#1', '\\uncover': '#1', '\\visible': '#1', '\\onslide': '', '\\mathds': '\\mathbb', '\\bm': '\\boldsymbol',
          '\\pause': '', '\\label': '', '\\nonumber': '', '\\notag': '',
        }, this.katexMacros),
      });
      return display ? `<div class="dmath${extraClass}">${html}</div>` : html;
    } catch (e) {
      this.diag('KaTeX: ' + e.message, t);
      return `<code class="math-err">${esc(src)}</code>`;
    }
  }

  // wrap rest of the current group in a span (font switches etc.)
  wrapRest(s, ctx, open, close) {
    const rest = s.rest();
    return open + this.convert(rest, ctx) + close;
  }

  expandMacro(def, s) {
    const args = [];
    let k = 0;
    if (def.def) {
      const o = readOpt(s);
      args.push(o || def.def);
      k = 1;
    }
    for (; k < def.n; k++) args.push(readArg(s));
    const body = [];
    for (const u of def.body) {
      if (u.type === 'param') body.push(...(args[u.n - 1] || []));
      else body.push(u);
    }
    return body;
  }

  command(t, s, ctx) {
    let name = this.lets[t.name] || t.name;
    if (!(ctx.expansions > 5000) && this.macros[name] && !NATIVE_OVERRIDES.has(name)) {
      ctx.expansions = (ctx.expansions || 0) + 1;
      s.insert(this.expandMacro(this.macros[name], s));
      return '';
    }
    if (FONT_WRAP[name]) {
      readOverlay(s);
      if (name === 'makebox' || name === 'framebox') { readOpt(s); readOpt(s); }
      const a = readArg(s);
      const [o, c] = FONT_WRAP[name];
      return o + this.convert(a, ctx) + c;
    }
    if (SWITCHES[name] !== undefined) {
      if (!SWITCHES[name]) return '';
      return this.wrapRest(s, ctx, `<span class="sw" style="${SWITCHES[name]}">`, '</span>');
    }
    if (SIZES[name]) {
      return this.wrapRest(s, ctx, `<span class="sw" style="font-size:${SIZES[name]}pt;line-height:${(SIZES[name] * 1.2 * 1.15).toFixed(2)}pt">`, '</span>');
    }
    if (ACCENTS[name]) {
      const a = readArg(s);
      let base = texOf(a).replace(/\\i\b/, 'ı').replace(/\\j\b/, 'ȷ').trim() || ' ';
      return esc((base + ACCENTS[name]).normalize('NFC'));
    }
    switch (name) {
      case '\\': {
        readStar(s);
        const o = readOpt(s);
        const len = o ? cssLength(texOf(o), 'v') : null;
        return len ? `<br><span class="vsp" style="height:${len}"></span>` : '<br>';
      }
      case 'newline': case 'linebreak': return '<br>';
      case 'par': return '<span class="par"></span>';
      case 'today': return esc(todayString());
      case 'pause': {
        const o = readOpt(s);
        ctx.pause = o ? parseInt(texOf(o), 10) - 1 : ctx.pause + 1;
        ctx.plus = Math.max(ctx.plus, ctx.pause + 1);
        ctx.maxStep = Math.max(ctx.maxStep, ctx.pause + 1);
        return this.ovWrap('uncover', `${ctx.pause + 1}-`, s.rest(), ctx);
      }
      case 'only': case 'uncover': case 'visible': case 'invisible': case 'onslide': {
        const spec = readOverlay(s);
        skipSpaces(s);
        const hasArg = s.peek() && s.peek().type === 'bgroup';
        const kind = name === 'only' ? 'only' : name === 'invisible' ? 'invisible' : 'uncover';
        if (!spec) { return hasArg ? this.convert(readArg(s), ctx) : ''; }
        if (!hasArg) {
          if (name === 'onslide') return this.ovWrap('uncover', spec, s.rest(), ctx);
          return '';
        }
        return this.ovWrap(kind, spec, readArg(s), ctx);
      }
      case 'alt': {
        const spec = readOverlay(s);
        const a = readArg(s); const b = readArg(s);
        if (!spec) return this.convert(a, ctx);
        return this.ovWrap('only', spec, a, ctx) + this.ovWrap('notonly', spec, b, ctx);
      }
      case 'temporal': {
        readOverlay(s); readArg(s); const b = readArg(s); readArg(s);
        return this.convert(b, ctx);
      }
      case 'frametitle': {
        readOverlay(s); readOpt(s);
        const a = readArg(s);
        ctx.frametitle = this.convert(a, ctx);
        ctx.frametitleText = this.inlineText(a);
        return '';
      }
      case 'framesubtitle': readArg(s); return '';
      case 'color': {
        const o = readOpt(s);
        const c = this.colorCss(o, readArg(s));
        return this.wrapRest(s, ctx, `<span class="sw" style="color:${c}">`, '</span>');
      }
      case 'textcolor': {
        readOverlay(s);
        const o = readOpt(s);
        const c = this.colorCss(o, readArg(s));
        return `<span style="color:${c}">${this.convert(readArg(s), ctx)}</span>`;
      }
      case 'colorbox': {
        const o = readOpt(s);
        const c = this.colorCss(o, readArg(s));
        return `<span class="colorbox" style="background:${c}">${this.convert(readArg(s), ctx)}</span>`;
      }
      case 'fcolorbox': {
        const o = readOpt(s);
        const c1 = this.colorCss(o, readArg(s)); const c2 = this.colorCss(o, readArg(s));
        return `<span class="colorbox" style="border:0.4pt solid ${c1};background:${c2}">${this.convert(readArg(s), ctx)}</span>`;
      }
      case 'cellcolor': case 'rowcolor': {
        // handled inside tabular; outside ignore
        readOpt(s); readArg(s); return '';
      }
      case 'href': {
        const url = texOf(readArg(s)).replace(/\\([#%&_~])/g, '$1');
        const a = readArg(s);
        return `<a href="${esc(url)}">${this.convert(a, ctx)}</a>`;
      }
      case 'url': case 'nolinkurl': {
        const url = texOf(readArg(s)).replace(/\\([#%&_~])/g, '$1');
        return `<a class="url" href="${esc(url)}">${esc(url)}</a>`;
      }
      case 'footnote': case 'blfootnote': case 'footnotetext': {
        readOverlay(s);
        const o = readOpt(s);
        const a = readArg(s);
        const numbered = name !== 'blfootnote';
        let mark = '';
        if (numbered && ctx.colFn) { ctx.colFnNo++; mark = String.fromCharCode(96 + ctx.colFnNo); }
        else if (numbered) { ctx.fnNo = o ? parseInt(texOf(o), 10) || ctx.fnNo + 1 : ctx.fnNo + 1; mark = String(ctx.fnNo); }
        const textHtml = this.convert(a, ctx);
        let note = `<div class="fn"><span class="fn-mark">${mark ? `<sup>${mark}</sup>` : ''}</span>${textHtml}</div>`;
        // footnotes inherit enclosing overlay state
        for (const w of ctx.ov.slice().reverse()) note = `<div class="ovb"${w}>${note}</div>`;
        (ctx.colFn || ctx.footnotes).push(note);
        return numbered && name !== 'footnotetext' ? `<sup class="fnref">${mark}</sup>` : '';
      }
      case 'includegraphics': return this.includegraphics(s, ctx);
      case 'animategraphics': return this.animategraphics(s, ctx);
      case 'resizebox': {
        readStar(s);
        const w = texOf(readArg(s)).trim(); const h = texOf(readArg(s)).trim();
        const a = readArg(s);
        const ww = w === '!' ? null : cssLength(w, 'w');
        const hh = h === '!' ? null : cssLength(h, 'v');
        const style = ww ? `width:${ww}` : hh ? `height:${hh}` : '';
        return `<div class="resizebox" data-fitw="${ww ? 1 : ''}" data-fith="${!ww && hh ? 1 : ''}" style="${style}"><div class="rb-inner">${this.convert(a, ctx)}</div></div>`;
      }
      case 'scalebox': {
        const k = parseFloat(texOf(readArg(s))) || 1;
        readOpt(s);
        return `<span class="scalebox" style="zoom:${k}">${this.convert(readArg(s), ctx)}</span>`;
      }
      case 'rotatebox': { readOpt(s); const ang = parseFloat(texOf(readArg(s))) || 0; return `<span style="display:inline-block;transform:rotate(${-ang}deg)">${this.convert(readArg(s), ctx)}</span>`; }
      case 'raisebox': { const l = cssLength(texOf(readArg(s)), 'v'); readOpt(s); readOpt(s); return `<span style="position:relative;bottom:${l || 0}">${this.convert(readArg(s), ctx)}</span>`; }
      case 'parbox': {
        readOpt(s); readOpt(s); readOpt(s);
        const w = cssLength(texOf(readArg(s)), 'w');
        return `<div class="minipage" style="width:${w || 'auto'}">${this.convert(readArg(s), ctx)}</div>`;
      }
      case 'vspace': case 'vspace*': {
        readStar(s);
        const l = cssLength(texOf(readArg(s)), 'v');
        return l ? `<span class="vsp" style="height:${l}"></span>` : '';
      }
      case 'hspace': case 'hspace*': {
        readStar(s);
        const raw = texOf(readArg(s));
        if (/fill/.test(raw)) return '<span class="hfill"></span>';
        const l = cssLength(raw, 'w');
        return l ? `<span class="hsp" style="width:${l}"></span>` : '';
      }
      case 'vskip': case 'hskip': case 'kern': {
        // read a dimen "1em plus 2pt" crudely
        let str = '';
        skipSpaces(s);
        while (!s.eof()) {
          const u = s.peek();
          if (u.type === 'char' && /[-0-9.a-z ]/i.test(u.ch)) { str += u.ch; s.i++; continue; }
          if (u.type === 'cs' && /^(textwidth|linewidth|baselineskip|textheight|columnwidth)$/.test(u.name)) { str += '\\' + u.name; s.i++; }
          break;
        }
        const l = cssLength(str.trim().split(/\s+/)[0], name === 'vskip' ? 'v' : 'w');
        if (!l) return '';
        return name === 'vskip' ? `<span class="vsp" style="height:${l}"></span>` : `<span class="hsp" style="width:${l}"></span>`;
      }
      case 'smallskip': return '<span class="vsp" style="height:3pt"></span>';
      case 'medskip': return '<span class="vsp" style="height:6pt"></span>';
      case 'bigskip': return '<span class="vsp" style="height:12pt"></span>';
      case 'vfill': return '<span class="vfill"></span>';
      case 'hfill': case 'hfil': case 'hss': case 'dotfill': case 'hrulefill':
        return name === 'hrulefill' ? '<span class="hfill hrule"></span>' : '<span class="hfill"></span>';
      case 'centering': return this.wrapRest(s, ctx, '<div class="centering">', '</div>');
      case 'setlength': {
        const what = texOf(readArg(s)).trim(); const val = texOf(readArg(s)).trim();
        if (what === '\\itemsep') ctx.itemsep = cssLength(val, 'v');
        else if (what === '\\parskip') ctx.parskip = cssLength(val, 'v');
        else if (what === '\\baselineskip') {
          const l = cssLength(val, 'v');
          if (l) return this.wrapRest(s, ctx, `<span class="sw" style="line-height:${l}">`, '</span>');
        } else if (what === '\\tabcolsep') ctx.tabcolsep = cssLength(val, 'w');
        return '';
      }
      case 'renewcommand': case 'newcommand': case 'def': case 'providecommand': case 'let':
      case 'definecolor': case 'colorlet': case 'setbeamercolor': case 'DeclareMathOperator': case 'newenvironment':
      case 'metroset': {
        // body-level definitions: \renewcommand{\arraystretch}{1.5} is common
        if (name === 'renewcommand') {
          const save = s.i;
          readStar(s);
          const nm = readArg(s).find((x) => x.type === 'cs');
          if (nm && nm.name === 'arraystretch') { ctx.arraystretch = parseFloat(texOf(readArg(s))) || 1; return ''; }
          s.i = save;
        }
        this.handleDefinition({ ...t, name }, s, ctx.dir);
        if (name === 'metroset' && this.cssVars) this.finishTheme();
        return '';
      }
      case 'item': {
        // stray \item outside list
        readOverlay(s); readOpt(s);
        return '<br>• ';
      }
      case 'caption': {
        readOverlay(s);
        readOpt(s);
        const a = readArg(s);
        const label = ctx.floatKind === 'table' ? `Table ${++this.tableNo}` : ctx.floatKind === 'figure' ? `Figure ${++this.figureNo}` : '';
        return `<div class="caption">${label ? `<span class="cap-label">${label}:</span> ` : ''}${this.convert(a, ctx)}</div>`;
      }
      case 'section': case 'subsection': case 'subsubsection': case 'paragraph': {
        readStar(s); readOpt(s); readArg(s); return '';
      }
      case 'insertframetitle': return ctx.frametitle || '';
      case 'insertsection': case 'secname': return esc(ctx.frame ? ctx.frame.section || '' : '');
      case 'insertsubsection': case 'subsecname': return esc(ctx.frame ? ctx.frame.subsection || '' : '');
      case 'insertframenumber': case 'thepage': return String(ctx.frame ? ctx.frame.frameNumber : '');
      case 'inserttitle': return this.info.title ? this.convert(this.info.title, ctx) : '';
      case 'insertauthor': return this.info.author ? this.convert(this.info.author, ctx) : '';
      case 'ccLogo': case 'ccAttribution': case 'ccShareAlike': return '🅭';
      case 'ccbysa': case 'ccby': return '<span class="cc">🅭🅯🄎</span>';
      case 'input': case 'include': case 'subimport': case 'import': {
        let dir = ctx.dir;
        if (name === 'subimport' || name === 'import') { readStar(s); dir = path.resolve(ctx.dir, texOf(readArg(s)).trim()); }
        const f = texOf(readArg(s)).trim();
        const toks = this.loadTex(path.resolve(dir, f));
        if (toks) s.insert(toks);
        return '';
      }
      case 'iffalse': {
        let depth = 1;
        while (!s.eof()) {
          const u = s.next();
          if (u.type === 'cs' && /^if/.test(u.name)) depth++;
          if (u.type === 'cs' && u.name === 'fi') { depth--; if (!depth) break; }
        }
        return '';
      }
      case 'iftrue': case 'fi': case 'else': return '';
      case 'multicolumn': {
        // outside tabular
        readArg(s); readArg(s); return this.convert(readArg(s), ctx);
      }
      case 'multirow': {
        readOpt(s); readArg(s); readOpt(s); readArg(s); readOpt(s); return this.convert(readArg(s), ctx);
      }
      case 'column': {
        // \column{width} short form inside columns: handled by columns env; ignore here
        readOpt(s); readArg(s); return '';
      }
      case 'tikz': {
        readOpt(s); const a = readArg(s);
        return this.rawEnv({ type: 'raw', env: 'tikzpicture', src: `\\tikz{${texOf(a)}}`, file: t.file, pos: t.pos }, ctx);
      }
      case 'ding': { const a = texOf(readArg(s)).trim(); return { 51: '✓', 55: '✗', 52: '✔', 56: '✘', 43: '☞', 182: '➀', 228: '➔', 220: '➜' }[a] || '•'; }
      case 'textcircled': return `<span class="circled">${this.convert(readArg(s), ctx)}</span>`;
      case 'ensuremath': return this.convert(readArg(s), ctx);
      case 'mathbb': case 'mathbf': case 'mathcal': case 'mathrm': case 'boldsymbol': {
        // used in text mode by mistake: render through katex
        const a = texOf(readArg(s));
        return this.math({ type: 'math', display: false, src: `\\${name}{${a}}`, file: t.file, pos: t.pos }, ctx);
      }
      case 'rule': {
        readOpt(s);
        const w = cssLength(texOf(readArg(s)), 'w'); const h = cssLength(texOf(readArg(s)), 'v');
        return `<span class="rule" style="width:${w || 0};height:${h || 0}"></span>`;
      }
      case 'titlegraphic': readArg(s); return '';
      case 'lstinputlisting': {
        const o = readOpt(s);
        const f = texOf(readArg(s)).trim();
        const code = this.opts.readFile(path.resolve(ctx.dir, f)) ?? this.opts.readFile(path.resolve(this.rootDir, f));
        if (code == null) { this.diag('Listing file not found: ' + f, t); return `<span class="img-missing">${esc(f)}</span>`; }
        const opts = Object.assign({}, this.lstDefaults || {}, parseKeyVals(o ? texOf(o) : ''));
        if (!opts.language && /\.py$/i.test(f)) opts.language = 'Python';
        let lines = code.replace(/\s+$/, '').split(/\r?\n/);
        if (opts.firstline || opts.lastline) lines = lines.slice((+opts.firstline || 1) - 1, +opts.lastline || undefined);
        return this.codeBlock(lines.join('\n'), opts);
      }
      case 'lstset': { this.lstDefaults = Object.assign(this.lstDefaults || {}, parseKeyVals(texOf(readArg(s)))); return ''; }
      case 'todo': {
        const o = readOpt(s);
        const kv = parseKeyVals(o ? texOf(o) : '');
        const a = readArg(s);
        return kv.disable ? '' : `<span class="todo">${this.convert(a, ctx)}</span>`;
      }
      case 'missingfigure': { readOpt(s); return `<span class="todo missingfigure">Missing figure: ${this.convert(readArg(s), ctx)}</span>`; }
      case 'tikzstyle': {
        // \tikzstyle{name}=[options]: keep for the LaTeX snippet preamble
        const nm = texOf(readArg(s)).trim();
        skipSpaces(s);
        if (s.peek() && s.peek().type === 'char' && s.peek().ch === '=') s.i++;
        const o = readOpt(s);
        if (o) this.preambleLines.push(`\\tikzset{${nm}/.style={${texOf(o)}}}`);
        return '';
      }
      default: break;
    }
    if (IGNORE[name] !== undefined) {
      readStar(s); readOverlay(s);
      let n = IGNORE[name];
      if (n < 0) { readOpt(s); n = -n; if (n === 2) { readArg(s); readOpt(s); return ''; } }
      for (let k = 0; k < n; k++) { readOpt(s); readArg(s); }
      return '';
    }
    // unknown command: drop it, keep its braces content flowing normally
    this.diag('Unknown command \\' + name, t);
    return '';
  }

  colorCss(optToks, argToks) {
    const spec = texOf(argToks).trim();
    if (optToks) {
      const tmp = new ColorTable();
      tmp.define('__x', texOf(optToks).trim(), spec);
      return toCss(tmp.user.__x) || 'inherit';
    }
    return this.colors.css(spec) || 'inherit';
  }

  // ---------- images ----------
  findImage(rel, dir) {
    rel = rel.replace(/^"|"$/g, '').trim();
    const dirs = [dir, ...(this.graphicsPath || []).map((g) => path.resolve(dir, g)), this.rootDir,
      ...(this.graphicsPath || []).map((g) => path.resolve(this.rootDir, g))];
    const known = ['.pdf', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.eps'];
    const exts = known.includes(path.extname(rel).toLowerCase()) ? [''] : ['', ...known];
    for (const d of dirs) {
      for (const e of exts) {
        const r = this.opts.resolveImage(path.resolve(d, rel + e));
        if (r) return r;
      }
    }
    return null;
  }

  imageStyle(kv) {
    const st = [];
    const data = [];
    if (kv.width) { const w = cssLength(kv.width, 'w'); if (w) st.push(`width:${w}`); }
    if (kv.height || kv.totalheight) { const h = cssLength(kv.height || kv.totalheight, 'v'); if (h) st.push(`height:${h}`); }
    if (kv.width && (kv.height || kv.totalheight) && kv.keepaspectratio) st.push('object-fit:contain');
    if (kv.scale) data.push(`data-scale="${parseFloat(kv.scale) || 1}"`);
    if (!kv.width && !kv.height && !kv.totalheight && !kv.scale) data.push('data-scale="1"');
    if (kv.angle) st.push(`transform:rotate(${-parseFloat(kv.angle)}deg)`);
    if (kv.width && !(kv.height || kv.totalheight)) st.push('height:auto');
    if (!kv.width && (kv.height || kv.totalheight)) st.push('width:auto');
    return { style: st.join(';'), data: data.join(' ') };
  }

  includegraphics(s, ctx) {
    readStar(s);
    const ov = readOverlay(s);
    const o = readOpt(s);
    const ov2 = readOverlay(s);
    const file = texOf(readArg(s)).trim();
    const kv = parseKeyVals(o ? texOf(o) : '');
    const img = this.findImage(file, ctx.dir);
    const { style, data } = this.imageStyle(kv);
    const line = ctx.frame ? ` data-line="${this.lineOf(s.t[s.i - 1])}"` : '';
    let html;
    if (!img) {
      this.diag('Image not found: ' + file, s.t[s.i - 1]);
      html = `<span class="img-missing" style="${style}">${esc(file)}</span>`;
    } else if (img.kind === 'pdf') {
      html = `<canvas class="pdfimg" data-src="${esc(img.uri)}" data-page="${parseInt(kv.page, 10) || 1}" ${data} style="${style}"${line}></canvas>`;
    } else {
      html = `<img class="ig" src="${esc(img.uri)}" ${data} style="${style}"${line}>`;
    }
    const spec = ov || ov2;
    if (spec) html = `<span class="ov"${this.overlayAttr('only', spec, ctx)}>${html}</span>`;
    return html;
  }

  animategraphics(s, ctx) {
    const o = readOpt(s);
    const fps = parseFloat(texOf(readArg(s))) || 10;
    const prefix = texOf(readArg(s)).trim();
    const first = texOf(readArg(s)).trim(); const last = texOf(readArg(s)).trim();
    const kv = parseKeyVals(o ? texOf(o) : '');
    const a = parseInt(first, 10), b = parseInt(last, 10);
    const pad = /^0\d/.test(first) ? first.length : 0;
    const frames = [];
    let kind = 'img';
    if (!isNaN(a) && !isNaN(b)) {
      for (let k = a; k <= b && frames.length < 500; k++) {
        const r = this.findImage(prefix + String(k).padStart(pad, '0'), ctx.dir);
        if (r) { frames.push(r.uri); kind = r.kind; }
      }
    }
    const { style, data } = this.imageStyle(kv);
    if (!frames.length) return `<span class="img-missing" style="${style}">animation ${esc(prefix)}</span>`;
    if (kind === 'pdf') {
      return `<canvas class="pdfimg anim" data-src="${esc(frames[0])}" data-frames="${esc(JSON.stringify(frames))}" data-fps="${fps}" ${data} style="${style}"></canvas>`;
    }
    return `<img class="ig anim" src="${esc(frames[0])}" data-frames="${esc(JSON.stringify(frames))}" data-fps="${fps}" ${data} style="${style}">`;
  }

  // ---------- raw environments (tikz, algorithms) ----------
  rawEnv(t, ctx) {
    const label = t.env;
    const placeholder = (key) => `<div class="snippet${key ? ' pending' : ''}"${key ? ` data-key="${key}"` : ''}><span class="snip-label">${esc(label)}</span><pre>${esc(abbrev(t.src))}</pre></div>`;
    if (this.opts.snippet) {
      const one = (src) => {
        const r = this.opts.snippet(src, { dir: ctx.dir, env: t.env, preamble: this });
        if (r && r.uri) return `<canvas class="pdfimg snippet-img" data-src="${esc(r.uri)}" data-page="1" data-scale="1" data-key="${r.key}"></canvas>`;
        if (r && r.key) return placeholder(r.key);
        return null;
      };
      // beamer overlays inside the snippet: compile one variant per step and switch between them
      const inc = resolveIncremental(t.src, ctx.plus);
      ctx.plus = inc.next;
      t = Object.assign({}, t, { src: inc.src });
      const n = overlaySteps(t.src);
      const tikz = t.env !== 'algorithm' && t.env !== 'algorithm2e';
      if (n > 1) {
        const parts = [];
        for (let k = 1; k <= n; k++) {
          const h = one(overlayVariant(t.src, k, tikz));
          if (h == null) { parts.length = 0; break; }
          parts.push(`<span class="ov"${this.overlayAttr('only', k === n ? `${k}-` : String(k), ctx)}>${h}</span>`);
        }
        if (parts.length) return parts.join('');
      } else {
        const h = one(n === 1 ? overlayVariant(t.src, 1, tikz) : t.src);
        if (h != null) return h;
      }
    }
    if (t.env === 'algorithm' || t.env === 'algorithm2e') return this.algorithm(t, ctx);
    return placeholder(null);
  }

  /** verbatim / lstlisting / minted, with listings options and light keyword highlighting */
  verbatim(t, ctx) {
    let src = t.src;
    let opts = {};
    if (t.env === 'lstlisting') {
      const m = /^\s*\[([^\]]*)\]/.exec(src);
      if (m) { opts = parseKeyVals(m[1]); src = src.slice(m[0].length); }
      opts = Object.assign({}, this.lstDefaults || {}, opts);
    } else if (t.env === 'minted') {
      const m = /^\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/.exec(src);
      if (m) { opts = Object.assign(parseKeyVals(m[1] || ''), { language: m[2] }); src = src.slice(m[0].length); }
    }
    return this.codeBlock(src.replace(/^[ \t]*\r?\n/, '').replace(/\s+$/, ''), opts);
  }

  codeBlock(code, opts) {
    const style = [];
    const size = (/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large)\b/.exec(opts.basicstyle || '') || [])[1];
    if (size) style.push(`font-size:${SIZES[size]}pt;line-height:${(SIZES[size] * 1.25).toFixed(2)}pt`);
    const kwColor = /\\color\{([^}]*)\}/.exec(opts.keywordstyle || '');
    const kwCss = kwColor ? this.colors.css(kwColor[1]) : null;
    const kwBold = !opts.keywordstyle || /\\bfseries/.test(opts.keywordstyle);
    const lang = String(opts.language || '').replace(/^\[[^\]]*\]/, '').trim().toLowerCase();
    const kws = CODE_KEYWORDS[lang];
    let html = esc(code);
    if (kws) {
      const comment = { python: '#', r: '#', bash: '#', sh: '#', matlab: '%', sql: '--' }[lang] || '//';
      const re = new RegExp(`(${comment.replace(/\//g, '\\/')}[^\\n]*)|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')|\\b([A-Za-z_][A-Za-z0-9_]*)\\b`, 'g');
      const kwAttr = kwCss || !kwBold ? ` style="${kwCss ? `color:${kwCss};` : ''}${kwBold ? '' : 'font-weight:inherit'}"` : '';
      html = '';
      let last = 0;
      for (const m of code.matchAll(re)) {
        html += esc(code.slice(last, m.index));
        if (m[1]) html += `<span class="c-com">${esc(m[1])}</span>`;
        else if (m[2]) html += `<span class="c-str">${esc(m[2])}</span>`;
        else if (kws.has(m[3])) html += `<span class="c-kw"${kwAttr}>${esc(m[3])}</span>`;
        else html += esc(m[3]);
        last = m.index + m[0].length;
      }
      html += esc(code.slice(last));
    }
    return `<pre class="verb"${style.length ? ` style="${style.join(';')}"` : ''}>${html}</pre>`;
  }

  /** algorithm2e approximation */
  algorithm(t, ctx) {
    let src = t.src.replace(/^\\begin\{algorithm2?e?\}(\[[^\]]*\])?/, '').replace(/\\end\{algorithm2?e?\}\s*$/, '');
    const toks = tokenize(src, { file: t.file });
    const s = new Stream(toks);
    let caption = '';
    const lines = [];
    let cur = '';
    let depth = 0;
    const kw = (w) => `<b>${w}</b> `;
    const push = () => { if (cur.trim()) lines.push({ depth, html: cur }); cur = ''; };
    const block = (head, tail) => {
      const a = readArg(s);
      const b = readArg(s);
      cur += head(this.convert(a, ctx)); push();
      depth++;
      this._algoBody(b, ctx, lines, depth);
      depth--;
      if (tail) { cur = tail; push(); }
    };
    while (!s.eof()) {
      const u = s.next();
      if (u.type === 'cs') {
        switch (u.name) {
          case 'caption': caption = this.convert(readArg(s), ctx); continue;
          case 'KwIn': case 'KwData': cur += kw(u.name === 'KwIn' ? 'Input:' : 'Data:') + this.convert(readArg(s), ctx); push(); continue;
          case 'KwOut': case 'KwResult': cur += kw(u.name === 'KwOut' ? 'Output:' : 'Result:') + this.convert(readArg(s), ctx); push(); continue;
          case 'For': case 'ForEach': case 'ForAll': block((c) => kw(u.name === 'For' ? 'for' : 'foreach') + c + ' ' + kw('do'), kw('end')); continue;
          case 'While': block((c) => kw('while') + c + ' ' + kw('do'), kw('end')); continue;
          case 'If': case 'uIf': block((c) => kw('if') + c + ' ' + kw('then'), u.name === 'If' ? kw('end') : ''); continue;
          case 'ElseIf': case 'uElseIf': block((c) => kw('else if') + c + ' ' + kw('then'), u.name === 'ElseIf' ? kw('end') : ''); continue;
          case 'Else': case 'uElse': { const b = readArg(s); cur = kw('else'); push(); depth++; this._algoBody(b, ctx, lines, depth); depth--; cur = kw('end'); push(); continue; }
          case 'Repeat': { const b = readArg(s); const c = readArg(s); cur = kw('repeat'); push(); depth++; this._algoBody(b, ctx, lines, depth); depth--; cur = kw('until') + this.convert(c, ctx); push(); continue; }
          case 'Begin': { readOpt(s); const b = readArg(s); cur = kw('begin'); push(); depth++; this._algoBody(b, ctx, lines, depth); depth--; cur = kw('end'); push(); continue; }
          case 'Return': case 'KwRet': cur += kw('return') + this.convert(readArg(s), ctx); continue;
          case '\\': case ';': push(); continue;
          default: if (/^(SetKw|SetAlgo|SetFunc|SetData|DontPrint|LinesNumbered|SetKwInOut|SetKwBlock|SetKwFunction|SetNlSty|SetAlCapFnt|label|SetAlFnt|SetArgSty)/.test(u.name)) {
            readOpt(s); const n = /SetKwBlock/.test(u.name) ? 3 : /SetKw|SetKwInOut|SetKwFunction/.test(u.name) ? 2 : /Set(Func|Data|NlSty|AlCapFnt|AlFnt|ArgSty)/.test(u.name) ? 1 : 0;
            for (let k = 0; k < n; k++) readArg(s); continue;
          }
        }
        s.i--;
        const one = [s.next()];
        cur += this.convertStream(new Stream(one.concat(this._argsGreedy(s))), ctx);
        continue;
      }
      if (u.type === 'char' && u.ch === ';') { push(); continue; }
      if (u.type === 'par') { push(); continue; }
      cur += this.convert([u], ctx);
    }
    push();
    return `<div class="algorithm">${caption ? `<div class="algo-cap"><b>Algorithm:</b> ${caption}</div>` : ''}<ol class="algo-lines">${
      lines.map((l) => `<li style="padding-left:${l.depth * 1.2}em">${l.html}</li>`).join('')}</ol></div>`;
  }

  _argsGreedy(s) {
    // take following braced groups for unknown command inside algorithm
    const out = [];
    while (s.peek() && s.peek().type === 'bgroup') { out.push({ type: 'bgroup' }, ...readArg(s), { type: 'egroup' }); }
    return out;
  }

  _algoBody(toks, ctx, lines, depth) {
    const html = this.algorithm({ src: texOf(toks), file: '' }, ctx);
    const items = [...html.matchAll(/<li style="padding-left:([\d.]+)em">([\s\S]*?)<\/li>/g)];
    for (const m of items) lines.push({ depth: depth + parseFloat(m[1]) / 1.2, html: m[2] });
  }

  // ---------- environments ----------
  environment(t, s, ctx) {
    const name = t.name;
    const line = this.lineOf(t);
    const user = this.envs[name];
    if (user) {
      const args = [];
      let k = 0;
      if (user.def) { args.push(readOpt(s) || user.def); k = 1; }
      for (; k < user.n; k++) args.push(readArg(s));
      const sub = (toks) => toks.flatMap((u) => (u.type === 'param' ? args[u.n - 1] || [] : [u]));
      const body = readEnvBody(s, name);
      return this.convert([{ type: 'bgroup' }, ...sub(user.begin), ...body, ...sub(user.end), { type: 'egroup' }], ctx);
    }
    switch (name) {
      case 'itemize': case 'enumerate': case 'description': return this.list(name, s, ctx, line);
      case 'center': case 'flushleft': case 'flushright': case 'centering': {
        const body = readEnvBody(s, name);
        return `<div class="${name}">${this.convert(body, ctx)}</div>`;
      }
      case 'quote': case 'quotation': case 'verse':
        return `<div class="quote">${this.convert(readEnvBody(s, name), ctx)}</div>`;
      case 'columns': return this.columns(s, ctx);
      case 'column': {
        readOpt(s); const w = cssLength(texOf(readArg(s)), 'w');
        return `<div class="column" style="width:${w}">${this.columnBody(readEnvBody(s, name), ctx)}</div>`;
      }
      case 'block': case 'alertblock': case 'exampleblock': {
        const ov = readOverlay(s);
        const title = readArg(s);
        const ov2 = readOverlay(s);
        const body = readEnvBody(s, name);
        const kind = name === 'alertblock' ? ' alerted' : name === 'exampleblock' ? ' example' : '';
        return this.block(kind, title.length ? this.convert(title, ctx) : '', body, ctx, ov || ov2, line);
      }
      case 'definition': case 'theorem': case 'lemma': case 'corollary': case 'example': case 'examples': case 'proof':
      case 'fact': case 'problem': case 'solution': case 'remark': case 'proposition': case 'exercise': {
        const ov = readOverlay(s);
        const o = readOpt(s);
        const body = readEnvBody(s, name);
        const nice = (this.theorems && this.theorems[name]) || name.charAt(0).toUpperCase() + name.slice(1);
        const title = nice + (o ? ` (${this.convert(o, ctx)})` : '');
        const kind = name === 'example' || name === 'examples' ? ' example' : '';
        return this.block(kind, title, body, ctx, ov, line, name === 'proof');
      }
      case 'figure': case 'figure*': case 'table': case 'table*': {
        readOpt(s);
        const body = readEnvBody(s, name);
        const prev = ctx.floatKind;
        ctx.floatKind = name.replace('*', '');
        const html = `<div class="float ${ctx.floatKind}">${this.convert(body, ctx)}</div>`;
        ctx.floatKind = prev;
        return html;
      }
      case 'tabular': case 'tabular*': case 'tabularx': case 'array': case 'longtable': case 'tabulary': {
        return this.tabular(name, s, ctx);
      }
      case 'minipage': {
        const pos = readOpt(s); readOpt(s); readOpt(s);
        const w = cssLength(texOf(readArg(s)), 'w');
        const p = pos ? texOf(pos).trim() : 'c';
        const va = p === 't' ? 'top' : p === 'b' ? 'bottom' : 'middle';
        return `<div class="minipage" style="width:${w || 'auto'};vertical-align:${va}">${this.convert(readEnvBody(s, name), ctx)}</div>`;
      }
      case 'adjustwidth': case 'adjustwidth*': {
        const l = cssLength(texOf(readArg(s)), 'w'); const r = cssLength(texOf(readArg(s)), 'w');
        return `<div style="margin-left:${l || 0};margin-right:${r || 0}">${this.convert(readEnvBody(s, name), ctx)}</div>`;
      }
      case 'multicols': case 'multicols*': {
        const n = parseInt(texOf(readArg(s)), 10) || 2;
        readOpt(s);
        return `<div class="multicols" style="column-count:${n}">${this.convert(readEnvBody(s, name), ctx)}</div>`;
      }
      case 'overprint': case 'overlayarea': {
        readOpt(s); if (name === 'overlayarea') { readArg(s); readArg(s); }
        // \onslide<n> inside overprint behaves like \only
        const body = readEnvBody(s, name);
        const parts = [];
        let cur = null;
        const pre = [];
        for (const u of body) {
          if (u.type === 'cs' && u.name === 'onslide') { cur = { spec: null, toks: [] }; parts.push(cur); continue; }
          if (cur && cur.spec === null && cur.toks.length === 0 && u.type === 'char' && u.ch === '<') { cur.spec = ''; continue; }
          if (cur && cur.spec !== null && !cur.closed) { if (u.type === 'char' && u.ch === '>') { cur.closed = true; continue; } cur.spec += texOf([u]); continue; }
          (cur ? cur.toks : pre).push(u);
        }
        let h = this.convert(pre, ctx);
        for (const p of parts) h += `<div class="ov"${this.overlayAttr('only', p.spec || '1-', ctx)}>${this.convert(p.toks, ctx)}</div>`;
        return `<div class="overprint">${h}</div>`;
      }
      case 'onlyenv': case 'altenv': {
        const ov = readOverlay(s);
        const body = readEnvBody(s, name);
        return `<div class="ov"${this.overlayAttr('only', ov || '1-', ctx)}>${this.convert(body, ctx)}</div>`;
      }
      case 'visibleenv': case 'uncoverenv': {
        const ov = readOverlay(s);
        const body = readEnvBody(s, name);
        return `<div class="ov"${this.overlayAttr('uncover', ov || '1-', ctx)}>${this.convert(body, ctx)}</div>`;
      }
      case 'thebibliography': { readArg(s); return `<div class="bib">${this.convert(readEnvBody(s, name), ctx)}</div>`; }
      case 'small': case 'footnotesize': case 'scriptsize': case 'tiny': case 'large': case 'Large': case 'normalsize': {
        const body = readEnvBody(s, name);
        return `<div style="font-size:${SIZES[name]}pt">${this.convert(body, ctx)}</div>`;
      }
      case 'frame': {
        // nested frame (should not happen) – render body
        return this.convert(readEnvBody(s, name), ctx);
      }
      default: {
        const body = readEnvBody(s, name);
        this.diag('Unknown environment ' + name, t);
        return `<div class="env-${esc(name)}">${this.convert(body, ctx)}</div>`;
      }
    }
  }

  block(kind, title, bodyToks, ctx, ov, line, qed) {
    const body = this.convert(bodyToks, ctx);
    let html = `<div class="block${kind}" data-line="${line}">${title ? `<div class="block-title">${title}</div>` : ''}<div class="block-body">${body}${qed ? '<span class="qed">∎</span>' : ''}</div></div>`;
    if (ov) html = `<div class="ov"${this.overlayAttr('uncover', ov, ctx)}>${html}</div>`;
    return html;
  }

  list(kind, s, ctx, line) {
    const envOv = readOverlay(s);
    const o = readOpt(s);
    let defaultSpec = null;
    let labelTpl = null;
    if (o) {
      const str = texOf(o).trim();
      const m = /^<([^>]*)>$/.exec(str);
      if (m) defaultSpec = m[1];
      else if (kind === 'enumerate') labelTpl = str.replace(/^label=/, '').replace(/[{}]/g, '').trim();
    }
    const body = readEnvBody(s, kind);
    // split at top-level \item
    const parts = [];
    let cur = { pre: true, toks: [] };
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      const u = body[i];
      if (u.type === 'bgroup' || u.type === 'begin') depth++;
      else if (u.type === 'egroup' || u.type === 'end') depth--;
      if (depth === 0 && u.type === 'cs' && u.name === 'item') {
        parts.push(cur);
        cur = { pre: false, toks: [], tok: u };
        continue;
      }
      cur.toks.push(u);
    }
    parts.push(cur);
    const prevSep = ctx.itemsep;
    ctx.itemsep = null;
    ctx.listDepth++;
    const level = ctx.listDepth;
    if (kind === 'enumerate') ctx.enumDepth = (ctx.enumDepth || 0) + 1;
    const enumLevel = ctx.enumDepth || 1;
    // font/size/color switches before the first \item apply to the whole list
    const listStyle = [];
    const preToks = [];
    const ps0 = new Stream(parts[0].toks);
    while (!ps0.eof()) {
      const u = ps0.next();
      if (u.type === 'cs' && SIZES[u.name]) { listStyle.push(`font-size:${SIZES[u.name]}pt;line-height:${(SIZES[u.name] * 1.38).toFixed(2)}pt`); continue; }
      if (u.type === 'cs' && SWITCHES[u.name]) { listStyle.push(SWITCHES[u.name]); continue; }
      if (u.type === 'cs' && u.name === 'color') { const o = readOpt(ps0); listStyle.push(`color:${this.colorCss(o, readArg(ps0))}`); continue; }
      preToks.push(u);
    }
    let pre = this.convert(preToks, ctx).trim();
    const itemsep = ctx.itemsep;
    let html = '';
    let n = 0;
    for (const p of parts.slice(1)) {
      const ps = new Stream(p.toks);
      let spec = readOverlay(ps);
      const lab = readOpt(ps);
      if (!spec) spec = readOverlay(ps);
      if (!spec && defaultSpec) spec = defaultSpec;
      n++;
      let label;
      if (lab) label = this.convert(lab, ctx);
      else if (kind === 'itemize') label = '•';
      else if (kind === 'enumerate') label = enumLabel(n, enumLevel, labelTpl);
      else label = '';
      let attrs = '';
      if (spec) attrs = this.overlayAttr('uncover', spec, ctx);
      if (ctx.pause > 0 && !spec) attrs = this.overlayAttr('uncover', `${ctx.pause + 1}-`, ctx);
      const content = this.convertStream(ps, ctx);
      if (spec && /\+/.test(spec)) ctx.plus++;
      else if (ctx.plusUsed) { ctx.plus++; }
      ctx.plusUsed = false;
      const ln = p.tok ? ` data-line="${this.lineOf(p.tok)}"` : '';
      html += kind === 'description'
        ? `<li class="desc"${attrs}${ln}><span class="dlabel">${label}</span> ${content}</li>`
        : `<li${attrs}${ln}><span class="lbl">${label}</span><div class="itm">${content}</div></li>`;
    }
    ctx.listDepth--;
    if (kind === 'enumerate') ctx.enumDepth--;
    ctx.itemsep = prevSep;
    if (itemsep) listStyle.push(`--itemsep:${itemsep}`);
    const style = listStyle.length ? ` style="${listStyle.join(';')}"` : '';
    let out = `${pre}<ul class="list ${kind} l${Math.min(level, 3)}"${style}>${html}</ul>`;
    if (envOv) out = `<div class="ov"${this.overlayAttr('uncover', envOv, ctx)}>${out}</div>`;
    return out;
  }

  columnBody(toks, ctx) {
    const prev = [ctx.colFn, ctx.colFnNo];
    ctx.colFn = []; ctx.colFnNo = 0;
    let html = this.convert(toks, ctx);
    if (ctx.colFn.length) html += `<div class="colfn"><div class="fn-rule"></div>${ctx.colFn.join('')}</div>`;
    [ctx.colFn, ctx.colFnNo] = prev;
    return html;
  }

  columns(s, ctx) {
    const o = readOpt(s);
    const opts = parseKeyVals(o ? texOf(o) : '');
    const body = readEnvBody(s, 'columns');
    const align = opts.t || opts.T ? 'flex-start' : opts.b ? 'flex-end' : 'center';
    // collect columns (env form and \column{w} form)
    const cols = [];
    let cur = null;
    const bs = new Stream(body);
    while (!bs.eof()) {
      const u = bs.next();
      if (u.type === 'begin' && u.name === 'column') {
        const co = readOpt(bs); const w = texOf(readArg(bs));
        cols.push({ w, align: co ? texOf(co).trim() : '', toks: readEnvBody(bs, 'column') });
        cur = null;
        continue;
      }
      if (u.type === 'cs' && u.name === 'column') {
        const co = readOpt(bs); const w = texOf(readArg(bs));
        cur = { w, align: co ? texOf(co).trim() : '', toks: [] };
        cols.push(cur);
        continue;
      }
      if (cur) cur.toks.push(u);
    }
    const total = opts.totalwidth ? cssLength(opts.totalwidth, 'w') : null;
    const html = cols.map((c) => {
      const a = c.align === 't' || c.align === 'T' ? 'flex-start' : c.align === 'b' ? 'flex-end' : c.align === 'c' ? 'center' : '';
      const w = cssLength(c.w.trim(), 'w');
      return `<div class="column" style="width:${w || 'auto'}${a ? `;align-self:${a}` : ''}">${this.columnBody(c.toks, ctx)}</div>`;
    }).join('');
    return `<div class="columns${opts.onlytextwidth ? ' otw' : ''}" style="align-items:${align}${total ? `;width:${total}` : ''}">${html}</div>`;
  }

  // ---------- tables ----------
  parseColSpec(spec) {
    // returns [{align, width, lborder, rborder}]
    const toks = tokenize(spec);
    const s = new Stream(toks);
    const cols = [];
    let pendingBorder = 0;
    const add = (align, width) => { cols.push({ align, width, lb: pendingBorder, rb: 0 }); pendingBorder = 0; };
    while (!s.eof()) {
      const u = s.next();
      if (u.type === 'char') {
        const c = u.ch;
        if (c === '|') {
          // a rule before a column is its left border; trailing rules are the last column's right border
          if (cols.length && !this._moreCols(s)) cols[cols.length - 1].rb++; else pendingBorder++;
          continue;
        }
        if (c === 'l' || c === 'c' || c === 'r') { add({ l: 'left', c: 'center', r: 'right' }[c]); continue; }
        if (c === 'p' || c === 'm' || c === 'b') { add('left', cssLength(texOf(readArg(s)), 'w')); continue; }
        if (c === 'X' || c === 'L' || c === 'C' || c === 'R' || c === 'J') { add(c === 'C' ? 'center' : c === 'R' ? 'right' : 'left', 'auto'); continue; }
        if (c === 'S') { add('center'); continue; }
        if (c === '@' || c === '!' || c === '>' || c === '<') { readArg(s); continue; }
        if (c === '*') {
          const n = parseInt(texOf(readArg(s)), 10) || 1;
          const inner = texOf(readArg(s));
          const sub = this.parseColSpec(inner);
          for (let k = 0; k < n; k++) for (const c2 of sub) cols.push({ ...c2, lb: c2.lb + (k === 0 ? pendingBorder : 0) });
          pendingBorder = 0;
          continue;
        }
      }
    }
    return cols;
  }

  _moreCols(s) {
    for (let k = s.i; k < s.t.length; k++) {
      const u = s.t[k];
      if (u.type === 'char' && /[lcrpmbXLCRJS*]/.test(u.ch)) return true;
    }
    return false;
  }

  tabular(name, s, ctx) {
    if (name === 'tabular*' || name === 'tabularx' || name === 'tabulary') readArg(s);
    readOpt(s);
    const spec = texOf(readArg(s));
    const body = readEnvBody(s, name);
    const cols = this.parseColSpec(spec);
    // split rows at \\ (depth 0)
    const rows = [];
    let cur = [];
    let depth = 0;
    const bs = new Stream(body);
    while (!bs.eof()) {
      const u = bs.next();
      if (u.type === 'bgroup') depth++;
      if (u.type === 'egroup') depth--;
      if (depth === 0 && u.type === 'begin') {
        // nested env: copy whole env
        cur.push(u);
        const inner = readEnvBody(bs, u.name);
        cur.push(...inner, { type: 'end', name: u.name });
        continue;
      }
      if (depth === 0 && u.type === 'cs' && (u.name === '\\' || u.name === 'tabularnewline')) { readStar(bs); readOpt(bs); rows.push(cur); cur = []; continue; }
      cur.push(u);
    }
    rows.push(cur);
    const rule = 'var(--rule)';
    const out = [];
    let pendingTop = '';
    const rowspans = new Array(cols.length).fill(0);
    rows.forEach((rt, ri) => {
      // leading rules / rowcolor
      const rs = new Stream(rt);
      let rowBg = null;
      let top = pendingTop;
      pendingTop = '';
      for (;;) {
        skipSpaces(rs, true);
        const u = rs.peek();
        if (!u || u.type !== 'cs') break;
        if (u.name === 'hline' || u.name === 'Hline') { rs.i++; top = top ? `${top};border-top-style:double;border-top-width:2.2pt` : `border-top:0.4pt solid ${rule}`; continue; }
        if (u.name === 'toprule' || u.name === 'bottomrule') { rs.i++; readOpt(rs); top = `border-top:0.8pt solid ${rule}`; continue; }
        if (u.name === 'midrule') { rs.i++; readOpt(rs); top = `border-top:0.5pt solid ${rule}`; continue; }
        if (u.name === 'cline' || u.name === 'cmidrule') { rs.i++; readOpt(rs); if (rs.peek() && rs.peek().type === 'char' && rs.peek().ch === '(') { while (!rs.eof() && !(rs.next().ch === ')')); } readArg(rs); top = top || `border-top:0.4pt solid ${rule}`; continue; }
        if (u.name === 'rowcolor') { rs.i++; const o = readOpt(rs); rowBg = this.colorCss(o, readArg(rs)); readOpt(rs); continue; }
        if (u.name === 'addlinespace' || u.name === 'noalign') { rs.i++; readOpt(rs); if (u.name === 'noalign') readArg(rs); continue; }
        break;
      }
      const restToks = rt.slice(rs.i);
      const isEmpty = restToks.every((u) => u.type === 'char' && u.ch === ' ' || u.type === 'par');
      if (isEmpty) {
        // rules after last row
        if (top && out.length) out[out.length - 1].bottom = top;
        else if (top) pendingTop = top;
        return;
      }
      // split cells on &
      const cells = [];
      let cc = [];
      let d = 0;
      for (const u of restToks) {
        if (u.type === 'bgroup') d++;
        if (u.type === 'egroup') d--;
        if (d === 0 && u.type === 'align') { cells.push(cc); cc = []; continue; }
        cc.push(u);
      }
      cells.push(cc);
      const tds = [];
      let ci = 0;
      for (const ct of cells) {
        while (ci < cols.length && rowspans[ci] > 0) { rowspans[ci]--; ci++; }
        const cs = new Stream(ct);
        let span = 1, align = cols[ci] ? cols[ci].align : 'left', cellBg = null, rowspan = 1;
        let lb = cols[ci] ? cols[ci].lb : 0, rb = cols[ci] ? cols[ci].rb : 0;
        let content;
        skipSpaces(cs, true);
        const first = cs.peek();
        if (first && first.type === 'cs' && first.name === 'multicolumn') {
          cs.i++;
          span = parseInt(texOf(readArg(cs)), 10) || 1;
          const sp = this.parseColSpec(texOf(readArg(cs)));
          if (sp[0]) { align = sp[0].align; lb = sp[0].lb; rb = sp[0].rb; }
          content = readArg(cs).concat(cs.rest());
        } else content = cs.rest();
        // multirow / cellcolor inside cell
        const inner = new Stream(content);
        const keep = [];
        while (!inner.eof()) {
          const u = inner.next();
          if (u.type === 'cs' && u.name === 'cellcolor') { const o = readOpt(inner); cellBg = this.colorCss(o, readArg(inner)); continue; }
          if (u.type === 'cs' && u.name === 'multirow') {
            readOpt(inner); rowspan = parseInt(texOf(readArg(inner)), 10) || 1; readOpt(inner); readArg(inner); readOpt(inner);
            keep.push({ type: 'bgroup' }, ...readArg(inner), { type: 'egroup' });
            continue;
          }
          keep.push(u);
        }
        if (rowspan > 1) for (let k = 0; k < span; k++) rowspans[ci + k] = rowspan - 1;
        const st = [`text-align:${align}`];
        if (cols[ci] && cols[ci].width && cols[ci].width !== 'auto') st.push(`width:${cols[ci].width}`);
        if (lb) st.push(`border-left:${lb > 1 ? '1.6pt double' : '0.4pt solid'} ${rule}`);
        if (rb) st.push(`border-right:${rb > 1 ? '1.6pt double' : '0.4pt solid'} ${rule}`);
        if (top) st.push(top);
        if (cellBg || rowBg) st.push(`background:${cellBg || rowBg}`);
        if (ctx.tabcolsep) st.push(`padding-left:${ctx.tabcolsep};padding-right:${ctx.tabcolsep}`);
        if (ctx.arraystretch !== 1) st.push(`padding-top:${(ctx.arraystretch - 1) * 0.5 + 0.1}em;padding-bottom:${(ctx.arraystretch - 1) * 0.5 + 0.1}em`);
        const prevAlign = ctx.inCell;
        ctx.inCell = true;
        const h = this.convert(keep, ctx);
        ctx.inCell = prevAlign;
        tds.push(`<td${span > 1 ? ` colspan="${span}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''} style="${st.join(';')}">${h}</td>`);
        ci += span;
      }
      out.push({ tds, bottom: '' });
    });
    const trs = out.map((r) => {
      let tds = r.tds;
      if (r.bottom) tds = tds.map((td) => td.replace(/style="/, `style="${r.bottom.replace('border-top', 'border-bottom')};`));
      return `<tr>${tds.join('')}</tr>`;
    }).join('');
    const inline = name === 'array' ? ' arr' : '';
    return `<table class="tabular${inline}">${trs}</table>`;
  }
}

const kw = (str) => new Set(str.split(/\s+/));
const CODE_KEYWORDS = {
  python: kw('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'),
  c: kw('auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while'),
  'c++': kw('auto bool break case catch char class const constexpr continue default delete do double else enum explicit false float for friend if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename using virtual void while'),
  java: kw('abstract boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true false try void while'),
  javascript: kw('async await break case catch class const continue default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while yield'),
  r: kw('if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA library return'),
  sql: kw('SELECT FROM WHERE GROUP BY ORDER HAVING JOIN LEFT RIGHT INNER OUTER ON AS AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DISTINCT LIMIT select from where group by order having join on as and or not insert into values update set delete create table distinct limit'),
  bash: kw('if then else elif fi for while do done case esac function in echo export return local'),
  matlab: kw('break case catch continue else elseif end for function global if otherwise persistent return switch try while'),
};
Object.assign(CODE_KEYWORDS, { sh: CODE_KEYWORDS.bash, cpp: CODE_KEYWORDS['c++'], js: CODE_KEYWORDS.javascript, py: CODE_KEYWORDS.python, python3: CODE_KEYWORDS.python });

const NATIVE_OVERRIDES = new Set(['blfootnote', 'alert', 'only', 'uncover', 'pause', 'footnote', 'includegraphics']);

function enumLabel(n, level, tpl) {
  const alpha = (k) => String.fromCharCode(96 + k);
  const roman = (k) => ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'][k] || String(k);
  if (tpl) {
    return esc(tpl.replace(/\\arabic\*|1/, String(n)).replace(/\\alph\*|a(?![a-z])/, alpha(n)).replace(/\\roman\*|i(?![a-z])/, roman(n))
      .replace(/\\Alph\*|A(?![a-z])/, alpha(n).toUpperCase()).replace(/\\Roman\*|I(?![a-z])/, roman(n).toUpperCase()));
  }
  if (level === 1) return `${n}.`;
  if (level === 2) return `(${alpha(n)})`;
  return `${roman(n)}.`;
}

function abbrev(src) {
  const lines = src.split('\n');
  return lines.length > 12 ? lines.slice(0, 10).join('\n') + '\n  …' : src;
}

function todayString() {
  const d = new Date();
  const m = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()];
  return `${m} ${d.getDate()}, ${d.getFullYear()}`;
}

module.exports = { Renderer, GEOM, texOf, cssLength, tokenize };

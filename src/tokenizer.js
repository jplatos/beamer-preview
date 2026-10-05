'use strict';
// Lightweight TeX tokenizer. Not a TeX engine: it produces a flat token list
// that the renderer walks. Math and verbatim-like environments are captured raw.

const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'displaymath', 'math', 'flalign', 'flalign*', 'alignat', 'alignat*',
]);
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment', 'Verbatim']);

// Environments captured raw so they can be rendered by LaTeX (snippet renderer)
// or shown as a placeholder. Configurable from the outside.
const DEFAULT_RAW_ENVS = new Set(['tikzpicture', 'algorithm', 'algorithm2e', 'forest', 'circuitikz']);

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function offsetToLine(starts, off) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo; // 0-based
}

/**
 * @param {string} src
 * @param {{file?:string, rawEnvs?:Set<string>}} opts
 */
function tokenize(src, opts = {}) {
  const file = opts.file || '';
  const rawEnvs = opts.rawEnvs || DEFAULT_RAW_ENVS;
  const toks = [];
  const n = src.length;
  let i = 0;
  const push = (t, pos) => { t.pos = pos; t.file = file; toks.push(t); };

  const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '@';

  // find "\end{name}" at or after j, returns index of backslash or -1
  const findEnd = (name, j) => {
    const needle = '\\end{' + name + '}';
    // naive nesting for same env name
    const open = '\\begin{' + name + '}';
    let depth = 1;
    let s = j;
    for (;;) {
      const nb = src.indexOf(open, s);
      const ne = src.indexOf(needle, s);
      if (ne < 0) return -1;
      if (nb >= 0 && nb < ne) { depth++; s = nb + open.length; continue; }
      depth--;
      if (depth === 0) return ne;
      s = ne + needle.length;
    }
  };

  // skip a % comment (to end of line, including leading whitespace of next line as TeX does)
  const skipComment = () => {
    while (i < n && src[i] !== '\n') i++;
    if (i < n) i++;
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
  };

  // find closing math delimiter, skipping escaped chars and comments
  const findMathClose = (j, close) => {
    let depth = 0;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        if (depth === 0 && src.startsWith(close, j)) return j;
        j += 2; continue;
      }
      if (c === '%') { while (j < n && src[j] !== '\n') j++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth <= 0 && src.startsWith(close, j)) return j;
      j++;
    }
    return -1;
  };

  // strip % comments from a raw math source
  const stripComments = (s) => s.replace(/(^|[^\\])%[^\n]*/g, '$1');

  while (i < n) {
    const c = src[i];
    const start = i;
    if (c === '%') { skipComment(); continue; }
    if (c === '\\') {
      const d = src[i + 1];
      if (d === undefined) { i++; continue; }
      if (isLetter(d)) {
        let j = i + 1;
        while (j < n && isLetter(src[j])) j++;
        let name = src.slice(i + 1, j);
        let star = false;
        // swallow spaces after control word
        let k = j;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
        // single newline after a control word is also a space (but not a blank line)
        if (src[k] === '\n') {
          let m = k + 1;
          while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
          if (src[m] !== '\n') k = m;
        }
        if (name === 'begin' || name === 'end') {
          const mm = /^\s*\{([^}]*)\}/.exec(src.slice(j, j + 200));
          if (mm) {
            const env = mm[1].trim();
            const after = j + mm[0].length;
            if (name === 'begin' && (MATH_ENVS.has(env) || VERBATIM_ENVS.has(env) || rawEnvs.has(env))) {
              const e = findEnd(env, after);
              const bodyEnd = e < 0 ? n : e;
              const body = src.slice(after, bodyEnd);
              const endLen = ('\\end{' + env + '}').length;
              const full = src.slice(start, e < 0 ? n : e + endLen);
              if (MATH_ENVS.has(env)) push({ type: 'math', display: true, env, src: stripComments(body) }, start);
              else if (VERBATIM_ENVS.has(env)) push({ type: 'verb', env, src: body }, start);
              else push({ type: 'raw', env, src: full }, start);
              i = e < 0 ? n : e + endLen;
              continue;
            }
            push({ type: name, name: env }, start);
            i = after;
            continue;
          }
        }
        if (name === 'verb' || name === 'lstinline') {
          let p = j;
          if (src[p] === '*') p++;
          if (src[p] === '[') { const q = src.indexOf(']', p); if (q > 0) p = q + 1; }
          const delim = src[p];
          const close = delim === '{' ? '}' : delim;
          const q = src.indexOf(close, p + 1);
          if (q > 0) {
            push({ type: 'verbinline', src: src.slice(p + 1, q) }, start);
            i = q + 1; continue;
          }
        }
        push({ type: 'cs', name }, start);
        i = k;
        continue;
      }
      // control symbol
      if (d === '[' || d === '(') {
        const close = d === '[' ? '\\]' : '\\)';
        const e = findMathClose(i + 2, close);
        const end = e < 0 ? n : e;
        push({ type: 'math', display: d === '[', src: stripComments(src.slice(i + 2, end)) }, start);
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (d === '\n' || d === ' ' || d === '\t') { push({ type: 'char', ch: ' ' }, start); i += 2; continue; }
      push({ type: 'cs', name: d, sym: true }, start);
      i += 2;
      continue;
    }
    if (c === '$') {
      const disp = src[i + 1] === '$';
      const open = disp ? 2 : 1;
      const e = findMathClose(i + open, disp ? '$$' : '$');
      const end = e < 0 ? n : e;
      push({ type: 'math', display: disp, src: stripComments(src.slice(i + open, end)) }, start);
      i = e < 0 ? n : e + open;
      continue;
    }
    if (c === '{') { push({ type: 'bgroup' }, start); i++; continue; }
    if (c === '}') { push({ type: 'egroup' }, start); i++; continue; }
    if (c === '&') { push({ type: 'align' }, start); i++; continue; }
    if (c === '~') { push({ type: 'char', ch: ' ' }, start); i++; continue; }
    if (c === '#') {
      const d = src[i + 1];
      if (d >= '1' && d <= '9') { push({ type: 'param', n: +d }, start); i += 2; continue; }
      push({ type: 'char', ch: '#' }, start); i++; continue;
    }
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      // collapse whitespace; detect paragraph break (blank line)
      let newlines = 0;
      let j = i;
      while (j < n) {
        const e = src[j];
        if (e === '\n') newlines++;
        else if (e === '%') {
          // comment inside whitespace run: TeX ignores up to and including newline
          while (j < n && src[j] !== '\n') j++;
          j++;
          while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
          // a comment line resets newline counting for this run
          newlines = 0;
          continue;
        } else if (e !== ' ' && e !== '\t' && e !== '\r') break;
        j++;
      }
      push(newlines >= 2 ? { type: 'par' } : { type: 'char', ch: ' ' }, start);
      i = j;
      continue;
    }
    push({ type: 'char', ch: c }, start);
    i++;
  }
  return toks;
}

module.exports = { tokenize, lineIndex, offsetToLine, MATH_ENVS, VERBATIM_ENVS, DEFAULT_RAW_ENVS };

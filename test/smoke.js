// Dependency-free smoke test: render the demo deck and check the output structure.
// usage: node test/smoke.js
const assert = require('assert');
const path = require('path');
const { Renderer } = require('../src/render');
const { findRoot, makeReader, imageKind } = require('../src/project');

const readFile = makeReader(null);
const render = (file, focus) => {
  const r = new Renderer({ readFile, resolveImage: (p) => { const k = imageKind(p); return k ? { uri: p, kind: k } : null; } });
  return r.renderDocument(findRoot(file, readFile) || file, { focusFile: focus });
};

const demo = path.resolve(__dirname, '../examples/demo');
const root = path.join(demo, 'main.tex');
const sub = path.join(demo, 'sections/basics.tex');
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); }
};

const doc = render(root, null);
const byTitle = (t) => doc.frames.find((f) => f.title === t);

test('finds the root from an included file', () => {
  assert.strictEqual(path.resolve(findRoot(sub, readFile)), path.resolve(root));
});
test('renders title, section pages, frames and standout', () => {
  const kinds = doc.frames.map((f) => f.kind);
  assert.strictEqual(kinds[0], 'title');
  assert.strictEqual(kinds.filter((k) => k === 'section').length, 2);
  assert.ok(doc.frames.some((f) => /standout/.test(f.html)));
});
test('no diagnostics on the demo deck', () => {
  assert.deepStrictEqual(doc.diagnostics.map((d) => d.msg), []);
});
test('theme colours come from the preamble', () => {
  assert.strictEqual(doc.cssVars['--ft-bg'], '#006fba');
  assert.strictEqual(doc.cssVars['--pp-bg'], '#006fba');
});
test('overlays: \\pause and \\only produce 3 steps', () => {
  const f = byTitle('Overlays');
  assert.strictEqual(f.steps, 3);
  assert.ok(/data-uncover="2-"/.test(f.html) && /data-only="3"/.test(f.html));
});
test('\\pause inside a list also hides the content after the list', () => {
  const f = byTitle('Overlays');
  assert.ok(/data-uncover="3-">\s*<div class="center">/.test(f.html));
});
test('enumerate inside itemize is numbered 1., 2.', () => {
  assert.ok(/<span class="lbl">1\.<\/span>/.test(byTitle('Lists and emphasis').html));
});
test('math is rendered with KaTeX, including user macros', () => {
  const f = byTitle('Math');
  assert.ok(f.html.includes('class="katex"'));
  assert.ok(!/katex-error/.test(f.html));
});
test('images: PNG as <img>, PDF as pdf.js canvas', () => {
  const f = byTitle('Columns and images');
  assert.ok(/<img class="ig"[^>]*histogram\.png/.test(f.html));
  assert.ok(/<canvas class="pdfimg"[^>]*curve\.pdf/.test(f.html));
  assert.ok(/class="colfn"/.test(f.html) && f.html.includes('<sup>a</sup>'), 'column footnote, lettered');
});
test('blocks and tables', () => {
  assert.ok(/class="block alerted"/.test(byTitle('Blocks').html));
  const t = byTitle('Tables').html;
  assert.ok(/<table class="tabular">/.test(t) && /Table 1:/.test(t));
});
test('algorithm2e approximation without the snippet engine', () => {
  assert.ok(/class="algorithm"/.test(byTitle('Algorithms').html));
});
test('lecture mode shows only the included file plus title/section/closing frames', () => {
  const lec = render(sub, sub);
  const kinds = lec.frames.map((f) => f.kind);
  assert.deepStrictEqual(kinds.slice(0, 2), ['title', 'section']);
  assert.ok(lec.frames.filter((f) => f.kind === 'frame').length >= 5);
  assert.ok(!lec.frames.some((f) => f.title === 'Tables'));
});

// ---- in-memory documents for specific constructs ----
const { overlayVariant, overlaySteps, resolveIncremental } = require('../src/overlays');
const memDoc = (body, extra = {}) => {
  const files = Object.assign({
    'C:/mem/main.tex': String.raw`\documentclass{beamer}\usetheme{metropolis}
\definecolor{fei}{RGB}{0,111,186}
\begin{document}
` + body + String.raw`
\end{document}`,
  }, extra);
  const norm = (f) => path.resolve(f).toLowerCase();
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const snippets = [];
  const r = new Renderer({
    readFile: (f) => map.get(norm(f)) ?? null,
    resolveImage: (p) => (map.has(norm(p)) ? { uri: p, kind: path.extname(p) === '.pdf' ? 'pdf' : 'img' } : null),
    snippet: (src) => { snippets.push(src); return { key: 'k' + snippets.length, uri: null }; },
  });
  const d = r.renderDocument('C:/mem/main.tex');
  return { html: d.frames.map((f) => f.html).join('\n'), frames: d.frames, snippets, diagnostics: d.diagnostics };
};

test('enumerate mini-template [ {[}1{]} ] gives [1], [2]', () => {
  const d = memDoc(String.raw`\begin{frame}{F}\begin{enumerate}[ {[}1{]} ]\item a\item b\end{enumerate}\end{frame}`);
  assert.ok(d.html.includes('<span class="lbl">[1]</span>') && d.html.includes('<span class="lbl">[2]</span>'));
});
test('image names with extra dots (x.drawio + .pdf)', () => {
  const d = memDoc(String.raw`\begin{frame}{F}\includegraphics{img/a.drawio}\end{frame}`, { 'C:/mem/img/a.drawio.pdf': '%PDF' });
  assert.ok(/canvas class="pdfimg"[^>]*a\.drawio\.pdf/.test(d.html), d.diagnostics.map((x) => x.msg).join());
});
test('lstlisting options: size and keyword highlighting, no option text', () => {
  const d = memDoc(String.raw`\begin{frame}[fragile]{F}
\begin{lstlisting}[language=Python, basicstyle=\ttfamily\scriptsize, keywordstyle=\color{fei}\bfseries]
import torch  # comment
def f(x): return "s"
\end{lstlisting}
\end{frame}`);
  assert.ok(!d.html.includes('language=Python'));
  assert.ok(/<pre class="verb" style="font-size:8pt/.test(d.html));
  assert.ok(d.html.includes('<span class="c-kw" style="color:#006fba;">import</span>'));
  assert.ok(d.html.includes('<span class="c-com"># comment</span>') && d.html.includes('<span class="c-str">&quot;s&quot;</span>'));
});
test('\\lstinputlisting reads the file', () => {
  const d = memDoc(String.raw`\begin{frame}{F}\lstinputlisting[language=Python]{code/a.py}\end{frame}`, { 'C:/mem/code/a.py': 'def g():\n    pass\n' });
  assert.ok(d.html.includes('<span class="c-kw">def</span> g()'));
});
test('\\todo renders as a visible note', () => {
  assert.ok(memDoc(String.raw`\begin{frame}{F}text \todo{fix me}\end{frame}`).html.includes('<span class="todo">fix me</span>'));
});
test('\\tabcolsep applies to cells', () => {
  const d = memDoc(String.raw`\begin{frame}{F}\setlength\tabcolsep{1pt}\begin{tabular}{c}a\end{tabular}\end{frame}`);
  assert.ok(/padding-left:1pt;padding-right:1pt/.test(d.html));
});
test('overlay variants for snippets (\\visible, \\only, \\alt, \\pause)', () => {
  const s = String.raw`A \visible<2>{B} \only<3>{D} \alt<2>{E}{F} \pause G`;
  assert.strictEqual(overlaySteps(s), 3);
  assert.strictEqual(overlayVariant(s, 1, false).replace(/\s+/g, ' ').trim(), 'A F G');
  assert.strictEqual(overlayVariant(s, 2, false).replace(/\s+/g, ' ').trim(), 'A B E G');
  assert.ok(overlayVariant(String.raw`\visible<2>{\node{x};}`, 1, true).includes('opacity=0'));
});
test('incremental specs <+->, <+>, <.> resolve in order', () => {
  const r = resolveIncremental(String.raw`\uncover<+->{a}\uncover<+>{b}\uncover<.>{c}\uncover<+->{d}`, 1);
  assert.strictEqual(r.src, String.raw`\uncover<1->{a}\uncover<2>{b}\uncover<2>{c}\uncover<3->{d}`);
  assert.strictEqual(r.next, 4);
});
test('tikz with overlays compiles one snippet per step, without overlay commands', () => {
  const d = memDoc(String.raw`\begin{frame}{F}\begin{tikzpicture}\node{a};\visible<2>{\node{b};}\only<3>{\node{c};}\end{tikzpicture}\end{frame}`);
  assert.strictEqual(d.snippets.length, 3);
  assert.ok(d.snippets.every((s) => !/\\(visible|only)\s*</.test(s)));
  const f = d.frames.find((x) => x.kind === 'frame');
  assert.strictEqual(f.steps, 3);
  assert.ok(f.html.includes('data-only="1"') && f.html.includes('data-only="3-"'));
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

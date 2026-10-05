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

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

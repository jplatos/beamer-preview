// Visual comparison: real LaTeX output vs. the preview, side by side.
//
// usage: node test/compare.js <main.tex> [--pdf reference.pdf] [--out dir] [--focus file.tex] [--snippets]
//
//   1. reference PDF: --pdf, or compiled with xelatex in Docker (texlive/texlive)
//   2. reference pages rasterised with ghostscript (Docker)
//   3. preview rendered (every overlay step = one slide, like the PDF) and screenshotted (Chrome/Edge)
//   4. <out>/compare.html shows them pairwise; page-count mismatches are reported
//
// Needs Docker (xelatex and ghostscript run in the texlive image; override with TEXLIVE_IMAGE)
// and Chrome/Edge (or CHROME_PATH).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const main = args.find((a) => a.endsWith('.tex') && args[args.indexOf(a) - 1] !== '--focus');
if (!main) { console.error('usage: node test/compare.js <main.tex> [--pdf ref.pdf] [--out dir] [--focus file.tex] [--snippets]'); process.exit(1); }
const mainAbs = path.resolve(main);
const deckDir = path.dirname(mainAbs);
const out = path.resolve(opt('--out') || 'compare-out');
const focus = opt('--focus') ? path.resolve(opt('--focus')) : null;
const image = process.env.TEXLIVE_IMAGE || 'texlive/texlive:latest';
fs.mkdirSync(out, { recursive: true });

function docker(dockerArgs, what) {
  const r = spawnSync('docker', dockerArgs, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) {
    console.error(`${what} failed:`, r.error ? r.error.message : (r.stderr || r.stdout).split('\n').slice(-15).join('\n'));
    process.exit(1);
  }
  return r.stdout;
}

// 1. reference PDF
let refPdf = opt('--pdf') ? path.resolve(opt('--pdf')) : null;
if (!refPdf) {
  console.log(`compiling ${path.basename(mainAbs)} with xelatex (${image})…`);
  const name = path.basename(mainAbs);
  docker(['run', '--rm', '-v', `${deckDir}:/w`, '-v', `${out}:/out`, '-w', '/w', image, 'sh', '-c',
    `xelatex -interaction=nonstopmode -output-directory=/out "${name}" >/dev/null; xelatex -interaction=nonstopmode -output-directory=/out "${name}" >/dev/null; test -f "/out/${name.replace(/\.tex$/, '.pdf')}"`],
  'xelatex');
  refPdf = path.join(out, name.replace(/\.tex$/, '.pdf'));
}

// 2. rasterise reference
for (const f of fs.readdirSync(out)) if (/^(ref|prev)-\d+\.png$/.test(f)) fs.unlinkSync(path.join(out, f));
console.log('rasterising reference…');
docker(['run', '--rm', '-v', `${path.dirname(refPdf)}:/in:ro`, '-v', `${out}:/out`, image,
  'gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', '-r96', '-sOutputFile=/out/ref-%03d.png', `/in/${path.basename(refPdf)}`], 'ghostscript');

// 3. preview
const cliArgs = [path.join(__dirname, '..', 'cli.js'), focus || mainAbs, '-o', path.join(out, 'preview.html')];
if (!focus) cliArgs.push('--document');
if (args.includes('--snippets')) cliArgs.push('--snippets');
const cli = spawnSync(process.execPath, cliArgs, { encoding: 'utf8', stdio: 'inherit' });
if (cli.status !== 0) process.exit(1);
const shots = path.join(out, 'shots');
fs.rmSync(shots, { recursive: true, force: true });
const sh = spawnSync(process.execPath, [path.join(__dirname, 'shoot.js'), path.join(out, 'preview.html'), shots, 'all'], { encoding: 'utf8', stdio: 'inherit' });
if (sh.status !== 0) process.exit(1);
for (const f of fs.readdirSync(shots)) fs.renameSync(path.join(shots, f), path.join(out, f.replace(/^s(\d+)\.png$/, (m, n) => `prev-${String(+n + 1).padStart(3, '0')}.png`)));
fs.rmSync(shots, { recursive: true, force: true });

// 4. side-by-side page
const ref = fs.readdirSync(out).filter((f) => /^ref-\d+\.png$/.test(f)).sort();
const prev = fs.readdirSync(out).filter((f) => /^prev-\d+\.png$/.test(f)).sort();
const n = Math.max(ref.length, prev.length);
const rows = Array.from({ length: n }, (_, i) => `<tr><td class="n">${i + 1}</td>
<td>${ref[i] ? `<img src="${ref[i]}">` : '<div class="none">—</div>'}</td>
<td>${prev[i] ? `<img src="${prev[i]}">` : '<div class="none">—</div>'}</td></tr>`).join('\n');
fs.writeFileSync(path.join(out, 'compare.html'), `<!doctype html><meta charset="utf-8"><title>LaTeX vs preview</title>
<style>body{font:13px system-ui;background:#222;color:#ddd;margin:16px}table{border-collapse:collapse;width:100%}
table{table-layout:fixed}td{padding:4px;vertical-align:top;width:48%}td.n{width:2em;color:#888}img{width:100%;display:block;background:#fff}
th{text-align:left;padding:4px}.none{color:#888;padding:40px;text-align:center;border:1px dashed #555}
.warn{background:#5a3b14;padding:8px;margin-bottom:12px}</style>
${ref.length !== prev.length ? `<div class="warn">Page count differs: LaTeX ${ref.length}, preview ${prev.length}. The first differing row shows where overlays or frames diverge.</div>` : ''}
<table><tr><th></th><th>LaTeX (${ref.length} pages)</th><th>Preview (${prev.length} slides)</th></tr>
${rows}</table>`);
console.log(`\nLaTeX ${ref.length} pages, preview ${prev.length} slides${ref.length === prev.length ? ' ✓' : '  ← mismatch'}`);
console.log(`open ${pathToFileURL(path.join(out, 'compare.html')).href}`);

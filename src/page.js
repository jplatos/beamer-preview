'use strict';
// Builds the preview HTML page. `asset(rel)` maps a path relative to the extension root to a URL.

function buildPage({ asset, csp, data, nonce }) {
  const css = [
    'node_modules/katex/dist/katex.min.css',
    'node_modules/@fontsource/fira-sans/300.css',
    'node_modules/@fontsource/fira-sans/300-italic.css',
    'node_modules/@fontsource/fira-sans/400.css',
    'node_modules/@fontsource/fira-sans/400-italic.css',
    'node_modules/@fontsource/fira-mono/400.css',
    'media/metropolis.css',
    'media/shell.css',
  ];
  const cfg = {
    pdfjs: asset('node_modules/pdfjs-dist/build/pdf.min.mjs'),
    pdfjsWorker: asset('node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
    cMapUrl: asset('node_modules/pdfjs-dist/cmaps/'),
    standardFontDataUrl: asset('node_modules/pdfjs-dist/standard_fonts/'),
  };
  const n = nonce ? ` nonce="${nonce}"` : '';
  const dataScript = data
    ? `<script${n}>window.__BEAMER_DATA__ = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>` : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
${csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : ''}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beamer preview</title>
${css.map((c) => `<link rel="stylesheet" href="${asset(c)}">`).join('\n')}
</head><body>
<div id="toolbar">
  <label>Layout <select id="tb-cols"><option value="1">1 column</option><option value="2">2 columns</option><option value="3">3 columns</option><option value="4">4 columns</option></select></label>
  <label>Overlays <select id="tb-ov"><option value="last">final step</option><option value="first">first step</option><option value="all">every step</option></select></label>
  <button id="tb-present" title="Present (P / F5). Esc to leave.">▶ Present</button>
  <span class="sp"></span><span id="diag"></span><span id="count"></span>
</div>
<div id="deck"></div>
<script${n}>window.__BEAMER_CFG__ = ${JSON.stringify(cfg)};</script>
${dataScript}
<script${n} src="${asset('media/preview.js')}"></script>
</body></html>`;
}

module.exports = { buildPage };

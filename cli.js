#!/usr/bin/env node
'use strict';
// Static export: node cli.js <file.tex> [-o out.html] [--document]
// Renders the same HTML the VS Code preview shows, viewable in any browser.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Renderer } = require('./src/render');
const { buildPage } = require('./src/page');
const { findRoot, makeReader, imageKind } = require('./src/project');
const { SnippetCache } = require('./src/snippets');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('-') && a.endsWith('.tex'));
if (!file) { console.error('usage: node cli.js <file.tex> [-o out.html] [--document] [--snippets]'); process.exit(1); }
const oi = args.indexOf('-o');
const out = oi >= 0 ? args[oi + 1] : file.replace(/\.tex$/, '.preview.html');
const abs = path.resolve(file);
const readFile = makeReader(null);
const root = findRoot(abs, readFile) || abs;

let snippets = null;
if (args.includes('--snippets')) {
  snippets = new SnippetCache({ cacheDir: path.join(__dirname, '.cache'), engine: 'docker' });
}
const renderOnce = () => {
  const r = new Renderer({
    readFile,
    resolveImage: (p) => { const k = imageKind(p); return k ? { uri: pathToFileURL(p).href, kind: k } : null; },
    snippet: snippets ? (src, ctx) => snippets.lookup(src, ctx, (p) => pathToFileURL(p).href) : null,
  });
  return r.renderDocument(root, { focusFile: args.includes('--document') ? null : abs });
};

(async () => {
  const t0 = Date.now();
  let doc = renderOnce();
  if (snippets && snippets.pendingCount()) {
    console.log(`compiling ${snippets.pendingCount()} LaTeX snippet(s)…`);
    await snippets.flush();
    doc = renderOnce();
  }
  const ms = Date.now() - t0;
  const html = buildPage({
    asset: (rel) => pathToFileURL(path.join(__dirname, rel)).href,
    data: doc,
  });
  fs.writeFileSync(out, html);
  console.log(`root: ${root}\n${doc.frames.length} slides in ${ms} ms -> ${out}`);
  if (doc.diagnostics.length) {
    const counts = {};
    for (const d of doc.diagnostics) counts[d.msg] = (counts[d.msg] || 0) + 1;
    console.log('notes:', Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([m, c]) => `${c}× ${m}`).join('\n  '));
  }
})();

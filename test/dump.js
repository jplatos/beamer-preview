// Debug helper: print the generated HTML of frames whose title contains <pattern>.
// usage: node test/dump.js <file.tex> <pattern>
const path = require('path');
const { Renderer } = require('../src/render');
const { findRoot, makeReader, imageKind } = require('../src/project');
const [file, pat] = process.argv.slice(2);
const readFile = makeReader(null);
const abs = path.resolve(file);
const r = new Renderer({ readFile, resolveImage: (p) => { const k = imageKind(p); return k ? { uri: p, kind: k } : null; } });
const doc = r.renderDocument(findRoot(abs, readFile) || abs, { focusFile: abs });
for (const f of doc.frames) if (f.title.includes(pat)) { console.log('---', f.title, f.line, f.steps); console.log(f.html); }

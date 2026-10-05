'use strict';
// Finding the root document of a .tex file and reading files (editor buffers first).
const fs = require('fs');
const path = require('path');

const IMG_KIND = { '.pdf': 'pdf', '.png': 'img', '.jpg': 'img', '.jpeg': 'img', '.gif': 'img', '.svg': 'img', '.webp': 'img' };

function isRoot(src) { return /^[^%\n]*\\documentclass/m.test(src); }

/**
 * Find the root file for `file`.
 * 1. `%!TEX root = ...` magic comment
 * 2. the file itself if it has \documentclass
 * 3. walk up the directory tree; the first .tex with \documentclass that (transitively) includes the file
 */
function findRoot(file, readFile) {
  const src = readFile(file) || '';
  const magic = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im.exec(src);
  if (magic) return path.resolve(path.dirname(file), magic[1]);
  if (isRoot(src)) return file;
  let dir = path.dirname(file);
  for (let up = 0; up < 6; up++) {
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.tex')); } catch (e) { /* ignore */ }
    for (const e of entries) {
      const cand = path.join(dir, e);
      if (path.resolve(cand) === path.resolve(file)) continue;
      const s = readFile(cand);
      if (s && isRoot(s) && includes(cand, file, readFile, 0)) return cand;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function includes(texFile, target, readFile, depth) {
  if (depth > 4) return false;
  const src = readFile(texFile);
  if (!src) return false;
  const dir = path.dirname(texFile);
  const re = /\\(subimport|import|input|include|subfile|inputfrom|subinputfrom)\*?\s*(?:\{([^}]*)\}\s*)?\{([^}]*)\}/g;
  let m;
  const t = path.resolve(target).toLowerCase();
  while ((m = re.exec(src))) {
    const kind = m[1];
    let p;
    if (kind === 'subimport' || kind === 'import' || kind === 'inputfrom' || kind === 'subinputfrom') {
      if (m[2] === undefined) continue;
      p = path.resolve(dir, m[2], m[3]);
    } else p = path.resolve(dir, m[3] || m[2] || '');
    const cands = [p, p + '.tex'];
    for (const c of cands) {
      if (path.resolve(c).toLowerCase() === t) return true;
    }
    if (fs.existsSync(p + '.tex') && includes(p + '.tex', target, readFile, depth + 1)) return true;
    if (fs.existsSync(p) && p.endsWith('.tex') && includes(p, target, readFile, depth + 1)) return true;
  }
  return false;
}

/** Plain file reader with an optional override map (open editor buffers). */
function makeReader(overrides) {
  return (f) => {
    const key = path.resolve(f).toLowerCase();
    if (overrides && overrides.has(key)) return overrides.get(key);
    try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
  };
}

function imageKind(abs) {
  const k = IMG_KIND[path.extname(abs).toLowerCase()];
  if (!k) return null;
  try { if (fs.statSync(abs).isFile()) return k; } catch (e) { /* missing */ }
  return null;
}

module.exports = { findRoot, makeReader, imageKind, isRoot };

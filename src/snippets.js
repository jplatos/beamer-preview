'use strict';
// Optional: render rare raw environments (tikzpicture, algorithm) with real LaTeX,
// once, in the background, cached by content hash. Everything else stays compile-free.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SKIP_PACKAGES = new Set(['appendixnumberbeamer', 'animate', 'todonotes', 'fontspec', 'beamerthememetropolis',
  'pgfpages', 'hyperref', 'import', 'inputenc', 'fontenc', 'graphbox', 'changepage', 'verbatim', 'listings', 'ccicons', 'babel']);

class SnippetCache {
  /**
   * @param {{cacheDir:string, engine:'docker'|'local'|'off', image?:string, onReady?:(key,uri|null,err?)=>void}} o
   */
  constructor(o) {
    this.o = Object.assign({ image: 'texlive/texlive:latest' }, o);
    this.pending = new Map(); // key -> {tex, srcDir, toUri}
    this.failed = new Map();
    this.running = null;
    fs.mkdirSync(this.o.cacheDir, { recursive: true });
  }

  pendingCount() { return this.pending.size; }

  preamble(r, env) {
    const pk = r.packages.filter((p) => !SKIP_PACKAGES.has(p.name.trim()))
      .map((p) => p.name.split(',').map((n) => n.trim()).filter((n) => !SKIP_PACKAGES.has(n))
        .map((n) => `\\usepackage${p.opt ? `[${p.opt}]` : ''}{${n}}`).join('\n'));
    return [
      // tikz pictures crop to their bounding box; text-like snippets need a line width
      /^algorithm/.test(env) ? '\\documentclass[11pt,border=2pt,varwidth=12.5cm]{standalone}' : '\\documentclass[11pt,border=1pt]{standalone}',
      '\\usepackage[dvipsnames,svgnames,table]{xcolor}',
      '\\usepackage[sfdefault,light]{FiraSans}',
      '\\renewcommand*\\familydefault{\\sfdefault}',
      '\\usepackage{graphicx,amsmath,amssymb}',
      ...pk,
      '\\definecolor{mDarkTeal}{HTML}{23373b}\\definecolor{mLightBrown}{HTML}{EB811B}\\definecolor{mLightGreen}{HTML}{14B03D}\\definecolor{mDarkBrown}{HTML}{604c38}',
      `\\definecolor{fg}{HTML}{${(r.cssVars['--fg'] || '#23373b').slice(1)}}\\definecolor{bg}{HTML}{${(r.cssVars['--bg'] || '#fafafa').slice(1)}}`,
      `\\definecolor{alerted text.fg}{HTML}{${(r.cssVars['--alert'] || '#EB811B').slice(1)}}`,
      '\\providecommand{\\alert}[1]{\\textcolor{alerted text.fg}{#1}}\\providecommand{\\only}{}\\providecommand{\\uncover}{}\\providecommand{\\pause}{}',
      ...r.preambleLines,
      ...(r.defLines || []),
      '\\color{fg}',
    ].join('\n');
  }

  lookup(src, ctx, toUri) {
    if (this.o.engine === 'off' || this.engineDown) return null;
    const r = ctx.preamble;
    let body = src;
    if (ctx.env === 'algorithm' || ctx.env === 'algorithm2e') body = body.replace(/\\begin\{(algorithm2?e?)\}(\[[^\]]*\])?/, '\\begin{$1}[H]');
    const tex = `${this.preamble(r, ctx.env)}\n\\begin{document}\n\\color{fg}${body}\n\\end{document}\n`;
    const key = crypto.createHash('sha1').update(tex).digest('hex').slice(0, 16);
    const pdf = path.join(this.o.cacheDir, key + '.pdf');
    if (fs.existsSync(pdf)) return { key, uri: toUri(pdf) };
    if (this.failed.has(key) || fs.existsSync(path.join(this.o.cacheDir, key + '.failed'))) return null;
    this.pending.set(key, { tex, srcDir: r.rootDir, toUri });
    return { key, uri: null };
  }

  /** Compile all pending snippets in one container run. */
  flush() {
    if (this.running) return this.running.then(() => (this.pending.size ? this.flush() : undefined));
    if (!this.pending.size) return Promise.resolve();
    const jobs = new Map(this.pending);
    this.pending.clear();
    const job = path.join(this.o.cacheDir, 'job-' + Date.now());
    fs.mkdirSync(job, { recursive: true });
    for (const [key, j] of jobs) fs.writeFileSync(path.join(job, key + '.tex'), j.tex);
    const srcDir = [...jobs.values()][0].srcDir;
    // parallel compile; each snippet is independent
    const script = `ls *.tex | xargs -P 8 -I{} sh -c 'pdflatex -interaction=nonstopmode -halt-on-error "{}" >/dev/null 2>&1 || echo "FAIL {}"'`;
    let cmd, args;
    if (this.o.engine === 'local') {
      cmd = process.platform === 'win32' ? 'cmd' : 'sh';
      args = process.platform === 'win32'
        ? ['/c', `for %f in (*.tex) do pdflatex -interaction=nonstopmode -halt-on-error %f`]
        : ['-c', script];
    } else {
      cmd = 'docker';
      args = ['run', '--rm', '-v', `${job}:/w`, '-v', `${srcDir}:/src:ro`, '-w', '/w', '-e', 'TEXINPUTS=.::/src//', this.o.image, 'sh', '-c', script];
    }
    this.running = new Promise((resolve) => {
      let p;
      try {
        p = spawn(cmd, args, { cwd: job, env: Object.assign({}, process.env, { TEXINPUTS: `.${path.delimiter}${srcDir}//${path.delimiter}` }) });
      } catch (e) { p = null; }
      if (!p) return resolve();
      p.on('error', () => resolve());
      p.on('close', () => resolve());
    }).then(() => {
      for (const [key, j] of jobs) {
        const out = path.join(job, key + '.pdf');
        const dst = path.join(this.o.cacheDir, key + '.pdf');
        if (fs.existsSync(out)) {
          fs.copyFileSync(out, dst);
          this.o.onReady && this.o.onReady(key, j.toUri(dst));
        } else if (!fs.existsSync(path.join(job, key + '.log'))) {
          // LaTeX never ran (docker/pdflatex missing): fall back to placeholders, do not cache a failure
          this.engineDown = true;
          this.o.onReady && this.o.onReady(key, null, `${cmd} not available`);
        } else {
          const err = (fs.readFileSync(path.join(job, key + '.log'), 'utf8').match(/^! .*$/m) || ['LaTeX error'])[0];
          this.failed.set(key, err);
          try { fs.writeFileSync(path.join(this.o.cacheDir, key + '.failed'), err); } catch (e) { /* ignore */ }
          this.o.onReady && this.o.onReady(key, null, err);
        }
      }
      try { fs.rmSync(job, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      this.running = null;
    });
    return this.running;
  }
}

module.exports = { SnippetCache };

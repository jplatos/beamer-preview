'use strict';
// Optional: render rare raw environments (tikzpicture, algorithm) with real LaTeX,
// once, in the background, cached by content hash. Everything else stays compile-free.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SKIP_PACKAGES = new Set(['appendixnumberbeamer', 'animate', 'todonotes', 'fontspec', 'beamerthememetropolis',
  'pgfpages', 'hyperref', 'import', 'inputenc', 'fontenc', 'graphbox', 'changepage', 'verbatim', 'listings', 'ccicons', 'babel']);

const RETRY_MS = 30000;
const LOCAL_PARALLEL = 4;

/** Run a command; resolves {code, out, err, spawnError}. Never rejects. */
function run(cmd, args, opts = {}, onLine) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try { p = spawn(cmd, args, Object.assign({ windowsHide: true }, opts)); } catch (e) { return resolve({ code: -1, out, err, spawnError: e }); }
    const feed = (chunk, isErr) => {
      const s = chunk.toString();
      if (isErr) err += s; else out += s;
      if (onLine) s.split(/\r?\n/).filter(Boolean).forEach(onLine);
    };
    p.stdout && p.stdout.on('data', (c) => feed(c, false));
    p.stderr && p.stderr.on('data', (c) => feed(c, true));
    p.on('error', (e) => resolve({ code: -1, out, err, spawnError: e }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/** First LaTeX error from a log, with its "l.<n>" context line. */
function latexError(log) {
  const m = /^! (.*)$/m.exec(log);
  if (!m) return 'LaTeX error (no message in log)';
  const ctx = /^l\.\d+ (.*)$/m.exec(log.slice(m.index));
  return m[1] + (ctx ? `  [at: ${ctx[1].trim().slice(0, 80)}]` : '');
}

class SnippetCache {
  /**
   * @param {object} o
   * @param {string} o.cacheDir
   * @param {'docker'|'local'|'off'} o.engine
   * @param {string} [o.image]      docker image
   * @param {string} [o.latex]      latex binary for the local engine (default pdflatex)
   * @param {(key:string, uri:string|null, err?:string)=>void} [o.onReady]  uri comes from lookup's toUri (not a file path)
   * @param {(msg:string)=>void} [o.log]
   * @param {(state:'pulling'|'compiling'|'idle'|'down', msg?:string)=>void} [o.onStatus]
   */
  constructor(o) {
    this.o = Object.assign({ image: 'texlive/texlive:latest', latex: 'pdflatex' }, o);
    this.pending = new Map(); // key -> {tex, srcDir, needsSrc, toUri}
    this.failed = new Map();
    this.running = null;
    this.down = null; // {reason, until}
    this.imageChecked = false;
    fs.mkdirSync(this.o.cacheDir, { recursive: true });
  }

  log(msg) { if (this.o.log) this.o.log(msg); }
  status(state, msg) { if (this.o.onStatus) this.o.onStatus(state, msg); }
  pendingCount() { return this.pending.size; }

  preamble(r, env) {
    const pk = r.packages.filter((p) => !SKIP_PACKAGES.has(p.name.trim()))
      .map((p) => p.name.split(',').map((n) => n.trim()).filter((n) => !SKIP_PACKAGES.has(n))
        .map((n) => `\\usepackage${p.opt ? `[${p.opt}]` : ''}{${n}}`).join('\n'));
    return [
      // tikz pictures crop to their bounding box; text-like snippets need a line width
      /^algorithm/.test(env) ? '\\documentclass[11pt,border=2pt,varwidth=12.5cm]{standalone}' : '\\documentclass[11pt,border=1pt]{standalone}',
      '\\usepackage[dvipsnames,svgnames,table]{xcolor}',
      // metropolis uses Fira Sans; minimal TeX installations may not have it
      '\\IfFileExists{FiraSans.sty}{\\usepackage[sfdefault,light]{FiraSans}}{\\renewcommand*\\familydefault{\\sfdefault}}',
      '\\usepackage{graphicx,amsmath,amssymb,ifthen}',
      ...pk,
      // metropolis loads its pgfplots theme (mlineplot, mbarplot, …) whenever pgfplots is used
      ...(r.packages.some((p) => /\bpgfplots\b/.test(p.name)) ? ['\\IfFileExists{pgfplotsthemetol.sty}{\\usepackage{pgfplotsthemetol}}{}'] : []),
      '\\definecolor{mDarkTeal}{HTML}{23373b}\\definecolor{mLightBrown}{HTML}{EB811B}\\definecolor{mLightGreen}{HTML}{14B03D}\\definecolor{mDarkBrown}{HTML}{604c38}',
      `\\definecolor{fg}{HTML}{${(r.cssVars['--fg'] || '#23373b').slice(1)}}\\definecolor{bg}{HTML}{${(r.cssVars['--bg'] || '#fafafa').slice(1)}}`,
      `\\definecolor{alerted text.fg}{HTML}{${(r.cssVars['--alert'] || '#EB811B').slice(1)}}`,
      '\\providecommand{\\alert}[1]{\\textcolor{alerted text.fg}{#1}}\\providecommand{\\pause}{}',
      ...r.preambleLines,
      ...(r.defLines || []),
    ].join('\n');
  }

  isDown() {
    if (!this.down) return false;
    if (Date.now() > this.down.until) { this.down = null; this.imageChecked = false; return false; }
    return true;
  }

  setDown(reason) {
    if (!this.down) this.log(`snippet engine unavailable: ${reason} (retrying in ${RETRY_MS / 1000}s)`);
    this.down = { reason, until: Date.now() + RETRY_MS };
    this.status('down', reason);
  }

  lookup(src, ctx, toUri) {
    if (this.o.engine === 'off' || this.isDown()) return null;
    const r = ctx.preamble;
    let body = src;
    if (ctx.env === 'algorithm' || ctx.env === 'algorithm2e') body = body.replace(/\\begin\{(algorithm2?e?)\}(\[[^\]]*\])?/, '\\begin{$1}[H]');
    const tex = `${this.preamble(r, ctx.env)}\n\\begin{document}\n\\color{fg}${body}\n\\end{document}\n`;
    const key = crypto.createHash('sha1').update(tex).digest('hex').slice(0, 16);
    const pdf = path.join(this.o.cacheDir, key + '.pdf');
    if (fs.existsSync(pdf)) return { key, uri: toUri(pdf) };
    if (this.failed.has(key) || fs.existsSync(path.join(this.o.cacheDir, key + '.failed'))) return null;
    // does the snippet read files from the project (images, \input, pgfplots tables)?
    const needsSrc = /\\(includegraphics|input|include|lstinputlisting|pgfplotstableread)\b|\btable\s*(\[[^\]]*\])?\s*\{[^}]*\.\w+\s*\}|\bfile\s*\{/.test(body);
    this.pending.set(key, { tex, srcDir: ctx.dir || r.rootDir, rootDir: r.rootDir || ctx.dir, needsSrc, toUri });
    return { key, uri: null };
  }

  /** Docker: make sure the daemon answers and the image exists (pull it once if not). */
  async ensureDocker() {
    if (this.imageChecked) return true;
    const insp = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', this.o.image]);
    if (insp.spawnError) { this.setDown('Docker not found on PATH (install Docker or set beamerPreview.snippets.engine to "local"/"off")'); return false; }
    if (insp.code !== 0) {
      if (/cannot connect|error during connect|is the docker daemon running|pipe/i.test(insp.err)) {
        this.setDown('Docker is installed but not running — start Docker Desktop / the docker service');
        return false;
      }
      this.log(`pulling ${this.o.image} (first use, several GB — this can take a while)…`);
      this.status('pulling', this.o.image);
      let last = 0;
      const pull = await run('docker', ['pull', this.o.image], {}, (line) => {
        if (Date.now() - last > 3000) { last = Date.now(); this.log('  ' + line.trim()); }
      });
      if (pull.code !== 0) { this.setDown(`docker pull ${this.o.image} failed: ${(pull.err || pull.out).trim().split('\n').pop()}`); return false; }
      this.log(`pulled ${this.o.image}`);
    }
    this.imageChecked = true;
    return true;
  }

  async compileDocker(job, jobs) {
    const srcJob = [...jobs.values()].find((j) => j.needsSrc);
    const script = 'ls *.tex | xargs -P 8 -I{} sh -c \'pdflatex -interaction=nonstopmode -halt-on-error "{}" >/dev/null 2>&1 || echo "FAIL {}"\'';
    const args = ['run', '--rm'];
    if (typeof process.getuid === 'function') args.push('--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp');
    args.push('-v', `${job}:/w`);
    if (srcJob) {
      // mount the document root; \input/\includegraphics resolve relative to the root and to the snippet's folder
      // (non-recursive: recursive kpathsea search over a bind mount is very slow on Windows/macOS)
      const root = srcJob.rootDir;
      const rels = [...new Set([...jobs.values()].filter((j) => j.needsSrc).map((j) => path.relative(root, j.srcDir)))]
        .filter((r) => r && !r.startsWith('..')).map((r) => '/src/' + r.split(path.sep).join('/') + '/');
      args.push('-v', `${root}:/src:ro`, '-e', `TEXINPUTS=.::/src/:${rels.join(':')}`);
    }
    args.push('-w', '/w', this.o.image, 'sh', '-c', script);
    this.log(`docker ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    const res = await run('docker', args);
    if (res.code !== 0 && res.err.trim()) this.log('docker: ' + res.err.trim().split('\n').slice(-3).join(' | '));
    if (res.spawnError) this.setDown('Docker not found on PATH');
    else if (/invalid mount|mounts denied|not shared|drive.*not shared|file sharing/i.test(res.err)) {
      this.setDown(`Docker cannot mount the folder (${res.err.trim().split('\n').pop()}). Enable file sharing for it in Docker Desktop.`);
    }
  }

  async compileLocal(job, jobs) {
    const files = [...jobs.keys()];
    const dirs = [...new Set([...jobs.values()].flatMap((j) => [j.rootDir, j.srcDir]))];
    const env = Object.assign({}, process.env, {
      // trailing empty entry = the TeX distribution's default path
      TEXINPUTS: ['.', ...dirs, ''].join(path.delimiter),
    });
    let i = 0;
    const worker = async () => {
      while (i < files.length) {
        const key = files[i++];
        const res = await run(this.o.latex, ['-interaction=nonstopmode', '-halt-on-error', key + '.tex'], { cwd: job, env });
        if (res.spawnError) { this.setDown(`"${this.o.latex}" not found on PATH`); return; }
      }
    };
    await Promise.all(Array.from({ length: LOCAL_PARALLEL }, worker));
  }

  /** Compile all pending snippets (one container run for docker). */
  flush() {
    if (this.running) return this.running.then(() => (this.pending.size ? this.flush() : undefined));
    if (!this.pending.size) return Promise.resolve();
    const jobs = new Map(this.pending);
    this.pending.clear();
    const job = path.join(this.o.cacheDir, 'job-' + Date.now());
    this.running = (async () => {
      fs.mkdirSync(job, { recursive: true });
      for (const [key, j] of jobs) fs.writeFileSync(path.join(job, key + '.tex'), j.tex);
      const t0 = Date.now();
      if (this.o.engine === 'docker') {
        if (await this.ensureDocker()) { this.status('compiling', `${jobs.size} snippet(s)`); await this.compileDocker(job, jobs); }
      } else {
        this.status('compiling', `${jobs.size} snippet(s)`);
        await this.compileLocal(job, jobs);
      }
      let ok = 0, bad = 0;
      for (const [key, j] of jobs) {
        const out = path.join(job, key + '.pdf');
        const logFile = path.join(job, key + '.log');
        const dst = path.join(this.o.cacheDir, key + '.pdf');
        if (fs.existsSync(out)) {
          fs.copyFileSync(out, dst);
          ok++;
          this.o.onReady && this.o.onReady(key, j.toUri(dst));
        } else if (!fs.existsSync(logFile)) {
          // LaTeX never ran: placeholders now, retry later; do not cache a failure
          if (!this.down) this.setDown('LaTeX did not run (see log above)');
          this.o.onReady && this.o.onReady(key, null, this.down.reason);
        } else {
          const err = latexError(fs.readFileSync(logFile, 'utf8'));
          bad++;
          this.log(`snippet ${key} failed: ${err}`);
          this.failed.set(key, err);
          try {
            fs.writeFileSync(path.join(this.o.cacheDir, key + '.failed'), err);
            fs.copyFileSync(path.join(job, key + '.tex'), path.join(this.o.cacheDir, key + '.failed.tex'));
            fs.copyFileSync(logFile, path.join(this.o.cacheDir, key + '.failed.log'));
          } catch (e) { /* ignore */ }
          this.o.onReady && this.o.onReady(key, null, err);
        }
      }
      if (ok || bad) this.log(`compiled ${ok} snippet(s), ${bad} failed, in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      this.status(this.down ? 'down' : 'idle', this.down ? this.down.reason : undefined);
      try { fs.rmSync(job, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    })().catch((e) => { this.log('snippet engine error: ' + (e && e.stack || e)); }).finally(() => { this.running = null; });
    return this.running;
  }

  /** Compile a tiny test document and report what happened (for the "check engine" command). */
  async selfTest(r) {
    const saved = { down: this.down, checked: this.imageChecked };
    this.down = null; this.imageChecked = false;
    const fake = { packages: [], preambleLines: ['\\usepackage{tikz}'], defLines: [], cssVars: {}, rootDir: this.o.cacheDir };
    const src = `\\begin{tikzpicture}\\draw[thick,blue] (0,0) circle (0.4) node {ok ${Date.now()}};\\end{tikzpicture}`;
    const res = this.lookup(src, { preamble: r || fake, env: 'tikzpicture', dir: this.o.cacheDir }, (p) => p);
    if (!res) return { ok: false, msg: this.down ? this.down.reason : 'lookup refused' };
    await this.flush();
    const pdf = path.join(this.o.cacheDir, res.key + '.pdf');
    if (fs.existsSync(pdf)) { try { fs.unlinkSync(pdf); } catch (e) { /* ignore */ } return { ok: true, msg: `${this.o.engine} engine works` }; }
    const failed = this.failed.get(res.key);
    if (!this.down && !failed) Object.assign(this, { down: saved.down, imageChecked: saved.checked });
    return { ok: false, msg: this.down ? this.down.reason : failed || 'unknown failure' };
  }
}

module.exports = { SnippetCache, latexError };

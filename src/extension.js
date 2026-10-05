'use strict';
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { Renderer } = require('./render');
const { buildPage } = require('./page');
const { findRoot, makeReader, imageKind } = require('./project');
const { SnippetCache } = require('./snippets');

const norm = (f) => (process.platform === 'win32' ? path.resolve(f).toLowerCase() : path.resolve(f));
const isTex = (doc) => doc && (doc.languageId === 'latex' || doc.languageId === 'tex' || /\.tex$/i.test(doc.fileName));

class Preview {
  constructor(context) {
    this.context = context;
    this.panel = null;
    this.focusFile = null;
    this.rootFile = null;
    this.ready = false;
    this.timer = null;
    this.lastCursor = null;
    this.snippets = null;
  }

  config() { return vscode.workspace.getConfiguration('beamerPreview'); }

  out() {
    if (!this.channel) this.channel = vscode.window.createOutputChannel('Beamer Preview');
    return this.channel;
  }

  ensureSnippets() {
    const engine = this.config().get('snippets.engine', 'docker');
    const image = this.config().get('snippets.dockerImage', 'texlive/texlive:latest');
    if (!this.snippets || this.snippets.o.engine !== engine || this.snippets.o.image !== image) {
      this.snippets = new SnippetCache({
        cacheDir: path.join(this.context.globalStorageUri.fsPath, 'snippets'),
        engine, image,
        onReady: (key, uri, err) => {
          if (this.panel) this.panel.webview.postMessage({ type: 'snippet', key, uri: uri && this.webUri(uri), error: err });
        },
      });
    }
    return this.snippets;
  }

  webUri(fsPath) { return this.panel.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString(); }

  open(editor) {
    const doc = editor ? editor.document : null;
    if (!isTex(doc)) { vscode.window.showInformationMessage('Open a .tex file to preview its beamer slides.'); return; }
    this.focusFile = doc.fileName;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('beamerPreview', 'Beamer Preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.resourceRoots(),
      });
      this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
      this.panel.onDidDispose(() => { this.panel = null; this.ready = false; });
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
      this.panel.webview.html = this.html();
    } else {
      this.panel.reveal(undefined, true);
    }
    this.schedule(0);
  }

  resourceRoots() {
    const roots = [this.context.extensionUri, this.context.globalStorageUri];
    for (const f of vscode.workspace.workspaceFolders || []) roots.push(f.uri);
    if (this.focusFile) {
      // the document tree (images live next to the sources); go up to the drive/workspace root conservatively
      let d = path.dirname(this.focusFile);
      for (let i = 0; i < 4 && path.dirname(d) !== d; i++) d = path.dirname(d);
      roots.push(vscode.Uri.file(d));
    }
    return roots;
  }

  html() {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const src = w.cspSource;
    const csp = [
      "default-src 'none'",
      `img-src ${src} data: blob:`,
      `style-src ${src} 'unsafe-inline'`,
      `font-src ${src} data:`,
      `script-src 'nonce-${nonce}' ${src}`,
      `connect-src ${src}`,
      'worker-src blob:',
    ].join('; ');
    return buildPage({
      asset: (rel) => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...rel.split('/'))).toString(),
      csp, nonce,
    });
  }

  onMessage(m) {
    if (m.type === 'ready') { this.ready = true; this.schedule(0); return; }
    if (m.type === 'log') { this.out().appendLine(m.msg); return; }
    if (m.type === 'stats') { this.lastStats = m; this.out().appendLine('stats ' + JSON.stringify(m)); return; }
    if (m.type === 'reveal' && m.file) {
      const uri = vscode.Uri.file(m.file);
      const line = Math.max(0, m.line || 0);
      const existing = vscode.window.visibleTextEditors.find((e) => norm(e.document.fileName) === norm(m.file));
      const show = existing
        ? vscode.window.showTextDocument(existing.document, { viewColumn: existing.viewColumn, preserveFocus: false })
        : vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One });
      Promise.resolve(show).then((ed) => {
        const pos = new vscode.Position(line, 0);
        this.suppressCursor = Date.now();
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      });
    }
  }

  /** a .tex document changed / became active */
  onDocument(doc, becameActive) {
    if (!this.panel || !isTex(doc)) return;
    if (becameActive && this.config().get('followActiveEditor', true) && norm(doc.fileName) !== norm(this.focusFile || '')) {
      this.focusFile = doc.fileName;
      this.schedule(0);
      return;
    }
    // re-render when any file of the current project changes (cheap: whole render is ~100 ms)
    this.schedule(this.config().get('debounceMs', 250));
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), ms);
  }

  render() {
    if (!this.panel || !this.ready || !this.focusFile) return;
    const overrides = new Map();
    for (const d of vscode.workspace.textDocuments) if (isTex(d)) overrides.set(norm(d.fileName), d.getText());
    const readFile = makeReader(overrides);
    const root = findRoot(this.focusFile, readFile) || this.focusFile;
    this.rootFile = root;
    const scope = this.config().get('scope', 'file');
    const snippetsOff = this.config().get('snippets.engine', 'docker') === 'off' || process.env.BEAMER_PREVIEW_NO_SNIPPETS;
    const snippets = snippetsOff ? null : this.ensureSnippets();
    const r = new Renderer({
      readFile,
      resolveImage: (p) => { const k = imageKind(p); return k ? { uri: this.webUri(p), kind: k } : null; },
      snippet: snippets ? (src, ctx) => snippets.lookup(src, ctx, (p) => this.webUri(p)) : null,
    });
    let doc;
    try {
      doc = r.renderDocument(root, { focusFile: scope === 'document' ? null : this.focusFile });
    } catch (e) {
      vscode.window.setStatusBarMessage(`Beamer preview: ${e.message}`, 5000);
      return;
    }
    for (const f of doc.frames) f.file = f.file ? norm(f.file) : '';
    this.panel.title = `Preview: ${path.basename(path.dirname(this.focusFile))}/${path.basename(this.focusFile)}`;
    const ed = vscode.window.activeTextEditor;
    const cursor = ed && isTex(ed.document) ? { file: norm(ed.document.fileName), line: ed.selection.active.line } : null;
    this.panel.webview.postMessage({ type: 'update', frames: doc.frames, cssVars: doc.cssVars, diagnostics: doc.diagnostics, cursor });
    if (snippets && snippets.pendingCount()) snippets.flush();
  }

  onCursor(e) {
    if (!this.panel || !isTex(e.textEditor.document)) return;
    if (this.suppressCursor && Date.now() - this.suppressCursor < 400) return;
    if (!this.config().get('syncCursor', true)) return;
    const file = norm(e.textEditor.document.fileName);
    const line = e.selections[0].active.line;
    const key = file + ':' + line;
    if (key === this.lastCursor) return;
    this.lastCursor = key;
    clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => this.panel && this.panel.webview.postMessage({ type: 'cursor', file, line }), 60);
  }
}

function activate(context) {
  const preview = new Preview(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('beamerPreview.open', () => preview.open(vscode.window.activeTextEditor)),
    vscode.commands.registerCommand('beamerPreview._stats', () => preview.lastStats || null),
    vscode.commands.registerCommand('beamerPreview.clearSnippetCache', async () => {
      const dir = vscode.Uri.joinPath(context.globalStorageUri, 'snippets');
      try { await vscode.workspace.fs.delete(dir, { recursive: true }); } catch (e) { /* none */ }
      preview.snippets = null;
      preview.schedule(0);
      vscode.window.showInformationMessage('Beamer preview: LaTeX snippet cache cleared.');
    }),
    vscode.workspace.onDidChangeTextDocument((e) => preview.onDocument(e.document, false)),
    vscode.workspace.onDidSaveTextDocument((d) => preview.onDocument(d, false)),
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && preview.onDocument(ed.document, true)),
    vscode.window.onDidChangeTextEditorSelection((e) => preview.onCursor(e)),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('beamerPreview')) preview.schedule(0); }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };

// Runs inside a real VS Code (see test/runTest.js): opens the demo, the preview, moves the cursor, edits.
const vscode = require('vscode');
const path = require('path');
const assert = require('assert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = () => vscode.commands.executeCommand('beamerPreview._stats');

exports.run = async () => {
  const file = path.resolve(__dirname, '../../examples/demo/sections/basics.tex');
  const doc = await vscode.workspace.openTextDocument(file);
  const ed = await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('beamerPreview.open');

  let s = null;
  for (let i = 0; i < 60 && !s; i++) { await sleep(500); s = await stats(); }
  console.log('STATS1', JSON.stringify(s));
  assert.ok(s, 'webview reported stats');
  assert.ok(s.cards >= 7, 'lecture-mode cards rendered');
  assert.strictEqual(s.missing, 0, 'no missing images');
  assert.ok(s.pdfOk >= 1, 'PDF figure rendered by pdf.js inside the webview');
  assert.ok(s.fonts.some((f) => f.startsWith('Fira Sans')), 'Fira Sans loaded');

  // cursor sync: move into the "Blocks" frame (last frame of basics.tex)
  const line = doc.getText().split('\n').findIndex((l) => l.includes('{Blocks}'));
  ed.selection = new vscode.Selection(line + 2, 0, line + 2, 0);
  // live edit without saving
  await ed.edit((eb) => eb.insert(new vscode.Position(0, 0), '% live edit\n'));
  await sleep(4000);
  const s2 = await stats();
  console.log('STATS2', JSON.stringify(s2));
  assert.strictEqual(+s2.cur, s2.cards - 2, 'cursor frame highlighted (last lecture frame before closing slide)');
  await vscode.commands.executeCommand('workbench.action.files.revert');
};

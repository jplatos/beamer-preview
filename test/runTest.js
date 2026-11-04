// Downloads VS Code (cached in .vscode-test/) and runs test/suite inside it with this extension loaded.
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

(async () => {
  try {
    await runTests({
      // test the newest stable by default, or a given one with VSCODE_VERSION=1.140.0
      version: process.env.VSCODE_VERSION || 'stable',
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite/index.js'),
      launchArgs: [
        path.resolve(__dirname, '../examples/demo'),
        '--disable-extensions',
        // keep the user data (and so the snippet cache in globalStorage) OUTSIDE the project tree, as in real use:
        // inside it, the document-tree resource root hid the 401 bug of 0.2.1
        '--user-data-dir', path.join(os.tmpdir(), 'beamer-preview-vscode-test'),
      ],
    });
  } catch (e) {
    console.error('VS Code tests failed', e);
    process.exit(1);
  }
})();

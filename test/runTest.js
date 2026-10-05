// Downloads VS Code (cached in .vscode-test/) and runs test/suite inside it with this extension loaded.
const path = require('path');
const { runTests } = require('@vscode/test-electron');

(async () => {
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite/index.js'),
      launchArgs: [
        path.resolve(__dirname, '../examples/demo'),
        '--disable-extensions',
        '--user-data-dir', path.resolve(__dirname, '../.vscode-test/user-data'),
      ],
    });
  } catch (e) {
    console.error('VS Code tests failed', e);
    process.exit(1);
  }
})();

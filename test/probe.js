// Debug helper: evaluate a JS snippet inside an exported preview page (headless Chrome).
// usage: node test/probe.js page.html "return document.querySelectorAll('.card').length"
const puppeteer = require('puppeteer-core');
const path = require('path');
const { pathToFileURL } = require('url');
(async () => {
  const [file, expr] = process.argv.slice(2);
  const { chromePath } = require('./browser');
  const browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('console:', m.text()));
  await page.setViewport({ width: 1238, height: 900 });
  await page.goto(pathToFileURL(path.resolve(file)).href, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(new Function('return (async () => {' + expr + '})()'));
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})();

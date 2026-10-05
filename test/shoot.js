// Screenshot every slide of an exported preview page.
// usage: node test/shoot.js page.html outDir [last|first|all]
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromePath } = require('./browser');

(async () => {
  const [pageFile, outDir, overlays = 'last'] = process.argv.slice(2);
  if (!pageFile || !outDir) { console.error('usage: node test/shoot.js page.html outDir [last|first|all]'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  // one slide per row at zoom 2
  await page.setViewport({ width: 1238, height: 900, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.resolve(pageFile)).href, { waitUntil: 'networkidle0' });
  if (overlays !== 'last') await page.select('#tb-ov', overlays);
  await page.evaluate(() => document.fonts.ready);
  const cards = await page.$$('.card .scaler');
  for (let i = 0; i < cards.length; i++) {
    await cards[i].scrollIntoView();
    await new Promise((r) => setTimeout(r, 150));
    await cards[i].screenshot({ path: path.join(outDir, `s${String(i).padStart(3, '0')}.png`) });
  }
  console.log(`${cards.length} screenshots -> ${outDir}`);
  if (logs.length) console.log(logs.slice(0, 20).join('\n'));
  await browser.close();
})();

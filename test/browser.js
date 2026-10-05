// Locate a local Chrome/Edge for puppeteer-core (override with CHROME_PATH).
const fs = require('fs');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function chromePath() {
  const p = CANDIDATES.find((c) => c && fs.existsSync(c));
  if (!p) throw new Error('No Chrome/Edge found; set CHROME_PATH');
  return p;
}

module.exports = { chromePath };

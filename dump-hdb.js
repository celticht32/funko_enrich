// dump-hdb.js — one-off: dump rendered HobbyDB page for a known blank record.
// Uses the SAME stack as enrich.js Pass 4 (puppeteer-extra + stealth).
// Usage:  node dump-hdb.js stitch-as-baker
// Output: hdb-dump.html  +  printed DOM hints showing where series/category live.
'use strict';
const fs = require('fs');
const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return undefined; // fall back to bundled chromium
}

(async () => {
  const handle = process.argv[2] || 'stitch-as-baker';
  const url = `https://www.hobbydb.com/marketplaces/hobbydb/catalog_items/${handle}`;
  const exe = findChrome();
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--window-size=1280,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  console.log('GET', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 3000)); // let Angular settle

  const html = await page.content();
  fs.writeFileSync('hdb-dump.html', html, 'utf8');
  console.log('Wrote hdb-dump.html (' + html.length + ' bytes)');

  const hints = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[class*="breadcrumb"] a, nav a').forEach(a => {
      const t = a.innerText.trim(); if (t) out.push('BREADCRUMB: ' + t + '  <<' + a.className + '>>');
    });
    document.querySelectorAll('a[href*="subcategor"], a[href*="categor"], a[href*="series"]').forEach(a => {
      const t = a.innerText.trim(); if (t) out.push('CATLINK: ' + t + '  href=' + a.getAttribute('href'));
    });
    document.querySelectorAll('strong').forEach(s => {
      const t = s.innerText.trim();
      if (/series|subcategor|brand|category|license|character/i.test(t)) {
        const sib = s.parentElement ? s.parentElement.innerText.trim().slice(0,160) : '';
        out.push('LABEL: [' + t + '] parent="' + sib.replace(/\s+/g,' ') + '"');
      }
    });
    // JSON-LD blocks often carry breadcrumb / category data
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s,i) => {
      out.push('LDJSON[' + i + ']: ' + s.textContent.replace(/\s+/g,' ').slice(0,300));
    });
    return out;
  });
  console.log('\n──── DOM HINTS ────');
  console.log(hints.join('\n') || '(no hints matched — inspect hdb-dump.html directly)');

  await browser.close();
})();

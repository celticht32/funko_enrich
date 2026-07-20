/**
 * pc_console_probe.js  —  standalone diagnostic (throwaway)
 *
 * Loads ONE PriceCharting console page in a real (Puppeteer) browser, exactly
 * the way Pass 3b does, scrolls it to the bottom, and reports:
 *   - the stated target ("Prices for all N Funko ... Figures")
 *   - how many <tr> rows exist vs how many carry a /game/ product link
 *   - whether a specific figure (default: "Stitch 626") is in the loaded DOM
 *   - whether a "Download Price List" export link is present, and its href
 * It ALSO writes the fully-scrolled HTML to disk so the real listing parser can
 * be run against real bytes.
 *
 * It changes NOTHING in enrich.js and touches no catalog data.
 *
 * Run from the funko_enrich repo root (so node_modules/puppeteer-extra resolve):
 *   node pc_console_probe.js
 *   node pc_console_probe.js --slug funko-pop-marvel --find "spider-man"
 *   node pc_console_probe.js --chrome-path "C:\path\to\chrome.exe"
 *
 * Output HTML lands next to it as  <slug>_console.html  (e.g. funko-pop-disney_console.html)
 */

const fs   = require('fs');
const path = require('path');
const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const PC_BASE = 'https://www.pricecharting.com';

// ---- args ----
const args = process.argv.slice(2);
let slug = 'funko-pop-disney';
let find = 'stitch 626';
let chromeOverride = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--slug') slug = args[++i];
  else if (args[i] === '--find') find = args[++i];
  else if (args[i] === '--chrome-path') chromeOverride = args[++i];
}

// ---- chrome resolution (mirrors enrich.js findChrome) ----
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
function findChrome(override) {
  if (override) { if (!fs.existsSync(override)) throw new Error(`Chrome not found at: ${override}`); return override; }
  for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p;
  throw new Error('Chrome not found. Pass --chrome-path "C:\\path\\to\\chrome.exe"');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const chromePath = findChrome(chromeOverride);
  const url = `${PC_BASE}/console/${slug}`;
  console.log(`\n[probe] loading ${url}`);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // target text
  const target = await page.evaluate(() => {
    const t = document.body.innerText;
    let m = t.match(/for all\s+([\d,]+)\s+Funko/i);
    if (!m) m = t.match(/\/\s*([\d,]+)\s+items/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  });
  console.log(`[probe] stated target: ${target}`);

  // rows BEFORE scrolling
  const before = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#games_table tbody tr')];
    return { tr: rows.length, linked: rows.filter(r => r.querySelector('a[href*="/game/"]')).length };
  });
  console.log(`[probe] pre-scroll : <tr>=${before.tr}  linked=${before.linked}`);

  // scroll to bottom until row count stops growing (same idea as the crawl)
  let prev = -1, stable = 0, scrolls = 0;
  const MAX = 250;
  while (scrolls < MAX) {
    scrolls++;
    const n = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      const t = document.querySelector('#games_table tbody');
      return t ? t.querySelectorAll('tr').length : 0;
    });
    if (target > 0 && n >= target) break;
    if (n === prev) { stable++; if (stable >= 15) break; await sleep(1200); }
    else { stable = 0; prev = n; }
    await sleep(700);
  }

  // rows AFTER scrolling + the specific figure + export link
  const findLc = find.toLowerCase();
  const after = await page.evaluate((findLc) => {
    const rows = [...document.querySelectorAll('#games_table tbody tr')];
    const linked = rows.filter(r => r.querySelector('a[href*="/game/"]'));
    const hit = rows.find(r => (r.innerText || '').toLowerCase().includes(findLc));
    // hunt for a downloadable price-list / CSV export anywhere on the page
    const links = [...document.querySelectorAll('a')];
    const exp = links.find(a => /download price list|price list|\.csv|export/i.test(a.innerText || '') || /\.csv|download.*price/i.test(a.href || ''));
    return {
      tr: rows.length,
      linked: linked.length,
      scrolls_done: true,
      hitPresent: !!hit,
      hitHref: hit ? ((hit.querySelector('a[href*="/game/"]') || {}).href || '(row present, NO /game/ link)') : '(not in DOM)',
      hitText: hit ? (hit.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
      exportText: exp ? (exp.innerText || '').trim().slice(0, 40) : '(none found)',
      exportHref: exp ? exp.href : '',
    };
  }, findLc);

  console.log(`[probe] post-scroll: <tr>=${after.tr}  linked=${after.linked}  (target=${target})`);
  console.log(`[probe] "${find}" in DOM: ${after.hitPresent}`);
  if (after.hitPresent) {
    console.log(`[probe]   row text : ${after.hitText}`);
    console.log(`[probe]   link     : ${after.hitHref}`);
  }
  console.log(`[probe] export link: ${after.exportText}  ${after.exportHref}`);

  // dump the fully-scrolled HTML for offline parser testing
  const html = await page.content();
  const outPath = path.resolve(`${slug}_console.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`[probe] saved HTML : ${outPath}  (${(html.length/1024/1024).toFixed(1)} MB)`);

  await browser.close();

  console.log('\n===== VERDICT HINTS =====');
  if (target > 0 && after.linked >= target - 5) console.log('  linked ≈ target  -> scroll+parse SHOULD get everything; bug is elsewhere (dedup?).');
  if (target > 0 && after.linked < target - 5)  console.log(`  linked (${after.linked}) < target (${target}) -> rows are missing links or not rendering; this is the gap.`);
  if (!after.hitPresent) console.log(`  "${find}" NOT in the listing DOM -> the console index does not list it under this sort; scroll-scrape can never see it. Export/other route needed.`);
  if (after.exportHref) console.log(`  export link found -> deterministic pull is viable (DEC-030 option 1).`);
  console.log('=========================\n');
})().catch(e => { console.error('[probe] ERROR:', e.message); process.exit(1); });

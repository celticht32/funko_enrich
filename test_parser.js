'use strict';
const puppeteer = require('puppeteer-extra');
const S = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
puppeteer.use(S());

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox'],
  });
  const p = await b.newPage();
  const t = Date.now();

  await p.goto(
    'https://www.hobbydb.com/marketplaces/hobbydb/catalog_items/captain-america-spider-man-homecoming',
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );

  await p.waitForFunction(() => {
    const strongs = Array.from(document.querySelectorAll('strong'));
    const refStrong = strongs.find(s => s.innerText.includes('Reference'));
    if (!refStrong) return false;
    const val = refStrong.parentElement && refStrong.parentElement.querySelector('.ng-binding');
    return val && val.innerText.trim().length > 0;
  }, { timeout: 20000 }).catch(() => {});

  const html = await p.content();
  const $ = cheerio.load(html);
  const results = [];

  $('strong').each((_, el) => {
    const label = $(el).text().replace(/:$/, '').trim();
    const parent = $(el).closest('.spaced-field, .col-md-6, .col-md-12, div');
    const value = parent.find('.ng-binding').first().text().trim();
    if (label && value && value !== label && value.length < 50) {
      results.push(label + ': ' + value);
    }
  });

  console.log('Time:', (Date.now() - t) + 'ms');
  console.log('Parsed fields:', results);

  // Also dump the raw Reference Numbers section HTML
  const refIdx = html.indexOf('Reference Numbers');
  if (refIdx > -1) {
    console.log('\nReference Numbers section HTML:');
    console.log(html.slice(refIdx, refIdx + 800));
  } else {
    console.log('Reference Numbers section not found in HTML');
  }

  await b.close();
})().catch(e => console.error(e));

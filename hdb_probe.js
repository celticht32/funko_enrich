#!/usr/bin/env node
/**
 * hdb_probe.js — Discover the DOM shape of a hobbyDB search-results page.
 *
 * MIT License, Copyright (c) 2026 Chris Ahrendt
 *
 * WHY A PROBE AND NOT JUST A SCRAPER
 * ----------------------------------
 * Three lookup strategies have already failed against endpoints that were never
 * inspected first:
 *
 *   - PriceCharting `search-products?q=<upc>` returns `category=no-results`;
 *     that barcode is not in their database at all.
 *   - hobbyDB `catalog_items?q=<upc>` over plain fetch returns a 27 KB React
 *     shell with none of the content in it.
 *   - hobbyDB `catalog_items?filters[search]=<upc>` does the same.
 *
 * enrich.js already knows hobbyDB is a client-rendered SPA — its comment reads
 * "'domcontentloaded' fires on the empty ~1.4KB shell, BEFORE the app fetches
 * item data" — and it waits on `networkidle2` plus a `waitForFunction` that
 * looks for "Reference #|UPC|HDBID" before reading `page.content()`.
 *
 * That machinery works for hobbyDB ITEM pages, which enrich.js fetches by handle.
 * It has never fetched a SEARCH page, so nobody knows that page's markup. This
 * script renders one and prints what is actually there, so the real scraper can
 * be written against observed structure instead of a guess.
 *
 * It writes nothing and changes nothing.
 *
 * Usage:
 *     node hdb_probe.js                    # probes UPC 889698831123 (Easter Stitch)
 *     node hdb_probe.js 889698819510       # probe a different barcode
 *     node hdb_probe.js 889698819510 --html   # also dump the rendered HTML
 */

'use strict';

const fs        = require('fs');
const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const HDB_SEARCH = (q) =>
  `https://www.hobbydb.com/marketplaces/hobbydb/catalog_items?q=${encodeURIComponent(q)}`;

const upc      = process.argv[2] || '889698831123';
const dumpHtml = process.argv.includes('--html');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0 Safari/537.36');

  const url = HDB_SEARCH(upc);
  console.log(`fetching ${url}\n`);

  // Same wait strategy enrich.js uses for hobbyDB item pages: the SPA has not
  // fetched anything by domcontentloaded.
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});

  // Give the app a chance to paint results, but do not fail the probe if it
  // never does — reporting "nothing rendered" is itself the answer.
  const grew = await page
    .waitForFunction(() => document.body && document.body.innerHTML.length > 5000,
                     { timeout: 20000 })
    .then(() => true)
    .catch(() => false);

  const report = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/catalog_items/"]'));
    const uniqHref = [...new Set(links.map((a) => a.getAttribute('href')))];

    // Anything that looks like a result card, so the real scraper knows what to
    // select. Report several candidate selectors rather than assuming one.
    const probe = (sel) => document.querySelectorAll(sel).length;

    return {
      title:        document.title,
      bodyLength:   document.body ? document.body.innerHTML.length : 0,
      bodyTextHead: document.body ? document.body.innerText.slice(0, 300) : '',
      catalogLinks: uniqHref.length,
      firstLinks:   uniqHref.slice(0, 5),
      firstTexts:   links.slice(0, 5).map((a) => a.innerText.trim()).filter(Boolean),
      selectorCounts: {
        'a[href*="/catalog_items/"]': probe('a[href*="/catalog_items/"]'),
        '.catalog-item':             probe('.catalog-item'),
        '.item-card':                probe('.item-card'),
        '[class*="card"]':           probe('[class*="card"]'),
        '.ng-binding':               probe('.ng-binding'),
        '.search-result':            probe('.search-result'),
        'img':                       probe('img'),
      },
      // Did the barcode itself make it onto the page?
      mentionsUpc: document.body
        ? document.body.innerText.includes(new URL(location.href).searchParams.get('q') || '')
        : false,
      // Any obvious "no results" copy?
      noResults: document.body
        ? /no results|nothing found|0 items|no items/i.test(document.body.innerText)
        : false,
    };
  });

  console.log(`rendered past shell : ${grew}`);
  console.log(`page title          : ${report.title}`);
  console.log(`body innerHTML      : ${report.bodyLength.toLocaleString()} chars`);
  console.log(`mentions the UPC    : ${report.mentionsUpc}`);
  console.log(`"no results" copy   : ${report.noResults}`);
  console.log(`\ncatalog_items links : ${report.catalogLinks}`);
  report.firstLinks.forEach((h) => console.log(`   ${h}`));
  if (report.firstTexts.length) {
    console.log(`\nlink texts:`);
    report.firstTexts.forEach((t) => console.log(`   ${JSON.stringify(t.slice(0, 70))}`));
  }

  console.log(`\nselector counts:`);
  Object.entries(report.selectorCounts).forEach(([k, v]) =>
    console.log(`   ${String(v).padStart(4)}  ${k}`));

  console.log(`\nfirst 300 chars of visible text:`);
  console.log(report.bodyTextHead.split('\n').map((l) => '   ' + l).join('\n'));

  if (dumpHtml) {
    const out = `hdb_search_${upc}.html`;
    fs.writeFileSync(out, await page.content(), 'utf8');
    console.log(`\nrendered HTML written to ${out}`);
  }

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

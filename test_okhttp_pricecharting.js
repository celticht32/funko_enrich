/**
 * test_okhttp_pricecharting.js
 *
 * Probe whether a PLAIN HTTP fetch (no browser, no JS) can read PriceCharting
 * product pages — i.e. whether the Android app's OkHttp client would work, or
 * whether PriceCharting serves a JS challenge / bot block instead.
 *
 * This mimics what PriceService.kt does on-device: a single GET with a browser-
 * like Android User-Agent and no JavaScript engine. If the real price HTML comes
 * back, OkHttp will work on the phone. If we get a challenge/redirect/empty
 * shell, OkHttp will NOT work and the app needs WebView (real Chromium) instead.
 *
 * NOTE on IP: your PC is likely on a different network than your phone. A pass
 * here is a strong "OkHttp will work"; a FAIL is suggestive but not final,
 * because the phone's residential mobile IP may be treated more leniently. The
 * definitive test is on-device, but this catches the common case cheaply.
 *
 * Usage:  node test_okhttp_pricecharting.js
 * No dependencies — uses Node's built-in https.
 */

const https = require('https');

// Same UA the app's eBay scrape sends (PriceService.EBAY_BROWSER_UA).
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Mobile Safari/537.36';

// A few known-good product pages (verified to exist this session).
const TEST_URLS = [
  'https://www.pricecharting.com/game/funko-pop-animation/pepe-le-pew-395',
  'https://www.pricecharting.com/game/funko-pop-ad-icons/twinkie-the-kid-27',
];

function fetchPlain(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': ANDROID_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 20000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', headers: {}, body: '' }); });
    req.on('error', (e) => resolve({ status: 'ERROR', headers: {}, body: String(e) }));
  });
}

// Detect whether the response actually contains the price data we need.
function analyze(body) {
  const hasPriceEls   = /id=["']?(used_price|complete_price|new_price)/.test(body);
  const hasDollarData = /\$\s*[\d,]+\.\d{2}/.test(body);
  // Common bot-wall / JS-challenge signatures.
  const looksChallenged = /captcha|cf-challenge|cloudflare|just a moment|enable javascript|attention required|access denied|are you a robot/i.test(body);
  return { hasPriceEls, hasDollarData, looksChallenged, length: body.length };
}

(async () => {
  console.log('Probing PriceCharting with a plain (no-browser) HTTP GET\n');
  let anyPass = false;

  for (const url of TEST_URLS) {
    process.stdout.write(`GET ${url}\n`);
    const res = await fetchPlain(url);
    console.log(`  status: ${res.status}`);

    if (typeof res.status === 'number' && res.status >= 300 && res.status < 400) {
      console.log(`  redirected to: ${res.headers.location || '(unknown)'}  <- often a block signal`);
    }

    const a = analyze(res.body || '');
    console.log(`  body length:        ${a.length}`);
    console.log(`  price elements:     ${a.hasPriceEls ? 'PRESENT' : 'missing'}`);
    console.log(`  dollar price text:  ${a.hasDollarData ? 'present' : 'missing'}`);
    console.log(`  challenge/block:    ${a.looksChallenged ? 'YES (bot wall detected)' : 'no'}`);

    const pass = res.status === 200 && a.hasPriceEls && a.hasDollarData && !a.looksChallenged;
    console.log(`  => ${pass ? 'PASS — plain fetch got real price data (OkHttp would work)' : 'FAIL — no usable price data via plain fetch'}\n`);
    if (pass) anyPass = true;
  }

  console.log('─'.repeat(60));
  if (anyPass) {
    console.log('RESULT: At least one page returned real price data via plain HTTP.');
    console.log('OkHttp in the app is likely to work. Worth building the OkHttp tier.');
  } else {
    console.log('RESULT: Plain HTTP did NOT return usable price data.');
    console.log('PriceCharting is blocking non-browser requests. OkHttp will likely');
    console.log('fail on-device too; the app would need WebView (real Chromium).');
    console.log('(Caveat: your phone\'s residential IP may behave differently — the');
    console.log(' truly definitive test is a tiny on-device WebView vs OkHttp trial.)');
  }
})();

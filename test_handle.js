'use strict';
const fetch = require('node-fetch');
async function check(h) {
  const r = await fetch('https://www.hobbydb.com/marketplaces/hobbydb/catalog_items/'+h,
    {redirect:'manual',headers:{'User-Agent':'Mozilla/5.0'}});
  return r.status;
}
(async()=>{
  const tests = [
    'the-demon-robot-prototype',   // content kept, parens removed
    'the-demon-robot',             // content removed
    'severus-snape-harry-potter-parvati-patil-minerva-mcgonagall-4-pack', // commas removed
    'severus-snape-harry-potter-parvati-patil-and-minerva-mcgonagall-4-pack', // commas -> and
  ];
  for (const h of tests) {
    console.log(await check(h), h);
  }
})().catch(e=>console.error(e));

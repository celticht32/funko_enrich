'use strict';
const fs = require('fs');

const filePath = './funko_data.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

let fixed = 0;
for (const rec of data) {
  if (rec.handle === 'pater-parker:-the-spectacular-spider-man') {
    rec.handle    = 'peter-parker-the-spectacular-spider-man';
    rec.title     = 'Peter Parker: The Spectacular Spider-Man';
    delete rec.hdbChecked;
    fixed++;
    console.log('Fixed:', rec.title, '| handle:', rec.handle);
  }
}

if (fixed === 0) {
  console.log('Record not found — check the handle spelling.');
} else {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Saved. ${fixed} record(s) fixed.`);
}

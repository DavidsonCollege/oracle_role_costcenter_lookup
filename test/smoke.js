// Smoke tests run on every pull request (see .github/workflows/pr-check.yml).
// They can't launch the Electron window or reach Oracle; they catch broken
// dependency updates, syntax errors, and missing packaged files.

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}\n  ${err.message}`);
  }
}

(async () => {
  await check('main.js, preload.js and renderer.js have no syntax errors', () => {
    for (const file of ['main.js', 'preload.js', 'renderer.js']) {
      execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    }
  });

  await check('every file listed in package.json "files" exists', () => {
    const { build } = require(path.join(root, 'package.json'));
    const missing = build.files
      .filter(f => f !== 'build-date.json') // generated at build time
      .map(f => f.replace(/\/\*\*$/, ''))
      .filter(f => !fs.existsSync(path.join(root, f)));
    assert.deepStrictEqual(missing, [], `Missing: ${missing.join(', ')}`);
  });

  await check('electron-updater loads', () => {
    require('electron-updater');
  });

  // Mirrors the parsing in runSoapReport (main.js). The fixture is shaped like a
  // BIP report: title row, header row, numbers, text with leading zeros, an empty
  // cell, a fully empty row, and a C-prefixed cost center.
  await check('read-excel-file parses a report-shaped xlsx', async () => {
    const { readSheet } = require('read-excel-file/node');
    const rows = await readSheet(fs.readFileSync(path.join(__dirname, 'fixtures', 'report.xlsx')));
    const data = rows.map(row => row.map(cell => cell ?? ''));
    assert.deepStrictEqual(data, [
      ['Cost Center Manager Report', '', '', '', ''],
      ['COST CENTER', 'DEPARTMENT NAME', 'COST CENTER MANAGER', 'CC MANAGER STATUS', 'COST_CENTER_MGR_NUM'],
      [1001, 'Finance', 'Jane Doe', 'Active', 800552115],
      ['0420', 'Library', '', 'Inactive', '012345'],
      ['', '', '', '', ''],
      ['C480', 'Admin Group', 'Pat Lee', 'Active', 800111222],
    ]);
  });

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll checks passed');
})();

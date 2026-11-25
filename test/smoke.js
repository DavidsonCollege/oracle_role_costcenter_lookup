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
    for (const file of ['main.js', 'preload.js', 'renderer.js', 'oscs-reindex.js']) {
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

  // ── Search index rebuild (oscs-reindex.js) ───────────────────────────────
  // Drives the runner against a fake Oracle so the guardrails are checked in CI.

  const oscsMod = require(path.join(root, 'oscs-reindex.js'));
  const defaultCfgPath = path.join(root, 'oscs-reindex.config.json');
  const os = require('os');

  // Stored (uncompressed) zip with one file, shaped like an ERP log download.
  function makeZip(name, text) {
    const n = Buffer.from(name), d = Buffer.from(text);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(d.length, 20); central.writeUInt32LE(d.length, 24); central.writeUInt16LE(n.length, 28);
    const cdOffset = 30 + n.length + d.length;
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + n.length, 12); eocd.writeUInt32LE(cdOffset, 16);
    return Buffer.concat([local, n, d, central, n, eocd]);
  }

  // Config with every job complete (the shipped default leaves ACL paths blank on purpose).
  function testConfig(steps) {
    const cfg = JSON.parse(fs.readFileSync(defaultCfgPath, 'utf8'));
    cfg.jobs.computeUsersAcl.packagePath = '/oracle/apps/ess/hcm/test';
    if (steps) cfg.steps = steps;
    return cfg;
  }

  // Fake Oracle: logFor(job, args) returns the log text; statusFor returns the final status.
  function fakeOracle({ logFor, statusFor = () => 'SUCCEEDED' }) {
    const submitted = [];
    let nextId = 1000;
    const jobs = new Map();
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map(), text: async () => JSON.stringify(body) });
    const fetch = async (url, opts = {}) => {
      if (url.includes('hooks.slack.com')) { submitted.push({ slack: JSON.parse(opts.body).text }); return json({}); }
      if (opts.method === 'POST' && url.endsWith('/erpintegrations')) {
        const b = JSON.parse(opts.body);
        const id = String(nextId++);
        jobs.set(id, { job: b.JobDefName, args: b.ESSParameters.split(',') });
        submitted.push({ api: 'erp', id, job: b.JobDefName, args: b.ESSParameters });
        return json({ ReqstId: id });
      }
      if (opts.method === 'POST' && url.endsWith('/ess/rest/scheduler/v1/requests')) {
        const b = JSON.parse(opts.body);
        const id = String(nextId++);
        const job = b.jobDefinitionId.split('/').pop();
        jobs.set(id, { job, args: b.requestParameters.map(p => p.value) });
        submitted.push({ api: 'ess', id, job, args: b.requestParameters.map(p => `${p.name}=${p.value}`).join(','), application: b.application, jobDefinitionId: b.jobDefinitionId });
        return json({ requestId: Number(id) });
      }
      const st = url.match(/ESSJobStatusRF;requestId=(\d+)/);
      if (st) return json({ items: [{ RequestStatus: statusFor(jobs.get(st[1])) }] });
      const ess = url.match(/\/requests\/(\d+)$/);
      if (ess) return json({ state: statusFor(jobs.get(ess[1])) === 'SUCCEEDED' ? 12 : 10 });
      const lg = url.match(/ESSJobExecutionDetailsRF;requestId=(\d+)/);
      if (lg) {
        const j = jobs.get(lg[1]);
        return json({ items: [{ DocumentContent: makeZip(`${lg[1]}.log`, logFor(j)).toString('base64') }] });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    return { fetch, submitted };
  }

  const goodLog = j => j.job === 'FndOSCSIndexIngestJob'
    ? `Index ${j.args[0]}\nTotal number of rows processed in the current run: 11\nTotal number of rows to be processed: 11\nnumber of records not ingested: 0`
    : j.job === 'ComputeUsersACL' ? 'Entering execute()- Compute Users ACL ...ALL_USERS\nCompute Users ACL: exiting getAllUsers().  Count- 4578\n#Remaining Users 1\t| 300000013396109\t| 800692655\nCompute Users ACL... done' : 'Wed Nov 25 21:01:10 UTC 2026: ASE active user Count: 1353\nProcessed 995 learners\nLearnOSCSACLUsersWorker onWorkDone';

  async function runToEnd(cfg, oracle, params, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscs-test-'));
    const cfgPath = path.join(dir, 'default.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const alerts = [];
    let finished;
    const done = new Promise(r => { finished = r; });
    const r = oscsMod.createReindexer({
      fetch: oracle.fetch, dataDir: dir, defaultConfigPath: cfgPath,
      getSlackWebhook: () => 'https://hooks.slack.com/services/T/B/X',
      onAlert: a => { alerts.push(a); finished(); },
      sleep: async () => {},
      ...extra,
    });
    const res = r.start({ baseUrl: 'https://fa-exci-test-saasfaprod1.fa.ocs.oraclecloud.com', username: 'u', password: 'p', confirmName: 'test', mode: 'full', ...params });
    if (res.ok) await done;
    return { res, alerts, reindexer: r, dir, last: alerts.at(-1)?.run };
  }

  await check('shipped OSCS config is valid, with 30 unique non-blank indexes and every job complete', () => {
    const cfg = JSON.parse(fs.readFileSync(defaultCfgPath, 'utf8'));
    const v = oscsMod.validateConfig(cfg);
    assert.deepStrictEqual(v.errors, []);
    assert.strictEqual(cfg.steps.length, 30);
    assert.deepStrictEqual(v.jobErrors, { ingest: [], computeUsersAcl: [], learningAcl: [] });
  });

  await check('OSCS: Prod and unknown hosts are refused; confirmation must match', () => {
    const cfg = testConfig();
    assert.strictEqual(oscsMod.checkInstance('https://fa-exci-saasfaprod1.fa.ocs.oraclecloud.com', cfg, 'test').ok, false);
    assert.strictEqual(oscsMod.checkInstance('https://example.com', cfg, 'example').ok, false);
    assert.strictEqual(oscsMod.checkInstance('https://fa-exci-test-saasfaprod1.fa.ocs.oraclecloud.com', cfg, 'dev1').ok, false);
    assert.strictEqual(oscsMod.checkInstance('https://fa-exci-dev1-saasfaprod1.fa.ocs.oraclecloud.com', cfg, 'DEV1').ok, true);
  });

  await check('OSCS: blank index names are rejected by config and by the submit guard', () => {
    const cfg = testConfig([{ index: 'fa-hcm-job' }, { index: '  ' }]);
    assert.ok(oscsMod.validateConfig(cfg).errors.some(e => /blank index name/.test(e)));
    const step = { kind: 'ingest', index: '' };
    assert.throws(() => oscsMod.assertSubmittable(step, oscsMod.buildArgs(cfg.jobs.ingest, step)), /blank or invalid/);
  });

  await check('OSCS: full run submits serially in order, ACL last, then posts a summary', async () => {
    const steps = [{ index: 'fa-hcm-acl' }, { index: 'fa-hcm-person' }, { index: 'fa-prc-pa' }];
    const oracle = fakeOracle({ logFor: goodLog });
    const { res, last } = await runToEnd(testConfig(steps), oracle, {});
    assert.ok(res.ok, res.error);
    assert.strictEqual(last.status, 'completed');
    const jobs = oracle.submitted.filter(s => s.job);
    assert.deepStrictEqual(jobs.map(s => s.args.split(',')[0]), ['fa-hcm-acl', 'fa-hcm-person', 'fa-prc-pa', 'submit.argument1=ALL_USERS', 'submit.argument1=ORA_REFRESH_OSCS_LEARN_ACL']);
    assert.strictEqual(jobs[0].args, 'fa-hcm-acl,false');
    assert.strictEqual(jobs[3].jobDefinitionId, 'JobDefinition://oracle/apps/ess/hcm/test/ComputeUsersACL');
    assert.strictEqual(jobs[3].application, 'EarHcmEss');
    // Learning ACL: argument 2 (Person Number) is omitted, numbering kept.
    assert.strictEqual(jobs[4].args, 'submit.argument1=ORA_REFRESH_OSCS_LEARN_ACL,submit.argument3=5,submit.argument4=1000');
    assert.strictEqual(jobs[4].jobDefinitionId, 'JobDefinition://oracle/apps/ess/hcm/engagement/videoshare/ProcessLearningItemsOSCSACLJob');
    assert.ok(oracle.submitted.at(-1).slack.includes('finished'));
  });

  await check('OSCS: a failed-rows log stops the run before the next step and alerts Slack', async () => {
    const steps = [{ index: 'fa-hcm-acl' }, { index: 'fa-hcm-person' }, { index: 'fa-hcm-job' }];
    const oracle = fakeOracle({ logFor: j => (j.args[0] === 'fa-hcm-person'
      ? 'Index fa-hcm-person\nTotal number of rows failed in the payload: 3' : goodLog(j)) });
    const { last } = await runToEnd(testConfig(steps), oracle, {});
    assert.strictEqual(last.status, 'stopped');
    assert.deepStrictEqual(last.steps.map(s => s.status), ['SUCCEEDED', 'WARNING', 'PENDING', 'PENDING', 'PENDING']);
    assert.ok(!oracle.submitted.some(s => s.args === 'fa-hcm-job,false'));
    assert.ok(oracle.submitted.at(-1).slack.includes('fa-hcm-person'));
  });

  await check('OSCS: Oracle ERROR stops the run; resume skips succeeded steps', async () => {
    const steps = [{ index: 'fa-hcm-acl' }, { index: 'fa-hcm-person' }];
    let fail = true;
    const oracle = fakeOracle({ logFor: goodLog, statusFor: j => (fail && j.args[0] === 'fa-hcm-person' ? 'ERROR' : 'SUCCEEDED') });
    const cfg = testConfig(steps);
    const first = await runToEnd(cfg, oracle, {});
    assert.strictEqual(first.last.steps[1].status, 'ERROR');
    fail = false;
    oracle.submitted.length = 0;
    // Resume in the same data folder so the run record is found.
    const alerts = [];
    let finished; const done = new Promise(r => { finished = r; });
    const r = oscsMod.createReindexer({ fetch: oracle.fetch, dataDir: first.dir, defaultConfigPath: path.join(first.dir, 'default.json'),
      onAlert: a => { alerts.push(a); finished(); }, sleep: async () => {} });
    const res = r.start({ baseUrl: 'https://fa-exci-test-saasfaprod1.fa.ocs.oraclecloud.com', username: 'u', password: 'p', confirmName: 'test',
      mode: 'resume', runId: first.last.id, fromStepId: 'ingest:fa-hcm-acl' });
    assert.ok(res.ok, res.error);
    await done;
    assert.strictEqual(alerts[0].run.status, 'completed');
    assert.ok(!oracle.submitted.some(s => s.args === 'fa-hcm-acl,false'), 'succeeded step was resubmitted');
  });

  await check('OSCS: Compute Users ACL count is read from the real log wording; low count warns', () => {
    const cfg = testConfig();
    const log = n => `Entering execute()- Compute Users ACL ...ALL_USERS\nCompute Users ACL: exiting getAllUsers().  Count- ${n}\nLongRunning Users Count: 0\n#Remaining Users 21\t| 300000120199796\t| 69025\nCompute Users ACL... done`;
    assert.deepStrictEqual(oscsMod.checkLog(cfg.jobs.computeUsersAcl, {}, log(4578)), { issues: [], rows: 4578, recreateOnly: false });
    assert.match(oscsMod.checkLog(cfg.jobs.computeUsersAcl, {}, log(120)).issues[0], /far below/);
    assert.ok(!oscsMod.logExcerpt(log(4578)).includes('#Remaining Users'));
  });

  await check('OSCS: Learning ACL count comes from "ASE active user Count", not other learner numbers', () => {
    const cfg = testConfig();
    const log = 'Wed Nov 25 21:01:10 UTC 2026: ASE active user Count: 1353\nProcessed 995 learners\nLi count : 2';
    assert.deepStrictEqual(oscsMod.checkLog(cfg.jobs.learningAcl, {}, log), { issues: [], rows: 1353, recreateOnly: false });
  });

  await check('OSCS: ACL index ingest logs are marked recreate only', () => {
    const cfg = testConfig();
    const log = 'Fetching the scheduled index name for recreate: fa-hcm-acl\nOnly performing recreate for index - fa-hcm-acl\nduration= 0:0:0:8:0.';
    assert.deepStrictEqual(oscsMod.checkLog(cfg.jobs.ingest, { index: 'fa-hcm-acl' }, log), { issues: [], rows: null, recreateOnly: true });
  });

  await check('OSCS: omitted arguments leave an empty ERP slot and are rejected for ingest', () => {
    const job = { api: 'erp', args: [{ value: 'A' }, { omit: true }, { value: '5' }] };
    const args = oscsMod.buildArgs(job, { kind: 'acl' });
    assert.doesNotThrow(() => oscsMod.assertSubmittable({ kind: 'acl' }, args));
    assert.strictEqual(args.map(a => (a.omit ? '' : oscsMod.erpArg(a.value))).join(','), 'A,,5');
    assert.throws(() => oscsMod.assertSubmittable({ kind: 'ingest', index: 'fa-hcm-job' },
      [{ value: 'fa-hcm-job' }, { omit: true }]), /cannot be omitted/);
  });

  await check('OSCS: personal config differences are listed, and reset backs up the old copy', () => {
    const shipped = JSON.parse(fs.readFileSync(defaultCfgPath, 'utf8'));
    assert.strictEqual(oscsMod.summarizeConfigDiff(shipped, shipped), null);
    const mine = JSON.parse(JSON.stringify(shipped));
    mine._readme = ['edited'];
    assert.strictEqual(oscsMod.summarizeConfigDiff(mine, shipped), null, '_readme changes are ignored');
    mine.steps.push({ index: 'fa-prc-poi' });
    mine.jobs.ingest.timeoutMinutes = 99;
    const diffs = oscsMod.summarizeConfigDiff(mine, shipped);
    assert.ok(diffs.some(d => /Only in your copy: fa-prc-poi/.test(d)));
    assert.ok(diffs.some(d => /Job settings differ: ingest/.test(d)));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscs-reset-'));
    fs.writeFileSync(path.join(dir, 'oscs-reindex.config.json'), JSON.stringify(mine));
    const { backup, userPath } = oscsMod.resetUserConfig(dir, defaultCfgPath);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), mine);
    assert.strictEqual(fs.readFileSync(userPath, 'utf8'), fs.readFileSync(defaultCfgPath, 'utf8'));
  });

  await check('OSCS: full run is refused while an ACL job is incomplete in the config', async () => {
    const cfg = JSON.parse(fs.readFileSync(defaultCfgPath, 'utf8'));
    cfg.jobs.learningAcl.packagePath = null;
    const { res } = await runToEnd(cfg, fakeOracle({ logFor: goodLog }), {});
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /packagePath/);
  });

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll checks passed');
})();

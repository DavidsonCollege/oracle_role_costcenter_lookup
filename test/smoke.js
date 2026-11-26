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
  function fakeOracle({ logFor, statusFor = () => 'SUCCEEDED', essFor = null }) {
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
      const ess = url.match(/\/requests\/(\d+)(?:\?|$)/);
      // Default: finished, with progress counters like Oracle's Recruiting jobs report.
      if (ess) return json(essFor?.(jobs.get(ess[1])) ?? { state: statusFor(jobs.get(ess[1])) === 'SUCCEEDED' ? 12 : 10,
        requestParameters: [{ name: 'FA_EMCC_counter_1_total', value: '10' }, { name: 'FA_EMCC_counter_1_processed', value: '10' }, { name: 'FA_EMCC_counter_1_failed', value: '0' }] });
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

  await check('shipped OSCS config is valid, with 31 unique non-blank indexes and every job complete', () => {
    const cfg = JSON.parse(fs.readFileSync(defaultCfgPath, 'utf8'));
    const v = oscsMod.validateConfig(cfg);
    assert.deepStrictEqual(v.errors, []);
    assert.strictEqual(cfg.steps.length, 31);
    assert.deepStrictEqual(v.jobErrors, { ingest: [], computeUsersAcl: [], learningAcl: [], recruitingGeography: [], recruitingRequisitions: [], recruitingCandidates: [] });
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
    assert.deepStrictEqual(jobs.map(s => s.args.split(',')[0]), ['fa-hcm-acl', 'fa-hcm-person', 'fa-prc-pa', 'submit.argument1=ALL_USERS', 'submit.argument1=ORA_REFRESH_OSCS_LEARN_ACL', 'submit.argument1=US', 'submit.argument1=FULL', 'submit.argument1=FULL']);
    // Recruiting: Drop and Recreate Index (FULL), never UPGRADE; Candidates also passes N.
    assert.strictEqual(jobs[7].args, 'submit.argument1=FULL,submit.argument2=N');
    assert.strictEqual(jobs[7].jobDefinitionId, 'JobDefinition://oracle/apps/ess/hcm/recruiting/sourcing/core/LoadSearchDocuments');
    assert.strictEqual(last.steps.at(-1).rows, 10);
    // Geography: Level 2 omitted, so only argument 1 is sent.
    assert.strictEqual(jobs[5].args, 'submit.argument1=US');
    assert.strictEqual(jobs[5].jobDefinitionId, 'JobDefinition://oracle/apps/ess/hcm/recruiting/common/LoadIndexGeographySearchDocument');
    assert.strictEqual(jobs[0].args, 'fa-hcm-acl,false');
    assert.strictEqual(jobs[3].jobDefinitionId, 'JobDefinition://oracle/apps/ess/hcm/test/ComputeUsersACL');
    assert.strictEqual(jobs[3].application, 'EarHcmEss');
    // Learning ACL: argument 2 (Person Number) is omitted, numbering kept.
    assert.strictEqual(jobs[4].args, 'submit.argument1=ORA_REFRESH_OSCS_LEARN_ACL,submit.argument3=5,submit.argument4=1000');
    assert.strictEqual(jobs[4].jobDefinitionId, 'JobDefinition://oracle/apps/ess/hcm/engagement/videoshare/ProcessLearningItemsOSCSACLJob');
    assert.ok(oracle.submitted.at(-1).slack.includes('finished'));
  });

  await check('OSCS: index list is read from "Indices (created)" lines and compared with steps and exclusions', () => {
    const names = oscsMod.parseCreatedIndices('x\nIndices (created): [fa-hcm-person, "fa-new-one", fnd-attachments]\nIndices (created): [fa-scm-thing]\n');
    assert.deepStrictEqual(names, ['fa-hcm-person', 'fa-new-one', 'fa-scm-thing', 'fnd-attachments']);
    const cfg = { steps: [{ index: 'fa-hcm-person' }, { index: 'fa-gone' }],
      exclusions: [{ index: 'fnd-attachments', reason: 'own job' }, { prefix: 'fa-scm-', reason: 'SCM' }] };
    const c = oscsMod.compareIndexes(names, cfg);
    assert.deepStrictEqual(c.newInOracle, ['fa-new-one']);
    assert.deepStrictEqual(c.missingFromOracle, ['fa-gone']);
    assert.deepStrictEqual(c.excluded.map(x => x.index), ['fa-scm-thing', 'fnd-attachments']);
    assert.ok(oscsMod.validateConfig({ ...testConfig([{ index: 'fnd-attachments' }]) }).errors.some(e => /both a step and an exclusion/.test(e)));
  });

  await check('OSCS: Check index list falls back when Oracle rejects the job filter, skips canceled and empty logs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscs-test-'));
    const cfgPath = path.join(dir, 'default.json');
    fs.writeFileSync(cfgPath, JSON.stringify(testConfig([{ index: 'fa-hcm-person' }, { index: 'fa-hcm-job' }])));
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map(), text: async () => JSON.stringify(body) });
    const job = n => `JobDefinition://oracle/apps/ess/fnd/applcore/${n}`;
    const items = [
      { requestId: 50, state: 12, jobDefinitionId: job('FndOSCSReindexJob'), submitter: 'FAAdmin' },
      { requestId: 70, state: 9, jobDefinitionId: job('FndOSCSReindexJob'), submitter: 'FAADMIN' },
      { requestId: 65, state: 12, jobDefinitionId: job('FndOSCSReindexJob'), submitter: 'FAADMIN' },
      { requestId: 80, state: 12, jobDefinitionId: job('FndOSCSReindexJob'), submitter: 'SOMEONE' },
      { requestId: 95, state: 1, jobDefinitionId: job('FndOSCSReindexJob'), submitter: 'FAADMIN' },
      { requestId: 90, state: 12, jobDefinitionId: job('OtherJob'), submitter: 'FAADMIN' },
    ];
    const logs = { 65: 'No valid indices found', 50: 'Indices (created): [fa-hcm-person, fa-new-one, fnd-attachments]' };
    const seenQ = [];
    const fetch = async url => {
      const u = new URL(url);
      if (u.pathname.endsWith('/ess/rest/scheduler/v1/requests')) {
        const q = u.searchParams.get('q') ?? '';
        seenQ.push(q);
        if (q.includes('jobDefinitionId')) return json({ title: 'Invalid filter' }, 400);
        return json({ items: Number(u.searchParams.get('offset')) ? [] : items, hasMore: false });
      }
      const lg = url.match(/ESSJobExecutionDetailsRF;requestId=(\d+)/);
      if (lg) return json({ items: [{ DocumentContent: makeZip('x.log', logs[lg[1]] ?? '').toString('base64') }] });
      throw new Error(`Unexpected URL ${url}`);
    };
    const r = oscsMod.createReindexer({ fetch, dataDir: dir, defaultConfigPath: cfgPath });
    const res = await r.checkIndexList({ baseUrl: 'https://fa-exci-saasfaprod1.fa.ocs.oraclecloud.com', username: 'u', password: 'p' });
    assert.ok(res.ok, res.error);
    assert.strictEqual(res.isProd, true);
    assert.strictEqual(res.method, 'date filter');
    assert.strictEqual(res.request.requestId, '50');
    assert.deepStrictEqual(res.newInOracle, ['fa-new-one']);
    assert.deepStrictEqual(res.missingFromOracle, ['fa-hcm-job']);
    assert.deepStrictEqual(res.excluded.map(x => x.index), ['fnd-attachments']);
    assert.ok(res.tried.some(t => t.startsWith('65:')));
    assert.ok(!res.tried.some(t => t.startsWith('95:')));
    assert.ok(!res.tried.some(t => t.startsWith('70:') || t.startsWith('80:')));
    const found = await r.findRequests({ baseUrl: 'https://fa-exci-saasfaprod1.fa.ocs.oraclecloud.com', username: 'u', password: 'p', jobName: 'FndOSCSReindexJob' });
    assert.deepStrictEqual(found.requests.map(x => x.requestId), ['95', '70', '65', '50']);
    assert.strictEqual(found.latest.requestId, '65');
  });

  await check('OSCS: Who created it finds ingest requests by index parameter, any submitter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscs-test-'));
    const cfgPath = path.join(dir, 'default.json');
    fs.writeFileSync(cfgPath, JSON.stringify(testConfig()));
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map(), text: async () => JSON.stringify(body) });
    const ingest = (id, idx, who) => ({ requestId: id, state: 12, submitter: who, jobDefinitionId: 'JobDefinition://oracle/apps/ess/fnd/applcore/FndOSCSIndexIngestJob',
      requestParameters: [{ name: 'submit.argument1', value: idx }, { name: 'submit.argument2', value: 'false' }] });
    const items = [ingest(300, 'fa-hcm-contentitem', 'jdoe'), ingest(310, 'fa-hcm-contentitem-x', 'FAADMIN'), ingest(320, 'fa-hcm-person', 'FAADMIN'), ingest(290, 'fa-hcm-contentitem', 'FAADMIN')];
    const fetch = async url => json({ items: Number(new URL(url).searchParams.get('offset')) ? [] : items });
    const r = oscsMod.createReindexer({ fetch, dataDir: dir, defaultConfigPath: cfgPath });
    const found = await r.findIndexRequests({ baseUrl: 'https://fa-exci-saasfaprod1.fa.ocs.oraclecloud.com', username: 'u', password: 'p', index: 'fa-hcm-contentitem' });
    assert.ok(found.ok, found.error);
    assert.deepStrictEqual(found.requests.map(x => [x.requestId, x.submitter]), [['300', 'jdoe'], ['290', 'FAADMIN']]);
  });

  await check('OSCS: Who created it opens each request when search results have no parameters', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscs-test-'));
    const cfgPath = path.join(dir, 'default.json');
    fs.writeFileSync(cfgPath, JSON.stringify(testConfig()));
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map(), text: async () => JSON.stringify(body) });
    const params = { 401: 'fa-hcm-person', 402: 'fa-hcm-contentitem', 403: 'fa-hcm-job' };
    const fetch = async url => {
      const u = new URL(url);
      const one = u.pathname.match(/\/requests\/(\d+)$/);
      if (one) return json({ requestId: Number(one[1]), requestParameters: [{ name: 'submit.argument1', value: params[one[1]] }] });
      return json({ items: Number(u.searchParams.get('offset')) ? [] : Object.keys(params).map(id => ({ requestId: Number(id), state: 12, submitter: 'jdoe', jobDefinitionId: 'x/FndOSCSIndexIngestJob', requestParameters: null })) });
    };
    const r = oscsMod.createReindexer({ fetch, dataDir: dir, defaultConfigPath: cfgPath });
    const res = await r.findIndexRequests({ baseUrl: 'https://fa-exci-saasfaprod1.fa.ocs.oraclecloud.com', username: 'u', password: 'p', index: 'fa-hcm-contentitem' });
    assert.ok(res.ok, res.error);
    assert.deepStrictEqual(res.requests.map(x => x.requestId), ['402']);
    assert.ok(res.notes.some(n => /opened 3 request/.test(n)));
  });

  await check('OSCS: a search with no match stops when Oracle honored the job filter, and respects the time limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscs-test-'));
    const cfgPath = path.join(dir, 'default.json');
    fs.writeFileSync(cfgPath, JSON.stringify(testConfig()));
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map(), text: async () => JSON.stringify(body) });
    const qs = [];
    const fetch = async url => {
      const q = new URL(url).searchParams.get('q') ?? '';
      qs.push(q);
      const off = Number(new URL(url).searchParams.get('offset'));
      return json({ items: off ? [] : [{ requestId: 1, state: 12, jobDefinitionId: 'x/FndOSCSIndexIngestJob', requestParameters: [{ value: 'fa-hcm-person' }] }] });
    };
    const r = oscsMod.createReindexer({ fetch, dataDir: dir, defaultConfigPath: cfgPath });
    const creds = { baseUrl: 'https://fa-exci-saasfaprod1.fa.ocs.oraclecloud.com', username: 'u', password: 'p' };
    const pages = [];
    const res = await r.findIndexRequests({ ...creds, index: 'fa-hcm-contentitem', onPage: p => pages.push(p) });
    assert.strictEqual(res.ok, false);
    assert.ok(!qs.some(q => !q.includes('jobDefinitionId')), 'should not fall back to a date-only search');
    assert.ok(pages.length >= 1);
    // An endless Oracle (always a full page) stops at the time limit.
    let n = 0;
    const endless = async () => { await new Promise(res => setTimeout(res, 10)); return json({ items: Array.from({ length: 200 }, () => ({ requestId: ++n, state: 12, jobDefinitionId: 'x/FndOSCSIndexIngestJob' })) }); };
    const r2 = oscsMod.createReindexer({ fetch: endless, dataDir: dir, defaultConfigPath: cfgPath });
    const res2 = await r2.findRequests({ ...creds, jobName: 'FndOSCSIndexIngestJob', submitter: null, days: 30, paramValue: 'nope', timeLimitMs: 30 });
    assert.strictEqual(res2.ok, false);
    assert.ok(/time limit/.test(res2.error) || res2.notes.some(x => /time limit/.test(x)));
  });

  await check('OSCS: request search pages past 200 results and retries without sorting when Oracle refuses it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscs-test-'));
    const cfgPath = path.join(dir, 'default.json');
    fs.writeFileSync(cfgPath, JSON.stringify(testConfig()));
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map(), text: async () => JSON.stringify(body) });
    // 450 requests, oldest first, no hasMore flag: like the 200-row batch that hid the newest run.
    const all = Array.from({ length: 450 }, (_, i) => ({
      requestId: 1000 + i, state: 12, submitter: 'FAADMIN',
      jobDefinitionId: `JobDefinition://x/${i % 50 === 0 ? 'FndOSCSReindexJob' : 'Other'}`,
      submissionTime: new Date(Date.UTC(2026, 9, 1) + i * 3600000).toISOString(),
    }));
    let sortRefused = 0;
    const fetch = async url => {
      const u = new URL(url);
      if (u.searchParams.get('orderBy')) { sortRefused++; return json({ title: 'Unknown parameter orderBy' }, 400); }
      const off = Number(u.searchParams.get('offset')), lim = Number(u.searchParams.get('limit'));
      return json({ items: all.slice(off, off + lim) });
    };
    const r = oscsMod.createReindexer({ fetch, dataDir: dir, defaultConfigPath: cfgPath });
    const found = await r.findRequests({ baseUrl: 'https://fa-exci-saasfaprod1.fa.ocs.oraclecloud.com', username: 'u', password: 'p', jobName: 'FndOSCSReindexJob' });
    assert.ok(found.ok, found.error);
    assert.strictEqual(found.latest.requestId, '1400');
    assert.strictEqual(found.requests.length, 9);
    assert.ok(sortRefused >= 1);
    assert.ok(found.notes.some(n => /sorting newest first was refused/.test(n)));
  });

  await check('OSCS: Recruiting jobs that say Succeeded but did nothing are caught by counters and the log', () => {
    const job = { counterCheck: { minTotal: 1, maxFailed: 0 }, logCheck: { type: 'count', requiredPatterns: [], errorPattern: 'Job failed' } };
    const counters = (t, p, f) => ({ requestParameters: [
      { name: 'FA_EMCC_counter_1_total', value: String(t) }, { name: 'FA_EMCC_counter_1_processed', value: String(p) }, { name: 'FA_EMCC_counter_1_failed', value: String(f) }] });
    // dev1 request 10387396: Upgrade Current Index after a refresh.
    assert.match(oscsMod.checkCounters(job, counters(0, 0, 0)).issues[0], /did nothing/);
    assert.match(oscsMod.checkLog(job, {}, 'Job failed. Reason: Re-ingestion not applicable as no existing field required to be re-ingested').issues[0], /Job failed/);
    // dev1 request 10536553: Drop and Recreate Index.
    assert.deepStrictEqual(oscsMod.checkCounters(job, counters(100, 100, 0)), { issues: [], rows: 100 });
    assert.match(oscsMod.checkCounters(job, counters(100, 90, 10)).issues[0], /10 of 100 items failed/);
    assert.match(oscsMod.checkCounters(job, { requestParameters: [] }).issues[0], /didn't report progress counters/);
    // Candidates (dev1 request 10536561): children do the work, so processed stays 0; Rows uses the total.
    assert.deepStrictEqual(oscsMod.checkCounters({ counterCheck: { minTotal: 1, maxFailed: 0, rowsFrom: 'total' } }, counters(27343, 0, 0)), { issues: [], rows: 27343 });
    // Geography only reports its count.
    assert.deepStrictEqual(oscsMod.checkCounters({ counterCheck: {} }, counters(98072, 49053, 49019)), { issues: [], rows: 49053 });
  });

  await check('OSCS: the app adds, skips and removes indexes in the personal config without hand editing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscs-test-'));
    const cfgPath = path.join(dir, 'default.json');
    fs.writeFileSync(cfgPath, JSON.stringify(testConfig([{ index: 'fa-hcm-person' }, { index: 'fa-hcm-job' }, { index: 'fa-prc-pa' }])));
    const edit = c => oscsMod.editUserConfig(dir, cfgPath, c);
    const user = () => JSON.parse(fs.readFileSync(path.join(dir, 'oscs-reindex.config.json'), 'utf8'));
    edit({ action: 'addStep', index: 'fa-hcm-new', after: 'fa-hcm-job', area: 'HCM', notes: 'KB1' });
    assert.deepStrictEqual(user().steps.map(x => x.index), ['fa-hcm-person', 'fa-hcm-job', 'fa-hcm-new', 'fa-prc-pa']);
    assert.deepStrictEqual(user().steps[2], { index: 'fa-hcm-new', area: 'HCM', notes: 'KB1' });
    // Skipping a step moves it to the exclusions with its reason.
    edit({ action: 'addExclusion', index: 'fa-hcm-new', reason: 'Not used' });
    assert.ok(!user().steps.some(x => x.index === 'fa-hcm-new'));
    assert.deepStrictEqual(user().exclusions.at(-1), { index: 'fa-hcm-new', reason: 'Not used' });
    edit({ action: 'removeStep', index: 'fa-prc-pa' });
    assert.deepStrictEqual(user().steps.map(x => x.index), ['fa-hcm-person', 'fa-hcm-job']);
    // Refused: bad names, duplicates, skips without a reason; the shipped file is never touched.
    assert.throws(() => edit({ action: 'addStep', index: '' }), /not a valid index name/);
    assert.throws(() => edit({ action: 'addStep', index: 'fa-hcm-job' }), /already in the rebuild/);
    assert.throws(() => edit({ action: 'addExclusion', index: 'fa-x' }), /reason/);
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).steps.length, 3);
  });

  await check('OSCS: change request email lists each index change, its reason and test, for Admin Services', () => {
    const shipped = testConfig([{ index: 'fa-hcm-person' }, { index: 'fa-hcm-job' }, { index: 'fa-prc-pa' }]);
    const user = JSON.parse(JSON.stringify(shipped));
    user.steps.splice(2, 0, { index: 'fa-hcm-new', area: 'HCM', notes: 'Required for X (KB1)' });
    user.steps = user.steps.filter(x => x.index !== 'fa-prc-pa');
    user.exclusions.push({ index: 'fa-prc-pa', reason: '0 rows in dev1' });
    const ch = oscsMod.describeConfigChanges(user, shipped);
    assert.deepStrictEqual(ch.added.map(a => [a.step.index, a.after]), [['fa-hcm-new', 'fa-hcm-job']]);
    assert.deepStrictEqual(ch.removed.map(x => x.index), ['fa-prc-pa']);
    assert.deepStrictEqual(ch.skipped.map(x => x.index), ['fa-prc-pa']);
    assert.strictEqual(ch.any, true);
    const mail = oscsMod.buildChangeRequest({ changes: ch, version: '1.6.0', fileName: 'cfg.json',
      tests: { 'fa-hcm-new': { requestId: '123', instance: 'dev1', status: 'SUCCEEDED', rows: 1234, endedAt: '2026-11-26T17:00:00Z' } } });
    assert.strictEqual(mail.to, 'ti@davidson.edu');
    assert.match(mail.subject, /Admin Services/);
    assert.match(mail.body, /^Please assign this ticket to Admin Services\./);
    assert.match(mail.body, /- fa-hcm-new, after fa-hcm-job \(HCM\)\n    Reason: Required for X \(KB1\)\n    Tested: request 123 on dev1, SUCCEEDED, 1,234 rows/);
    assert.match(mail.body, /Reason: 0 rows in dev1/);
    assert.match(mail.body, /HOW TO UPDATE THE APP/);
    assert.match(mail.body, /UPDATING_THE_INDEX_LIST\.md/);
    assert.strictEqual(oscsMod.describeConfigChanges(shipped, shipped).any, false);
  });

  await check('OSCS: Slack turned off for a run posts nothing but still alerts in the app', async () => {
    const oracle = fakeOracle({ logFor: j => (j.args[0] === 'fa-hcm-person'
      ? 'Index fa-hcm-person\nTotal number of rows failed in the payload: 3' : goodLog(j)) });
    const { alerts, last } = await runToEnd(testConfig([{ index: 'fa-hcm-person' }]), oracle, { mode: 'single', stepId: 'ingest:fa-hcm-person', slack: false });
    assert.strictEqual(last.status, 'stopped');
    assert.ok(!oracle.submitted.some(s => s.slack));
    assert.strictEqual(alerts.at(-1).slack, 'off for this run');
    assert.strictEqual(last.alerts.at(-1).slack, 'off for this run');
  });

  await check('OSCS: a failed-rows log stops the run before the next step and alerts Slack', async () => {
    const steps = [{ index: 'fa-hcm-acl' }, { index: 'fa-hcm-person' }, { index: 'fa-hcm-job' }];
    const oracle = fakeOracle({ logFor: j => (j.args[0] === 'fa-hcm-person'
      ? 'Index fa-hcm-person\nTotal number of rows failed in the payload: 3' : goodLog(j)) });
    const { last } = await runToEnd(testConfig(steps), oracle, {});
    assert.strictEqual(last.status, 'stopped');
    assert.deepStrictEqual(last.steps.map(s => s.status), ['SUCCEEDED', 'WARNING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING']);
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

  await check('OSCS: a request Oracle is auto-retrying stops the run as an error right away', async () => {
    const steps = [{ index: 'fa-hcm-fake' }, { index: 'fa-hcm-person' }];
    const oracle = fakeOracle({
      logFor: goodLog,
      statusFor: j => (j.args[0] === 'fa-hcm-fake' ? 'WAIT' : 'SUCCEEDED'),
      essFor: j => (j.args[0] === 'fa-hcm-fake' ? { state: 'WAIT', retriedCount: 1, errorWarningMessage: 'Index not found' } : null),
    });
    const { last } = await runToEnd(testConfig(steps), oracle, {});
    assert.strictEqual(last.status, 'stopped');
    assert.strictEqual(last.steps[0].status, 'ERROR');
    assert.match(last.steps[0].issues[0], /retrying request .*retried 1 time.*Index not found/);
    assert.ok(!oracle.submitted.some(s => s.args === 'fa-hcm-person,false'));
  });

  await check('OSCS: retry check ignores healthy waiting requests', async () => {
    let polls = 0;
    const oracle = fakeOracle({
      logFor: goodLog,
      statusFor: () => (++polls < 3 ? 'WAIT' : 'SUCCEEDED'),
      essFor: () => ({ state: 'WAIT', retriedCount: null, executionAttempt: 1, previousState: null }),
    });
    const { last } = await runToEnd(testConfig([{ index: 'fa-hcm-job' }]), oracle, { mode: 'single', stepId: 'ingest:fa-hcm-job' });
    assert.strictEqual(last.steps[0].status, 'SUCCEEDED');
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

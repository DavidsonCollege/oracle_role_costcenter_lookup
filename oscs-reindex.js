'use strict';
// Oracle Search (OSCS) index rebuild after a Prod-to-Test refresh.
// Background: CLAUDE.md, "Search Index Rebuild: background". Runs each index ingest job one at a time, then
// the two ACL jobs, and stops on the first error or warning.
//
// No Electron imports here, so test/smoke.js can load the helpers in plain Node.
// main.js supplies fetch, the data folder, and the alert/progress callbacks.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ERP_PATH = '/fscmRestApi/resources/11.13.18.05/erpintegrations';
const ESS_PATH = '/ess/rest/scheduler/v1/requests';
const INDEX_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const CONFIG_FILE = 'oscs-reindex.config.json';

// ── Status handling ───────────────────────────────────────────────────────────
// ERP Integrations returns names (SUCCEEDED, ERROR...). The ESS scheduler may
// return names or numeric ESS state codes, so map both to names.

const ESS_STATE_CODES = {
  1: 'WAIT', 2: 'READY', 3: 'RUNNING', 4: 'COMPLETED', 5: 'BLOCKED', 6: 'HOLD',
  7: 'CANCELLING', 8: 'EXPIRED', 9: 'CANCELLED', 10: 'ERROR', 11: 'WARNING',
  12: 'SUCCEEDED', 13: 'PAUSED', 14: 'PENDING_VALIDATION', 15: 'VALIDATION_FAILED',
  16: 'SCHEDULE_ENDED', 17: 'FINISHED', 18: 'ERROR_AUTO_RETRY', 19: 'ERROR_MANUAL_RECOVERY',
};

// Final states other than SUCCEEDED. All of them stop the run for a person to review.
const FINAL_NOT_SUCCEEDED = new Set([
  'ERROR', 'WARNING', 'CANCELLED', 'EXPIRED', 'VALIDATION_FAILED',
  'ERROR_MANUAL_RECOVERY', 'SCHEDULE_ENDED', 'FINISHED',
]);

function normalizeStatus(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  if (/^\d+$/.test(String(raw).trim())) return ESS_STATE_CODES[Number(raw)] ?? `STATE_${raw}`;
  return String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function isFinalStatus(s) {
  if (!s) return false;
  if (s === 'SUCCEEDED' || FINAL_NOT_SUCCEEDED.has(s)) return true;
  // Unknown wording that clearly means failure is final too.
  return /FAIL|CANCEL(?!LING)|^ERROR/.test(s) && s !== 'ERROR_AUTO_RETRY';
}

// States whose requests have a log worth reading.
const hasLogState = s => s === 'SUCCEEDED' || s === 'WARNING' || s === 'ERROR';

const isIndexBusy = text => /being used by other job/i.test(String(text ?? ''));

// ── Config ────────────────────────────────────────────────────────────────────
// The bundled default ships with the app. The first time someone opens it from
// the UI, it is copied to the user data folder, and that copy wins from then on.

function userConfigPath(dataDir) { return path.join(dataDir, CONFIG_FILE); }

function loadConfig(dataDir, defaultPath) {
  const userPath = userConfigPath(dataDir);
  const p = fs.existsSync(userPath) ? userPath : defaultPath;
  return { config: JSON.parse(fs.readFileSync(p, 'utf8')), path: p, isUserCopy: p === userPath };
}

function ensureUserConfig(dataDir, defaultPath) {
  const userPath = userConfigPath(dataDir);
  if (!fs.existsSync(userPath)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(defaultPath, userPath);
  }
  return userPath;
}

// What differs between a personal copy and the shipped config, or null if
// nothing does. _readme text is ignored.
function summarizeConfigDiff(user, shipped) {
  const names = c => (Array.isArray(c.steps) ? c.steps.map(s => s?.index) : []);
  const u = names(user), d = names(shipped);
  const diffs = [];
  const onlyYours = u.filter(x => !d.includes(x));
  const onlyShipped = d.filter(x => !u.includes(x));
  if (onlyYours.length) diffs.push(`Only in your copy: ${onlyYours.join(', ')}`);
  if (onlyShipped.length) diffs.push(`Only in the shipped config: ${onlyShipped.join(', ')}`);
  const common = u.filter(x => d.includes(x));
  if (common.join() !== d.filter(x => u.includes(x)).join()) diffs.push('Steps are in a different order.');
  else if (JSON.stringify(user.steps?.filter(s => d.includes(s?.index))) !== JSON.stringify(shipped.steps?.filter(s => u.includes(s?.index)))) {
    diffs.push('Some step settings differ (area, notes or "verify").');
  }
  const jobKeys = [...new Set([...Object.keys(user.jobs ?? {}), ...Object.keys(shipped.jobs ?? {})])];
  const changedJobs = jobKeys.filter(k => JSON.stringify(user.jobs?.[k]) !== JSON.stringify(shipped.jobs?.[k]));
  if (changedJobs.length) diffs.push(`Job settings differ: ${changedJobs.join(', ')}`);
  if (JSON.stringify(user.exclusions ?? []) !== JSON.stringify(shipped.exclusions ?? [])) diffs.push('The exclusion list differs.');
  const rest = c => JSON.stringify({ ...c, _readme: null, steps: null, jobs: null, exclusions: null });
  if (rest(user) !== rest(shipped)) diffs.push('Other settings differ (Prod hosts, polling, retries or ACL steps).');
  return diffs.length ? diffs : null;
}

// Small, checked edits to the personal copy, so nobody edits JSON by hand:
// add an index step (after a given step), skip an index with a reason, or
// remove a step. Writes only if the result still validates.
function editUserConfig(dataDir, defaultPath, { action, index, after = null, area = '', notes = '', reason = '' } = {}) {
  const name = String(index ?? '').trim();
  if (!INDEX_NAME_RE.test(name)) throw new Error(`"${name}" is not a valid index name.`);
  const userPath = ensureUserConfig(dataDir, defaultPath);
  const config = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  config.steps = Array.isArray(config.steps) ? config.steps : [];
  config.exclusions = Array.isArray(config.exclusions) ? config.exclusions : [];
  const stepAt = config.steps.findIndex(s => s?.index === name);
  const exclAt = config.exclusions.findIndex(x => x?.index === name);
  let message;
  if (action === 'addStep') {
    if (stepAt >= 0) throw new Error(`${name} is already in the rebuild.`);
    if (exclAt >= 0) config.exclusions.splice(exclAt, 1);
    const step = { index: name };
    if (String(area).trim()) step.area = String(area).trim();
    if (String(notes).trim()) step.notes = String(notes).trim();
    const pos = after ? config.steps.findIndex(s => s?.index === after) : -1;
    if (after && pos < 0) throw new Error(`Can't find ${after} in the rebuild's steps.`);
    config.steps.splice(after ? pos + 1 : config.steps.length, 0, step);
    message = `Added ${name} to the rebuild${after ? ` after ${after}` : ''}.`;
  } else if (action === 'addExclusion') {
    if (!String(reason).trim()) throw new Error('Give a reason for skipping it.');
    if (exclAt >= 0) throw new Error(`${name} is already skipped.`);
    if (stepAt >= 0) config.steps.splice(stepAt, 1);
    config.exclusions.push({ index: name, reason: String(reason).trim() });
    message = `${name} will be skipped: ${String(reason).trim()}.`;
  } else if (action === 'removeStep') {
    if (stepAt < 0) throw new Error(`${name} isn't in the rebuild.`);
    config.steps.splice(stepAt, 1);
    message = `Removed ${name} from the rebuild.`;
  } else {
    throw new Error('Unknown config change.');
  }
  const v = validateConfig(config);
  if (v.errors.length) throw new Error(`Not saved: ${v.errors.join(' ')}`);
  const tmp = `${userPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, userPath);
  return { message, path: userPath };
}

// ── Asking T&I to ship a config change ─────────────────────────────────────

const CHANGE_REQUEST_TO = 'ti@davidson.edu';
const UPDATE_DOC_URL = 'https://github.com/DavidsonCollege/oracle_role_costcenter_lookup/blob/main/UPDATING_THE_INDEX_LIST.md';

// Index-level differences between a personal copy and the shipped config.
function describeConfigChanges(user, shipped) {
  const uSteps = Array.isArray(user.steps) ? user.steps : [];
  const dSteps = Array.isArray(shipped.steps) ? shipped.steps : [];
  const uEx = Array.isArray(user.exclusions) ? user.exclusions : [];
  const dEx = Array.isArray(shipped.exclusions) ? shipped.exclusions : [];
  const dNames = dSteps.map(s => s?.index), uNames = uSteps.map(s => s?.index);
  const exKey = x => x?.index ?? `prefix:${x?.prefix}`;
  const added = uSteps.map((s, i) => ({ step: s, after: uSteps[i - 1]?.index ?? null }))
    .filter(x => !dNames.includes(x.step?.index));
  const removed = dSteps.filter(s => !uNames.includes(s?.index));
  const skipped = uEx.filter(x => !dEx.some(d => exKey(d) === exKey(x) && d.reason === x.reason));
  const unskipped = dEx.filter(d => !uEx.some(x => exKey(x) === exKey(d)));
  const changedSteps = uSteps.filter(s => {
    const d = dSteps.find(x => x?.index === s?.index);
    return d && JSON.stringify(d) !== JSON.stringify(s);
  });
  const common = uNames.filter(n => dNames.includes(n));
  const reordered = common.join() !== dNames.filter(n => uNames.includes(n)).join();
  // Anything beyond the index lists (job settings, hosts, polling) is listed but not itemized.
  const other = (summarizeConfigDiff(user, shipped) ?? [])
    .filter(d => /^Job settings differ|^Other settings differ/.test(d));
  const any = added.length || removed.length || skipped.length || unskipped.length || changedSteps.length || reordered || other.length;
  return { added, removed, skipped, unskipped, changedSteps, reordered, other, any: !!any };
}

// The email to T&I: what changed and why, tests run, and how to ship it.
function buildChangeRequest({ changes, tests = {}, version = '', fileName = '' }) {
  const testLine = index => {
    const t = tests[index];
    if (!t) return '    Not tested with the app yet.';
    return `    Tested: request ${t.requestId} on ${t.instance}, ${t.status}${t.rows != null ? `, ${t.rows.toLocaleString('en-US')} rows` : t.recreateOnly ? ', recreate only' : ''} (${String(t.endedAt ?? '').slice(0, 10)}).`;
  };
  const L = [];
  L.push('Please assign this ticket to Admin Services.', '');
  L.push(`Requested change to the Search Index Rebuild's index list in the Oracle Access Request Lookup app${version ? ` (version ${version})` : ''}, so it applies to everyone's future runs.`, '');
  if (changes.added.length) {
    L.push('ADD to the rebuild:');
    for (const a of changes.added) {
      L.push(`- ${a.step.index}${a.after ? `, after ${a.after}` : ', at the start'}${a.step.area ? ` (${a.step.area})` : ''}`);
      L.push(`    Reason: ${a.step.notes || '(none given)'}`, testLine(a.step.index));
    }
    L.push('');
  }
  if (changes.skipped.length) {
    L.push("SKIP (add to the exclusions, don't rebuild):");
    for (const x of changes.skipped) {
      L.push(`- ${x.index ?? `indexes starting ${x.prefix}`}`, `    Reason: ${x.reason || '(none given)'}`);
      if (x.index) L.push(testLine(x.index));
    }
    L.push('');
  }
  if (changes.removed.length) {
    L.push('REMOVE from the rebuild:');
    for (const s of changes.removed) {
      const nowSkipped = changes.skipped.some(x => x.index === s.index);
      L.push(`- ${s.index}${nowSkipped ? ' (also skipped, above)' : ''}`);
    }
    L.push('');
  }
  if (changes.unskipped.length) {
    L.push('No longer skipped (remove from the exclusions):');
    for (const x of changes.unskipped) L.push(`- ${x.index ?? `indexes starting ${x.prefix}`}`);
    L.push('');
  }
  if (changes.changedSteps.length) {
    L.push('Changed settings (area, notes or "verify"):');
    for (const s of changes.changedSteps) L.push(`- ${s.index}: ${JSON.stringify(s)}`);
    L.push('');
  }
  if (changes.reordered) L.push('The order of the steps also differs. Compare with the attached file.', '');
  if (changes.other.length) L.push(...changes.other.map(o => `${o} Compare with the attached file; these may not be intended.`), '');

  const entries = [
    ...changes.added.map(a => `steps: ${JSON.stringify(a.step)}`),
    ...changes.skipped.map(x => `exclusions: ${JSON.stringify(x)}`),
  ];
  if (entries.length) L.push('Entries to copy into the shipped oscs-reindex.config.json:', ...entries, '');

  L.push(`ATTACHED: ${fileName || 'my oscs-reindex.config.json'}, my config with these changes. Use it to check the changes; copy only the changes listed above into the shipped config.`, '');
  L.push('HOW TO UPDATE THE APP');
  L.push('1. On a branch, apply the changes above to oscs-reindex.config.json in the repository.');
  L.push('2. Update the index count in test/smoke.js, then run npm test.');
  L.push('3. Run npm start, click Replace with shipped config, then Check index list on Production: the changed indexes should no longer show as New in Oracle or Missing from Oracle.');
  L.push('4. Bump the patch version in package.json, open a pull request, merge it, and push the version tag. GitHub Actions builds and publishes the release.');
  L.push('5. Tell me when it is released. I will click Replace with shipped config in the app.');
  L.push(`Full instructions: ${UPDATE_DOC_URL}`);

  const names = [...changes.added.map(a => a.step.index), ...changes.skipped.map(x => x.index ?? x.prefix), ...changes.removed.map(s => s.index)];
  const unique = [...new Set(names)];
  const subject = `Oracle Access Request Lookup: update the search index list${unique.length ? ` (${unique.slice(0, 3).join(', ')}${unique.length > 3 ? ', ...' : ''})` : ''} - assign to Admin Services`;
  return { to: CHANGE_REQUEST_TO, subject, body: L.join('\n') };
}

// Backs up the personal copy, then replaces it with the shipped config.
function resetUserConfig(dataDir, defaultPath) {
  const userPath = userConfigPath(dataDir);
  let backup = null;
  if (fs.existsSync(userPath)) {
    backup = path.join(dataDir, `oscs-reindex.config.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(userPath, backup);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(defaultPath, userPath);
  return { userPath, backup };
}

function validateJob(job, key) {
  if (!job) return [`Job "${key}" is missing from the config.`];
  const e = [];
  if (!['erp', 'ess'].includes(job.api)) e.push(`${key}: "api" must be "erp" or "ess".`);
  if (typeof job.packagePath !== 'string' || !job.packagePath.startsWith('/')) {
    e.push(`${key}: "packagePath" isn't set. Copy it from Manage Enterprise Scheduler Job Definitions (Path column).`);
  }
  if (!String(job.jobName ?? '').trim()) e.push(`${key}: "jobName" is blank.`);
  if (job.api === 'ess' && !String(job.application ?? '').trim()) e.push(`${key}: "application" is required when "api" is "ess".`);
  if (!Array.isArray(job.args)) {
    e.push(`${key}: "args" must be a list.`);
  } else {
    job.args.forEach((a, i) => {
      if (a?.omit === true) return; // deliberately not passed (e.g. an optional filter)
      if (a?.value == null || String(a.value).trim() === '') {
        e.push(`${key}: argument ${i + 1} has no value${a?.note ? ` (${a.note})` : ''}.`);
      }
    });
  }
  return e;
}

function validateConfig(config) {
  const errors = [];
  if (!Array.isArray(config.prodHosts) || config.prodHosts.length === 0) errors.push('"prodHosts" must list the Production host.');
  try { new RegExp(config.nonProdHostPattern); } catch { errors.push('"nonProdHostPattern" is not a valid regular expression.'); }

  const steps = Array.isArray(config.steps) ? config.steps : [];
  if (steps.length === 0) errors.push('"steps" is empty.');
  const seen = new Set();
  steps.forEach((s, i) => {
    const name = String(s?.index ?? '').trim();
    if (!name) errors.push(`Step ${i + 1} has a blank index name. A blank name rebuilds every index, so it is never submitted.`);
    else if (!INDEX_NAME_RE.test(name)) errors.push(`Step ${i + 1}: "${name}" is not a valid index name.`);
    else if (seen.has(name)) errors.push(`Step ${i + 1}: "${name}" is listed twice.`);
    seen.add(name);
  });

  if (config.exclusions != null && !Array.isArray(config.exclusions)) errors.push('"exclusions" must be a list.');
  (Array.isArray(config.exclusions) ? config.exclusions : []).forEach((x, i) => {
    if (!String(x?.index ?? x?.prefix ?? '').trim()) errors.push(`Exclusion ${i + 1} needs an "index" or "prefix".`);
    else if (x.index && seen.has(x.index)) errors.push(`"${x.index}" is both a step and an exclusion.`);
  });

  if (!Array.isArray(config.aclSteps)) errors.push('"aclSteps" must be a list of job keys.');
  const ingest = config.jobs?.ingest;
  if (ingest && Array.isArray(ingest.args) && !ingest.args.some(a => String(a?.value ?? '').includes('{index}'))) {
    errors.push('ingest: one argument must be "{index}" so each step passes its index name.');
  }

  // Job problems are kept per job: a single-step test only needs its own job to be complete.
  const jobErrors = {};
  for (const key of ['ingest', ...(config.aclSteps ?? [])]) jobErrors[key] = validateJob(config.jobs?.[key], key);
  return { errors, jobErrors };
}

function planSteps(config) {
  const ingest = config.steps.map(s => ({
    id: `ingest:${s.index}`, kind: 'ingest', jobKey: 'ingest', index: s.index,
    label: s.index, area: s.area ?? '', notes: s.notes ?? '', verify: s.verify === true,
  }));
  const acl = config.aclSteps.map(key => ({
    id: `acl:${key}`, kind: 'acl', jobKey: key, index: null,
    label: config.jobs?.[key]?.label ?? key, area: config.jobs?.[key]?.area ?? 'Search security', notes: '', verify: false,
  }));
  return [...ingest, ...acl];
}

// ── Prod guard ────────────────────────────────────────────────────────────────
// Allowlist, not denylist: the host must match the non-Prod pattern AND must not
// be a listed Prod host. confirmName must equal the instance name from the host.

function checkInstance(baseUrl, config, confirmName) {
  let host;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return { ok: false, error: 'The environment URL is not valid.' }; }
  if ((config.prodHosts ?? []).some(h => String(h).toLowerCase() === host)) {
    return { ok: false, error: `${host} is Production. Search index rebuilds never run against Prod.` };
  }
  let m;
  try { m = host.match(new RegExp(config.nonProdHostPattern, 'i')); } catch { m = null; }
  if (!m) return { ok: false, error: `${host} is not a recognized non-Prod instance, so the rebuild won't run.` };
  const name = (m[1] ?? m[0]).toLowerCase();
  if (confirmName !== undefined && String(confirmName ?? '').trim().toLowerCase() !== name) {
    return { ok: false, error: `Type the instance name "${name}" to confirm.`, name };
  }
  return { ok: true, name, host };
}

// ── Job arguments ─────────────────────────────────────────────────────────────

function buildArgs(job, step) {
  return job.args.map(a => (a.omit === true
    ? { omit: true }
    : { type: a.type || 'STRING', value: String(a.value).split('{index}').join(step.index ?? '') }));
}

// Last check before anything is sent to Oracle. Guardrail 2: a blank index name
// rebuilds every predefined index, so an ingest step must carry a valid name.
function assertSubmittable(step, args) {
  if (step.kind === 'ingest') {
    if (!step.index || !INDEX_NAME_RE.test(step.index)) throw new Error(`Refusing to submit: index name "${step.index ?? ''}" is blank or invalid.`);
    if (!args.some(a => a.value === step.index)) throw new Error('Refusing to submit: no argument carries the index name.');
  }
  if (step.kind === 'ingest' && args.some(a => a.omit)) throw new Error('Refusing to submit: ingest arguments cannot be omitted.');
  args.forEach((a, i) => {
    if (!a.omit && a.value.trim() === '') throw new Error(`Refusing to submit: argument ${i + 1} is blank.`);
  });
}

// ERP's ESSParameters is one comma-separated string; quote values with commas or quotes.
const erpArg = v => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// ── Minimal zip reader (ERP log downloads are base64 zips) ────────────────────

function unzipEntries(buf, depth = 0) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Log download is not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Log zip is damaged.');
    const method     = buf.readUInt16LE(p + 10);
    const csize      = buf.readUInt32LE(p + 20);
    const nameLen    = buf.readUInt16LE(p + 28);
    const extraLen   = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local      = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) continue;
    if (/\.zip$/i.test(name) && depth < 2) { out.push(...unzipEntries(data, depth + 1)); continue; }
    if (data.subarray(0, 2000).includes(0)) continue; // binary output (PDF etc.)
    out.push({ name, text: data.toString('utf8') });
  }
  return out;
}

// ── Log checks: a job can say Succeeded and still be wrong ───────

function sumMatches(text, pattern) {
  const re = new RegExp(pattern, 'gi');
  let total = null;
  for (const m of text.matchAll(re)) total = (total ?? 0) + Number(String(m[1]).replace(/,/g, ''));
  return total;
}

function maxMatch(text, pattern) {
  const re = new RegExp(pattern, 'gi');
  let max = null;
  for (const m of text.matchAll(re)) max = Math.max(max ?? 0, Number(String(m[1]).replace(/,/g, '')));
  return max;
}

function checkLog(job, step, log) {
  const c = job.logCheck ?? { type: 'none' };
  const issues = [];
  let rows = null;
  let recreateOnly = false;

  if (c.type === 'ingest') {
    // ACL indexes (fa-hcm-acl, fa-hcm-learn-acl) are only recreated empty;
    // their ACL jobs fill them later, so there's no row count to read.
    recreateOnly = /Only performing recreate for index/i.test(log);
    const failed = sumMatches(log, c.rowsFailedPattern);
    const notIngested = sumMatches(log, c.notIngestedPattern);
    rows = sumMatches(log, c.rowsPattern);
    if (failed > 0) issues.push(`Log shows ${failed} rows failed.`);
    if (notIngested > 0) issues.push(`Log shows ${notIngested} records not ingested.`);
    if (!log.toLowerCase().includes(String(step.index).toLowerCase())) issues.push(`Log doesn't mention the index ${step.index}.`);
    if (rows === 0 && step.verify) issues.push('0 rows ingested for an index marked "verify".');
  } else if (c.type === 'count') {
    for (const p of c.requiredPatterns ?? []) {
      if (!new RegExp(p, 'i').test(log)) issues.push(`Log doesn't contain the expected text /${p}/.`);
    }
    if (c.errorPattern) {
      const m = log.match(new RegExp(c.errorPattern));
      if (m) issues.push(`Log reports an error: "${m[0]}".`);
    }
    if (c.countPattern) {
      rows = maxMatch(log, c.countPattern);
      if (rows != null && c.minCount && rows < c.minCount) issues.push(`Count ${rows} is far below the expected ${c.expectedCount ?? c.minCount}.`);
    }
  }
  return { issues, rows, recreateOnly };
}

function logExcerpt(log, maxLines = 16) {
  // Skip per-user listing lines (Compute Users ACL logs one per user).
  const lines = log.split(/\r?\n/).filter(l => l.trim() && !/#Remaining Users/i.test(l));
  const hits = lines.filter(l => /fail|not ingested|error|exception|warning|done|total number|count/i.test(l));
  const src = hits.length ? hits : lines;
  // Keep both the start and the end: the outcome is usually at the end.
  const half = Math.floor(maxLines / 2);
  const pick = src.length <= maxLines ? src : [...src.slice(0, half), '…', ...src.slice(-half)];
  return pick.map(l => l.slice(0, 300)).join('\n');
}

// Inspect shows long logs as start + end, since the outcome is at the end.
function headTail(text, max = 20000) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n…[${(text.length - max).toLocaleString()} characters omitted]…\n\n${text.slice(-half)}`;
}

// ── Oracle API wrappers ───────────────────────────────────────────────────────
// submit(job, args) -> requestId, status(job, id) -> normalized status, log(id) -> text.
// The runner doesn't care which API a job uses; each job picks "erp" or "ess" in config.

function makeApi({ fetch, baseUrl, authHeader }) {
  const base = baseUrl.replace(/\/$/, '');
  const headers = contentType => ({
    Authorization: authHeader,
    Accept: 'application/json',
    ...(contentType ? { 'Content-Type': contentType } : {}),
  });

  async function call(url, opts, ms) {
    const res = await fetch(url, opts, ms);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { res, text, json };
  }

  function httpError(what, r) {
    const hint = r.res.status === 401 ? ' (check username and password)'
      : r.res.status === 403 ? ' (your account may lack the privilege, or you may need the Davidson network)' : '';
    const detail = r.json?.detail ?? r.json?.title ?? r.text;
    return new Error(`${what} failed: HTTP ${r.res.status}${hint}: ${String(detail ?? '').replace(/\s+/g, ' ').slice(0, 400)}`);
  }

  const checkId = id => {
    const s = String(id ?? '').trim();
    if (!/^\d+$/.test(s)) throw new Error(`Oracle did not return a usable request ID (got "${s}").`);
    return s;
  };

  async function submitErp(job, args) {
    const body = {
      OperationName : 'submitESSJobRequest',
      JobPackageName: job.packagePath,
      JobDefName    : job.jobName,
      ESSParameters : args.map(a => (a.omit ? '' : erpArg(a.value))).join(','),
    };
    const r = await call(`${base}${ERP_PATH}`, { method: 'POST', headers: headers('application/json'), body: JSON.stringify(body) }, 60000);
    if (!r.res.ok) throw httpError('Job submission', r);
    return checkId(r.json?.ReqstId);
  }

  async function submitEss(job, args) {
    const body = {
      jobDefinitionId  : `JobDefinition:/${job.packagePath}/${job.jobName}`,
      application      : job.application,
      requestParameters: [
        ...args.flatMap((a, i) => (a.omit ? [] : [{ name: `submit.argument${i + 1}`, paramType: a.type, value: a.value }])),
        ...(job.extraParameters ?? []).map(p => ({ name: p.name, paramType: p.type || 'STRING', value: String(p.value) })),
      ],
    };
    const r = await call(`${base}${ESS_PATH}`, { method: 'POST', headers: headers('application/json'), body: JSON.stringify(body) }, 60000);
    if (!r.res.ok) throw httpError('Job submission', r);
    const fromLocation = r.res.headers.get('location')?.match(/(\d+)\/?$/)?.[1];
    return checkId(r.json?.requestId ?? r.json?.id ?? fromLocation);
  }

  async function erpStatusRaw(id) {
    const r = await call(`${base}${ERP_PATH}?finder=ESSJobStatusRF;requestId=${checkId(id)}`, { headers: headers() }, 30000);
    if (!r.res.ok) throw httpError('Status check', r);
    return r.json;
  }

  // By default Oracle returns only requestId/state/stateDescription, so Inspect
  // asks for the fields it needs. If the field list is rejected, fall back.
  const DETAIL_FIELDS = 'requestId,state,stateDescription,jobDefinitionId,jobDisplayName,application,'
    + 'submitter,submissionTime,processStartTime,processEndTime,errorWarningMessage,requestParameters,'
    + 'previousState,retriedCount,executionAttempt';

  const LIST_FIELDS = 'requestId,state,jobDefinitionId,jobDisplayName,submitter,submissionTime,processEndTime';

  async function essRequest(id, { detailed = false } = {}) {
    const url = `${base}${ESS_PATH}/${checkId(id)}`;
    if (detailed) {
      const r = await call(`${url}?fields=${DETAIL_FIELDS}`, { headers: headers() }, 30000);
      if (r.res.ok) return r.json;
    }
    const r = await call(url, { headers: headers() }, 30000);
    if (!r.res.ok) throw httpError('Request lookup', r);
    return r.json;
  }

  async function status(job, id) {
    const raw = job.api === 'ess'
      ? (await essRequest(id))?.state
      : (await erpStatusRaw(id))?.items?.[0]?.RequestStatus;
    const s = normalizeStatus(raw);
    if (!s) throw new Error(`No status returned for request ${id}.`);
    return s;
  }

  // A request Oracle is auto-retrying has already failed once. Signs differ by
  // API and release, so check several. Returns null when there's no sign.
  async function retrySignal(id) {
    const j = await essRequest(id, { detailed: true });
    const reasons = [];
    const st = normalizeStatus(j?.state);
    if (st && /RETRY/.test(st)) reasons.push(`state ${st}`);
    if (/retry/i.test(String(j?.stateDescription ?? ''))) reasons.push(`"${j.stateDescription}"`);
    if (Number(j?.retriedCount) > 0) reasons.push(`retried ${j.retriedCount} time(s)`);
    if (Number(j?.executionAttempt) > 1) reasons.push(`attempt ${j.executionAttempt}`);
    if (normalizeStatus(j?.previousState) === 'ERROR') reasons.push('previous state ERROR');
    return reasons.length ? { reasons, message: j?.errorWarningMessage ?? null } : null;
  }

  // Only ERP Integrations documents a log download, so both APIs use it.
  async function log(id) {
    const url = `${base}${ERP_PATH}?finder=ESSJobExecutionDetailsRF;requestId=${checkId(id)},fileType=LOG`;
    const r = await call(url, { headers: headers() }, 120000);
    if (!r.res.ok) throw httpError('Log download', r);
    const b64 = r.json?.items?.[0]?.DocumentContent;
    if (!b64) throw new Error(`Oracle has no log for request ${id}; the job probably never ran.`);
    const files = unzipEntries(Buffer.from(b64, 'base64'));
    if (files.length === 0) throw new Error(`Oracle has no log for request ${id}; the job probably never ran.`);
    return files.map(f => `===== ${f.name} =====\n${f.text}`).join('\n');
  }

  // One page of the ESS request search. Oracle's filter support varies by
  // release, so the caller checks what comes back rather than trusting q.
  async function searchRequests({ q, limit = 200, offset = 0, orderBy = null }) {
    const qs = new URLSearchParams({ fields: LIST_FIELDS, limit: String(limit), offset: String(offset) });
    if (q) qs.set('q', q);
    if (orderBy) qs.set('orderBy', orderBy);
    const r = await call(`${base}${ESS_PATH}?${qs}`, { headers: headers() }, 60000);
    if (!r.res.ok) throw httpError('Request search', r);
    const items = r.json?.items ?? r.json?.requests ?? r.json?.value ?? (Array.isArray(r.json) ? r.json : []);
    return { items: Array.isArray(items) ? items : [], hasMore: r.json?.hasMore === true, raw: r.json };
  }

  return {
    submit: (job, args) => (job.api === 'ess' ? submitEss(job, args) : submitErp(job, args)),
    status, log, essRequest, erpStatusRaw, retrySignal, searchRequests,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

// ── Finding Oracle's own requests and checking the index list ────────────────

const reqId   = it => String(it?.requestId ?? it?.id ?? '');
const reqJob  = it => String(it?.jobDefinitionId ?? it?.jobDefinitionName ?? it?.jobDefinition ?? it?.name ?? '');
const reqUser = it => (it?.submitter ?? it?.submittedBy ?? it?.userName ?? null);
const reqTime = it => (it?.submissionTime ?? it?.submittedTime ?? null);

// Pulls every index name out of "Indices (created): [a, b, c]" lines.
// Oracle's progress counters on a request (FA_EMCC_counter_1_*), checked
// against the job's counterCheck. Some jobs say Succeeded but did nothing.
function checkCounters(job, essRequestJson) {
  const c = job.counterCheck;
  if (!c) return { issues: [], rows: null };
  const params = Array.isArray(essRequestJson?.requestParameters) ? essRequestJson.requestParameters : [];
  const num = name => {
    const v = params.find(p => p?.name === `FA_EMCC_counter_1_${name}`)?.value;
    return v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
  };
  const total = num('total'), processed = num('processed'), failed = num('failed');
  const issues = [];
  if (total == null) {
    if (c.minTotal != null || c.maxFailed != null) issues.push("Oracle didn't report progress counters, so the app couldn't confirm the job did anything.");
  } else {
    if (c.minTotal != null && total < c.minTotal) issues.push(`Oracle's counters show ${total} items in total. The job probably did nothing (check the Indexing Mode).`);
    if (c.maxFailed != null && failed != null && failed > c.maxFailed) issues.push(`Oracle's counters show ${failed} of ${total} items failed.`);
  }
  // Some parents hand the work to child requests and never update "processed".
  return { issues, rows: c.rowsFrom === 'total' ? total : processed };
}

function parseCreatedIndices(log) {
  const found = new Set();
  for (const m of String(log ?? '').matchAll(/Indices\s*\(created\)\s*:\s*\[([^\]]*)\]/gi)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^["']|["']$/g, '').trim();
      if (INDEX_NAME_RE.test(name)) found.add(name);
    }
  }
  return [...found].sort();
}

// Oracle's list vs the config: new, missing and excluded on purpose.
function compareIndexes(oracleNames, config) {
  const steps = (config.steps ?? []).map(s => s.index);
  const excl = Array.isArray(config.exclusions) ? config.exclusions : [];
  const exclusionFor = name => excl.find(x => (x.index ? x.index === name : x.prefix && name.startsWith(x.prefix)));
  const inOracle = new Set(oracleNames);
  return {
    newInOracle: oracleNames.filter(n => !steps.includes(n) && !exclusionFor(n)),
    missingFromOracle: steps.filter(n => !inOracle.has(n)),
    excluded: oracleNames.filter(n => !steps.includes(n) && exclusionFor(n))
      .map(n => ({ index: n, reason: exclusionFor(n).reason ?? '' })),
    matched: steps.filter(n => inOracle.has(n)).length,
  };
}

function createReindexer({ fetch, dataDir, defaultConfigPath, onProgress, onAlert, getSlackWebhook,
                           sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const runsDir = path.join(dataDir, 'oscs-runs');
  let active = null; // { run, stopRequested }

  const iso = () => new Date().toISOString();
  const clone = o => JSON.parse(JSON.stringify(o));

  function save(run) {
    fs.mkdirSync(runsDir, { recursive: true });
    const f = path.join(runsDir, `${run.id}.json`);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(run, null, 2), 'utf8');
    fs.renameSync(`${f}.tmp`, f);
  }

  function emit(run) {
    try { save(run); delete run.saveError; } catch (e) { run.saveError = `Could not save the run record: ${e.message}`; }
    onProgress?.(clone(run));
  }

  function loadRun(id) {
    if (!/^[\w-]+$/.test(String(id ?? ''))) throw new Error('Invalid run ID.');
    return JSON.parse(fs.readFileSync(path.join(runsDir, `${id}.json`), 'utf8'));
  }

  function listRuns() {
    let files = [];
    try { files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json')); } catch { return []; }
    return files
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, 20)
      .map(r => ({
        id: r.id, mode: r.mode, instance: r.instance, startedAt: r.startedAt, endedAt: r.endedAt,
        status: r.status, stopReason: r.stopReason,
        steps: r.steps.map(s => ({ id: s.id, label: s.label, status: s.status })),
      }));
  }

  function newStepRecord(p) {
    return { ...p, status: 'PENDING', requestId: null, submittedAt: null, endedAt: null,
             oracleStatus: null, rows: null, issues: [], note: '', logExcerpt: null, attempts: [] };
  }

  async function postSlack(text) {
    const url = await getSlackWebhook?.();
    if (!url) return 'not configured';
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }, 15000);
      return res.ok ? 'sent' : `failed (HTTP ${res.status})`;
    } catch (e) {
      return `failed (${e.message})`;
    }
  }

  function formatStop(run, step) {
    const lines = [`:rotating_light: *OSCS index rebuild stopped* on *${run.instance}*`];
    if (step) {
      const pos = run.steps.indexOf(step) + 1;
      lines.push(`Step ${pos} of ${run.steps.length}: ${step.index ? `\`${step.index}\`` : step.label}`);
      lines.push(`Request ${step.requestId ?? '(not submitted)'}: *${step.status}*`);
      for (const i of step.issues) lines.push(`• ${i}`);
      if (step.logExcerpt) lines.push('Log excerpt:\n```' + step.logExcerpt.slice(0, 1500) + '```');
    }
    if (run.stopReason) lines.push(run.stopReason);
    lines.push(`Steps after this one were not submitted. Review before resuming. Run record: ${run.id}`);
    return lines.join('\n');
  }

  function formatSummary(run) {
    const mins = Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 60000);
    const resumed = run.resumes?.length ? `, resumed ${run.resumes.length} time${run.resumes.length === 1 ? '' : 's'}` : '';
    const lines = [`:white_check_mark: *OSCS index rebuild finished* on *${run.instance}* (${run.steps.length} steps, ${mins} min${resumed})`];
    for (const s of run.steps) {
      lines.push(`${s.status === 'SUCCEEDED' ? '✓' : '•'} ${s.index ?? s.label}: ${s.status}${s.requestId ? ` (request ${s.requestId})` : ''}${s.rows != null ? `, ${s.rows.toLocaleString()} rows` : s.recreateOnly ? ', recreate only' : ''}`);
    }
    return lines.join('\n');
  }

  // Short version for the in-app dialog; the table on the tab has the detail.
  function formatSummaryShort(run) {
    const mins = Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 60000);
    const ok = run.steps.filter(s => s.status === 'SUCCEEDED').length;
    const acl = run.steps.filter(s => s.kind === 'acl' && s.rows != null).map(s => `${s.label}: ${s.rows.toLocaleString()}`);
    return [
      `${ok} of ${run.steps.length} steps succeeded on ${run.instance} in ${mins} min${run.resumes?.length ? ` (resumed ${run.resumes.length} time${run.resumes.length === 1 ? '' : 's'})` : ''}.`,
      ...acl,
      'See the table on the Run Index Jobs tab in the app for every step.',
    ].join('\n');
  }

  async function alert(run, level, text, step) {
    // Testers can turn Slack off for a run so the channel only gets real runs.
    const slack = run.slackOff ? 'off for this run' : await postSlack(text);
    run.alerts.push({ at: iso(), level, slack, text });
    emit(run);
    const dialogText = level === 'complete' && run.mode !== 'single' ? formatSummaryShort(run) : text;
    onAlert?.({ level, text: dialogText, slack, run: clone(run), stepLabel: step?.label ?? null });
  }

  function finish(run, status, reason) {
    run.status = status;
    run.stopReason = reason ?? null;
    run.endedAt = iso();
    emit(run);
  }

  async function waitForFinal(run, step, job, config) {
    const deadline = Date.now() + (job.timeoutMinutes ?? 60) * 60000;
    const pollMs = Math.max(10, config.pollSeconds ?? 30) * 1000;
    let failures = 0;
    for (;;) {
      await sleep(pollMs);
      try {
        const s = await active.api.status(job, step.requestId);
        failures = 0;
        if (s !== step.oracleStatus) { step.oracleStatus = s; emit(run); }
        if (isFinalStatus(s)) return s;
        if (config.stopOnRetry !== false) {
          let retry = null;
          try { retry = await active.api.retrySignal(step.requestId); } catch { /* can't tell; keep waiting */ }
          if (retry) {
            const err = new Error(`Oracle is retrying request ${step.requestId} after it failed (${retry.reasons.join(', ')})`
              + `${retry.message ? `: ${retry.message}` : ''}.`);
            err.retrying = true;
            throw err;
          }
        }
      } catch (e) {
        if (e.retrying) throw e;
        failures++;
        step.note = `Status check failed (${failures}): ${e.message}`;
        emit(run);
        if (failures >= (config.maxStatusFailures ?? 10)) throw new Error(`Lost contact with Oracle while waiting for request ${step.requestId}: ${e.message}`);
      }
      if (Date.now() > deadline) throw new Error(`Request ${step.requestId} hadn't finished after ${job.timeoutMinutes ?? 60} minutes.`);
    }
  }

  async function runStep(run, step, config) {
    const job = config.jobs[step.jobKey];
    const args = buildArgs(job, step);
    assertSubmittable(step, args);
    const busy = { waitMinutes: 5, maxRetries: 3, ...(config.busyRetry ?? {}) };

    for (let attempt = 0; ; attempt++) {
      Object.assign(step, { status: 'SUBMITTING', requestId: null, submittedAt: iso(), endedAt: null,
                            oracleStatus: null, rows: null, issues: [], logExcerpt: null });
      emit(run);

      const waitBusy = async () => {
        step.status = 'WAITING';
        step.note = `Index busy with another job. Retry ${attempt + 1} of ${busy.maxRetries} in ${busy.waitMinutes} min.`;
        emit(run);
        await sleep(busy.waitMinutes * 60000);
      };

      try {
        step.requestId = await active.api.submit(job, args);
      } catch (e) {
        if (isIndexBusy(e.message) && attempt < busy.maxRetries) { await waitBusy(); continue; }
        Object.assign(step, { status: 'ERROR', endedAt: iso(), issues: [`Submission failed: ${e.message}`] });
        emit(run);
        return step.status;
      }
      step.attempts.push({ requestId: step.requestId, submittedAt: step.submittedAt });
      step.status = 'RUNNING';
      step.note = '';
      emit(run);

      let final;
      try {
        final = await waitForFinal(run, step, job, config);
      } catch (e) {
        if (e.retrying) {
          Object.assign(step, { status: 'ERROR', oracleStatus: 'RETRYING', endedAt: iso(),
            issues: [`${e.message} Stopped instead of waiting for the retries. Oracle keeps retrying it; cancel it in Scheduled Processes if it shouldn't run.`] });
          emit(run);
          return step.status;
        }
        Object.assign(step, { status: 'UNKNOWN', endedAt: iso(),
          issues: [`${e.message} The job may still be running in Oracle; check Scheduled Processes.`] });
        emit(run);
        return step.status;
      }
      step.oracleStatus = final;
      step.endedAt = iso();
      step.note = '';

      let log = null, logErr = null;
      try { log = await active.api.log(step.requestId); } catch (e) { logErr = e.message; }

      if (final !== 'SUCCEEDED' && isIndexBusy(log) && attempt < busy.maxRetries) { await waitBusy(); continue; }

      if (final === 'SUCCEEDED') {
        const res = log != null ? checkLog(job, step, log)
          : { rows: null, issues: job.requireLogCheck === false ? [] : [`Couldn't read the log to check it: ${logErr}`] };
        if (job.counterCheck) {
          let ess = null;
          try { ess = await active.api.essRequest(step.requestId, { detailed: true }); }
          catch (e) { res.issues.push(`Couldn't read Oracle's progress counters: ${e.message}`); }
          if (ess) {
            const cc = checkCounters(job, ess);
            res.issues.push(...cc.issues);
            if (cc.rows != null) res.rows = cc.rows;
          }
        }
        step.rows = res.rows;
        step.recreateOnly = res.recreateOnly === true;
        step.issues = res.issues;
        step.status = res.issues.length ? 'WARNING' : 'SUCCEEDED';
      } else {
        step.status = final;
        if (logErr) step.issues.push(`Couldn't read the log: ${logErr}`);
      }
      step.logExcerpt = log ? logExcerpt(log) : null;
      emit(run);
      return step.status;
    }
  }

  async function execute(run, ids, config) {
    let step = null;
    try {
      for (const id of ids) {
        step = run.steps.find(s => s.id === id);
        if (active.stopRequested) {
          finish(run, 'stopped', `Stopped by request before ${step.label}.`);
          await alert(run, 'stopped', formatStop(run, null), null);
          return;
        }
        // Guardrail 5: ACL jobs only after every ingest step in this run succeeded.
        if (step.kind === 'acl' && run.mode !== 'single') {
          const notDone = run.steps.filter(s => s.kind === 'ingest' && s.status !== 'SUCCEEDED');
          if (notDone.length) {
            finish(run, 'stopped', `ACL jobs not submitted: ${notDone.length} ingest step(s) haven't succeeded (${notDone.slice(0, 5).map(s => s.label).join(', ')}${notDone.length > 5 ? '…' : ''}).`);
            await alert(run, 'error', formatStop(run, null), null);
            return;
          }
        }
        const result = await runStep(run, step, config);
        if (result !== 'SUCCEEDED') {
          finish(run, 'stopped', null);
          await alert(run, 'error', formatStop(run, step), step);
          return;
        }
      }
      finish(run, 'completed', null);
      await alert(run, 'complete', run.mode === 'single'
        ? `:white_check_mark: OSCS test step on *${run.instance}*: ${run.steps[0].label} succeeded (request ${run.steps[0].requestId}).`
        : formatSummary(run), null);
    } catch (e) {
      if (step && !['SUCCEEDED', 'WARNING', 'ERROR', 'UNKNOWN'].includes(step.status)) {
        Object.assign(step, { status: 'ERROR', endedAt: iso(), issues: [...step.issues, e.message] });
      }
      finish(run, 'stopped', `Unexpected problem: ${e.message}`);
      await alert(run, 'error', formatStop(run, step), step).catch(() => {});
    }
  }

  function start(params) {
    if (active) return { ok: false, error: 'A rebuild is already running.' };
    const { baseUrl, username, password, confirmName, mode, stepId, runId, fromStepId, slack = true } = params ?? {};
    if (!username || !password) return { ok: false, error: 'Enter your username and password first.' };

    let config;
    try { config = loadConfig(dataDir, defaultConfigPath).config; } catch (e) { return { ok: false, error: `Couldn't read the config file: ${e.message}` }; }
    const v = validateConfig(config);
    if (v.errors.length) return { ok: false, error: `Fix the config first:\n${v.errors.join('\n')}` };
    const inst = checkInstance(baseUrl, config, confirmName);
    if (!inst.ok) return inst;

    const planned = planSteps(config);
    const jobProblems = keys => [...new Set(keys)].flatMap(k => v.jobErrors[k] ?? validateJob(config.jobs?.[k], k));

    let run, ids;
    if (mode === 'single') {
      const p = planned.find(s => s.id === stepId);
      if (!p) return { ok: false, error: 'Choose a step to test.' };
      const problems = jobProblems([p.jobKey]);
      if (problems.length) return { ok: false, error: `Fix the config first:\n${problems.join('\n')}` };
      run = { steps: [newStepRecord(p)] };
      ids = [p.id];
    } else if (mode === 'full' || mode === 'resume') {
      const problems = jobProblems(planned.map(s => s.jobKey));
      if (problems.length) return { ok: false, error: `Fix the config before a full run (every job must be complete, so the ACL jobs can't fail after the ingests):\n${problems.join('\n')}` };
      if (mode === 'full') {
        run = { steps: planned.map(newStepRecord) };
        ids = planned.map(s => s.id);
      } else {
        let prior;
        try { prior = loadRun(runId); } catch (e) { return { ok: false, error: `Couldn't open that run record: ${e.message}` }; }
        if (prior.mode !== 'full') return { ok: false, error: 'Only a full run can be resumed.' };
        if (prior.instance !== inst.name) return { ok: false, error: `That run was on ${prior.instance}, not ${inst.name}.` };
        const from = planned.findIndex(s => s.id === fromStepId);
        if (from < 0) return { ok: false, error: 'Choose the step to resume from.' };
        // Uses the current config's step list, matched to earlier results by step ID,
        // so a "verify" index removed from the config drops out of the ACL gate too.
        const byId = new Map(prior.steps.map(s => [s.id, s]));
        run = prior;
        run.steps = planned.map(p => (byId.has(p.id) ? { ...byId.get(p.id), ...p, status: byId.get(p.id).status } : newStepRecord(p)));
        run.resumes = [...(run.resumes ?? []), { at: iso(), fromStepId }];
        ids = planned.slice(from).map(s => s.id).filter(id => run.steps.find(s => s.id === id).status !== 'SUCCEEDED');
        if (ids.length === 0) return { ok: false, error: 'Every step from there on already succeeded in that run.' };
      }
    } else {
      return { ok: false, error: 'Unknown mode.' };
    }

    if (!run.id) {
      Object.assign(run, {
        id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${inst.name}`,
        mode, instance: inst.name, host: inst.host, username, startedAt: iso(), alerts: [],
      });
    }
    // Set on every start, so a resume can turn Slack back on (or off).
    Object.assign(run, { status: 'running', endedAt: null, stopReason: null, slackOff: slack === false });

    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    active = { run, stopRequested: false, api: makeApi({ fetch, baseUrl, authHeader }) };
    emit(run);
    execute(run, ids, config).finally(() => { active = null; onProgress?.(clone(run)); });
    return { ok: true, run: clone(run) };
  }

  function stop() {
    if (!active) return { ok: false, error: 'Nothing is running.' };
    active.stopRequested = true;
    return { ok: true };
  }

  // Read-only lookup of one request, for checking parameters of past runs
  // (spec 5b tip). Allowed on any instance, including Prod, since it changes nothing.
  async function inspect({ baseUrl, username, password, requestId }) {
    if (!/^\d+$/.test(String(requestId ?? '').trim())) return { ok: false, error: 'Enter a numeric request ID.' };
    const api = makeApi({ fetch, baseUrl, authHeader: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` });
    const id = String(requestId).trim();
    const [ess, erp, log] = await Promise.allSettled([api.essRequest(id, { detailed: true }), api.erpStatusRaw(id), api.log(id)]);
    const val = r => (r.status === 'fulfilled' ? r.value : { error: r.reason.message });
    return {
      ok: true,
      essRequest: val(ess),
      erpStatus : erp.status === 'fulfilled' ? (erp.value?.items?.[0] ?? erp.value) : { error: erp.reason.message },
      log       : log.status === 'fulfilled' ? headTail(log.value) : null,
      logError  : log.status === 'rejected' ? log.reason.message : null,
    };
  }

  const apiFor = ({ baseUrl, username, password }) =>
    makeApi({ fetch, baseUrl, authHeader: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` });

  // Finds recent requests for one job, newest first. Read-only, so any instance
  // (including Prod) is allowed. Oracle's filter, sort and paging support isn't
  // documented for our release, so each is tried, checked against what comes
  // back, and re-applied here. Notes explain what worked, for troubleshooting.
  async function findRequests({ baseUrl, username, password, jobName, submitter, days, paramValue = null,
    onPage = null, timeLimitMs = 150000 }) {
    if (!baseUrl || !username || !password) return { ok: false, error: 'Enter the environment, username and password first.' };
    if (!/^[A-Za-z0-9_]+$/.test(String(jobName ?? ''))) return { ok: false, error: 'Unknown job name.' };
    // Submitter and search window default to the config's indexCheck settings.
    if (submitter === undefined || days === undefined) {
      let ic = {};
      try { ic = loadConfig(dataDir, defaultConfigPath).config.indexCheck ?? {}; } catch { /* use defaults */ }
      if (submitter === undefined) submitter = ic.submitter ?? 'FAADMIN';
      if (days === undefined) days = ic.days ?? 120;
    }
    const api = apiFor({ baseUrl, username, password });
    const since = new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
    const isJob = it => reqJob(it).toLowerCase().includes(jobName.toLowerCase());
    const isUser = it => !submitter || !reqUser(it) || String(reqUser(it)).toUpperCase() === submitter.toUpperCase();
    // Optional: only requests with this parameter value (e.g. an index name).
    const hasParam = it => !paramValue || JSON.stringify(it?.requestParameters ?? []).includes(`"${paramValue}"`);
    const want = it => isJob(it) && isUser(it) && hasParam(it);
    const time = it => Date.parse(reqTime(it) ?? '') || null;
    // No submitter filter on Oracle's side: it's case-sensitive there, and Oracle
    // records FAAdmin for some jobs and FAADMIN for others. isUser ignores case.
    const tries = [
      { label: 'job filter', q: `jobDefinitionId co "${jobName}" and submissionTime gt "${since}"` },
      { label: 'date filter', q: `submissionTime gt "${since}"` },
    ];
    const LIMIT = 200, MAX_PAGES = 50;
    const deadline = Date.now() + timeLimitMs;
    const notes = [];
    for (const t of tries) {
      if (Date.now() > deadline) break;
      let orderBy = 'submissionTime:desc';
      let items = [], pages = 0, sampleKeys = null, stopNote = '';
      try {
        for (;;) {
          if (Date.now() > deadline) { stopNote = `; stopped at the ${Math.round(timeLimitMs / 1000)}-second time limit, so older requests weren't searched`; break; }
          let page;
          try {
            page = await api.searchRequests({ q: t.q, offset: items.length, limit: LIMIT, orderBy });
          } catch (e) {
            if (!orderBy || pages > 0) throw e;
            notes.push(`${t.label}: sorting newest first was refused (${e.message.slice(0, 120)}); trying without it.`);
            orderBy = null;
            continue;
          }
          pages++;
          if (!sampleKeys && page.items[0]) sampleKeys = Object.keys(page.items[0]);
          if (items.length && page.items[0] && reqId(page.items[0]) === reqId(items[0])) { stopNote = '; Oracle ignored the page offset'; break; }
          items.push(...page.items);
          onPage?.({ label: t.label, pages, searched: items.length, matches: items.filter(want).length });
          // Stop once Oracle has clearly sorted newest first and we have plenty of candidates.
          const times = items.map(time);
          const sortedDesc = times.every(x => x != null) && times.every((x, i) => i === 0 || x <= times[i - 1]);
          if (sortedDesc && items.filter(want).filter(it => hasLogState(normalizeStatus(it.state))).length >= 10) { stopNote = '; sorted newest first, so stopped early'; break; }
          if (!(page.hasMore || page.items.length >= LIMIT) || page.items.length === 0) break;
          if (pages >= MAX_PAGES) { stopNote = `; stopped after ${MAX_PAGES} pages, so the newest requests may be missing`; break; }
        }
      } catch (e) {
        notes.push(`${t.label}: ${e.message}`);
        continue;
      }
      // Oracle's search results leave requestParameters empty, so when matching
      // by parameter, open each request of this job (as Inspect does) and check.
      let detailNote = '';
      if (paramValue && items.some(isJob) && !items.some(it => Array.isArray(it?.requestParameters))) {
        const todo = items.filter(it => isJob(it) && isUser(it)).slice(0, 100);
        let opened = 0, failed = 0;
        for (let i = 0; i < todo.length && Date.now() <= deadline; i += 5) {
          await Promise.all(todo.slice(i, i + 5).map(async it => {
            try {
              const d = await api.essRequest(reqId(it), { detailed: true });
              it.requestParameters = Array.isArray(d?.requestParameters) ? d.requestParameters : [];
              opened++;
            } catch { failed++; }
          }));
          onPage?.({ label: 'opening requests', pages, searched: opened, matches: items.filter(want).length });
        }
        detailNote = `; search results had no parameters, so opened ${opened} request(s) to read them${failed ? ` (${failed} failed)` : ''}${opened + failed < todo.length ? ', stopped at the time limit' : ''}`;
      }
      const matches = items.filter(want);
      notes.push(`${t.label}: ${items.length} request(s) in ${pages} page(s), ${matches.length} for ${jobName}${submitter ? ` by ${submitter}` : ''}${paramValue ? ` with ${paramValue}` : ''}${stopNote}${detailNote}`);
      if (items.length && !items.some(it => reqJob(it))) {
        notes.push('Oracle returned requests without a job name, so they can\'t be matched.');
        continue;
      }
      // If Oracle honored the job filter (everything returned is this job), its
      // answer stands: falling back to a date-only search would page through
      // every request in Production.
      const filterHonored = t.label === 'job filter' && items.every(isJob);
      if (!matches.length) {
        if (filterHonored) break;
        continue;
      }
      // Request IDs increase over time, so the highest ID is the newest.
      const list = matches
        .sort((x, y) => Number(reqId(y)) - Number(reqId(x)))
        .map(it => ({ requestId: reqId(it), state: normalizeStatus(it.state) ?? String(it.state ?? ''), submitter: reqUser(it), submitted: reqTime(it), job: reqJob(it) }));
      // "Latest" is the newest run that has a log: Succeeded, Warning or Error.
      // Canceled runs and the next scheduled run (still waiting) have none.
      const latest = list.find(r => hasLogState(r.state)) ?? null;
      return { ok: true, method: t.label, requests: list, latest, notes };
    }
    const what = `${jobName} request${paramValue ? ` for ${paramValue}` : ''}${submitter ? ` submitted by ${submitter}` : ''}`;
    return { ok: false, error: Date.now() > deadline
      ? `Couldn't find a ${what} before the time limit. Open "How the app searched" for details.`
      : `Couldn't find a ${what} in the last ${days} days.`, notes };
  }

  // Reads Production's index list from the latest reindex log that has one and
  // compares it with the config. Read-only.
  async function checkIndexList({ onPage, ...creds }) {
    const { config } = loadConfig(dataDir, defaultConfigPath);
    const ic = { jobName: 'FndOSCSReindexJob', submitter: 'FAADMIN', days: 120, ...(config.indexCheck ?? {}) };
    const host = (() => { try { return new URL(creds.baseUrl).host.toLowerCase(); } catch { return ''; } })();
    const isProd = (config.prodHosts ?? []).some(h => h.toLowerCase() === host);
    const found = await findRequests({ ...creds, ...ic, onPage });
    if (!found.ok) return { ...found, host, isProd };
    const api = apiFor(creds);
    const tried = [];
    // Only runs that produce a log; canceled and waiting runs are skipped silently.
    for (const r of found.requests.filter(x => hasLogState(x.state)).slice(0, 10)) {
      let names = [];
      try { names = parseCreatedIndices(await api.log(r.requestId)); }
      catch (e) { tried.push(`${r.requestId}: ${e.message}`); continue; }
      if (!names.length) { tried.push(`${r.requestId}: no "Indices (created)" line. Normal for a run that had nothing to reindex or didn't finish; not an error.`); continue; }
      let submitted = r.submitted;
      if (!submitted) {
        try { submitted = (await api.essRequest(r.requestId, { detailed: true }))?.submissionTime ?? null; } catch { /* date stays unknown */ }
      }
      const ageDays = submitted && Date.parse(submitted) ? Math.floor((Date.now() - Date.parse(submitted)) / 86400000) : null;
      return {
        ok: true, host, isProd, request: { ...r, submitted }, ageDays, oracleCount: names.length,
        noExclusions: !(Array.isArray(config.exclusions) && config.exclusions.length),
        ...compareIndexes(names, config), tried, notes: found.notes, method: found.method,
      };
    }
    return { ok: false, host, isProd, error: `None of the most recent finished ${ic.jobName} requests had an "Indices (created)" line in its log.`, tried, notes: found.notes };
  }

  // Who created an index: ingest requests (any submitter) with that index as a parameter.
  async function findIndexRequests({ index, ...creds }) {
    if (!INDEX_NAME_RE.test(String(index ?? ''))) return { ok: false, error: 'Not a valid index name.' };
    let jobName = 'FndOSCSIndexIngestJob', days = 120;
    try {
      const { config } = loadConfig(dataDir, defaultConfigPath);
      jobName = config.jobs?.ingest?.jobName ?? jobName;
      days = config.indexCheck?.days ?? days;
    } catch { /* defaults */ }
    return findRequests({ ...creds, jobName, submitter: null, days, paramValue: index });
  }

  function getConfigInfo(baseUrl) {
    try {
      const { config, path: p, isUserCopy } = loadConfig(dataDir, defaultConfigPath);
      const v = validateConfig(config);
      const inst = baseUrl ? checkInstance(baseUrl, config) : null;
      let differences = null;
      if (isUserCopy) {
        try { differences = summarizeConfigDiff(config, JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'))); }
        catch { differences = ["Couldn't read the shipped config to compare."]; }
      }
      return { ok: true, path: p, isUserCopy, differences, steps: planSteps(config), errors: v.errors, jobErrors: v.jobErrors, instance: inst };
    } catch (e) {
      return { ok: false, error: `Couldn't read the config file: ${e.message}` };
    }
  }

  return {
    start, stop, inspect, listRuns, getConfigInfo, findRequests, checkIndexList, findIndexRequests,
    postSlack,
    isRunning: () => !!active,
    current  : () => (active ? clone(active.run) : null),
    runsDir,
    ensureUserConfig: () => ensureUserConfig(dataDir, defaultConfigPath),
    resetUserConfig: () => {
      if (active) throw new Error("Can't replace the config while a rebuild is running.");
      return resetUserConfig(dataDir, defaultConfigPath);
    },
    // Everything the "Email this change to T&I" button needs. Throws if nothing changed.
    prepareChangeRequest: ({ version } = {}) => {
      const userPath = userConfigPath(dataDir);
      if (!fs.existsSync(userPath)) throw new Error('You have no changes: the app is using the shipped config.');
      const configText = fs.readFileSync(userPath, 'utf8');
      const changes = describeConfigChanges(JSON.parse(configText), JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8')));
      if (!changes.any) throw new Error('Your config matches the shipped one, so there is nothing to send.');
      // Latest single-step test of each changed index, from the run records.
      const tests = {};
      let files = [];
      try { files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json')); } catch { /* no runs yet */ }
      const runs = files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch { return null; } })
        .filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      for (const r of runs) {
        for (const s of r.steps ?? []) {
          if (s.index && s.requestId && !tests[s.index] && ['SUCCEEDED', 'WARNING', 'ERROR'].includes(s.status)) {
            tests[s.index] = { requestId: s.requestId, instance: r.instance, status: s.status, rows: s.rows, recreateOnly: s.recreateOnly, endedAt: s.endedAt };
          }
        }
      }
      return { changes, tests, configText };
    },
    editUserConfig: change => {
      if (active) throw new Error("Can't change the config while a rebuild is running.");
      return editUserConfig(dataDir, defaultConfigPath, change);
    },
  };
}

module.exports = {
  createReindexer,
  // Exported for test/smoke.js
  summarizeConfigDiff, resetUserConfig,
  normalizeStatus, isFinalStatus, isIndexBusy, validateConfig, checkInstance, planSteps,
  buildArgs, assertSubmittable, erpArg, unzipEntries, checkLog, logExcerpt, headTail, makeApi,
  parseCreatedIndices, compareIndexes, checkCounters, editUserConfig,
  describeConfigChanges, buildChangeRequest,
};

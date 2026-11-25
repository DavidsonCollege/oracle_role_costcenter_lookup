'use strict';
// Oracle Search (OSCS) index rebuild after a Prod-to-Test refresh.
// Spec: OSCS_REINDEX_FEATURE.md. Runs each index ingest job one at a time, then
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
  const rest = c => JSON.stringify({ ...c, _readme: null, steps: null, jobs: null });
  if (rest(user) !== rest(shipped)) diffs.push('Other settings differ (Prod hosts, polling, retries or ACL steps).');
  return diffs.length ? diffs : null;
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
    label: config.jobs?.[key]?.label ?? key, area: 'Search security', notes: '', verify: false,
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

// ── Log checks (section 7a): a job can say Succeeded and still be wrong ───────

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
    + 'submitter,submissionTime,processStartTime,processEndTime,errorWarningMessage,requestParameters';

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

  // Only ERP Integrations documents a log download, so both APIs use it.
  async function log(id) {
    const url = `${base}${ERP_PATH}?finder=ESSJobExecutionDetailsRF;requestId=${checkId(id)},fileType=LOG`;
    const r = await call(url, { headers: headers() }, 120000);
    if (!r.res.ok) throw httpError('Log download', r);
    const b64 = r.json?.items?.[0]?.DocumentContent;
    if (!b64) throw new Error(`Oracle returned no log for request ${id}.`);
    const files = unzipEntries(Buffer.from(b64, 'base64'));
    if (files.length === 0) throw new Error(`The log download for request ${id} had no text files.`);
    return files.map(f => `===== ${f.name} =====\n${f.text}`).join('\n');
  }

  return {
    submit: (job, args) => (job.api === 'ess' ? submitEss(job, args) : submitErp(job, args)),
    status, log, essRequest, erpStatusRaw,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

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
      'See the table on the Scheduled Processes tab for every step.',
    ].join('\n');
  }

  async function alert(run, level, text, step) {
    const slack = await postSlack(text);
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
      } catch (e) {
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
    const { baseUrl, username, password, confirmName, mode, stepId, runId, fromStepId } = params ?? {};
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
    Object.assign(run, { status: 'running', endedAt: null, stopReason: null });

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
    start, stop, inspect, listRuns, getConfigInfo,
    postSlack,
    isRunning: () => !!active,
    current  : () => (active ? clone(active.run) : null),
    runsDir,
    ensureUserConfig: () => ensureUserConfig(dataDir, defaultConfigPath),
    resetUserConfig: () => {
      if (active) throw new Error("Can't replace the config while a rebuild is running.");
      return resetUserConfig(dataDir, defaultConfigPath);
    },
  };
}

module.exports = {
  createReindexer,
  // Exported for test/smoke.js
  summarizeConfigDiff, resetUserConfig,
  normalizeStatus, isFinalStatus, isIndexBusy, validateConfig, checkInstance, planSteps,
  buildArgs, assertSubmittable, erpArg, unzipEntries, checkLog, logExcerpt, headTail, makeApi,
};

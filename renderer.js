// ── Wire up buttons and key listeners ─────────────────────────────────────
document.getElementById('lookupBtn').addEventListener('click', lookup);
document.getElementById('ccBtn').addEventListener('click', runCCReport);
document.getElementById('manageCCRoleBtn').addEventListener('click', runManageCCRole);
document.getElementById('reconnectBtn').addEventListener('click', () => window.hcmAPI.appRelaunch());

// ── Button enable/disable based on required fields ──────────────────────────
function updateButtonStates() {
  const username        = document.getElementById('username').value.trim();
  const password        = document.getElementById('password').value;
  const personNum       = document.getElementById('personNumber').value.trim();
  const costCenter      = document.getElementById('costCenter').value.trim();
  const accessCC        = document.getElementById('accessCostCenter').value.trim();
  const accessPersonNum = document.getElementById('accessPersonNumber').value.trim();
  document.getElementById('lookupBtn').disabled      = !username || !password || !personNum;
  document.getElementById('ccBtn').disabled          = !username || !password || !costCenter;
  document.getElementById('manageCCRoleBtn').disabled = !accessCC || !accessPersonNum;
}

['username', 'password', 'personNumber', 'costCenter', 'accessCostCenter', 'accessPersonNumber'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateButtonStates);
});

updateButtonStates();

// ── Restore saved settings and show version on startup ─────────────────────
window.hcmAPI.getSettings().then(s => {
  if (s.baseUrl)   document.getElementById('baseUrl').value   = s.baseUrl;
  if (s.username)  document.getElementById('username').value  = s.username;
  updateButtonStates();
});

Promise.all([window.hcmAPI.appVersion(), window.hcmAPI.buildDate()]).then(([v, d]) => {
  const date = d ? ` — released ${d}` : '';
  document.getElementById('appVersion').textContent = `v${v}${date}`;
});

document.getElementById('feedbackLink').addEventListener('click', () => {
  window.hcmAPI.openExternal('mailto:jedonovan@davidson.edu?subject=Oracle%20Access%20Request%20Lookup%20feedback');
});

document.getElementById('costCenter').addEventListener('keydown', e => {
  if (e.key === 'Enter') runCCReport();
});

['accessCostCenter', 'accessPersonNumber'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') runManageCCRole();
  });
});

['username', 'password', 'personNumber'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') lookup();
  });
});

async function lookup() {
  const baseUrl    = document.getElementById('baseUrl').value.trim().replace(/\/$/, '');
  const username   = document.getElementById('username').value.trim();
  const password   = document.getElementById('password').value;
  const searchTerm = document.getElementById('personNumber').value.trim();
  const btn        = document.getElementById('lookupBtn');
  const resultEl   = document.getElementById('result');

  // Basic validation
  if (!username || !password || !searchTerm) return;

  window.hcmAPI.saveSettings({ baseUrl, username });
  document.getElementById('costCenter').value = '';
  const ccResultEl = document.getElementById('ccResult');
  ccResultEl.className = 'result';
  ccResultEl.innerHTML = '';

  // Loading state
  btn.disabled = true;
  btn.classList.add('loading');
  resultEl.className = 'result';
  resultEl.innerHTML = '';

  try {
    const result = await doLookup(baseUrl, username, password, searchTerm);
    if (result.candidates) {
      showCandidates(result.candidates);
    } else {
      showSuccess(result);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

async function doLookup(baseUrl, username, password, searchTerm) {
  const result = await window.hcmAPI.lookup({ baseUrl, username, password, searchTerm });
  if (!result.ok) throw new Error(result.error);
  if (result.candidates) return { candidates: result.candidates };
  return {
    assignments      : result.assignments,
    positionCode     : result.positionCode,
    provisioningRules: result.provisioningRules,
    rulesError       : result.rulesError,
    userGuid         : result.userGuid,
    personNumber     : result.personNumber,
    personId         : result.personId,
    displayName      : result.displayName,
    legalName        : result.legalName,
    preferredName    : result.preferredName,
  };
}

function showCandidates(candidates) {
  const el = document.getElementById('result');
  el.className = 'result info';
  el.innerHTML = `
    <p class="candidates-header">Multiple workers found — select one:</p>
    <table class="candidates-table">
      <thead><tr><th>Person #</th><th>Name</th></tr></thead>
      <tbody id="candidateTbody"></tbody>
    </table>`;
  const tbody = document.getElementById('candidateTbody');
  for (const c of candidates) {
    const tr = document.createElement('tr');
    tr.className = 'candidate-row';
    tr.innerHTML = `
      <td class="cand-num">${esc(c.personNumber ?? '—')}</td>
      <td>${esc(c.displayName ?? '—')}</td>`;
    tr.addEventListener('click', () => selectCandidate(c.personNumber ?? ''));
    tbody.appendChild(tr);
  }
}

function selectCandidate(personNumber) {
  document.getElementById('personNumber').value = personNumber;
  lookup();
}

function showSuccess({ personNumber, personId, userGuid, displayName, legalName, preferredName, positionCode, assignments, provisioningRules, rulesError }) {
  const el = document.getElementById('result');
  el.className = 'result success';

  let rulesHtml;
  if (rulesError) {
    rulesHtml = `<p class="rules-error">&#9888; Could not load provisioning rules: ${esc(rulesError)}</p>`;
  } else if (provisioningRules.length === 0) {
    rulesHtml = `<p class="no-rules">No assigned roles found for this position.</p>`;
  } else {
    rulesHtml = `
      <table class="rules-table" id="rolesTable">
        <thead>
          <tr>
            <th>Role Code</th>
            <th>Date Assigned</th>
            <th>Last Updated</th>
          </tr>
        </thead>
        <tbody>
          ${provisioningRules.map(role => {
            const code = role.RoleCode ?? '';
            // DAV_SEC_C<digits> codes (e.g. DAV_SEC_C480) represent hierarchical cost
            // center groups. Clicking runs a SOAP hierarchy lookup and merges all child
            // cost centers into the Cost Center Report field.
            const cMatch  = code.match(/DAV_SEC_(C\d+)/);
            // Other DAV_SEC_<digits> codes (e.g. DAV_SEC_1234) map directly to a single
            // cost center. Clicking appends that cost center to the Cost Center Report field.
            // Non-numeric codes like DAV_SEC_ALL-ALL_COST_CENTERS are intentionally excluded.
            const segCode = !cMatch && code.startsWith('DAV_SEC_')
              ? (code.match(/DAV_SEC_(\d+)/)?.[1] ?? null)
              : null;
            const roleCodeHtml = cMatch
              ? `<a class="role-link" href="#" data-action="hierarchy" data-code="${esc(cMatch[1])}">${esc(code)}</a>`
              : segCode
                ? `<a class="role-link" href="#" data-action="add-cc" data-code="${esc(segCode)}">${esc(code)}</a>`
                : esc(code || '—');
            return `<tr>
              <td class="mono">${roleCodeHtml}</td>
              <td>${esc(formatDate(role.CreationDate) ?? '—')}</td>
              <td>${esc(formatDate(role.LastUpdateDate) ?? '—')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  const nameDisplay = preferredName
    ? (legalName && legalName !== preferredName
        ? `${esc(preferredName)} <span style="color:#666">(${esc(legalName)})</span>`
        : esc(preferredName))
    : (legalName ? esc(legalName) : '—');
  const nameRow = `<div class="result-row">
    <span class="result-key">Name</span>
    <span class="result-val">${nameDisplay}</span>
  </div>`;

  el.innerHTML = `
    ${nameRow}
    <div class="result-row">
      <span class="result-key">Person Number</span>
      <span class="result-val">${esc(personNumber)}</span>
    </div>
    <div class="result-row">
      <span class="result-key">Person ID</span>
      <span class="result-val">${esc(personId ?? '—')}</span>
    </div>
    ${userGuid ? `
    <div class="result-row">
      <span class="result-key">User GUID</span>
      <span class="result-val">${esc(userGuid)}</span>
    </div>` : ''}
    <div class="result-row assignments-row">
      <span class="result-key">Assignment${assignments.length !== 1 ? 's' : ''}</span>
      <span class="result-val">
        <table class="assignments-table">
          <thead>
            <tr>
              <th></th>
              <th>Position Code</th>
              <th>Position Name</th>
              <th>Manager</th>
            </tr>
          </thead>
          <tbody>
            ${assignments.map(a => `
              <tr${a.isPrimary ? ' class="assignment-primary"' : ''}>
                <td class="assignment-flag">${a.isPrimary ? '<span class="primary-badge">Primary</span>' : ''}</td>
                <td class="mono">${esc(a.positionCode)}</td>
                <td>${a.positionName ? esc(a.positionName) : '<span style="opacity:0.4">—</span>'}</td>
                <td>${a.managerName ? esc(a.managerName) + (a.managerNumber ? ` <span style="opacity:0.6">(${esc(a.managerNumber)})</span>` : '') : '<span style="opacity:0.4">—</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </span>
    </div>
    <div class="rules-section">
      <p class="rules-label">
        Assigned Roles
        ${!rulesError ? `<span class="rules-count">${provisioningRules.length}</span>` : ''}
      </p>
      ${rulesHtml}
    </div>
    <div class="rules-section" id="autoProvSection">
      <p class="rules-label">Auto-Provisioning Rules</p>
      <p class="no-rules">
        <button class="btn-load-autoprov" id="loadAutoProvBtn" data-position-code="${esc(positionCode)}">Load Auto-Provisioning Rules</button>
      </p>
    </div>
`;

  // Delegate role-link clicks to avoid unsafe inline onclick handlers.
  document.getElementById('rolesTable')?.querySelector('tbody')?.addEventListener('click', e => {
    const link = e.target.closest('.role-link');
    if (!link) return;
    e.preventDefault();
    const { action, code } = link.dataset;
    if (action === 'hierarchy') lookupHierarchy(code);
    else if (action === 'add-cc') addToCostCenter(code);
  });

  // Load auto-provisioning rules on demand.
  document.getElementById('loadAutoProvBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    const posCode = btn.dataset.positionCode;
    const section = document.getElementById('autoProvSection');
    btn.disabled = true;
    btn.textContent = 'Loading…';

    const baseUrl  = document.getElementById('baseUrl').value.trim().replace(/\/$/, '');
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    const result = await window.hcmAPI.autoProvRules({ baseUrl, username, password, positionCode: posCode });

    if (!result.ok) {
      section.querySelector('p.no-rules').innerHTML =
        `<span class="rules-error">&#9888; Could not load auto-provisioning rules: ${esc(result.error)}</span>`;
      return;
    }

    const rules = result.autoProvRules ?? [];
    const label = section.querySelector('p.rules-label');
    label.innerHTML = `Auto-Provisioning Rules <span class="rules-count">${rules.length}</span>`;

    if (rules.length === 0) {
      section.querySelector('p.no-rules').textContent = 'No auto-provisioning rules found for this position.';
      return;
    }

    const cols = ['MAPPING_NAME', 'DEPARTMENT', 'JOB', 'ROLE'];
    section.querySelector('p.no-rules').outerHTML = `
      <table class="rules-table">
        <thead><tr>${cols.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rules.map(row =>
            `<tr>${cols.map(h => `<td class="mono">${esc(row[h] ?? '—')}</td>`).join('')}</tr>`
          ).join('')}
        </tbody>
      </table>`;
  });
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function showError(msg) {
  const el = document.getElementById('result');
  el.className = 'result error';
  el.innerHTML = `<span class="error-icon">&#9888;</span><span class="error-msg">${esc(msg)}</span>`;
}

// ── Cost Center Report ─────────────────────────────────────────────────────

async function runCCReport() {
  const costCenter = document.getElementById('costCenter').value.trim();
  const btn        = document.getElementById('ccBtn');
  const resultEl   = document.getElementById('ccResult');

  if (!costCenter) {
    showCCError('Please enter one or more Cost Center numbers.');
    return;
  }

  btn.disabled = true;
  btn.classList.add('loading');
  resultEl.className = 'result';
  resultEl.innerHTML = '';

  try {
    const baseUrl  = document.getElementById('baseUrl').value.trim().replace(/\/$/, '');
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    window.hcmAPI.saveSettings({ baseUrl, username });
    const result = await window.hcmAPI.ccReport({ baseUrl, username, password, costCenter });
    if (!result.ok) throw new Error(result.error);
    showCCResults(result.results);
  } catch (err) {
    showCCError(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

function showCCResults(results) {
  const el = document.getElementById('ccResult');
  el.className = 'result success';

  const rows = results.map(r => {
    if (r.error) {
      return `<tr class="cc-not-found">
        <td class="cc-code">${esc(r.costCenter)}</td>
        <td colspan="4" class="cc-error-msg">&#9888; ${esc(r.error)}</td>
      </tr>`;
    }
    const managerDisplay = r.manager
      ? esc(r.manager) + (r.managerPersonNum ? ` (${esc(r.managerPersonNum)})` : '')
      : '—';
    return `<tr>
      <td class="cc-code">${esc(r.costCenter)}</td>
      <td>${esc(r.departmentName   ?? '—')}</td>
      <td>${managerDisplay}</td>
      <td>${esc(r.managerStatus   ?? '—')}</td>
      <td>${esc(r.managerEmail    ?? '—')}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="cc-table">
      <thead>
        <tr>
          <th>Cost Center</th>
          <th>Department</th>
          <th>Manager</th>
          <th>Manager Status</th>
          <th>Manager Email</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function showCCError(msg) {
  const el = document.getElementById('ccResult');
  el.className = 'result error';
  el.innerHTML = `<span class="error-icon">&#9888;</span><span class="error-msg">${esc(msg)}</span>`;
}

// ── Cost Center Access (add / remove DAV_SEC_<number> role) ───────────────

async function runManageCCRole() {
  const costCenter  = document.getElementById('accessCostCenter').value.trim();
  const personNum   = document.getElementById('accessPersonNumber').value.trim();
  const action      = document.querySelector('input[name="accessAction"]:checked')?.value ?? 'add';
  const btn         = document.getElementById('manageCCRoleBtn');
  const resultEl    = document.getElementById('accessResult');

  if (!costCenter || !personNum) return;

  btn.disabled = true;
  btn.classList.add('loading');
  resultEl.className = 'result';
  resultEl.innerHTML = '';

  try {
    const baseUrl  = document.getElementById('baseUrl').value.trim().replace(/\/$/, '');
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    const result = await window.hcmAPI.manageCCRole({ baseUrl, username, password, personNumber: personNum, costCenter, action });

    if (!result.ok) {
      resultEl.className = 'result error';
      resultEl.innerHTML = `<span class="error-icon">&#9888;</span><span class="error-msg">${esc(result.error)}</span>`;
    } else {
      resultEl.className = 'result success';
      resultEl.innerHTML = `<span style="font-size:0.9rem">${esc(result.message)}</span>`;
    }
  } catch (err) {
    resultEl.className = 'result error';
    resultEl.innerHTML = `<span class="error-icon">&#9888;</span><span class="error-msg">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    updateButtonStates();
  }
}

// ── Add single cost center to the CC Report field ─────────────────────────

function addToCostCenter(code) {
  const field    = document.getElementById('costCenter');
  const ccResult = document.getElementById('ccResult');
  const existing = field.value.split(',').map(s => s.trim()).filter(Boolean);
  if (existing.includes(code)) {
    ccResult.className = 'result info';
    ccResult.innerHTML = `${esc(code)} is already in the Cost Center Report field.`;
    return;
  }
  existing.push(code);
  field.value = existing.join(', ');
  updateButtonStates();
  ccResult.className = 'result info';
  ccResult.innerHTML = `${esc(code)} added to the Cost Center Report field (${existing.length} total).`;
}

// ── Cost center hierarchy lookup ───────────────────────────────────────────

async function lookupHierarchy(costCenterCode) {
  const ccResult = document.getElementById('ccResult');
  ccResult.className = 'result info';
  ccResult.innerHTML = `Loading hierarchy for ${esc(costCenterCode)}&hellip;`;

  const baseUrl  = document.getElementById('baseUrl').value.trim();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  const result = await window.hcmAPI.ccHierarchy({ baseUrl, username, password, costCenterCode });

  if (!result.ok) {
    showCCError(`Hierarchy lookup failed: ${result.error}`);
    return;
  }

  if (result.values.length === 0) {
    showCCError(`No child cost centers found under ${esc(costCenterCode)}.`);
    return;
  }

  const field    = document.getElementById('costCenter');
  const existing = field.value.split(',').map(s => s.trim()).filter(Boolean);
  const merged   = [...new Set([...existing, ...result.values])];
  field.value    = merged.join(', ');
  updateButtonStates();
  ccResult.className = 'result info';
  ccResult.innerHTML = `${result.values.length} cost center${result.values.length !== 1 ? 's' : ''} merged into the Cost Center Report field (${merged.length} total).`;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Search Index Rebuild (OSCS) ────────────────────────────────────────────
// The run itself happens in the main process (oscs-reindex.js); this only
// starts it, shows progress events, and offers the config and inspect tools.

const oscs = { steps: [], runs: [], running: false };

function oscsCreds() {
  return {
    baseUrl : document.getElementById('baseUrl').value.trim().replace(/\/$/, ''),
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
  };
}

function oscsMsg(id, text, kind = '') {
  const el = document.getElementById(id);
  el.className = `oscs-msg ${kind}`;
  el.textContent = text;
}

function stepOptions(steps) {
  return steps.map((s, i) =>
    `<option value="${esc(s.id)}">${i + 1}. ${esc(s.label)}${s.area ? ` (${esc(s.area)})` : ''}</option>`).join('');
}

async function oscsLoadConfig() {
  const info = await window.hcmAPI.oscsConfig({ baseUrl: oscsCreds().baseUrl });
  if (!info.ok) {
    oscsMsg('oscsConfigMsg', info.error, 'bad');
    return;
  }
  oscs.steps = info.steps;
  document.getElementById('oscsStep').innerHTML = stepOptions(info.steps);
  document.getElementById('oscsFromStep').innerHTML = stepOptions(info.steps);

  const jobProblems = Object.values(info.jobErrors).flat();
  const lines = [`${info.steps.length} steps from ${info.isUserCopy ? 'your config' : 'the default config'}: ${info.path}`];
  if (info.errors.length) lines.push(...info.errors);
  if (jobProblems.length) lines.push('Before a full run, finish these (a single-step test only needs its own job):', ...jobProblems.map(p => `• ${p}`));
  oscsMsg('oscsConfigMsg', lines.join('\n'), info.errors.length || jobProblems.length ? 'bad' : 'oscs-hint');

  const hint = document.getElementById('oscsConfirmHint');
  hint.textContent = info.instance?.ok
    ? `Type "${info.instance.name}" to confirm this instance.`
    : (info.instance?.error ?? '');

  oscsMsg('oscsSlackMsg', info.slackConfigured
    ? 'A Slack webhook is saved (encrypted on this computer).'
    : 'No Slack webhook saved. Alerts will only show in the app.', 'oscs-hint');

  const diffBox = document.getElementById('oscsConfigDiff');
  diffBox.hidden = !info.differences;
  document.getElementById('oscsConfigDiffList').innerHTML = (info.differences ?? []).map(d => `<li>${esc(d)}</li>`).join('');

  if (info.running) oscsRender(info.running);
  await oscsLoadRuns();
}

async function oscsLoadRuns() {
  oscs.runs = await window.hcmAPI.oscsListRuns();
  const resumable = oscs.runs.filter(r => r.mode === 'full' && r.status !== 'running');
  document.getElementById('oscsRun').innerHTML = resumable.length
    ? resumable.map(r => `<option value="${esc(r.id)}">${esc(r.instance)}, ${esc(formatDateTime(r.startedAt))}: ${esc(r.status)}</option>`).join('')
    : '<option value="">No full runs to resume</option>';
  oscsSuggestResumeStep();
}

// Default the resume point to the first step that didn't succeed.
function oscsSuggestResumeStep() {
  // Uses the current config's steps, so an index removed from the config is skipped.
  const run = oscs.runs.find(r => r.id === document.getElementById('oscsRun').value);
  if (!run) return;
  const done = new Set(run.steps.filter(s => s.status === 'SUCCEEDED').map(s => s.id));
  const firstOpen = oscs.steps.find(s => !done.has(s.id));
  if (firstOpen) document.getElementById('oscsFromStep').value = firstOpen.id;
}

function oscsModeChanged() {
  const mode = document.getElementById('oscsMode').value;
  document.getElementById('oscsStep').style.display     = mode === 'single' ? '' : 'none';
  document.getElementById('oscsRun').style.display      = mode === 'resume' ? '' : 'none';
  document.getElementById('oscsFromStep').style.display = mode === 'resume' ? '' : 'none';
}

async function oscsStart() {
  const mode = document.getElementById('oscsMode').value;
  const creds = oscsCreds();
  const params = {
    ...creds,
    mode,
    confirmName: document.getElementById('oscsConfirm').value,
    stepId     : document.getElementById('oscsStep').value,
    runId      : document.getElementById('oscsRun').value,
    fromStepId : document.getElementById('oscsFromStep').value,
  };

  // Guardrail 5 exception: a single ACL job is allowed only as a deliberate test.
  if (mode === 'single' && params.stepId.startsWith('acl:') &&
      !confirm('Submit this ACL job on its own? Normally ACL jobs run only after every ingest step succeeds.')) return;

  const btn = document.getElementById('oscsStartBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  oscsMsg('oscsStartMsg', '');
  try {
    window.hcmAPI.saveSettings({ baseUrl: creds.baseUrl, username: creds.username });
    const result = await window.hcmAPI.oscsStart(params);
    if (!result.ok) {
      oscsMsg('oscsStartMsg', result.error, 'bad');
      return;
    }
    document.getElementById('oscsConfirm').value = '';
    oscsRender(result.run);
  } finally {
    btn.classList.remove('loading');
    oscsSetRunning(oscs.running);
  }
}

function oscsSetRunning(running) {
  oscs.running = running;
  document.getElementById('oscsStartBtn').disabled = running;
  document.getElementById('oscsStopBtn').disabled  = !running;
}

function oscsRender(run) {
  oscsSetRunning(run.status === 'running');
  const done = run.steps.filter(s => s.status === 'SUCCEEDED').length;
  const head = run.status === 'running'
    ? `Running on <strong>${esc(run.instance)}</strong>: ${done} of ${run.steps.length} steps succeeded.`
    : `Run on <strong>${esc(run.instance)}</strong> ${esc(run.status)}: ${done} of ${run.steps.length} steps succeeded.`;

  const rows = run.steps.map((s, i) => {
    const st = String(s.status ?? '').split(/\s/)[0];
    const oracle = s.oracleStatus && s.oracleStatus !== s.status ? ` <span class="oscs-hint">(Oracle: ${esc(s.oracleStatus)})</span>` : '';
    const issues = s.issues?.length ? `<div class="oscs-issues">${s.issues.map(esc).join('<br>')}</div>` : '';
    const note = s.note ? `<div class="oscs-hint">${esc(s.note)}</div>` : '';
    const log = s.logExcerpt && s.status !== 'SUCCEEDED'
      ? `<details><summary class="oscs-hint">Log excerpt</summary><div class="oscs-pre">${esc(s.logExcerpt)}</div></details>` : '';
    return `<tr>
      <td>${i + 1}</td>
      <td class="mono">${esc(s.label)}${s.verify ? ' <span class="oscs-hint">verify</span>' : ''}</td>
      <td><span class="st st-${esc(st)}">${esc(s.status)}</span>${oracle}${issues}${note}${log}</td>
      <td class="mono nowrap">${esc(s.requestId ?? '')}</td>
      <td class="nowrap">${esc(formatTime(s.submittedAt))}</td>
      <td class="nowrap">${esc(formatTime(s.endedAt))}</td>
      <td>${s.rows != null ? esc(s.rows.toLocaleString()) : s.recreateOnly ? '<span class="oscs-hint" title="ACL index: recreated empty here, filled by its ACL job at the end">recreate only</span>' : ''}</td>
    </tr>`;
  }).join('');

  document.getElementById('oscsProgress').innerHTML = `
    <p class="oscs-runhead">${head}</p>
    ${run.stopReason ? `<p class="oscs-msg bad">${esc(run.stopReason)}</p>` : ''}
    ${run.saveError ? `<p class="oscs-msg bad">${esc(run.saveError)}</p>` : ''}
    <table class="oscs-table">
      <thead><tr><th>#</th><th>Step</th><th>Status</th><th>Request</th><th>Started</th><th>Ended</th><th>Rows</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  if (run.status !== 'running') oscsLoadRuns();
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function oscsInspect() {
  const out = document.getElementById('oscsInspectOut');
  const requestId = document.getElementById('oscsInspectId').value.trim();
  out.innerHTML = '<p class="oscs-hint">Loading…</p>';
  const r = await window.hcmAPI.oscsInspect({ ...oscsCreds(), requestId });
  if (!r.ok) {
    out.innerHTML = `<p class="oscs-msg bad">${esc(r.error)}</p>`;
    return;
  }
  const params = r.essRequest?.requestParameters;
  const boxes = [
    ...(Array.isArray(params) ? [['Request parameters', params.map(p => `${p.name} = ${p.value}${p.paramType ? `  (${p.paramType})` : ''}`).join('\n')]] : []),
    ['ESS scheduler request', JSON.stringify(r.essRequest, null, 2)],
    ['ERP Integrations status', JSON.stringify(r.erpStatus, null, 2)],
    ['Log', r.log ?? r.logError ?? ''],
  ];
  out.innerHTML = boxes.map(([title, text], i) => `
    <p class="oscs-sub oscs-boxhead">${esc(title)}
      <button class="btn-secondary btn-copy" data-copy="${i}">Copy</button></p>
    <div class="oscs-pre" data-box="${i}">${esc(text)}</div>`).join('');
}

// One-click copy for the Inspect boxes (delegated, since the boxes are re-rendered).
document.getElementById('oscsInspectOut').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-copy');
  if (!btn) return;
  const box = document.querySelector(`#oscsInspectOut [data-box="${btn.dataset.copy}"]`);
  try {
    await navigator.clipboard.writeText(box.textContent);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
});

async function oscsSaveSlack(url) {
  const r = await window.hcmAPI.oscsSetSlack({ url });
  if (!r.ok) return oscsMsg('oscsSlackMsg', r.error, 'bad');
  document.getElementById('oscsSlackUrl').value = '';
  oscsMsg('oscsSlackMsg', r.configured ? 'Slack webhook saved (encrypted on this computer).' : 'Slack webhook removed.', 'good');
}

document.getElementById('oscsMode').addEventListener('change', oscsModeChanged);
document.getElementById('oscsRun').addEventListener('change', oscsSuggestResumeStep);
document.getElementById('oscsStartBtn').addEventListener('click', oscsStart);
document.getElementById('oscsStopBtn').addEventListener('click', async () => {
  const r = await window.hcmAPI.oscsStop();
  oscsMsg('oscsStartMsg', r.ok ? 'Will stop after the current step finishes in Oracle.' : r.error, r.ok ? 'oscs-hint' : 'bad');
});
document.getElementById('oscsOpenConfigBtn').addEventListener('click', async () => {
  const r = await window.hcmAPI.oscsOpenConfig();
  if (!r.ok) oscsMsg('oscsConfigMsg', r.error, 'bad');
  else oscsLoadConfig();
});
document.getElementById('oscsReloadBtn').addEventListener('click', oscsLoadConfig);
document.getElementById('oscsResetConfigBtn').addEventListener('click', async () => {
  if (!confirm('Replace your config with the shipped one? Your current copy will be saved as a backup.')) return;
  const r = await window.hcmAPI.oscsResetConfig();
  await oscsLoadConfig();
  if (!r.ok) oscsMsg('oscsConfigMsg', r.error, 'bad');
  else if (r.backup) oscsMsg('oscsConfigMsg', `Config replaced. Your old copy was saved as ${r.backup}`, 'good');
});
document.getElementById('oscsRunsBtn').addEventListener('click', () => window.hcmAPI.oscsOpenRunsFolder());
document.getElementById('oscsInspectBtn').addEventListener('click', oscsInspect);
document.getElementById('oscsInspectId').addEventListener('keydown', e => { if (e.key === 'Enter') oscsInspect(); });
document.getElementById('oscsSlackSaveBtn').addEventListener('click', () => oscsSaveSlack(document.getElementById('oscsSlackUrl').value.trim()));
document.getElementById('oscsSlackClearBtn').addEventListener('click', () => oscsSaveSlack(''));
document.getElementById('oscsSlackTestBtn').addEventListener('click', async () => {
  const r = await window.hcmAPI.oscsTestSlack();
  oscsMsg('oscsSlackMsg', r.ok ? 'Test message sent.' : r.error, r.ok ? 'good' : 'bad');
});
// The confirmation hint depends on the selected environment.
document.getElementById('baseUrl').addEventListener('change', () => {
  if (activeTab === 'scheduled') oscsLoadConfig();
});
window.hcmAPI.onOscsProgress(run => {
  oscsRender(run);
  // Dot on the tab while a rebuild runs, so it's visible from the Lookups tab.
  const tab = document.getElementById('tab-scheduled');
  const dot = tab.querySelector('.tab-dot');
  if (run.status === 'running' && !dot) tab.insertAdjacentHTML('beforeend', '<span class="tab-dot" title="A rebuild is running"></span>');
  if (run.status !== 'running' && dot) dot.remove();
});

// ── Tabs ───────────────────────────────────────────────────────────────────

let activeTab = 'lookups';

function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.tabs .tab').forEach(t => {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  });
  if (name === 'scheduled') oscsLoadConfig();
  try { localStorage.setItem('activeTab', name); } catch { /* storage unavailable */ }
}

document.querySelectorAll('.tabs .tab').forEach(t => {
  t.addEventListener('click', () => showTab(t.dataset.tab));
  // Left/right arrow keys move between tabs.
  t.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = [...document.querySelectorAll('.tabs .tab')];
    const next = tabs[(tabs.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    showTab(next.dataset.tab);
    next.focus();
  });
});

try {
  if (localStorage.getItem('activeTab') === 'scheduled') showTab('scheduled');
} catch { /* storage unavailable */ }

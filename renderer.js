// ── Wire up buttons and key listeners ─────────────────────────────────────
document.getElementById('lookupBtn').addEventListener('click', lookup);
document.getElementById('ccBtn').addEventListener('click', runCCReport);
document.getElementById('reconnectBtn').addEventListener('click', () => window.hcmAPI.appRelaunch());

// ── Button enable/disable based on required fields ──────────────────────────
function updateButtonStates() {
  const username   = document.getElementById('username').value.trim();
  const password   = document.getElementById('password').value;
  const personNum  = document.getElementById('personNumber').value.trim();
  const costCenter = document.getElementById('costCenter').value.trim();
  document.getElementById('lookupBtn').disabled = !username || !password || !personNum;
  document.getElementById('ccBtn').disabled     = !username || !password || !costCenter;
}

['username', 'password', 'personNumber', 'costCenter'].forEach(id => {
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

document.getElementById('costCenter').addEventListener('keydown', e => {
  if (e.key === 'Enter') runCCReport();
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

function showSuccess({ personNumber, personId, displayName, legalName, preferredName, positionCode, assignments, provisioningRules, rulesError }) {
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
    <div class="result-row">
      <span class="result-key">Person Number</span>
      <span class="result-val">${esc(personNumber)}</span>
    </div>
    <div class="result-row">
      <span class="result-key">Person ID</span>
      <span class="result-val">${esc(personId ?? '—')}</span>
    </div>
    ${nameRow}
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

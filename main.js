const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');
const XLSX = require('xlsx');

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 760,
    height: 820,
    resizable: true,
    title: 'Oracle Access Request Lookup',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Settings persistence ──────────────────────────────────────────────────────

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

ipcMain.handle('hcm:getSettings', () => {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
});

ipcMain.handle('hcm:saveSettings', (_event, { baseUrl, username }) => {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify({ baseUrl, username }), 'utf8');
  } catch {
    // Non-fatal — ignore write errors.
  }
});

// ── IPC: hcm:lookup ──────────────────────────────────────────────────────────
//
// Receives { baseUrl, username, password, searchTerm } from the renderer.
// searchTerm is treated as a person number when all-digits, otherwise as a display name.
// Returns  { ok: true, positionCode, personNumber, displayName, provisioningRules, rulesError }
//        | { ok: false, error }.

ipcMain.handle('hcm:lookup', async (_event, { baseUrl, username, password, searchTerm }) => {
  try {
    // Name input: resolve to a person number first, surfacing multi-match disambiguation.
    const isPersonNumber = /^\d+$/.test(searchTerm.trim());
    let resolvedPersonNumber = searchTerm;

    if (!isPersonNumber) {
      const token = Buffer.from(`${username}:${password}`).toString('base64');
      const candidates = await findWorkersByName(baseUrl, token, searchTerm);

      if (candidates.length === 0) {
        return { ok: false, error: `No worker found matching name: "${searchTerm}"` };
      }

      if (candidates.length > 1) {
        // Return the candidate list so the UI can show a disambiguation picker.
        return { ok: true, candidates };
      }

      // Exactly one match — use their person number.
      resolvedPersonNumber = candidates[0].personNumber;
    }

    const { positionCode, positionName, personId, personNumber, displayName } =
      await getWorkerInfo(baseUrl, username, password, resolvedPersonNumber);

    let provisioningRules = [];
    let rulesError = null;
    try {
      provisioningRules = await getAssignedRoles(baseUrl, username, password, personId);
    } catch (err) {
      rulesError = err.message;
    }

    let autoProvRules = [];
    let autoProvRuleHeaders = [];
    let autoProvError = null;
    try {
      const { rows, headers } = await runAutoProvisioningReport(baseUrl, username, password, positionCode);
      autoProvRules = rows;
      autoProvRuleHeaders = headers;
    } catch (err) {
      autoProvError = err.message;
    }

    return { ok: true, positionCode, positionName, provisioningRules, rulesError, autoProvRules, autoProvRuleHeaders, autoProvError, personNumber, displayName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: hcm:ccreport ────────────────────────────────────────────────────────
//
// Receives { baseUrl, username, password, costCenter } from the renderer —
// costCenter may be a single value or a comma-delimited list (e.g. "1001, 1002, 1003").
// Fetches the report once, then returns one result object per cost center.
// Returns  { ok: true, results: [{ costCenter, departmentName, departmentStatus,
//              manager, managerStatus, error }, ...] }
//        | { ok: false, error }.

ipcMain.handle('hcm:ccreport', async (_event, { baseUrl, username, password, costCenter }) => {
  try {
    const costCenters = costCenter.split(',').map(s => s.trim()).filter(Boolean);
    if (costCenters.length === 0) throw new Error('No cost centers provided.');
    const results = await runCostCenterReport(baseUrl, username, password, costCenters);
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Cost center report (SOAP 1.1 → PublicReportService) ──────────────────────
//
// Endpoint : {baseUrl}/xmlpserver/services/PublicReportService
// Report   : /Custom/DeptCostCenterMgrRpt.xdo
// Auth     : credentials embedded in SOAP body (from user input)

// costCenters — string[] of trimmed cost center values.
// Fetches the full report once and returns one result per requested cost center.
async function runCostCenterReport(baseUrl, username, password, costCenters) {
  const SOAP_ENDPOINT = `${baseUrl.replace(/\/$/, '')}/xmlpserver/services/PublicReportService`;

  // ── SOAP response helpers ─────────────────────────────────────────────────

  function extractElement(xml, localName) {
    const re = new RegExp(
      `<[^\\s>/]*:?${localName}[^>]*>([\\s\\S]*?)<\\/[^\\s>/]*:?${localName}>`, 'i'
    );
    return (xml.match(re) ?? [])[1]?.trim() ?? null;
  }

  function soapFaultMessage(xml) {
    const fault = extractElement(xml, 'Fault');
    if (!fault) return null;
    return extractElement(fault, 'faultstring')
      ?? extractElement(fault, 'Text')
      ?? extractElement(fault, 'message')
      ?? `(raw fault) ${fault.replace(/\s+/g, ' ').slice(0, 400)}`;
  }

  // ── SOAP 1.1 request — xlsx format for in-memory parsing ─────────────────
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<runReport xmlns="http://xmlns.oracle.com/oxp/service/PublicReportService">
<reportRequest>
<reportAbsolutePath>/Custom/Jessamyn/CostCenterManager/DeptCostCenterMgr.xdo</reportAbsolutePath>
<attributeFormat>xlsx</attributeFormat>
<sizeOfDataChunkDownload>-1</sizeOfDataChunkDownload>
</reportRequest>
<userID>${username}</userID>
<password>${password}</password>
</runReport>
</soap:Body>
</soap:Envelope>`;

  let response;
  try {
    response = await fetch(SOAP_ENDPOINT, {
      method : 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction'  : '"runReport"',
      },
      body: envelope,
    });
  } catch (err) {
    throw new Error(`Network error reaching SOAP endpoint: ${err.message}`);
  }

  const responseText = await response.text();

  const fault = soapFaultMessage(responseText);
  if (fault) throw new Error(`SOAP fault: ${fault}`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  const b64 = extractElement(responseText, 'reportBytes');
  if (!b64) {
    throw new Error(`No reportBytes in SOAP response.\nSnippet: ${responseText.slice(0, 300)}`);
  }

  // ── Parse xlsx in-memory with SheetJS ────────────────────────────────────
  const fileBuffer = Buffer.from(b64, 'base64');
  const workbook   = XLSX.read(fileBuffer, { type: 'buffer' });
  const worksheet  = workbook.Sheets[workbook.SheetNames[0]];

  // Parse as raw 2D array.
  // Report structure (confirmed): row 0 = title, row 1 = column headers, row 2+ = data.
  const raw = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  // Row 1 (index 1) is always the header row — row 0 is the report title and
  // must be skipped.
  const headerRowIdx = 1;

  if (raw.length < 2) {
    throw new Error(
      `Report has fewer than 2 rows — cannot locate header row.\n` +
      `First row seen: ${JSON.stringify(raw[0] ?? [])}`
    );
  }

  // Normalise headers to trimmed upper-case for reliable matching.
  const headers = raw[headerRowIdx].map(h => String(h).trim().toUpperCase());

  // Build plain objects from every non-empty data row that follows the header.
  const rows = raw
    .slice(headerRowIdx + 1)
    .filter(row => row.some(cell => String(cell).trim() !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = String(row[i] ?? '').trim(); });
      return obj;
    });

  if (rows.length === 0) {
    throw new Error('Report returned no data rows.');
  }

  // ── Find the cost center row using the COST CENTER column ─────────────────
  // Known columns (confirmed from report): DEPARTMENT NAME, DEPARTMENT STATUS,
  // DEPARTMENT ID, COST CENTER, COST CENTER MANAGER, CC MANAGER STATUS
  const exactCol = (...candidates) =>
    candidates.find(c => headers.includes(c.toUpperCase()))?.toUpperCase() ?? null;

  const ccCol         = exactCol('COST CENTER', 'COST_CENTER');
  const mgrCol        = exactCol('COST CENTER MANAGER', 'CC MANAGER');
  const deptCol       = exactCol('DEPARTMENT NAME', 'DEPT NAME');
  const deptStatusCol = exactCol('DEPARTMENT STATUS', 'DEPT STATUS');
  const mgrStatusCol  = exactCol('CC MANAGER STATUS', 'MANAGER STATUS');
  const mgrEmailCol   = exactCol('COST_CENTER_MGR_EMAIL', 'COST CENTER MGR EMAIL');
  const mgrNumCol     = exactCol('COST_CENTER_MGR_NUM', 'COST CENTER MGR NUM');

  if (!ccCol) {
    throw new Error(
      `No "COST CENTER" column found in report.\nColumns: ${headers.join(', ')}`
    );
  }

  // Pre-build the set of available cost centers once (used in "not found" messages).
  const available = [...new Set(rows.map(r => r[ccCol]).filter(Boolean))];

  // Map each requested cost center to its result (or an error entry if not found).
  return costCenters.map(cc => {
    const match = rows.find(r => r[ccCol] === cc);
    if (!match) {
      return {
        costCenter: cc,
        error: `"${cc}" not found. Available (first 20): ${available.slice(0, 20).join(', ')}`,
      };
    }
    return {
      costCenter      : cc,
      departmentName  : deptCol       ? (match[deptCol]       || null) : null,
      departmentStatus: deptStatusCol ? (match[deptStatusCol] || null) : null,
      manager         : mgrCol        ? (match[mgrCol]        || null) : null,
      managerStatus   : mgrStatusCol  ? (match[mgrStatusCol]  || null) : null,
      managerEmail    : mgrEmailCol   ? (match[mgrEmailCol]   || null) : null,
      managerPersonNum: mgrNumCol     ? (match[mgrNumCol]     || null) : null,
      error           : null,
    };
  });
}

// ── Auto-provisioning rules report (SOAP 1.1 → PublicReportService) ──────────
//
// Report: /Custom/Jessamyn/Auto-Provisioning Rules/Auto-Provisioning Rules.xdo
// Returns all rows from the report where the position code column matches
// the given positionCode, along with the full list of column headers.

async function runAutoProvisioningReport(baseUrl, username, password, positionCode) {
  const SOAP_ENDPOINT = `${baseUrl.replace(/\/$/, '')}/xmlpserver/services/PublicReportService`;

  function extractElement(xml, localName) {
    const re = new RegExp(
      `<[^\\s>/]*:?${localName}[^>]*>([\\s\\S]*?)<\\/[^\\s>/]*:?${localName}>`, 'i'
    );
    return (xml.match(re) ?? [])[1]?.trim() ?? null;
  }

  function soapFaultMessage(xml) {
    const fault = extractElement(xml, 'Fault');
    if (!fault) return null;
    return extractElement(fault, 'faultstring')
      ?? extractElement(fault, 'Text')
      ?? extractElement(fault, 'message')
      ?? `(raw fault) ${fault.replace(/\s+/g, ' ').slice(0, 400)}`;
  }

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<runReport xmlns="http://xmlns.oracle.com/oxp/service/PublicReportService">
<reportRequest>
<reportAbsolutePath>/Custom/Jessamyn/Auto-Provisioning Rules/Auto-Provisioning Rules.xdo</reportAbsolutePath>
<attributeFormat>xlsx</attributeFormat>
<sizeOfDataChunkDownload>-1</sizeOfDataChunkDownload>
</reportRequest>
<userID>${username}</userID>
<password>${password}</password>
</runReport>
</soap:Body>
</soap:Envelope>`;

  let response;
  try {
    response = await fetch(SOAP_ENDPOINT, {
      method : 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction'  : '"runReport"',
      },
      body: envelope,
    });
  } catch (err) {
    throw new Error(`Network error reaching SOAP endpoint: ${err.message}`);
  }

  const responseText = await response.text();

  const fault = soapFaultMessage(responseText);
  if (fault) throw new Error(`SOAP fault: ${fault}`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  const b64 = extractElement(responseText, 'reportBytes');
  if (!b64) {
    throw new Error(`No reportBytes in SOAP response.\nSnippet: ${responseText.slice(0, 300)}`);
  }

  const fileBuffer = Buffer.from(b64, 'base64');
  const workbook   = XLSX.read(fileBuffer, { type: 'buffer' });
  const worksheet  = workbook.Sheets[workbook.SheetNames[0]];

  // Confirmed columns: MAPPING_NAME, DEPARTMENT, POSITION_CODE, JOB, ROLE.
  // Header row index varies — some report layouts include a title row (row 0) before
  // the column headers; others start headers at row 0. Detect by finding whichever
  // row contains the known POSITION_CODE column name.
  const raw = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  const KNOWN_COL = 'POSITION_CODE';
  const headerRowIdx = raw.findIndex(row =>
    row.map(c => String(c).trim().toUpperCase()).includes(KNOWN_COL)
  );

  if (headerRowIdx === -1) {
    throw new Error(
      `Could not locate header row — "${KNOWN_COL}" column not found.\n` +
      `First row seen: ${JSON.stringify(raw[0] ?? [])}`
    );
  }

  const headers = raw[headerRowIdx].map(h => String(h).trim().toUpperCase());

  const rows = raw
    .slice(headerRowIdx + 1)
    .filter(row => row.some(cell => String(cell).trim() !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = String(row[i] ?? '').trim(); });
      return obj;
    });

  return { rows: rows.filter(r => r[KNOWN_COL] === positionCode), headers };
}

// ── Worker lookup (ported from lookup-position.js) ───────────────────────────
//
// Returns { positionCode, personId } for the given person number.

async function getWorkerInfo(baseUrl, username, password, personNumber) {
  const token = Buffer.from(`${username}:${password}`).toString('base64');

  const params = new URLSearchParams({
    q: `PersonNumber=${personNumber}`,
    expand: 'workRelationships,workRelationships.assignments',
  });

  const url = `${baseUrl}/hcmRestApi/resources/latest/workers?${params}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`API error ${response.status} ${response.statusText}${body ? ': ' + body : ''}`);
  }

  const data = await response.json();

  if (!data.items || data.items.length === 0) {
    throw new Error(`No worker found with Person Number: ${personNumber}`);
  }

  const worker = data.items[0];
  const personId = worker.PersonId;
  const displayName = worker.DisplayName ?? null;
  const relationships = worker.workRelationships ?? [];

  if (relationships.length === 0) {
    throw new Error(`No work relationships found for Person Number: ${personNumber}`);
  }

  // Find the best matching assignment (prefer active primary, fall back to any with a code).
  let chosen = null;

  for (const rel of relationships) {
    for (const assignment of rel.assignments ?? []) {
      if (
        assignment.PrimaryFlag === true &&
        assignment.AssignmentStatusType === 'ACTIVE' &&
        assignment.PositionCode
      ) {
        chosen = assignment;
        break;
      }
    }
    if (chosen) break;
  }

  if (!chosen) {
    for (const rel of relationships) {
      for (const assignment of rel.assignments ?? []) {
        if (assignment.PositionCode) { chosen = assignment; break; }
      }
      if (chosen) break;
    }
  }

  if (!chosen) throw new Error(`No position code found for Person Number: ${personNumber}`);

  const positionCode = chosen.PositionCode;

  // PositionName is not populated in the assignments expand — fetch it from the
  // positions resource using the position code.
  const positionName = await fetchPositionName(baseUrl, token, positionCode);

  return { positionCode, positionName, personId, personNumber, displayName };
}

// Fetches the human-readable name for a position code from the positions resource.
// Returns null if the position is not found or the endpoint is inaccessible.
//
// Confirmed working: Oracle HCM returns pos.Name on this endpoint.
// A 'Code' fallback is included for instances that use that field name instead.
async function fetchPositionName(baseUrl, token, positionCode) {
  const headers = {
    Authorization: `Basic ${token}`,
    'Content-Type': 'application/json',
  };

  const esc = positionCode.replace(/'/g, "''");

  for (const q of [`PositionCode='${esc}'`, `Code='${esc}'`]) {
    try {
      const params = new URLSearchParams({ q, limit: '1' });
      const response = await fetch(
        `${baseUrl}/hcmRestApi/resources/latest/positions?${params}`,
        { headers }
      );
      if (!response.ok) continue;
      const data = await response.json();
      if (!data.items || data.items.length === 0) continue;
      const pos = data.items[0];
      return pos.Name ?? pos.PositionName ?? pos.DisplayName ?? null;
    } catch {
      // Network error or parse failure — try next attempt.
    }
  }

  return null;
}

// Searches for workers by exact name match and returns an array of
// { personNumber, displayName } candidates.
//
// Attempts are tried in priority order; the first attempt that returns any results
// determines the full candidate list (up to 25). Subsequent attempts are skipped
// so we don't blend results from different name fields.
async function findWorkersByName(baseUrl, token, name) {
  const escaped = name.replace(/'/g, "''"); // escape single quotes

  const headers = {
    Authorization: `Basic ${token}`,
    'Content-Type': 'application/json',
  };

  const attempts = [
    // /workers is tried first — confirmed accessible for this account.
    { endpoint: 'workers',       q: `FirstName='${escaped}'`   },
    { endpoint: 'workers',       q: `LastName='${escaped}'`    },
    // /publicWorkers as fallback — name fields are explicitly documented as queryable.
    { endpoint: 'publicWorkers', q: `FirstName='${escaped}'`   },
    { endpoint: 'publicWorkers', q: `LastName='${escaped}'`    },
    { endpoint: 'publicWorkers', q: `DisplayName='${escaped}'` },
    { endpoint: 'publicWorkers', q: `KnownAs='${escaped}'`     },
    { endpoint: 'publicWorkers', q: `FullName='${escaped}'`    },
  ];

  for (const { endpoint, q } of attempts) {
    let response;
    try {
      const params = new URLSearchParams({ q, limit: '25' });
      const url = `${baseUrl}/hcmRestApi/resources/latest/${endpoint}?${params}`;
      response = await fetch(url, { headers });
    } catch {
      continue; // network error — try the next attempt
    }

    if (!response.ok) continue; // field unsupported or access denied — try next

    const data = await response.json();
    if (data.items && data.items.length > 0) {
      // First successful hit — return all matches from this field and stop.
      return data.items.map(item => ({
        personNumber: item.PersonNumber,
        displayName : item.DisplayName ?? null,
      }));
    }
  }

  return []; // no matches found across all attempts
}

// ── Assigned roles ────────────────────────────────────────────────────────────
//
// Two-step approach:
//   1. Fetch the userAccount record for the given personId to obtain its self link.
//   2. Query the userAccountRoles child resource directly with limit=500.
//
// The single-call expand approach only returns the default page size (typically 1
// or 25 rows) for child collections, which is why only one role was appearing.
// Going to the child resource directly lets us set an explicit limit.

async function getAssignedRoles(baseUrl, username, password, personId) {
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  const headers = {
    Authorization: `Basic ${token}`,
    'Content-Type': 'application/json',
  };

  // Step 1 — find the user account for this person.
  const accountParams = new URLSearchParams({ q: `PersonId=${personId}`, limit: '1' });
  const accountRes = await fetch(
    `${baseUrl}/hcmRestApi/resources/latest/userAccounts?${accountParams}`,
    { headers }
  );

  if (!accountRes.ok) {
    const body = await accountRes.text().catch(() => '');
    throw new Error(`User accounts API error ${accountRes.status} ${accountRes.statusText}${body ? ': ' + body : ''}`);
  }

  const accountData = await accountRes.json();

  if (!accountData.items || accountData.items.length === 0) {
    return []; // Worker exists but has no user account (e.g. future-dated or contractor)
  }

  const account = accountData.items[0];

  // Step 2 — follow the self link to build the child resource URL.
  // This avoids guessing the internal account ID field name.
  const selfHref = (account.links ?? []).find(l => l.rel === 'self')?.href;
  if (!selfHref) {
    throw new Error('Could not determine user account URL — self link missing from response');
  }

  const rolesRes = await fetch(`${selfHref}/child/userAccountRoles?limit=500`, { headers });

  if (!rolesRes.ok) {
    const body = await rolesRes.text().catch(() => '');
    throw new Error(`User account roles API error ${rolesRes.status} ${rolesRes.statusText}${body ? ': ' + body : ''}`);
  }

  const rolesData = await rolesRes.json();
  const items = rolesData.items ?? [];
  return items.filter(role =>
    role.RoleCode?.startsWith('DAV_SEC') || role.RoleCode?.includes('REPORTS')
  );
}

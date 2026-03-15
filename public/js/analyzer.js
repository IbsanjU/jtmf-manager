// ═══════════════════════════════════════════════════════════════════════════════
//  JTMF Manager — Folder Analyzer JS
// ═══════════════════════════════════════════════════════════════════════════════

const SPRINT_RE = /^FY\d{2}Q[1-4]-S\d+$/i;

// ─── State ────────────────────────────────────────────────────────────────────
const AZ = {
  projectKey:   '',
  podPath:      '',
  malcodes:     [],
  activeSprint: '',
  readOnly:     false,

  // Results
  tests:        [],
  rows:         [],
  selectedRows: new Set(),
  
  // API cache (path -> { ts, rows, tests, folder }), TTL = 5 min
  cache: {},
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await api('/api/auth/status');
    if (!res.authenticated) { window.location.href = '/'; return; }
    AZ.projectKey = res.projectKey;
    document.getElementById('navProjectKey').textContent = res.projectKey;
  } catch {
    window.location.href = '/';
    return;
  }

  loadConfig();
  applyReadOnly();

  // Check for auto-analysis from URL params
  const urlParams = new URLSearchParams(window.location.search);
  const autoPath = urlParams.get('path');
  if (autoPath) {
    document.getElementById('analyzerPathInput').value = autoPath;
    runAnalysis();
  }
});

function loadConfig() {
  const saved = JSON.parse(localStorage.getItem('jtmf_config') || '{}');
  AZ.podPath      = saved.podPath      || '';
  AZ.malcodes     = saved.malcodes     || [];
  AZ.activeSprint = saved.activeSprint || '';
  AZ.readOnly     = saved.readOnly     || false;
  AZ.fyStartMonth = saved.fyStartMonth || 11; // default: November
  AZ.sprintWeeks  = saved.sprintWeeks  || 2;  // default: 2-week sprints
  AZ.envs         = saved.envs         || ['SIT', 'PAT']; // default environments
  
  if (!AZ.malcodes || AZ.malcodes.length === 0) {
    AZ.malcodes = [];
  }
}

function applyReadOnly() {
  document.getElementById('readonlyBanner').style.display = AZ.readOnly ? 'flex' : 'none';
}

// ─── API helper ───────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
}

// ─── URL / PATH PARSER ────────────────────────────────────────────────────────
function parseInputPath(raw) {
  if (!raw) return '';
  raw = raw.trim();

  // If it looks like a URL, try to extract the folder path
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const url = new URL(raw);

      // Pattern 1: Hash-based route e.g. #/PROJ/folder/path/here
      if (url.hash) {
        const hashPath = decodeURIComponent(url.hash.replace(/^#\/?/, ''));
        if (hashPath) return '/' + hashPath.replace(/^\//, '');
      }

      // Pattern 2: Query param "path" or "folder" or "folderId"
      const qPath = url.searchParams.get('path') || url.searchParams.get('folder');
      if (qPath) return qPath.startsWith('/') ? qPath : '/' + qPath;

      // Pattern 3: /testrepository/{project}/folders path in URL
      const repoMatch = url.pathname.match(/\/testrepository\/[^/]+\/(.+)/);
      if (repoMatch) return '/' + decodeURIComponent(repoMatch[1]);

      // Pattern 4: Just take the pathname if nothing else matched
      if (url.pathname && url.pathname !== '/') {
        return decodeURIComponent(url.pathname);
      }
    } catch {
      // Not a valid URL — treat as plain path
    }
  }

  // Plain path — ensure it starts with /
  return raw.startsWith('/') ? raw : '/' + raw;
}

// ─── ANALYSIS ─────────────────────────────────────────────────────────────────
const AZ_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function runAnalysis(forceRefresh = false) {
  let inputPath = parseInputPath(document.getElementById('analyzerPathInput').value);
  if (!inputPath) { toast('Please enter a folder path or URL', 'error'); return; }

  // Update the input box with the parsed path so the user sees what was extracted
  document.getElementById('analyzerPathInput').value = inputPath;

  // Check cache (skip if forceRefresh=true)
  const cached = AZ.cache[inputPath];
  if (!forceRefresh && cached && (Date.now() - cached.ts) < AZ_CACHE_TTL) {
    AZ.rows = cached.rows;
    AZ.tests = cached.tests;
    AZ.selectedRows.clear();
    renderTable(inputPath, AZ.tests.length);
    toast('Showing cached results — click Refresh to reload from Xray', 'info');
    return;
  }

  document.getElementById('resultsCard').style.display      = 'none';
  document.getElementById('analyzerLoading').style.display  = 'flex';
  document.getElementById('analyzerLoadingMsg').textContent = `Analyzing ${inputPath}…`;

  try {
    const [folderData, testsData] = await Promise.all([
      api(`/api/folders?path=${encodeURIComponent(inputPath)}`),
      api(`/api/tests?${new URLSearchParams({ folderPath: inputPath, limit: 200, start: 0 })}`)
    ]);

    const folder = folderData.folder;
    const tests  = testsData.results || [];
    AZ.tests = tests;

    if (!folder) {
      toast('Folder not found — check the path and try again', 'error');
      document.getElementById('analyzerLoading').style.display = 'none';
      return;
    }

    AZ.rows = tests.map(test => buildRow(test, inputPath, tests));
    AZ.selectedRows.clear();
    
    // Cache the results
    AZ.cache[inputPath] = { ts: Date.now(), rows: AZ.rows, tests, folder };

    renderTable(inputPath, tests.length);
    document.getElementById('analyzerLoading').style.display = 'none';
    document.getElementById('resultsCard').style.display     = 'flex';
    document.getElementById('resultsCard').style.flexDirection = 'column';
  } catch (err) {
    document.getElementById('analyzerLoading').style.display = 'none';
    toast(err.message, 'error');
  }
}

// ─── ROW BUILDER ──────────────────────────────────────────────────────────────
function buildRow(test, currentPath, allTests) {
  const summary  = (test.jira?.summary || '').toLowerCase().trim();
  const pathParts = currentPath.split('/').filter(Boolean);

  // Detect clone: if this test's summary appears in a Functional folder
  // Normalize path for case-insensitive matching
  const pathLower = currentPath.toLowerCase();
  const isInFunctional = pathLower.includes('functional') && !pathLower.includes('regression');
  const isInRegression = pathLower.includes('regression');

  // Clone = same folder contains both functional and regression clones
  // (In practice, we flag the current test if the path is Functional and marked as clone candidate)
  // We infer clone if the source folder is Functional — in that case suggest Regression/Functional moves
  let isClone = false;
  if (isInFunctional) {
    // Check if any other test in this batch has the same summary (potential duplicate/clone)
    const matchCount = allTests.filter(t => (t.jira?.summary || '').toLowerCase().trim() === summary).length;
    isClone = matchCount > 1;
  }

  // Derive sprint from path (or fallback to creation date, then active sprint)
  let sprintFromPath = pathParts.find(p => SPRINT_RE.test(p));
  if (!sprintFromPath && test.jira?.created) {
    sprintFromPath = getSprintFromDate(test.jira.created);
  }
  sprintFromPath = sprintFromPath || AZ.activeSprint || '';
  
  // Smarter MALCODE detection (in priority order):
  // 1. Path parts — handles compound names like MATA_Archive, CHOMM_October-2025
  //    Split each folder name on _ and - to check segments individually
  let malcodeFromPath = '';
  for (const p of pathParts) {
    const pUpper = p.toUpperCase();
    // First try exact segment match (strongest: "MATA" segment in "MATA_Archive")
    const segments = pUpper.split(/[_\-]/);
    const exactMatch = AZ.malcodes.find(m => segments.includes(m.toUpperCase()));
    if (exactMatch) { malcodeFromPath = exactMatch; break; }
    // Fallback: substring match (e.g. path part that starts with MALCODE)
    const subMatch = AZ.malcodes.find(m => pUpper.startsWith(m.toUpperCase()) || pUpper.includes(m.toUpperCase()));
    if (subMatch) { malcodeFromPath = subMatch; break; }
  }

  // 2. Check Jira labels (substring match)
  if (!malcodeFromPath && test.jira?.labels) {
    for (const l of test.jira.labels) {
      const lUpper = l.toUpperCase();
      const found = AZ.malcodes.find(m => lUpper.includes(m.toUpperCase()));
      if (found) { malcodeFromPath = found; break; }
    }
  }

  // 3. Check Jira components (name field)
  if (!malcodeFromPath && test.jira?.components) {
    for (const c of test.jira.components) {
      const cUpper = (c.name || '').toUpperCase();
      const found = AZ.malcodes.find(m => cUpper.includes(m.toUpperCase()));
      if (found) { malcodeFromPath = found; break; }
    }
  }

  // 4. Check any custom field values (string type only)
  if (!malcodeFromPath && test.jira?.customfields) {
    for (const val of Object.values(test.jira.customfields)) {
      if (typeof val === 'string') {
        const vUpper = val.toUpperCase();
        const found = AZ.malcodes.find(m => vUpper.includes(m.toUpperCase()));
        if (found) { malcodeFromPath = found; break; }
      }
    }
  }

  // 5. Check Jira summary (substring)
  if (!malcodeFromPath && summary) {
    const sumUpper = summary.toUpperCase();
    malcodeFromPath = AZ.malcodes.find(m => sumUpper.includes(m.toUpperCase())) || '';
  }

  // Default: first configured MALCODE (empty if none configured)
  malcodeFromPath = malcodeFromPath || (AZ.malcodes.length > 0 ? AZ.malcodes[0] : '');
  malcodeFromPath = malcodeFromPath.toUpperCase();

  // Suggest test category and target
  let suggestedCategory = 'Functional';
  let suggestedTarget   = 'Functional'; // Note: Only used if Category is Regression, but we set a default
  if (isClone && isInFunctional) {
    suggestedCategory = 'Regression';
    suggestedTarget   = 'Functional';
  } else if (isInRegression) {
    suggestedCategory = 'Regression';
    suggestedTarget   = pathParts.includes('E2E') ? 'E2E' : 'Functional';
  }

  const suggested = buildPath(suggestedCategory, suggestedTarget, sprintFromPath, malcodeFromPath);
  const suggestedTags = suggestTags(suggestedCategory, suggestedTarget, sprintFromPath, malcodeFromPath, isClone);

  return {
    test,
    currentPath,
    isClone,
    isInFunctional,
    isInRegression,
    suggestedCategory,
    suggestedTarget,
    sprintFromPath,
    malcodeFromPath,
    suggested,
    selectedTags: [...suggestedTags],  // Tags toggled on by default
    customCategory: suggestedCategory,
    customTarget:   suggestedTarget,
    customSprint:   sprintFromPath,
    customMalcode:  malcodeFromPath,
  };
}

// ─── PATH BUILDER ─────────────────────────────────────────────────────────────
function buildPath(category, target, sprint, malcode, env) {
  if (!sprint || !malcode || !AZ.podPath) return null;
  const base = AZ.podPath.replace(/\/$/, '');
  const envSuffix = env || (AZ.envs && AZ.envs[0]) || 'SIT';
  if (category === 'Functional') {
    return `${base}/Functional/${sprint}/${malcode}/${envSuffix}`;
  } else if (category === 'Regression') {
    const t = target || 'Functional';
    return `${base}/Regression/${t}/${sprint}/${malcode}/${envSuffix}`;
  }
  return null;
}

// ─── TAG SUGGESTIONS ──────────────────────────────────────────────────────────
function suggestTags(category, target, sprint, malcode, isClone) {
  const tags = [];
  if (sprint)   tags.push(sprint);
  if (malcode)  tags.push(malcode);
  
  if (category === 'Functional') {
    tags.push('SIT', 'Functional');
  } else if (category === 'Regression') {
    tags.push('Regression');
    if (target === 'Functional') tags.push('Functional');
    if (target === 'E2E')        tags.push('E2E');
  }
  
  if (isClone) tags.push('Cloned');
  return [...new Set(tags)];
}

// ─── RENDER TABLE ─────────────────────────────────────────────────────────────
function renderTable(folderPath, total) {
  document.getElementById('resultsTitle').textContent = `Analysis: ${folderPath.split('/').pop()}`;
  document.getElementById('resultsSub').textContent   = `${total} test(s) found`;

  const tbody = document.getElementById('analyzerTableBody');
  tbody.innerHTML = '';

  if (AZ.rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted);">No tests found in this folder</td></tr>`;
    return;
  }

  AZ.rows.forEach((row, idx) => {
    tbody.appendChild(buildTableRow(row, idx));
  });

  // Populate the folder-level suggestion panel dropdowns from the first row's detection
  populateFolderPanel();
}

function buildTableRow(row, idx) {
  const { test, isClone, sprintFromPath, malcodeFromPath } = row;
  const issueId = test.issueId || '';
  const summary = test.jira?.summary || '—';
  const labels  = test.jira?.labels  || [];
  const isSelected = AZ.selectedRows.has(idx);
  const caseSelectOn = document.getElementById('toggleCaseSelect')?.checked;

  const tr = document.createElement('tr');
  tr.dataset.idx = idx;
  if (isSelected) tr.classList.add('selected');

  // Detection badge
  let detectionBadge = '';
  if (isClone) {
    detectionBadge = `<span class="badge-clone">⚡ Clone → Regression</span>`;
  } else if (row.isInFunctional) {
    detectionBadge = `<span class="badge badge-neutral">Functional</span>`;
  } else if (row.isInRegression) {
    detectionBadge = `<span class="badge badge-warning">Regression</span>`;
  } else {
    detectionBadge = `<span class="badge badge-neutral">Other</span>`;
  }

  // Labels pills
  const labelPills = labels.map(l => `<span class="badge badge-neutral" style="font-size:10px;">${escHtml(l)}</span>`).join('');

  tr.innerHTML = `
    ${caseSelectOn ? `<td style="width:36px;text-align:center;">
      <input type="checkbox" onchange="toggleSelectAz(${idx}, this)" ${isSelected ? 'checked' : ''} />
    </td>` : ''}
    <td class="col-az-key"><span class="test-key">${escHtml(issueId)}</span></td>
    <td class="col-az-sum"><div class="test-summary">${escHtml(summary)}</div></td>
    <td class="col-az-status">${detectionBadge}</td>
    <td class="col-az-tags"><div style="display:flex;flex-wrap:wrap;gap:3px;">${labelPills || '<span style="color:var(--text-muted);font-size:11px;">—</span>'}</div></td>
    <td style="font-family:var(--mono);font-size:12px;color:var(--text-muted);">${escHtml(sprintFromPath || '—')}</td>
  `;

  return tr;
}

// ─── FOLDER PANEL ─────────────────────────────────────────────────────────────
function populateFolderPanel() {
  // Set pod root label
  const podRoot = document.getElementById('folderPodRoot');
  if (podRoot) podRoot.textContent = AZ.podPath || '/{POD}';

  // Populate MALCODE dropdown
  const malSel = document.getElementById('folderMalcode');
  if (malSel) {
    malSel.innerHTML = '<option value="">\u2014 MALCODE \u2014</option>' +
      AZ.malcodes.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
  }

  // Populate ENV dropdown
  const envSel = document.getElementById('folderEnv');
  if (envSel) {
    envSel.innerHTML = AZ.envs.map((e, i) => `<option value="${escHtml(e)}"${i === 0 ? ' selected' : ''}>${escHtml(e)}</option>`).join('');
  }

  // Auto-detect from first row
  if (AZ.rows.length > 0) {
    const first = AZ.rows[0];
    document.getElementById('folderCategory').value = first.customCategory || 'Functional';
    updateFolderTargetAccess();
    if (first.customCategory === 'Regression') {
      document.getElementById('folderTarget').value = first.customTarget || 'Functional';
    }
    document.getElementById('folderSprint').value = first.customSprint || '';
    if (malSel && first.customMalcode) malSel.value = first.customMalcode;
  }

  updateFolderPathPreview();
}

function updateFolderTargetAccess() {
  const cat = document.getElementById('folderCategory').value;
  const targetSel = document.getElementById('folderTarget');

  if (cat === 'Regression') {
    targetSel.disabled = false;
  } else {
    targetSel.disabled = true;
    targetSel.value = 'Functional';
  }
}

function updateFolderPathPreview() {
  const cat    = document.getElementById('folderCategory').value;
  const target = document.getElementById('folderTarget').value;
  const sprint = document.getElementById('folderSprint').value.trim().toUpperCase();
  const malcode = document.getElementById('folderMalcode').value;
  const env    = document.getElementById('folderEnv')?.value || '';

  const path = buildPath(cat, target, sprint, malcode, env);
  const el = document.getElementById('folderPathPreview');
  if (el) el.textContent = path || '— fill in Sprint and MALCODE —';
}

function openMoveFolderFromPanel() {
  if (AZ.readOnly) {
    toast('Read-only mode is active — folder move is disabled', 'warning');
    return;
  }
  const sourcePath = document.getElementById('analyzerPathInput').value.trim();
  if (!sourcePath) {
    toast('Analyze a folder first', 'error');
    return;
  }
  const destPath = document.getElementById('folderPathPreview').textContent;
  if (!destPath || destPath.startsWith('—')) {
    toast('Please configure the destination dropdowns first', 'error');
    return;
  }

  document.getElementById('moveFolderSrcLabel').textContent = sourcePath;
  document.getElementById('moveFolderDest').value = destPath;
  document.getElementById('moveFolderModal').style.display = 'flex';
}

// ─── CASE SELECTION TOGGLE ────────────────────────────────────────────────────
function setCaseSelectionMode(on) {
  const controls = document.getElementById('caseSelectionControls');
  const thChk    = document.getElementById('thCheckbox');
  if (controls) controls.style.display = on ? 'flex' : 'none';
  if (thChk)    thChk.style.display    = on ? '' : 'none';

  // Re-render the table to add/remove checkboxes
  const inputPath = document.getElementById('analyzerPathInput').value.trim();
  if (AZ.rows.length > 0) {
    const tbody = document.getElementById('analyzerTableBody');
    tbody.innerHTML = '';
    AZ.rows.forEach((row, idx) => tbody.appendChild(buildTableRow(row, idx)));
  }
}

// ─── SELECTION ────────────────────────────────────────────────────────────────
function toggleSelectAz(idx, cb) {
  if (cb.checked) AZ.selectedRows.add(idx);
  else            AZ.selectedRows.delete(idx);
  const tr = document.querySelector(`tr[data-idx="${idx}"]`);
  if (tr) tr.classList.toggle('selected', cb.checked);
  updateAzActionBar();
}

function toggleSelectAllAz(masterCb) {
  AZ.rows.forEach((_, idx) => {
    if (masterCb.checked) AZ.selectedRows.add(idx);
    else                  AZ.selectedRows.delete(idx);
  });
  document.querySelectorAll('#analyzerTableBody input[type=checkbox]').forEach(cb => {
    cb.checked = masterCb.checked;
    const tr = cb.closest('tr');
    if (tr) tr.classList.toggle('selected', masterCb.checked);
  });
  updateAzActionBar();
}

function clearAzSelection() {
  AZ.selectedRows.clear();
  document.querySelectorAll('#analyzerTableBody input[type=checkbox]').forEach(cb => {
    cb.checked = false;
    cb.closest('tr')?.classList.remove('selected');
  });
  const selectAllCb = document.getElementById('selectAllAz');
  if (selectAllCb) selectAllCb.checked = false;
  updateAzActionBar();
}

function updateAzActionBar() {
  const n   = AZ.selectedRows.size;
  const btn = document.getElementById('azMigrateBtn');
  const countEl = document.getElementById('azSelectedCount');
  if (countEl) countEl.textContent = `${n} selected`;
  if (btn)     btn.disabled = n === 0 || AZ.readOnly;
}



// ─── MOVE ENTIRE FOLDER ─────────────────────────────────────────────────────────────
function openMoveFolderModal() {
  if (AZ.readOnly) {
    toast('Read-only mode is active — folder move is disabled', 'warning');
    return;
  }
  const currentPath = document.getElementById('analyzerPathInput').value.trim();
  if (!currentPath) {
    toast('Please analyze a folder first', 'error');
    return;
  }
  document.getElementById('moveFolderSrcLabel').textContent = currentPath;
  document.getElementById('moveFolderDest').value = '';
  document.getElementById('moveFolderModal').style.display = 'flex';
}

async function confirmMoveFolder() {
  const sourcePath = document.getElementById('analyzerPathInput').value.trim();
  const destPath   = document.getElementById('moveFolderDest').value.trim();
  
  if (!destPath) {
    toast('Destination path is required', 'error');
    return;
  }
  if (destPath === sourcePath) {
    toast('Destination is the same as the source', 'error');
    return;
  }
  
  try {
    await api('/api/folders/move', {
      method: 'POST',
      body: { sourcePath, destPath }
    });
    toast(`Folder moved to ${destPath}`, 'success');
    closeModal('moveFolderModal');
    // Clear cache for this path since it's been moved
    delete AZ.cache[sourcePath];
  } catch (err) {
    toast(`Move failed: ${err.message}`, 'error');
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ─── MIGRATION ────────────────────────────────────────────────────────────────
async function runAzMigration() {
  if (AZ.readOnly) { toast('Read-only mode is ON — no changes allowed', 'error'); return; }
  if (AZ.selectedRows.size === 0) return;

  const selectedIdxs = [...AZ.selectedRows];
  const rowsToMigrate = selectedIdxs.map(i => AZ.rows[i]);

  // Check all have valid paths
  const invalid = rowsToMigrate.filter(r => !buildPath(r.customType, r.customSprint, r.customMalcode));
  if (invalid.length) {
    toast(`${invalid.length} test(s) have incomplete paths (sprint or MALCODE missing)`, 'error');
    return;
  }

  if (!confirm(`Migrate ${rowsToMigrate.length} test(s) to their new paths and download a report?`)) return;

  const btn = document.getElementById('azMigrateBtn');
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="border-top-color:white;width:14px;height:14px;"></div> Migrating…`;

  // Group by target path
  const groups = {};
  rowsToMigrate.forEach(row => {
    const target = buildPath(row.customCategory, row.customTarget, row.customSprint, row.customMalcode);
    if (!groups[target]) groups[target] = [];
    groups[target].push(row);
  });

  const reportData = [];
  let successCount = 0, failCount = 0;

  for (const [targetPath, rows] of Object.entries(groups)) {
    const issueIds = rows.map(r => r.test.issueId);
    try {
      await api('/api/tests/move', { method: 'POST', body: { testIssueIds: issueIds, targetPath } });

      // Apply tags if any selected
      for (const row of rows) {
        if (row.selectedTags.length > 0) {
          try {
            await api('/api/tests/labels', {
              method: 'POST',
              body: { testIssueIds: [row.test.issueId], labels: row.selectedTags, action: 'add' }
            });
          } catch { /* non-fatal if labels fail */ }
        }
        reportData.push({
          key: row.test.issueId,
          summary: row.test.jira?.summary || '',
          previous: row.currentPath,
          new: targetPath,
          tags: row.selectedTags.join('; '),
          status: 'Success'
        });
      }
      successCount += issueIds.length;
    } catch (err) {
      rows.forEach(row => {
        reportData.push({
          key: row.test.issueId,
          summary: row.test.jira?.summary || '',
          previous: row.currentPath,
          new: targetPath,
          tags: row.selectedTags.join('; '),
          status: `Failed: ${err.message}`
        });
      });
      failCount += issueIds.length;
    }
  }

  // Generate CSV
  let csv = 'Issue Key,Summary,Previous Path,New Path,Tags Applied,Status\n';
  reportData.forEach(r => {
    csv += `"${r.key}","${r.summary.replace(/"/g,'""')}","${r.previous}","${r.new}","${r.tags}","${r.status}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'migration_report.csv';
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  toast(`Migrated ${successCount} tests.${failCount > 0 ? ` Failed: ${failCount}.` : ''} Report downloaded.`, successCount > 0 ? 'success' : 'error');
  btn.disabled = false;
  btn.innerHTML = origHtml;
  clearAzSelection();
}

// ─── TOAST / UTILS ────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  el.innerHTML = `<span>${icons[type] || '•'}</span><span>${escHtml(msg)}</span>`;
  document.getElementById('toastContainer').prepend(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 350); }, 4000);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── DATE → SPRINT CALCULATION ─────────────────────────────────────────────────────
function getSprintFromDate(dateString) {
  if (!dateString) return null;
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return null;

  const fyStartMonth = AZ.fyStartMonth || 11; // 1-indexed month (November = 11)
  const sprintWeeks  = AZ.sprintWeeks  || 2;
  const sprintDays   = sprintWeeks * 7;

  // Determine FY year. FY starts at fyStartMonth.
  // If we're AT or AFTER the FY start month in the calendar year, FY year = calendar year.
  // If we're BEFORE, FY year = calendar year (FY covers previous November to next October).
  // Convention: FY26 = Nov 2025 – Oct 2026.
  const year  = d.getFullYear();
  const month = d.getMonth() + 1; // 1-indexed

  let fyYear;
  if (fyStartMonth > 1) {
    // e.g. November start: Nov=FY+1 year, so FY26 = Nov 2025 - Oct 2026
    fyYear = (month >= fyStartMonth) ? year + 1 : year;
  } else {
    fyYear = year;
  }
  const fyStr = String(fyYear).slice(-2); // e.g. "26"

  // Calculate which quarter we're in.
  // Quarter boundaries are always 3-month blocks from FY start.
  // E.g. FY Nov start: Q1=Nov,Dec,Jan Q2=Feb,Mar,Apr Q3=May,Jun,Jul Q4=Aug,Sep,Oct
  
  // Normalize month into offset from FY start (0-indexed)
  let monthOffset = (month - fyStartMonth + 12) % 12; // 0=first month of Q1
  const quarter = Math.floor(monthOffset / 3) + 1; // 1-4

  // Sprint number within the quarter:
  // Find the first Thursday of the quarter's first month
  const firstDayOfQ = new Date(d.getFullYear(), (fyStartMonth - 1 + Math.floor(monthOffset / 3) * 3) % 12, 1);
  // Find the first Thursday (day 4 in JS, 0=Sun)
  let dayOfWeek = firstDayOfQ.getDay();
  let daysUntilThursday = (4 - dayOfWeek + 7) % 7;
  const firstSprintStart = new Date(firstDayOfQ);
  firstSprintStart.setDate(1 + daysUntilThursday);

  // How many days since first sprint started?
  const daysDiff = Math.floor((d - firstSprintStart) / (1000 * 60 * 60 * 24));
  
  let sprintNum;
  if (daysDiff < 0) {
    sprintNum = 1; // Before the first sprint of the quarter
  } else {
    sprintNum = Math.floor(daysDiff / sprintDays) + 1;
  }

  return `FY${fyStr}Q${quarter}-S${sprintNum}`;
}

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
  tests:        [],      // raw tests from Xray
  rows:         [],      // enriched row objects { test, compliance, isClone, selectedTags, path }
  selectedRows: new Set(), // indices of selected rows
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
});

function loadConfig() {
  const saved = JSON.parse(localStorage.getItem('jtmf_config') || '{}');
  AZ.podPath      = saved.podPath      || '';
  AZ.malcodes     = saved.malcodes     || [];
  AZ.activeSprint = saved.activeSprint || '';
  AZ.readOnly     = saved.readOnly     || false;
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

// ─── ANALYSIS ─────────────────────────────────────────────────────────────────
async function runAnalysis() {
  const inputPath = document.getElementById('analyzerPathInput').value.trim();
  if (!inputPath) { toast('Please enter a folder path', 'error'); return; }

  document.getElementById('resultsCard').style.display      = 'none';
  document.getElementById('analyzerLoading').style.display  = 'flex';
  document.getElementById('analyzerLoadingMsg').textContent = `Analyzing ${inputPath}…`;

  try {
    // 1. Fetch folder info + tests
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

    // 2. Build enriched rows with smart suggestions
    AZ.rows = tests.map(test => buildRow(test, inputPath, tests));
    AZ.selectedRows.clear();

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
  // while the current path is NOT Functional, or vice versa
  const isInFunctional   = pathParts.includes('Functional')   && !pathParts.includes('Regression');
  const isInRegression   = pathParts.includes('Regression');

  // Clone = same folder contains both functional and regression clones
  // (In practice, we flag the current test if the path is Functional and marked as clone candidate)
  // We infer clone if the source folder is Functional — in that case suggest Regression/Functional moves
  let isClone = false;
  if (isInFunctional) {
    // Check if any other test in this batch has the same summary (potential duplicate/clone)
    const matchCount = allTests.filter(t => (t.jira?.summary || '').toLowerCase().trim() === summary).length;
    isClone = matchCount > 1;
  }

  // Derive sprint from path
  const sprintFromPath  = pathParts.find(p => SPRINT_RE.test(p)) || AZ.activeSprint || '';
  
  // Smarter MALCODE detection:
  // 1. Try to find right from the folder path
  let malcodeFromPath = pathParts.find(p => AZ.malcodes.includes(p.toUpperCase()));
  // 2. If not in path, try checking the Jira labels
  if (!malcodeFromPath && test.jira?.labels) {
     malcodeFromPath = test.jira.labels.find(l => AZ.malcodes.includes(l.toUpperCase()));
  }
  // 3. If not in labels, try checking if it's mentioned in the Jira Summary
  if (!malcodeFromPath && summary) {
     malcodeFromPath = AZ.malcodes.find(m => summary.includes(m.toLowerCase()));
  }
  // 4. Default to first configured MALCODE (or empty)
  malcodeFromPath = malcodeFromPath || AZ.malcodes[0] || '';
  // Ensure uppercase for consistency
  malcodeFromPath = malcodeFromPath.toUpperCase();

  // Suggest test type
  let suggestedType = 'functional';
  if (isClone && isInFunctional) {
    suggestedType = 'regression-functional';
  } else if (isInRegression) {
    suggestedType = pathParts.includes('E2E') ? 'regression-e2e' : 'regression-functional';
  }

  const suggested = buildPath(suggestedType, sprintFromPath, malcodeFromPath);
  const suggestedTags = suggestTags(suggestedType, sprintFromPath, malcodeFromPath, isClone);

  return {
    test,
    currentPath,
    isClone,
    isInFunctional,
    isInRegression,
    suggestedType,
    sprintFromPath,
    malcodeFromPath,
    suggested,
    selectedTags: [...suggestedTags],  // Tags toggled on by default
    customType:   suggestedType,
    customSprint: sprintFromPath,
    customMalcode: malcodeFromPath,
  };
}

// ─── PATH BUILDER ─────────────────────────────────────────────────────────────
function buildPath(testType, sprint, malcode) {
  if (!sprint || !malcode || !AZ.podPath) return null;
  const base = AZ.podPath.replace(/\/$/, '');
  switch (testType) {
    case 'functional':            return `${base}/Functional/${sprint}/${malcode}/SIT`;
    case 'regression-functional': return `${base}/Regression/Functional/${sprint}/${malcode}`;
    case 'regression-e2e':        return `${base}/Regression/E2E/${sprint}/${malcode}`;
    default: return null;
  }
}

// ─── TAG SUGGESTIONS ──────────────────────────────────────────────────────────
function suggestTags(testType, sprint, malcode, isClone) {
  const tags = [];
  if (sprint)   tags.push(sprint);
  if (malcode)  tags.push(malcode);
  if (testType === 'functional')            tags.push('SIT', 'Functional');
  if (testType === 'regression-functional') tags.push('Regression', 'Functional');
  if (testType === 'regression-e2e')        tags.push('Regression', 'E2E');
  if (isClone)  tags.push('Cloned');
  return [...new Set(tags)];
}

// ─── RENDER TABLE ─────────────────────────────────────────────────────────────
function renderTable(folderPath, total) {
  document.getElementById('resultsTitle').textContent = `Analysis: ${folderPath.split('/').pop()}`;
  document.getElementById('resultsSub').textContent   = `${total} test(s) found`;

  const tbody = document.getElementById('analyzerTableBody');
  tbody.innerHTML = '';

  if (AZ.rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted);">No tests found in this folder</td></tr>`;
    return;
  }

  AZ.rows.forEach((row, idx) => {
    tbody.appendChild(buildTableRow(row, idx));
  });

  updateAzActionBar();
}

function buildTableRow(row, idx) {
  const { test, currentPath, isClone, suggestedType, sprintFromPath, malcodeFromPath, selected, selectedTags } = row;
  const issueId = test.issueId || '';
  const summary = test.jira?.summary || '—';
  const labels  = test.jira?.labels  || [];
  const isSelected = AZ.selectedRows.has(idx);

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

  // Build MALCODE options from config + current
  const malcodeOptions = [...new Set([...AZ.malcodes, malcodeFromPath].filter(Boolean))];

  // Tag pills HTML
  const allPossibleTags = suggestTags(row.customType, row.customSprint, row.customMalcode, isClone);
  const tagPillsHtml = allPossibleTags.map(t => {
    const active = selectedTags.includes(t);
    return `<span class="tag-pill ${active ? 'active' : ''}" onclick="toggleTag(${idx}, '${escHtml(t)}')" title="Click to toggle">${escHtml(t)}</span>`;
  }).join('');

  // Current path preview of new path
  const previewPath = buildPath(row.customType, row.customSprint, row.customMalcode) || '— (configure POD first)';

  tr.innerHTML = `
    <td class="col-az-key">
      <span class="test-key">${escHtml(issueId)}</span>
    </td>
    <td class="col-az-sum">
      <div class="test-summary">${escHtml(summary)}</div>
      ${labels.length ? `<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:3px;">${labels.map(l => `<span class="badge badge-neutral" style="font-size:10px;">${escHtml(l)}</span>`).join('')}</div>` : ''}
    </td>
    <td class="col-az-cur">
      <span class="test-path" title="${escHtml(currentPath)}">${escHtml(currentPath)}</span>
    </td>
    <td class="col-az-status">${detectionBadge}</td>
    <td class="col-az-builder">
      <div class="path-builder-inline">
        <select onchange="updateRowType(${idx}, this.value)">
          <option value="functional"            ${row.customType==='functional'?'selected':''}>Functional</option>
          <option value="regression-functional" ${row.customType==='regression-functional'?'selected':''}>Regression/Functional</option>
          <option value="regression-e2e"        ${row.customType==='regression-e2e'?'selected':''}>Regression/E2E</option>
        </select>
        <span class="path-sep">/</span>
        <input type="text" value="${escHtml(row.customSprint)}" placeholder="FY26Q4-S2"
               oninput="updateRowSprint(${idx}, this.value)" style="width:105px;" />
        <span class="path-sep">/</span>
        <select onchange="updateRowMalcode(${idx}, this.value)">
          ${malcodeOptions.map(m => `<option value="${escHtml(m)}" ${row.customMalcode===m?'selected':''}>${escHtml(m)}</option>`).join('') || `<option value="">—</option>`}
        </select>
      </div>
      <div class="path-preview-inline" id="preview_${idx}">${escHtml(previewPath)}</div>
    </td>
    <td class="col-az-tags">
      <div class="tag-pills" id="tags_${idx}">${tagPillsHtml}</div>
    </td>
    <td class="col-az-apply" style="text-align:center;">
      <label class="checkbox-label" style="justify-content:center;">
        <input type="checkbox" onchange="toggleSelectAz(${idx}, this)" ${isSelected ? 'checked' : ''} />
        <span class="checkbox-custom"></span>
      </label>
    </td>
  `;

  return tr;
}

// ─── ROW UPDATE HANDLERS ──────────────────────────────────────────────────────
function updateRowType(idx, val) {
  AZ.rows[idx].customType = val;
  refreshRowPreview(idx);
  refreshRowTags(idx);
}
function updateRowSprint(idx, val) {
  AZ.rows[idx].customSprint = val.trim().toUpperCase();
  refreshRowPreview(idx);
  refreshRowTags(idx);
}
function updateRowMalcode(idx, val) {
  AZ.rows[idx].customMalcode = val;
  refreshRowPreview(idx);
  refreshRowTags(idx);
}

function refreshRowPreview(idx) {
  const row     = AZ.rows[idx];
  const preview = buildPath(row.customType, row.customSprint, row.customMalcode) || '— (sprint or MALCODE missing)';
  const el = document.getElementById(`preview_${idx}`);
  if (el) el.textContent = preview;
}

function refreshRowTags(idx) {
  const row = AZ.rows[idx];
  const allTags = suggestTags(row.customType, row.customSprint, row.customMalcode, row.isClone);
  // Keep existing selected tags that are still relevant
  row.selectedTags = row.selectedTags.filter(t => allTags.includes(t));
  // Add any new tags that result from the change
  allTags.forEach(t => { if (!row.selectedTags.includes(t)) row.selectedTags.push(t); });

  const el = document.getElementById(`tags_${idx}`);
  if (!el) return;
  el.innerHTML = allTags.map(t => {
    const active = row.selectedTags.includes(t);
    return `<span class="tag-pill ${active ? 'active' : ''}" onclick="toggleTag(${idx}, '${escHtml(t)}')">${escHtml(t)}</span>`;
  }).join('');
}

function toggleTag(idx, tag) {
  const row = AZ.rows[idx];
  const i   = row.selectedTags.indexOf(tag);
  if (i >= 0) row.selectedTags.splice(i, 1);
  else         row.selectedTags.push(tag);

  const el = document.getElementById(`tags_${idx}`);
  if (!el) return;
  el.querySelectorAll('.tag-pill').forEach(pill => {
    if (pill.textContent.trim() === tag) pill.classList.toggle('active', i < 0);
  });
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
  document.getElementById('selectAllAz').checked = false;
  updateAzActionBar();
}

function updateAzActionBar() {
  const n   = AZ.selectedRows.size;
  const btn = document.getElementById('azMigrateBtn');
  document.getElementById('azSelectedCount').textContent = `${n} test${n !== 1 ? 's' : ''} selected`;
  btn.disabled = n === 0 || AZ.readOnly;
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
    const target = buildPath(row.customType, row.customSprint, row.customMalcode);
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

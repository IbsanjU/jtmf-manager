// ═══════════════════════════════════════════════════════════════════════════════
//  JTMF Manager — Main App JS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── State ─────────────────────────────────────────────────────────────────────
const S = {
  projectKey:    '',
  podPath:       '',
  malcodes:      [],
  activeSprint:  '',
  readOnly:      false,
  currentFolder: null,
  tests:         [],
  filteredTests: [],
  selectedIds:   new Set(),
  pageSize:      50,
  page:          0,
  totalTests:    0,
  folderTree:    null,
};

const SPRINT_RE = /^FY\d{2}Q[1-4]-S\d+$/i;

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const res  = await api('/api/auth/status');
  if (!res.authenticated) { window.location.href = '/'; return; }

  S.projectKey = res.projectKey;
  document.getElementById('navProjectKey').textContent = res.projectKey;

  loadConfig();

  if (S.podPath) {
    applyConfig();
    loadTree();
  }
});

// ─── Persist config in localStorage ───────────────────────────────────────────
function loadConfig() {
  const saved = JSON.parse(localStorage.getItem('jtmf_config') || '{}');
  S.podPath      = saved.podPath      || '';
  S.malcodes     = saved.malcodes     || [];
  S.activeSprint = saved.activeSprint || '';
  S.readOnly     = saved.readOnly     || false;
  S.fyStartMonth = saved.fyStartMonth || 11; // default: November
  S.sprintWeeks  = saved.sprintWeeks  || 2;  // default: 2-week sprints
  S.envs         = saved.envs         || ['SIT', 'PAT']; // default environments
}
function saveConfig() {
  localStorage.setItem('jtmf_config', JSON.stringify({
    podPath:      S.podPath,
    malcodes:     S.malcodes,
    activeSprint: S.activeSprint,
    readOnly:     S.readOnly,
    fyStartMonth: S.fyStartMonth,
    sprintWeeks:  S.sprintWeeks,
    envs:         S.envs
  }));
}
function applyConfig() {
  const short = S.podPath.split('/').filter(Boolean).slice(-1)[0] || S.podPath;
  document.getElementById('podNameDisplay').textContent = short || 'No POD selected';

  // Pre-fill setup modal
  document.getElementById('setupPodPath').value    = S.podPath;
  document.getElementById('setupMalcodes').value   = S.malcodes.join(', ');
  document.getElementById('setupSprint').value     = S.activeSprint;
  document.getElementById('setupReadOnly').checked = S.readOnly;
  document.getElementById('setupFyStartMonth').value = String(S.fyStartMonth || 11);
  document.getElementById('setupSprintWeeks').value  = String(S.sprintWeeks  || 2);
  document.getElementById('setupEnvs').value          = (S.envs || ['SIT', 'PAT']).join(', ');

  // Read-only banner
  const banner = document.getElementById('readonlyBanner');
  if (banner) banner.style.display = S.readOnly ? 'flex' : 'none';

  // Enable toolbar buttons if pod configured
  const hasPod = !!S.podPath;
  document.getElementById('analyzeBtn').disabled      = !hasPod;
  document.getElementById('sprintWizardBtn').disabled = !hasPod;
  document.getElementById('suggestCapBtn').disabled   = !hasPod;

  // Populate MALCODE dropdowns
  populateMalcodeDropdowns();
}

// ─── API helper ────────────────────────────────────────────────────────────────
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

// ─── Auth ──────────────────────────────────────────────────────────────────────
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
}

// ─── Setup modal ──────────────────────────────────────────────────────────────
function openSetupModal() {
  document.getElementById('setupPodPath').value    = S.podPath;
  document.getElementById('setupMalcodes').value   = S.malcodes.join(', ');
  document.getElementById('setupSprint').value     = S.activeSprint;
  document.getElementById('setupReadOnly').checked = S.readOnly;
  document.getElementById('setupFyStartMonth').value = String(S.fyStartMonth || 11);
  document.getElementById('setupSprintWeeks').value  = String(S.sprintWeeks  || 2);
  document.getElementById('setupEnvs').value          = (S.envs || ['SIT', 'PAT']).join(', ');
  showModal('setupModal');
}

function saveSetup() {
  const podPath  = document.getElementById('setupPodPath').value.trim();
  const malRaw   = document.getElementById('setupMalcodes').value.trim();
  const sprint   = document.getElementById('setupSprint').value.trim().toUpperCase();
  const readOnly = document.getElementById('setupReadOnly').checked;

  if (!podPath) { toast('POD path is required', 'error'); return; }

  S.podPath       = podPath.startsWith('/') ? podPath : '/' + podPath;
  S.malcodes      = malRaw.split(',').map(m => m.trim().toUpperCase()).filter(Boolean);
  S.activeSprint  = sprint;
  S.readOnly      = readOnly;
  S.fyStartMonth  = parseInt(document.getElementById('setupFyStartMonth').value, 10) || 11;
  S.sprintWeeks   = parseInt(document.getElementById('setupSprintWeeks').value, 10)  || 2;
  S.envs          = document.getElementById('setupEnvs').value.split(',').map(e => e.trim().toUpperCase()).filter(Boolean);
  if (S.envs.length === 0) S.envs = ['SIT', 'PAT'];

  saveConfig();
  applyConfig();
  closeModal('setupModal');
  loadTree();
}

// ─── FOLDER TREE ──────────────────────────────────────────────────────────────
async function loadTree() {
  const treeEl = document.getElementById('folderTree');
  treeEl.innerHTML = `<div style="padding:20px;display:flex;justify-content:center;"><div class="spinner-lg"></div></div>`;

  try {
    const data = await api(`/api/folders?path=${encodeURIComponent(S.podPath)}`);
    S.folderTree = data.folder;
    if (!S.folderTree) {
      treeEl.innerHTML = `<div class="tree-empty"><p>No folder found at<br><code>${S.podPath}</code></p></div>`;
      return;
    }
    treeEl.innerHTML = '';
    treeEl.appendChild(buildTreeNode(S.folderTree, 0));
  } catch (err) {
    treeEl.innerHTML = `<div class="tree-empty"><p style="color:#EF4444;">${err.message}</p></div>`;
  }
}

async function refreshTree() { if (S.podPath) await loadTree(); }

function buildTreeNode(folder, depth) {
  const compliance = checkFolderCompliance(folder.path);
  const hasChildren = folder.folders?.length > 0;

  const node = document.createElement('div');
  node.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-node-row';
  row.dataset.path = folder.path;

  // Indentation
  const indent = document.createElement('span');
  indent.className = 'tree-indent';
  indent.style.width = `${depth * 14 + 8}px`;
  indent.style.display = 'inline-block';
  row.appendChild(indent);

  // Toggle arrow
  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';
  if (hasChildren) {
    toggle.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;
  }
  row.appendChild(toggle);

  // Folder icon
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = folderSVG(compliance.status);
  row.appendChild(icon);

  // Label
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = folder.name;
  row.appendChild(label);

  // Test count
  if (folder.testsCount > 0) {
    const cnt = document.createElement('span');
    cnt.className = 'tree-count';
    cnt.textContent = folder.testsCount;
    row.appendChild(cnt);
  }

  // Compliance dot
  const dot = document.createElement('span');
  dot.className = `tree-compliance dot-${compliance.dotClass}`;
  row.appendChild(dot);

  node.appendChild(row);

  // Children container
  let childrenEl = null;
  if (hasChildren) {
    childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';
    folder.folders.forEach(child => {
      childrenEl.appendChild(buildTreeNode(child, depth + 1));
    });
    node.appendChild(childrenEl);

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = childrenEl.classList.toggle('open');
      toggle.classList.toggle('open', open);
    });
  }

  // Click row → load tests
  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-node-row').forEach(r => r.classList.remove('active'));
    row.classList.add('active');
    // Auto-expand children
    if (hasChildren && childrenEl && !childrenEl.classList.contains('open')) {
      childrenEl.classList.add('open');
      toggle.classList.add('open');
    }
    loadTests(folder);
  });

  return node;
}

function folderSVG(status) {
  const colors = { ok: '#10B981', warn: '#F59E0B', err: '#EF4444', none: '#475569' };
  const c = colors[status] || colors.none;
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="${c}" style="opacity:.85"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;
}

// ─── COMPLIANCE CHECK ─────────────────────────────────────────────────────────
/*
  Compliant patterns (relative to POD root):
    Functional/{Sprint}/{MALCODE}/SIT              → full compliant
    Regression/Functional/{Sprint}/{MALCODE}       → full compliant
    Regression/E2E/{Sprint}/{MALCODE}              → full compliant

  Partial: prefix is right but sprint/malcode mismatch
  Non-compliant: doesn't start with Functional or Regression
  None: folder IS the POD root or above
*/
function checkFolderCompliance(fullPath) {
  if (!S.podPath || fullPath === S.podPath) {
    return { status: 'none', dotClass: 'none', label: '—', pattern: null };
  }

  const podPrefix = S.podPath.replace(/\/$/, '');
  if (!fullPath.startsWith(podPrefix + '/')) {
    return { status: 'none', dotClass: 'none', label: 'Outside POD', pattern: null };
  }

  const rel = fullPath.slice(podPrefix.length + 1); // e.g. "Functional/FY26Q4-S2/MALCODE1/SIT"
  const parts = rel.split('/').filter(Boolean);

  if (parts.length === 0) return { status: 'none', dotClass: 'none', label: '—', pattern: null };

  const validTypes = ['Functional', 'Regression'];
  if (!validTypes.includes(parts[0])) {
    return { status: 'err', dotClass: 'err', label: 'Non-compliant', pattern: null };
  }

  // Full path checks
  if (parts[0] === 'Functional') {
    if (parts.length === 4 &&
        SPRINT_RE.test(parts[1]) &&
        (S.malcodes.length === 0 || S.malcodes.includes(parts[2].toUpperCase())) &&
        parts[3] === 'SIT') {
      return { status: 'ok', dotClass: 'ok', label: 'Compliant', pattern: 'Functional' };
    }
    if (parts.length >= 2 && !SPRINT_RE.test(parts[1])) {
      return { status: 'warn', dotClass: 'warn', label: 'Wrong sprint format', pattern: null };
    }
    return { status: 'warn', dotClass: 'warn', label: 'Incomplete path', pattern: null };
  }

  if (parts[0] === 'Regression') {
    if (parts[1] === 'Functional') {
      if (parts.length === 4 && SPRINT_RE.test(parts[2]) &&
          (S.malcodes.length === 0 || S.malcodes.includes(parts[3].toUpperCase()))) {
        return { status: 'ok', dotClass: 'ok', label: 'Compliant', pattern: 'Reg/Functional' };
      }
      return { status: 'warn', dotClass: 'warn', label: 'Incomplete path', pattern: null };
    }
    if (parts[1] === 'E2E') {
      if (parts.length === 4 && SPRINT_RE.test(parts[2]) &&
          (S.malcodes.length === 0 || S.malcodes.includes(parts[3].toUpperCase()))) {
        return { status: 'ok', dotClass: 'ok', label: 'Compliant', pattern: 'Reg/E2E' };
      }
      return { status: 'warn', dotClass: 'warn', label: 'Incomplete path', pattern: null };
    }
    return { status: 'warn', dotClass: 'warn', label: 'Unknown Regression type', pattern: null };
  }

  return { status: 'err', dotClass: 'err', label: 'Non-compliant', pattern: null };
}

// ─── SUGGEST PATH ─────────────────────────────────────────────────────────────
function suggestPath(test, currentFolderPath) {
  // Derive sprint from current path if possible
  const pathParts = (currentFolderPath || '').split('/').filter(Boolean);
  const sprintFromPath = pathParts.find(p => SPRINT_RE.test(p)) || S.activeSprint || '';

  // Derive MALCODE: prefer known malcode found in path, then first malcode
  const malcodeFromPath = pathParts.find(p => S.malcodes.includes(p.toUpperCase())) || '';
  const malcode = malcodeFromPath || (S.malcodes[0] || '');

  // Derive test type from path
  let testType = 'functional'; // default
  if (pathParts.includes('Regression')) {
    testType = pathParts.includes('E2E') ? 'regression-e2e' : 'regression-functional';
  }

  if (!sprintFromPath || !malcode || !S.podPath) return null;

  return buildPath(testType, sprintFromPath, malcode, S.envs?.[0]);
}

function buildPath(testType, sprint, malcode, env) {
  if (!sprint || !malcode || !S.podPath) return null;
  const base = S.podPath.replace(/\/$/, '');
  const envSuffix = env || (S.envs && S.envs[0]) || 'SIT';
  switch (testType) {
    case 'functional':           return `${base}/Functional/${sprint}/${malcode}/${envSuffix}`;
    case 'regression-functional': return `${base}/Regression/Functional/${sprint}/${malcode}/${envSuffix}`;
    case 'regression-e2e':       return `${base}/Regression/E2E/${sprint}/${malcode}/${envSuffix}`;
    default:                      return null;
  }
}

// ─── LOAD TESTS ───────────────────────────────────────────────────────────────
async function loadTests(folder, pageOverride = 0) {
  S.currentFolder = folder;
  S.page = pageOverride;
  S.selectedIds.clear();
  updateActionBar();

  // Show loading
  document.getElementById('contentEmpty').style.display   = 'none';
  document.getElementById('tableWrapper').style.display   = 'none';
  document.getElementById('loadingState').style.display   = 'flex';
  document.getElementById('loadingMsg').textContent       = `Loading tests from ${folder.name}…`;

  // Breadcrumb
  renderBreadcrumb(folder.path);

  try {
    const qs = new URLSearchParams({
      folderPath: folder.path,
      limit: S.pageSize,
      start: pageOverride * S.pageSize
    });
    const data = await api(`/api/tests?${qs}`);

    S.tests      = data.results || [];
    S.totalTests = data.total || 0;

    renderTable();
    populateFolderPanel(folder);

    document.getElementById('loadingState').style.display   = 'none';
    document.getElementById('tableWrapper').style.display   = 'flex';
    document.getElementById('tableWrapper').style.flexDirection = 'column';
  } catch (err) {
    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('contentEmpty').style.display = 'flex';
    toast(err.message, 'error');
  }
}

// ─── RENDER TABLE ─────────────────────────────────────────────────────────────
function renderTable() {
  filterTests(); // applies search/filter and renders
}

function filterTests() {
  const q     = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const cf    = document.getElementById('filterCompliance')?.value || '';

  S.filteredTests = S.tests.filter(t => {
    const summary = (t.jira?.summary || '').toLowerCase();
    const key     = (t.issueId || '').toLowerCase();
    const matchQ  = !q || summary.includes(q) || key.includes(q);
    if (!matchQ) return false;

    if (cf) {
      const comp = checkFolderCompliance(S.currentFolder?.path || '');
      if (cf === 'compliant'     && comp.status !== 'ok')   return false;
      if (cf === 'partial'       && comp.status !== 'warn')  return false;
      if (cf === 'non-compliant' && comp.status !== 'err')   return false;
    }
    return true;
  });

  renderTableRows();
}

function renderTableRows() {
  const tbody  = document.getElementById('testTableBody');
  const count  = document.getElementById('tableCount');
  count.textContent = `${S.filteredTests.length} test${S.filteredTests.length !== 1 ? 's' : ''}`;

  if (S.filteredTests.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted);">No tests found</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  S.filteredTests.forEach(test => {
    const row = buildTestRow(test);
    tbody.appendChild(row);
  });

  // Pagination info
  const start = S.page * S.pageSize + 1;
  const end   = Math.min(start + S.filteredTests.length - 1, S.totalTests);
  document.getElementById('paginationInfo').textContent =
    `Showing ${start}–${end} of ${S.totalTests}`;

  renderPagination();
}

function buildTestRow(test) {
  const issueId    = test.issueId || '';
  const summary    = test.jira?.summary || '—';
  const labels     = test.jira?.labels || [];
  const curPath    = S.currentFolder?.path || '';
  const compliance = checkFolderCompliance(curPath);
  const suggested  = suggestPath(test, curPath);
  const isSelected = S.selectedIds.has(issueId);

  // Suggested labels from state, if any computed by suggestCapabilities
  const suggestedLabels = test.suggestedLabels || [];
  const hasNewLabels = suggestedLabels.length > 0 && suggestedLabels.some(l => !labels.includes(l));

  const tr = document.createElement('tr');
  tr.dataset.id = issueId;
  if (isSelected) tr.classList.add('row-selected');

  tr.innerHTML = `
    <td class="col-check">
      <label class="checkbox-label">
        <input type="checkbox" onchange="toggleSelect('${escHtml(issueId)}', this)" ${isSelected ? 'checked' : ''} />
        <span class="checkbox-custom"></span>
      </label>
    </td>
    <td class="col-key">
      <span class="test-key">${escHtml(issueId)}</span>
    </td>
    <td class="col-summary">
      <div class="test-summary">${escHtml(summary)}</div>
      ${labels.length ? `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px;">${labels.map(l => `<span class="badge badge-neutral" style="font-size:10px;">${escHtml(l)}</span>`).join('')}</div>` : ''}
    </td>
    <td class="col-path">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="test-path" title="${escHtml(curPath)}">${escHtml(curPath)}</span>
        <a href="/analyzer.html?path=${encodeURIComponent(curPath)}" class="row-btn" style="padding:2px 4px;height:auto;" title="Open in Analyzer">
          <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
        </a>
      </div>
    </td>
    <td class="col-status">
      ${complianceBadge(compliance)}
    </td>
    <td class="col-suggest-labels">
       <div style="display:flex;flex-wrap:wrap;gap:3px;">
         ${suggestedLabels.length 
           ? suggestedLabels.map(l => {
              const badgeClass = labels.includes(l) ? 'badge-neutral' : 'badge-primary';
              return `<span class="badge ${badgeClass}" style="font-size:10px;" title="Suggested label">${escHtml(l)}</span>`;
             }).join('')
           : '<span class="suggest-path no-suggest">—</span>'}
       </div>
    </td>
    <td class="col-suggest">
      <div class="suggest-cell">
        ${suggested
          ? `<span class="suggest-path" title="${escHtml(suggested)}">${escHtml(suggested.replace(S.podPath, '…'))}</span>`
          : `<span class="suggest-path no-suggest">—</span>`}
      </div>
    </td>
    <td class="col-actions">
      <div class="row-actions">
        ${suggested
          ? `<button class="row-btn row-btn-primary" onclick="moveSingle('${escHtml(issueId)}', '${escHtml(suggested)}')">Move</button>`
          : `<button class="row-btn" onclick="openSingleMoveModal('${escHtml(issueId)}', '${escHtml(summary)}')">Move…</button>`}
      </div>
    </td>
  `;

  return tr;
}

function complianceBadge(c) {
  if (c.status === 'ok')   return `<span class="badge badge-success">✓ ${c.label}</span>`;
  if (c.status === 'warn') return `<span class="badge badge-warning">⚠ ${c.label}</span>`;
  if (c.status === 'err')  return `<span class="badge badge-error">✗ ${c.label}</span>`;
  return `<span class="badge badge-neutral">${c.label}</span>`;
}

// ─── SELECTION ────────────────────────────────────────────────────────────────
function toggleSelect(issueId, cb) {
  if (cb.checked) S.selectedIds.add(issueId);
  else            S.selectedIds.delete(issueId);

  const row = document.querySelector(`tr[data-id="${issueId}"]`);
  if (row) row.classList.toggle('row-selected', cb.checked);
  updateActionBar();
  updateSelectAll();
}

function toggleSelectAll(masterCb) {
  S.filteredTests.forEach(t => {
    if (masterCb.checked) S.selectedIds.add(t.issueId);
    else                  S.selectedIds.delete(t.issueId);
  });
  document.querySelectorAll('#testTableBody input[type=checkbox]').forEach(cb => {
    cb.checked = masterCb.checked;
    const row = cb.closest('tr');
    if (row) row.classList.toggle('row-selected', masterCb.checked);
  });
  updateActionBar();
}

function updateSelectAll() {
  const master = document.getElementById('selectAll');
  if (!master) return;
  const total    = S.filteredTests.length;
  const selected = S.filteredTests.filter(t => S.selectedIds.has(t.issueId)).length;
  master.checked = selected === total && total > 0;
  master.indeterminate = selected > 0 && selected < total;
}

function clearSelection() {
  S.selectedIds.clear();
  document.querySelectorAll('#testTableBody input[type=checkbox]').forEach(cb => cb.checked = false);
  document.querySelectorAll('#testTableBody tr').forEach(r => r.classList.remove('row-selected'));
  updateSelectAll();
  updateActionBar();
}

function updateActionBar() {
  const bar   = document.getElementById('actionBar');
  const count = document.getElementById('actionCount');
  const badge = document.getElementById('selectedBadge');
  const n     = S.selectedIds.size;

  if (n > 0) {
    bar.style.display = 'flex';
    count.textContent = `${n} test${n !== 1 ? 's' : ''} selected`;
    badge.textContent = `${n} selected`;
    badge.style.display = 'inline-flex';
  } else {
    bar.style.display = 'none';
    badge.style.display = 'none';
  }
}

// ─── ANALYZE ALL ──────────────────────────────────────────────────────────────
async function analyzeAll() {
  if (!S.folderTree) { toast('Load the folder tree first', 'error'); return; }
  toast(`Analyzing ${S.folderTree.testsCount || 0} tests across all folders…`, 'info');
  // For now, loads the root folder tests
  if (S.folderTree) loadTests(S.folderTree);
}

// ─── AUTO-SUGGEST LABELS ──────────────────────────────────────────────────────
async function suggestCapabilities() {
  if (!S.currentFolder || S.filteredTests.length === 0) {
    toast('No tests to suggest labels for', 'warn');
    return;
  }

  const btn = document.getElementById('suggestCapBtn');
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<div class="spinner" style="border-top-color:white;width:14px;height:14px;"></div> Suggesting…`;

  try {
    const data = await api('/api/tests/suggest-labels', {
      method: 'POST',
      body: { tests: S.filteredTests, currentPath: S.currentFolder.path }
    });

    if (data.results) {
      // Map results back to tests in state
      data.results.forEach(res => {
        const test = S.tests.find(t => t.issueId === res.issueId);
        if (test) {
          test.suggestedLabels = res.suggestedLabels;
        }
      });
      // Re-trigger layout render
      renderTableRows();
      toast('Labels generated! You can now review and move/tag them.', 'success');
    }
  } catch (err) {
    toast(`Failed to analyze capabilities: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

// ─── MOVE MODAL ───────────────────────────────────────────────────────────────
function openMoveModal() {
  if (S.selectedIds.size === 0) return;

  const ids   = [...S.selectedIds];
  const tests = S.tests.filter(t => ids.includes(t.issueId));

  // Pre-fill from current folder path
  const pathParts  = (S.currentFolder?.path || '').split('/').filter(Boolean);
  const podParts   = S.podPath.replace(/^\//, '').split('/').filter(Boolean);
  const relParts   = pathParts.slice(podParts.length);

  let testType = 'functional';
  if (relParts[0] === 'Regression') {
    testType = relParts[1] === 'E2E' ? 'regression-e2e' : 'regression-functional';
  }

  const sprintFromPath = relParts.find(p => SPRINT_RE.test(p)) || S.activeSprint;
  const malcodeFromPath = relParts.find(p => S.malcodes.includes(p.toUpperCase())) || S.malcodes[0] || '';

  // Set dropdowns
  document.getElementById('moveTestType').value = testType;
  document.getElementById('moveSprint').value   = sprintFromPath || '';
  const malSel = document.getElementById('moveMalcode');
  if (malSel) malSel.value = malcodeFromPath;

  // Chips
  const chips = document.getElementById('moveTestChips');
  chips.innerHTML = tests.map(t => `
    <div class="test-chip">
      <span class="test-chip-key">${escHtml(t.issueId)}</span>
      <span class="test-chip-name">${escHtml(t.jira?.summary || '')}</span>
    </div>`).join('');
  document.getElementById('moveTestCount').textContent = ids.length;
  document.getElementById('moveInfo').textContent = `Moving ${ids.length} test case${ids.length !== 1 ? 's' : ''} to a new folder.`;

  updatePathPreview();
  showModal('moveModal');
}

function openSingleMoveModal(issueId, summary) {
  S.selectedIds.clear();
  S.selectedIds.add(issueId);
  updateActionBar();
  openMoveModal();
}

function updatePathPreview() {
  const testType = document.getElementById('moveTestType')?.value || 'functional';
  const sprint   = document.getElementById('moveSprint')?.value?.trim().toUpperCase() || '';
  const malcode  = document.getElementById('moveMalcode')?.value || '';
  const preview  = buildPath(testType, sprint, malcode);
  document.getElementById('pathPreviewText').textContent = preview || '/…';
}

async function confirmMove() {
  if (S.readOnly) { toast('Read-only mode is ON — no changes will be made', 'error'); return; }
  const testType = document.getElementById('moveTestType').value;
  const sprint   = document.getElementById('moveSprint').value.trim().toUpperCase();
  const malcode  = document.getElementById('moveMalcode').value;

  if (!sprint || !SPRINT_RE.test(sprint)) { toast('Sprint format invalid (e.g. FY26Q4-S2)', 'error'); return; }
  if (!malcode) { toast('Please select a MALCODE', 'error'); return; }

  const targetPath = buildPath(testType, sprint, malcode);
  if (!targetPath) { toast('Cannot build path — check your settings', 'error'); return; }

  const ids = [...S.selectedIds];
  const btn = document.getElementById('confirmMoveBtn');
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="border-top-color:white;width:14px;height:14px;"></div> Moving…`;

  try {
    await api('/api/tests/move', { method: 'POST', body: { testIssueIds: ids, targetPath } });
    toast(`✓ Moved ${ids.length} test${ids.length !== 1 ? 's' : ''} to ${targetPath}`, 'success');
    closeModal('moveModal');
    clearSelection();
    if (S.currentFolder) loadTests(S.currentFolder);
    loadTree();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Confirm Move`;
  }
}

async function moveSingle(issueId, targetPath) {
  if (S.readOnly) { toast('Read-only mode is ON — no changes will be made', 'error'); return; }
  try {
    await api('/api/tests/move', { method: 'POST', body: { testIssueIds: [issueId], targetPath } });
    toast(`✓ Moved ${issueId} to ${targetPath.split('/').slice(-3).join('/')}`, 'success');
    if (S.currentFolder) loadTests(S.currentFolder);
    loadTree();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── MIGRATE & REPORT ─────────────────────────────────────────────────────────
async function migrateSelected() {
  if (S.readOnly) { toast('Read-only mode is ON — no changes will be made', 'error'); return; }
  if (S.selectedIds.size === 0) return;

  const ids = [...S.selectedIds];
  const testsToMigrate = S.tests.filter(t => ids.includes(t.issueId));
  const curPath = S.currentFolder?.path || '';

  if (!confirm(`Are you sure you want to migrate ${ids.length} test(s) to their suggested paths and download a report?`)) {
    return;
  }

  const btn = document.getElementById('migrateReportBtn');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="border-top-color:white;width:14px;height:14px;"></div> Migrating…`;

  // Group by target path
  const movements = {};
  const reportData = [];

  for (const test of testsToMigrate) {
    const suggested = suggestPath(test, curPath);
    if (suggested) {
      if (!movements[suggested]) movements[suggested] = [];
      movements[suggested].push(test.issueId);
      reportData.push({
        key: test.issueId,
        previous: curPath,
        new: suggested,
        status: 'Pending'
      });
    } else {
      reportData.push({
        key: test.issueId,
        previous: curPath,
        new: 'None',
        status: 'Skipped (No suggested path)'
      });
    }
  }

  let successCount = 0;
  let failCount = 0;

  // Execute movements
  for (const [targetPath, issueIds] of Object.entries(movements)) {
    try {
      await api('/api/tests/move', { method: 'POST', body: { testIssueIds: issueIds, targetPath } });
      issueIds.forEach(id => {
        const reportIdx = reportData.findIndex(r => r.key === id);
        if (reportIdx !== -1) reportData[reportIdx].status = 'Success';
      });
      successCount += issueIds.length;
    } catch (err) {
      issueIds.forEach(id => {
        const reportIdx = reportData.findIndex(r => r.key === id);
        if (reportIdx !== -1) reportData[reportIdx].status = `Failed: ${err.message}`;
      });
      failCount += issueIds.length;
    }
  }

  // Generate CSV
  let csvContent = 'Issue Key,Previous Path,New Path,Status\n';
  reportData.forEach(row => {
    csvContent += `"${row.key}","${row.previous}","${row.new}","${row.status}"\n`;
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', 'migration_report.csv');
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  toast(`Migrated ${successCount} tests. ${failCount > 0 ? `Failed ${failCount}. ` : ''}Report downloaded.`, successCount > 0 ? 'success' : 'warn');

  btn.disabled = false;
  btn.innerHTML = originalHtml;
  clearSelection();
  
  if (S.currentFolder) loadTests(S.currentFolder);
  loadTree();
}

// ─── SPRINT WIZARD ────────────────────────────────────────────────────────────
function openSprintWizard() {
  document.getElementById('wizardSprint').value = S.activeSprint || '';
  const malSel = document.getElementById('wizardMalcode');
  if (malSel) malSel.value = S.malcodes[0] || '';
  updateWizardPreview();
  showModal('sprintModal');
}

function updateWizardPreview() {
  const sprint  = document.getElementById('wizardSprint')?.value?.trim().toUpperCase() || '';
  const malcode = document.getElementById('wizardMalcode')?.value || '';
  const list    = document.getElementById('wizardFolderList');
  if (!list) return;

  if (!sprint || !malcode || !S.podPath) {
    list.innerHTML = `<li style="color:var(--text-muted);font-family:var(--font);">Enter sprint and MALCODE to preview</li>`;
    return;
  }

  const base = S.podPath.replace(/\/$/, '');
  const folders = [
    `${base}/Functional/${sprint}/${malcode}/SIT`,
    `${base}/Regression/Functional/${sprint}/${malcode}`,
    `${base}/Regression/E2E/${sprint}/${malcode}`
  ];
  list.innerHTML = folders.map(f => `<li>${escHtml(f)}</li>`).join('');
}

async function runSprintWizard() {
  if (S.readOnly) { toast('Read-only mode is ON — no changes will be made', 'error'); return; }
  const sprint  = document.getElementById('wizardSprint').value.trim().toUpperCase();
  const malcode = document.getElementById('wizardMalcode').value;

  if (!sprint || !SPRINT_RE.test(sprint)) { toast('Sprint format invalid (e.g. FY26Q4-S2)', 'error'); return; }
  if (!malcode) { toast('Please select a MALCODE', 'error'); return; }

  const base = S.podPath.replace(/\/$/, '');
  const folders = [
    `${base}/Functional/${sprint}/${malcode}/SIT`,
    `${base}/Regression/Functional/${sprint}/${malcode}`,
    `${base}/Regression/E2E/${sprint}/${malcode}`
  ];

  closeModal('sprintModal');
  let created = 0, failed = 0;

  for (const fp of folders) {
    try {
      await api('/api/folders/create', { method: 'POST', body: { path: fp } });
      created++;
    } catch {
      failed++;
    }
  }

  if (failed === 0) toast(`✓ Created all ${created} sprint folders for ${sprint}`, 'success');
  else              toast(`Created ${created}, failed ${failed} folders`, 'error');

  loadTree();
}

// ─── PAGINATION ───────────────────────────────────────────────────────────────
function renderPagination() {
  const total = Math.ceil(S.totalTests / S.pageSize);
  const cur   = S.page;
  const pag   = document.getElementById('pagination');
  if (!pag || total <= 1) { if (pag) pag.innerHTML = ''; return; }

  let html = `<button class="page-btn" onclick="goPage(${cur-1})" ${cur===0?'disabled':''}>‹</button>`;
  for (let i = 0; i < total; i++) {
    if (total > 7 && i > 1 && i < total-2 && Math.abs(i-cur) > 1) {
      if (i === 2 || i === total-3) html += `<span class="page-btn" style="cursor:default;">…</span>`;
      continue;
    }
    html += `<button class="page-btn ${i===cur?'active':''}" onclick="goPage(${i})">${i+1}</button>`;
  }
  html += `<button class="page-btn" onclick="goPage(${cur+1})" ${cur>=total-1?'disabled':''}>›</button>`;
  pag.innerHTML = html;
}

function goPage(n) {
  if (n < 0 || n >= Math.ceil(S.totalTests / S.pageSize)) return;
  loadTests(S.currentFolder, n);
}

// ─── BREADCRUMB ───────────────────────────────────────────────────────────────
function renderBreadcrumb(fullPath) {
  const bc = document.getElementById('breadcrumb');
  if (!fullPath) { bc.innerHTML = `<span class="breadcrumb-home">Select a folder</span>`; return; }
  const parts = fullPath.split('/').filter(Boolean);
  bc.innerHTML = parts.map((p, i) => {
    if (i === parts.length - 1) return `<span class="breadcrumb-item">${escHtml(p)}</span>`;
    return `<span class="breadcrumb-item" style="color:var(--text-muted)">${escHtml(p)}</span><span class="breadcrumb-sep">/</span>`;
  }).join('') + `
    <a href="/analyzer.html?path=${encodeURIComponent(fullPath)}" class="btn btn-ghost btn-sm" style="margin-left:12px;height:24px;padding:0 8px;font-size:11px;display:inline-flex;align-items:center;gap:4px;" title="Open this folder in Folder Analyzer">
      <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      Analyze Folder
    </a>
  `;
}

// ─── DROPDOWNS ────────────────────────────────────────────────────────────────
function populateMalcodeDropdowns() {
  ['moveMalcode', 'wizardMalcode'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = S.malcodes.length
      ? S.malcodes.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('')
      : `<option value="">No MALCODEs configured</option>`;
  });
}

// ─── MODAL HELPERS ────────────────────────────────────────────────────────────
function showModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// ─── TOAST ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  el.innerHTML = `<span>${icons[type] || '•'}</span><span>${escHtml(msg)}</span>`;
  document.getElementById('toastContainer').prepend(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 350); }, 4000);
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── FOLDER PANEL (ANALYZER FEATURES) ──────────────────────────────────────────
function populateFolderPanel(folder) {
  if (!folder) return;
  
  // Set POD root label
  document.getElementById('folderPodRoot').textContent = S.podPath || '/POD';
  
  // Populate MALCODE dropdown
  const malSel = document.getElementById('folderMalcode');
  if (malSel) {
    malSel.innerHTML = `<option value="">— MALCODE —</option>` + 
      S.malcodes.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
  }

  // Populate ENV dropdown
  const envSel = document.getElementById('folderEnv');
  if (envSel) {
    envSel.innerHTML = (S.envs || ['SIT', 'PAT']).map(e => `<option value="${escHtml(e)}">${escHtml(e)}</option>`).join('');
  }

  // Detect context from path
  const parts = folder.path.split('/').filter(Boolean);
  const podParts = (S.podPath || '').split('/').filter(Boolean);
  const rel = parts.slice(podParts.length);

  let category = 'Functional';
  let target = 'Functional';
  if (rel[0] === 'Regression') {
    category = 'Regression';
    target = rel[1] === 'E2E' ? 'E2E' : 'Functional';
  }

  const sprint = rel.find(p => SPRINT_RE.test(p)) || S.activeSprint || '';
  const malcode = rel.find(p => S.malcodes.includes(p.toUpperCase())) || S.malcodes[0] || '';

  // Set values
  document.getElementById('folderCategory').value = category;
  document.getElementById('folderTarget').value = target;
  document.getElementById('folderSprint').value = sprint;
  if (malSel) malSel.value = malcode;

  updateFolderTargetAccess();
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
  const cat     = document.getElementById('folderCategory').value;
  const target  = document.getElementById('folderTarget').value;
  const sprint  = document.getElementById('folderSprint').value.trim().toUpperCase();
  const malcode = document.getElementById('folderMalcode').value;
  const env     = document.getElementById('folderEnv').value;

  const typeMap = {
    'Functional': 'functional',
    'RegressionFunctional': 'regression-functional',
    'RegressionE2E': 'regression-e2e'
  };
  const key = cat === 'Regression' ? `Regression${target}` : 'Functional';
  const type = typeMap[key];

  const preview = buildPath(type, sprint, malcode, env);
  const previewEl = document.getElementById('folderPathPreview');
  if (preview) {
    previewEl.textContent = preview;
    previewEl.style.color = 'var(--success)';
  } else {
    previewEl.textContent = '— configure dropdowns above —';
    previewEl.style.color = 'var(--text-muted)';
  }
}

function openMoveFolderFromPanel() {
  const path = document.getElementById('folderPathPreview').textContent;
  if (!path || path.includes('—')) {
    toast('Please configure a valid destination path first', 'warn');
    return;
  }

  if (!S.currentFolder) return;
  
  // Reuse the move folder logic (we'll implement a folder move confirmation)
  if (S.readOnly) { toast('Read-only mode is ON — no changes will be made', 'error'); return; }

  const count = S.totalTests;
  if (!confirm(`Warning: This will move the ENTIRE folder "${S.currentFolder.name}" (${count} tests) to:\n\n${path}\n\nAre you sure?`)) {
    return;
  }

  const btn = document.getElementById('folderMoveBtn');
  const oldHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="border-top-color:white;width:12px;height:12px;"></div> Moving…`;

  api('/api/folders/move', {
    method: 'POST',
    body: { sourcePath: S.currentFolder.path, targetPath: path }
  }).then(() => {
    toast(`✓ Folder moved successfully to ${path}`, 'success');
    loadTree();
    // After move, the current folder might be gone/moved, so we clear view
    document.getElementById('tableWrapper').style.display = 'none';
    document.getElementById('contentEmpty').style.display = 'flex';
  }).catch(err => {
    toast(err.message, 'error');
  }).finally(() => {
    btn.disabled = false;
    btn.innerHTML = oldHtml;
  });
}

// Add scroll container to table
document.addEventListener('DOMContentLoaded', () => {
  // Wrap table in scroll container
  const tw = document.getElementById('tableWrapper');
  if (tw) {
    const scrollDiv = document.createElement('div');
    scrollDiv.className = 'table-scroll';
    scrollDiv.style.flex = '1';
    scrollDiv.style.overflowY = 'auto';
    const table = document.getElementById('testTable');
    if (table) {
      table.parentNode.insertBefore(scrollDiv, table);
      scrollDiv.appendChild(table);
    }
  }
});

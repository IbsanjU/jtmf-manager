/**
 * JTMF Manager — Node.js server (zero external dependencies)
 * Uses only built-in: http, https, fs, path, url, crypto
 */
const http   = require('http');
require('dotenv').config();
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

const PORT         = process.env.PORT || 3000;
const PUBLIC_DIR   = path.join(__dirname, 'public');
const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');

// ─── In-memory session store ────────────────────────────────────────────────
const sessions = new Map(); // token → { xrayToken, projectKey, jiraUrl, createdAt }

function createSession(data) {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { ...data, createdAt: Date.now() });
  return id;
}
function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/jtmf_sid=([a-f0-9]+)/);
  if (!match) return null;
  const sess = sessions.get(match[1]);
  if (!sess) return null;
  // 8-hour expiry
  if (Date.now() - sess.createdAt > 8 * 60 * 60 * 1000) {
    sessions.delete(match[1]);
    return null;
  }
  return { id: match[1], ...sess };
}
function deleteSession(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/jtmf_sid=([a-f0-9]+)/);
  if (match) sessions.delete(match[1]);
}

// ─── MIME types ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function respond(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const ct   = typeof data === 'string' ? 'text/plain' : 'application/json';
  res.writeHead(status, { 'Content-Type': ct, ...headers });
  res.end(body);
}

function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { json(res, 404, { error: 'Not found' }); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ─── HTTPS request helper ───────────────────────────────────────────────────
// rejectUnauthorized:false allows self-signed / internal-CA certs (TD network)
const SSL_AGENT = new https.Agent({ rejectUnauthorized: false });

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ agent: SSL_AGENT, ...options }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── Jira / Xray DC auth & request helpers ──────────────────────────────────

function jiraHost() {
  return (JIRA_BASE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// Make a Basic-Auth request to Jira/Xray DC
async function jiraReq(method, path, basicAuth, body = null) {
  const host = jiraHost();
  if (!host) throw new Error('JIRA_BASE_URL is not configured on the server.');
  const bodyStr  = body ? JSON.stringify(body) : null;
  const headers  = {
    'Authorization':  `Basic ${basicAuth}`,
    'Content-Type':   'application/json',
    'Accept':         'application/json',
    ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
  };
  const res = await httpsRequest({ hostname: host, path, method, headers }, bodyStr);
  if (res.status === 401) throw new Error('Jira session expired. Please log in again.');
  return res;
}

// Validate credentials against Jira; returns Base64 Basic-auth string
async function jiraAuth(username, password) {
  const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');
  const res = await jiraReq('GET', '/rest/api/2/myself', basicAuth);
  if (res.status !== 200 || (!res.data?.name && !res.data?.emailAddress)) {
    throw new Error('Invalid Jira credentials. Please check your username and password.');
  }
  return basicAuth;
}

// ─── Xray DC folder tree helpers ─────────────────────────────────────────────

// Fetch the full folder tree from Xray DC
async function xrayFolderTree(projectKey, basicAuth) {
  const res = await jiraReq('GET', `/rest/raven/1.0/api/testrepository/${projectKey}/folders`, basicAuth);
  if (res.status !== 200) throw new Error(res.data?.message || 'Failed to load folder tree from Xray');
  return res.data;
}

// Recursively annotate each folder node with its full path string and return a flat map
function buildFolderPathMap(node, parentPath = '') {
  const map = {};
  if (!node) return map;
  const folders = node.folders || [];
  for (const f of folders) {
    const p = parentPath ? `${parentPath}/${f.name}` : `/${f.name}`;
    map[p] = f;
    Object.assign(map, buildFolderPathMap(f, p));
  }
  return map;
}

// Given a target path, return the Xray DC folder node (with .id)
function findFolderByPath(tree, targetPath) {
  if (!targetPath || targetPath === '/') return { id: -1, folders: tree.folders || [] };
  const map = buildFolderPathMap(tree);
  return map[targetPath] || null;
}

// Convert an Xray DC folder node into the shape the frontend expects
// (name, path, testsCount, folders[…])
function normalizeFolderNode(node, nodePath) {
  const sub = (node.folders || []).map(f => {
    const childPath = nodePath ? `${nodePath}/${f.name}` : `/${f.name}`;
    return normalizeFolderNode(f, childPath);
  });
  return {
    id:         node.id,
    name:       node.name,
    path:       nodePath,
    testsCount: node.testCount || 0,
    folders:    sub
  };
}

// ─── Router ──────────────────────────────────────────────────────────────────
async function router(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method   = req.method.toUpperCase();

  // ── Static files ──────────────────────────────────────────────────────────
  if (method === 'GET' && !pathname.startsWith('/api/')) {
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname === '/app' || pathname === '/app.html') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'app.html'));
    }
    if (pathname === '/analyzer' || pathname === '/analyzer.html') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'analyzer.html'));
    }
    const filePath = path.join(PUBLIC_DIR, pathname);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath)) {
      return serveStatic(res, filePath);
    }
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  // ── API routes ────────────────────────────────────────────────────────────

  // POST /api/auth/login
  if (method === 'POST' && pathname === '/api/auth/login') {
    const { username, password, projectKey } = await readBody(req);
    if (!username || !password || !projectKey) {
      return json(res, 400, { error: 'Username, Password and Project Key are required.' });
    }
    if (!JIRA_BASE_URL) {
      return json(res, 500, { error: 'Server is not configured: JIRA_BASE_URL environment variable is missing.' });
    }
    try {
      const basicAuth = await jiraAuth(username, password);
      const sid = createSession({
        basicAuth,
        projectKey: projectKey.toUpperCase().trim()
      });
      return json(res, 200, { success: true, projectKey: projectKey.toUpperCase().trim() }, {
        'Set-Cookie': `jtmf_sid=${sid}; HttpOnly; Path=/; Max-Age=28800`
      });
    } catch (err) {
      return json(res, 401, { error: err.message });
    }
  }

  // POST /api/auth/logout
  if (method === 'POST' && pathname === '/api/auth/logout') {
    deleteSession(req);
    return json(res, 200, { success: true }, {
      'Set-Cookie': 'jtmf_sid=; HttpOnly; Path=/; Max-Age=0'
    });
  }

  // GET /api/auth/status
  if (method === 'GET' && pathname === '/api/auth/status') {
    const sess = getSession(req);
    if (sess) return json(res, 200, { authenticated: true, projectKey: sess.projectKey });
    return json(res, 200, { authenticated: false });
  }

  // ── Auth-required routes ──────────────────────────────────────────────────
  const sess = getSession(req);
  if (!sess) return json(res, 401, { error: 'Session expired. Please log in again.' });

  const { basicAuth, projectKey } = sess;
  const query = parsed.query;

  // GET /api/folders?path=/...
  if (method === 'GET' && pathname === '/api/folders') {
    const folderPath = query.path || '/';
    try {
      const tree   = await xrayFolderTree(projectKey, basicAuth);
      const folderMap = buildFolderPathMap(tree);

      let node, nodePath;
      if (!folderPath || folderPath === '/') {
        // Return a virtual root containing top-level folders
        node     = { id: -1, name: '(root)', testCount: 0, folders: tree.folders || [] };
        nodePath = '';
      } else {
        node     = folderMap[folderPath];
        nodePath = folderPath;
      }

      if (!node) return json(res, 404, { error: `Folder not found: ${folderPath}` });
      return json(res, 200, { folder: normalizeFolderNode(node, nodePath) });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/folders/create  { path }
  if (method === 'POST' && pathname === '/api/folders/create') {
    const { path: folderPath } = await readBody(req);
    if (!folderPath) return json(res, 400, { error: 'path is required' });
    try {
      // Resolve parent folder ID
      const parts      = folderPath.replace(/^\//,'').split('/');
      const folderName = parts.pop();
      const parentPath = parts.length ? '/' + parts.join('/') : '';

      const tree      = await xrayFolderTree(projectKey, basicAuth);
      const folderMap = buildFolderPathMap(tree);
      const parentId  = parentPath ? (folderMap[parentPath]?.id ?? -1) : -1;

      const res2 = await jiraReq('POST',
        `/rest/raven/1.0/api/testrepository/${projectKey}/folders/${parentId}`,
        basicAuth,
        { name: folderName }
      );
      if (res2.status !== 200 && res2.status !== 201) {
        throw new Error(res2.data?.message || `Failed to create folder (${res2.status})`);
      }
      return json(res, 200, { folder: { name: folderName, path: folderPath } });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/folders/move  { sourcePath, destPath }
  if (method === 'POST' && pathname === '/api/folders/move') {
    const { sourcePath, destPath } = await readBody(req);
    if (!sourcePath || !destPath) return json(res, 400, { error: 'sourcePath and destPath are required' });
    try {
      const tree      = await xrayFolderTree(projectKey, basicAuth);
      const folderMap = buildFolderPathMap(tree);

      // Find source folder
      const srcNode = folderMap[sourcePath];
      if (!srcNode) return json(res, 404, { error: `Source folder not found: ${sourcePath}` });

      // Determine destination parent path and new folder name
      const destParts  = destPath.replace(/^\//, '').split('/');
      const newName    = destParts.pop();
      const destParent = destParts.length ? '/' + destParts.join('/') : '';
      
      // Resolve or create destination parent
      let destParentId = -1;
      if (destParent) {
        let parentNode = folderMap[destParent];
        if (!parentNode) {
          // Create parent folder recursively (best effort)
          const createRes = await jiraReq('POST',
            `/rest/raven/1.0/api/testrepository/${projectKey}/folders/-1`,
            basicAuth, { name: destParts[destParts.length - 1] }
          );
          if (createRes.status !== 200 && createRes.status !== 201) {
            throw new Error(`Could not create parent folder: ${destParent}`);
          }
          destParentId = createRes.data?.id ?? -1;
        } else {
          destParentId = parentNode.id;
        }
      }

      // Move = rename folder + set new parent via Xray DC API
      const moveRes = await jiraReq('PUT',
        `/rest/raven/1.0/api/testrepository/${projectKey}/folders/${srcNode.id}`,
        basicAuth,
        { name: newName, parentFolderId: destParentId }
      );
      if (moveRes.status !== 200 && moveRes.status !== 204) {
        throw new Error(moveRes.data?.message || `Folder move failed (${moveRes.status})`);
      }
      return json(res, 200, { moved: true, from: sourcePath, to: destPath });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/tests/suggest-labels  { tests, currentPath }
  if (method === 'POST' && pathname === '/api/tests/suggest-labels') {
    const { tests, currentPath } = await readBody(req);
    if (!tests || !Array.isArray(tests)) {
      return json(res, 400, { error: 'Tests array is required' });
    }

    try {
      // Very basic heuristics for capability suggestion
      // We look at the test summary and existing labels to guess a "capability"
      const results = tests.map(t => {
        const summary = (t.jira?.summary || '').toLowerCase();
        const existingLabels = t.jira?.labels || [];
        
        let suggestedCapability = null;
        
        // Example simple keyword matching capability suggestions
        if (summary.includes('login') || summary.includes('auth') || summary.includes('password')) {
          suggestedCapability = 'capability-auth';
        } else if (summary.includes('checkout') || summary.includes('payment') || summary.includes('cart')) {
          suggestedCapability = 'capability-checkout';
        } else if (summary.includes('search') || summary.includes('filter')) {
          suggestedCapability = 'capability-search';
        } else if (summary.includes('profile') || summary.includes('account')) {
          suggestedCapability = 'capability-account';
        } else if (summary.includes('api') || summary.includes('endpoint')) {
          suggestedCapability = 'capability-api';
        } else {
          // Fallback: Use folder name if we can't figure it out from summary
          const pathParts = (currentPath || '').split('/').filter(Boolean);
          if (pathParts.length > 0) {
            const lastFolder = pathParts[pathParts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '-');
            suggestedCapability = `capability-${lastFolder}`;
          } else {
             suggestedCapability = 'capability-general';
          }
        }

        // Suggest 'regression' or 'functional' label based on path if missing
        let missingTypeLabel = null;
        const lowerPath = (currentPath || '').toLowerCase();
        
        if (lowerPath.includes('regression') && !existingLabels.map(l => l.toLowerCase()).includes('regression')) {
          missingTypeLabel = 'regression';
        } else if (lowerPath.includes('functional') && !existingLabels.map(l => l.toLowerCase()).includes('functional') && !lowerPath.includes('regression')) {
           missingTypeLabel = 'functional';
        }

        const suggestedLabels = [suggestedCapability];
        if (missingTypeLabel) suggestedLabels.push(missingTypeLabel);

        return {
          issueId: t.issueId,
          suggestedLabels: suggestedLabels.filter(Boolean),
          currentLabels: existingLabels
        };
      });

      return json(res, 200, { results });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // GET /api/tests?folderPath=/...&limit=50&start=0
  if (method === 'GET' && pathname === '/api/tests') {
    const { folderPath, limit = '50', start = '0' } = query;
    if (!folderPath) return json(res, 400, { error: 'folderPath is required' });
    try {
      // 1. Get folder ID from tree
      const tree      = await xrayFolderTree(projectKey, basicAuth);
      const folderMap = buildFolderPathMap(tree);
      const folderId  = folderPath === '/' ? -1 : (folderMap[folderPath]?.id ?? null);
      
      if (folderId === null) {
         return json(res, 404, { error: `Folder not found: ${folderPath}` });
      }

      // 2. Fetch tests in folder from Xray DC (paginated)
      // Note: Xray DC pagination for tests uses "limit" and "page"
      const page = Math.floor(parseInt(start) / parseInt(limit)) + 1;
      const xrayRes = await jiraReq('GET', 
        `/rest/raven/1.0/api/testrepository/${projectKey}/folders/${folderId}/tests?limit=${limit}&page=${page}`, 
        basicAuth
      );
      if (xrayRes.status !== 200) throw new Error(xrayRes.data?.message || 'Failed to fetch tests from Xray folder');

      // The Xray API returns an array of tests. It might look like [{id: 123, key: "CALC-1"}, ...]
      // If it doesn't return total count metadata directly, we just return the array length for now
      const xrayTests = Array.isArray(xrayRes.data) ? xrayRes.data : (xrayRes.data.tests || []);
      const testKeys  = xrayTests.map(t => typeof t === 'string' ? t : t.key).filter(Boolean);

      if (testKeys.length === 0) {
        return json(res, 200, { total: 0, start: parseInt(start), limit: parseInt(limit), results: [] });
      }

      // 3. Fetch comprehensive issue details from Jira (summary, labels, status, etc)
      const jql = `key in (${testKeys.join(',')})`;
      const params = new URLSearchParams({
        jql,
        fields: 'summary,status,labels,priority,assignee,components,issuetype,created',
        maxResults: testKeys.length
      });
      const jiraRes = await jiraReq('GET', `/rest/api/2/search?${params}`, basicAuth);
      if (jiraRes.status !== 200) throw new Error(jiraRes.data?.errorMessages?.[0] || 'Jira bulk issue fetch failed');

      const issues = jiraRes.data.issues || [];
      const results = issues.map(issue => ({
        issueId: issue.key,
        jira: {
          summary:    issue.fields.summary,
          labels:     issue.fields.labels     || [],
          status:     issue.fields.status,
          priority:   issue.fields.priority,
          assignee:   issue.fields.assignee,
          components: issue.fields.components || [],
          created:    issue.fields.created
        }
      }));

      // Sort results to match original Xray order
      results.sort((a, b) => testKeys.indexOf(a.issueId) - testKeys.indexOf(b.issueId));

      return json(res, 200, {
        total:   xrayTests.length, // approximation without full pagination metadata
        start:   parseInt(start),
        limit:   parseInt(limit),
        results
      });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/tests/move  { testIssueIds, targetPath }
  if (method === 'POST' && pathname === '/api/tests/move') {
    const { testIssueIds, targetPath } = await readBody(req);
    if (!testIssueIds?.length || !targetPath) {
      return json(res, 400, { error: 'testIssueIds and targetPath are required.' });
    }
    try {
      // Resolve (or create) the target folder
      const tree      = await xrayFolderTree(projectKey, basicAuth);
      const folderMap = buildFolderPathMap(tree);
      let   targetId  = folderMap[targetPath]?.id;

      // Auto-create the folder if it doesn't exist
      if (!targetId) {
        const parts      = targetPath.replace(/^\//,'').split('/');
        const folderName = parts.pop();
        const parentPath = parts.length ? '/' + parts.join('/') : '';
        const parentId   = parentPath ? (folderMap[parentPath]?.id ?? -1) : -1;
        const createRes  = await jiraReq('POST',
          `/rest/raven/1.0/api/testrepository/${projectKey}/folders/${parentId}`,
          basicAuth, { name: folderName }
        );
        targetId = createRes.data?.id || createRes.data?.folder?.id;
        if (!targetId) throw new Error(`Could not create or find folder: ${targetPath}`);
      }

      // Move tests into the resolved folder
      const moveRes = await jiraReq('PUT',
        `/rest/raven/1.0/api/testrepository/${projectKey}/folders/${targetId}/tests`,
        basicAuth,
        { add: testIssueIds, remove: [] }
      );
      if (moveRes.status !== 200 && moveRes.status !== 204) {
        throw new Error(moveRes.data?.message || `Move failed (status ${moveRes.status})`);
      }
      return json(res, 200, { success: true, movedCount: testIssueIds.length, targetPath });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/tests/labels  { testIssueIds, labels, action }
  if (method === 'POST' && pathname === '/api/tests/labels') {
    const { testIssueIds, labels, action = 'add' } = await readBody(req);
    if (!testIssueIds?.length || !labels?.length) {
      return json(res, 400, { error: 'testIssueIds and labels are required.' });
    }
    const results = [];
    for (const issueId of testIssueIds) {
      try {
        const getRes = await jiraReq('GET', `/rest/api/2/issue/${issueId}?fields=labels`, basicAuth);
        const current = getRes.data?.fields?.labels || [];
        let next;
        if (action === 'add')         next = [...new Set([...current, ...labels])];
        else if (action === 'remove') next = current.filter(l => !labels.includes(l));
        else                          next = labels;
        await jiraReq('PUT', `/rest/api/2/issue/${issueId}`, basicAuth, { fields: { labels: next } });
        results.push({ issueId, success: true });
      } catch (e) {
        results.push({ issueId, success: false, error: e.message });
      }
    }
    return json(res, 200, { results });
  }

  return json(res, 404, { error: 'Not found' });
}

// ─── Start server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    await router(req, res);
  } catch (err) {
    console.error('Unhandled error:', err);
    json(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║      JTMF Manager  —  Running         ║
  ║   http://localhost:${PORT}               ║
  ╚═══════════════════════════════════════╝
  `);
});

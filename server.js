/**
 * JTMF Manager — Node.js server (zero external dependencies)
 * Uses only built-in: http, https, fs, path, url, crypto
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const XRAY_BASE  = 'xray.cloud.getxray.app';

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

// ─── HTTPS request helper (replaces axios) ──────────────────────────────────
function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
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

async function xrayAuth(clientId, clientSecret) {
  const body = JSON.stringify({ client_id: clientId, client_secret: clientSecret });
  const res = await httpsRequest({
    hostname: XRAY_BASE,
    path: '/api/v2/authenticate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (res.status !== 200) throw new Error(res.data?.error || res.data || 'Auth failed');
  // Response is a quoted JWT string
  return typeof res.data === 'string' ? res.data.replace(/^"|"$/g, '') : res.data;
}

async function xrayGql(token, query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  const res = await httpsRequest({
    hostname: XRAY_BASE,
    path: '/api/v2/graphql',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  if (res.status === 401) throw new Error('Xray token expired. Please log in again.');
  if (res.data?.errors?.length) throw new Error(res.data.errors[0].message);
  if (!res.data?.data) throw new Error('Empty response from Xray GraphQL');
  return res.data.data;
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
    const filePath = path.join(PUBLIC_DIR, pathname);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath)) {
      return serveStatic(res, filePath);
    }
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  // ── API routes ────────────────────────────────────────────────────────────

  // POST /api/auth/login
  if (method === 'POST' && pathname === '/api/auth/login') {
    const { username, password, projectKey, jiraUrl } = await readBody(req);
    if (!username || !password || !projectKey) {
      return json(res, 400, { error: 'Username, Password and Project Key are required.' });
    }
    try {
      const token = await xrayAuth(username, password);
      const sid   = createSession({
        xrayToken:  token,
        projectKey: projectKey.toUpperCase().trim(),
        jiraUrl:    (jiraUrl || '').replace(/\/$/, '')
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

  const { xrayToken, projectKey, jiraUrl } = sess;
  const query = parsed.query;

  // GET /api/folders?path=/...
  if (method === 'GET' && pathname === '/api/folders') {
    const folderPath = query.path || '/';
    try {
      const data = await xrayGql(xrayToken, `
        query GetFolder($projectId: String!, $path: String!) {
          getFolder(projectId: $projectId, path: $path) {
            name path testsCount
            folders {
              name path testsCount
              folders {
                name path testsCount
                folders {
                  name path testsCount
                  folders {
                    name path testsCount
                    folders { name path testsCount }
                  }
                }
              }
            }
          }
        }
      `, { projectId: projectKey, path: folderPath });
      return json(res, 200, { folder: data.getFolder });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /api/folders/create  { path }
  if (method === 'POST' && pathname === '/api/folders/create') {
    const { path: folderPath } = await readBody(req);
    try {
      const data = await xrayGql(xrayToken, `
        mutation CreateFolder($projectId: String!, $path: String!) {
          createFolder(projectId: $projectId, path: $path) {
            folder { name path testsCount }
            warnings
          }
        }
      `, { projectId: projectKey, path: folderPath });
      return json(res, 200, data.createFolder);
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
      const jql = `project = "${projectKey}" AND folder = "${folderPath}"`;
      const data = await xrayGql(xrayToken, `
        query GetTests($jql: String!, $limit: Int!, $start: Int!) {
          getTests(jql: $jql, limit: $limit, start: $start) {
            total start limit
            results {
              issueId
              jira(fields: ["summary", "status", "labels", "priority", "assignee", "components"])
            }
          }
        }
      `, { jql, limit: parseInt(limit), start: parseInt(start) });
      return json(res, 200, data.getTests);
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
      // Ensure destination folder exists
      await xrayGql(xrayToken, `
        mutation CreateFolder($projectId: String!, $path: String!) {
          createFolder(projectId: $projectId, path: $path) { folder { path } warnings }
        }
      `, { projectId: projectKey, path: targetPath }).catch(() => {});

      // Move tests
      const data = await xrayGql(xrayToken, `
        mutation AddTests($projectId: String!, $path: String!, $testIssueIds: [String]!) {
          addTestsToFolder(projectId: $projectId, path: $path, testIssueIds: $testIssueIds) {
            folder { name path testsCount }
            warnings
          }
        }
      `, { projectId: projectKey, path: targetPath, testIssueIds });
      return json(res, 200, data.addTestsToFolder);
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
    if (!jiraUrl) {
      return json(res, 400, { error: 'Jira URL not set. Please log out and log in with the Jira URL.' });
    }
    const jiraHost = jiraUrl.replace('https://', '').replace('http://', '');
    const results  = [];

    for (const issueId of testIssueIds) {
      try {
        const getRes = await httpsRequest({
          hostname: jiraHost,
          path: `/rest/api/3/issue/${issueId}?fields=labels`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${xrayToken}`, 'Content-Type': 'application/json' }
        });
        const current = (getRes.data?.fields?.labels || []);
        let next;
        if (action === 'add')    next = [...new Set([...current, ...labels])];
        else if (action === 'remove') next = current.filter(l => !labels.includes(l));
        else                     next = labels;

        const putBody = JSON.stringify({ fields: { labels: next } });
        await httpsRequest({
          hostname: jiraHost,
          path: `/rest/api/3/issue/${issueId}`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${xrayToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(putBody)
          }
        }, putBody);
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

// pos-web/server.js
// Lightweight Node.js server for The Crown & Copper Web POS
// Bridges browser interactions to Floreant POS local API (http://127.0.0.1:8787/v1)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { registerVoiceRoutes } = require('./voice-bridge');

const PORT = parseInt(process.env.PORT || process.env.POS_WEB_PORT || '3000', 10);
const POS_API_BASE = process.env.POS_API_URL || 'http://127.0.0.1:8787/v1';
const POS_API_TOKEN = process.env.POS_API_TOKEN;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Agora's tool timeout is 15s; two POS attempts (retry with the same idempotency key) must fit inside it.
const POS_TIMEOUT_MS = parseInt(process.env.POS_TIMEOUT_MS || '6000', 10);
// Optional shared secret Agora sends as x-voice-token (see agora-agent.js).
const VOICE_TOOL_TOKEN = process.env.VOICE_TOOL_TOKEN || '';
// Requests arriving through a tunnel (ngrok sets X-Forwarded-For) may only reach the voice tools,
// otherwise the whole POS proxy is public. Set ALLOW_PUBLIC_UI=1 to open the web UI through the tunnel.
const ALLOW_PUBLIC_UI = process.env.ALLOW_PUBLIC_UI === '1';
const VOICE_TOOL_PATHS = new Set([
  '/api/voice/tables',
  '/api/voice/menu',
  '/api/voice/open-tab',
  '/api/voice/get-ticket',
  '/api/voice/ticket',
  '/api/voice/add-items',
  '/api/voice/send-kitchen'
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

async function forwardToPos(method, posPath, body = null, { idempotencyKey, timeoutMs = POS_TIMEOUT_MS } = {}) {
  const url = `${POS_API_BASE}${posPath}`;
  const headers = {
    'Authorization': `Bearer ${POS_API_TOKEN}`,
    'Accept': 'application/json'
  };

  const options = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  };

  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    // Reusing a key lets the POS deduplicate a retried request instead of applying it twice.
    headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
    options.body = typeof body === 'string' ? body : JSON.stringify(body || {});
  }

  try {
    const res = await fetch(url, options);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, data: json };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    return {
      status: timedOut ? 504 : 503,
      data: {
        error: {
          code: timedOut ? 'pos_timeout' : 'pos_unreachable',
          message: timedOut
            ? `POS API at ${POS_API_BASE} did not respond within ${timeoutMs}ms.`
            : `Could not connect to POS API at ${POS_API_BASE}. Ensure Floreant POS is running with the API bridge.`,
          details: err.message
        }
      }
    };
  }
}

function isTunnelRequest(req) {
  return Boolean(req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']);
}

function hasVoiceToolToken(req) {
  const given = Buffer.from(String(req.headers['x-voice-token'] || ''));
  const expected = Buffer.from(VOICE_TOOL_TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON payload: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function serveStatic(req, res, pathname) {
  let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const handleVoice = registerVoiceRoutes(null, forwardToPos);

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Enable basic CORS for local testing if accessed from another local port
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (isTunnelRequest(req)) {
    if (!VOICE_TOOL_PATHS.has(pathname) && !ALLOW_PUBLIC_UI) {
      return sendJson(res, 403, { error: { code: 'tunnel_forbidden', message: 'Only voice tool endpoints are available through the public tunnel.' } });
    }
    if (VOICE_TOOL_PATHS.has(pathname) && VOICE_TOOL_TOKEN && !hasVoiceToolToken(req)) {
      return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Missing or invalid x-voice-token.' } });
    }
  }

  // --- API Routes ---
  if (pathname.startsWith('/api/')) {
    try {
      // Voice Assistant API (Agora Sora Tools)
      if (pathname.startsWith('/api/voice/')) {
        const handled = await handleVoice(req, res, pathname, method);
        if (handled) return;
      }

      // 1. Health check
      if (pathname === '/api/health' && method === 'GET') {
        const result = await forwardToPos('GET', '/health');
        return sendJson(res, result.status, result.data);
      }

      // 2. Capabilities
      if (pathname === '/api/capabilities' && method === 'GET') {
        const result = await forwardToPos('GET', '/capabilities');
        return sendJson(res, result.status, result.data);
      }

      // 3. Order Types
      if (pathname === '/api/order-types' && method === 'GET') {
        const result = await forwardToPos('GET', '/order-types');
        return sendJson(res, result.status, result.data);
      }

      // 4. Tables
      if (pathname === '/api/tables' && method === 'GET') {
        const result = await forwardToPos('GET', '/tables');
        return sendJson(res, result.status, result.data);
      }

      // 5. Open / Reuse Table Tab: POST /api/tables/:number/tab
      const tableTabMatch = pathname.match(/^\/api\/tables\/(\d+)\/tab$/);
      if (tableTabMatch && method === 'POST') {
        const tableNumber = tableTabMatch[1];
        const body = await parseJsonBody(req);
        const result = await forwardToPos('POST', `/tables/${tableNumber}/tab`, body);
        return sendJson(res, result.status, result.data);
      }

      // 6. Menu List: GET /api/menu
      if (pathname === '/api/menu' && method === 'GET') {
        const result = await forwardToPos('GET', '/menu');
        return sendJson(res, result.status, result.data);
      }

      // 7. Menu Item Details & Modifiers: GET /api/menu/:id
      const menuItemMatch = pathname.match(/^\/api\/menu\/(\d+)$/);
      if (menuItemMatch && method === 'GET') {
        const itemId = menuItemMatch[1];
        const result = await forwardToPos('GET', `/menu/${itemId}`);
        return sendJson(res, result.status, result.data);
      }

      // 8. Ticket Details: GET /api/tickets/:id
      const ticketMatch = pathname.match(/^\/api\/tickets\/(\d+)$/);
      if (ticketMatch && method === 'GET') {
        const ticketId = ticketMatch[1];
        const result = await forwardToPos('GET', `/tickets/${ticketId}`);
        return sendJson(res, result.status, result.data);
      }

      // 9. Append items to Ticket: POST /api/tickets/:id/items
      const ticketItemsMatch = pathname.match(/^\/api\/tickets\/(\d+)\/items$/);
      if (ticketItemsMatch && method === 'POST') {
        const ticketId = ticketItemsMatch[1];
        const body = await parseJsonBody(req);
        const result = await forwardToPos('POST', `/tickets/${ticketId}/items`, body);
        return sendJson(res, result.status, result.data);
      }

      // 10. Send ticket to kitchen: POST /api/tickets/:id/send
      const ticketSendMatch = pathname.match(/^\/api\/tickets\/(\d+)\/send$/);
      if (ticketSendMatch && method === 'POST') {
        const ticketId = ticketSendMatch[1];
        const body = await parseJsonBody(req);
        // Default to kitchen_display mode if not specified, since user requested no physical printer requirement!
        if (!body.deliveryMode) {
          body.deliveryMode = 'kitchen_display';
        }
        if (body.confirmed === undefined) {
          body.confirmed = true;
        }
        const result = await forwardToPos('POST', `/tickets/${ticketId}/send`, body);
        return sendJson(res, result.status, result.data);
      }

      // 11. Kitchen tickets for ticket: GET /api/tickets/:id/kitchen
      const ticketKitchenMatch = pathname.match(/^\/api\/tickets\/(\d+)\/kitchen$/);
      if (ticketKitchenMatch && method === 'GET') {
        const ticketId = ticketKitchenMatch[1];
        const result = await forwardToPos('GET', `/tickets/${ticketId}/kitchen`);
        return sendJson(res, result.status, result.data);
      }

      // 12. Kitchen reconciliation: POST /api/tickets/:id/kitchen/reconcile
      const reconcileMatch = pathname.match(/^\/api\/tickets\/(\d+)\/kitchen\/reconcile$/);
      if (reconcileMatch && method === 'POST') {
        const ticketId = reconcileMatch[1];
        const body = await parseJsonBody(req);
        const result = await forwardToPos('POST', `/tickets/${ticketId}/kitchen/reconcile`, body);
        return sendJson(res, result.status, result.data);
      }

      // 13. KDS Aggregated Feed: GET /api/kds
      // Gathers all open tables, fetches tickets and kitchen tickets to give a live Kitchen Display view
      if (pathname === '/api/kds' && method === 'GET') {
        const tablesRes = await forwardToPos('GET', '/tables');
        if (tablesRes.status !== 200) {
          return sendJson(res, tablesRes.status, tablesRes.data);
        }

        const tables = tablesRes.data.tables || [];
        const ticketIds = new Set();
        tables.forEach(t => {
          if (Array.isArray(t.openTicketIds)) {
            t.openTicketIds.forEach(id => ticketIds.add(id));
          }
        });

        // Fetch all open tickets in parallel; this feed is polled every 5s.
        const results = await Promise.all([...ticketIds].map(async tid => {
          const [ticketRes, kitchenRes] = await Promise.all([
            forwardToPos('GET', `/tickets/${tid}`),
            forwardToPos('GET', `/tickets/${tid}/kitchen`)
          ]);
          if (ticketRes.status !== 200) return null; // Ignore individual fetch failure
          return {
            ticketId: tid,
            ticket: ticketRes.data.ticket || {},
            kitchenTickets: kitchenRes.status === 200 ? kitchenRes.data.kitchenTickets || [] : []
          };
        }));
        return sendJson(res, 200, { tickets: results.filter(Boolean) });
      }

      return sendJson(res, 404, { error: 'Unknown API endpoint' });
    } catch (err) {
      console.error('API proxy error:', err);
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Otherwise serve static files
  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` The Crown & Copper - POS Web Interface`);
  console.log(` Web App:     http://localhost:${PORT}`);
  console.log(` POS API:     ${POS_API_BASE}`);
  console.log(`====================================================`);
});

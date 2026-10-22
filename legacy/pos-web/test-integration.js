// pos-web/test-integration.js
// Verification suite for the Web POS backend and bridge proxy logic

const http = require('node:http');

const MOCK_POS_PORT = 9898;
const WEB_PORT = 3001;

// 1. Start a mock POS API Server simulating Floreant POS Java API (ApiServer)
const mockPosServer = http.createServer((req, res) => {
  const auth = req.headers['authorization'];
  const idempotency = req.headers['idempotency-key'];
  const origin = req.headers['origin'];

  // Enforce Floreant POS ApiServer security rules
  if (!auth || !auth.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Bearer token required' } }));
  }

  if (origin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'browser_access_denied', message: 'Browser access denied' } }));
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsedBody = {};
    if (body) {
      try { parsedBody = JSON.parse(body); } catch {}
    }

    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ready', loggedIn: true }));
    }

    if (req.url === '/v1/tables') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        tables: [
          { number: 1, disabled: false, free: true, booked: false, dirty: false, openTicketIds: [] },
          { number: 2, disabled: false, free: false, booked: false, dirty: false, openTicketIds: [101] }
        ]
      }));
    }

    if (req.url === '/v1/menu') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        items: [
          { id: 10, name: 'Fish & Chips', price: 14.95, groupName: 'PUB CLASSICS', categoryName: 'Food', supported: true, hasModifiers: true },
          { id: 20, name: 'Timothy Taylor Landlord', price: 5.40, groupName: 'CASK & CIDER', categoryName: 'Drinks', supported: true, hasModifiers: false }
        ]
      }));
    }

    if (req.url === '/v1/tables/1/tab' && req.method === 'POST') {
      if (!idempotency) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'missing_idempotency', message: 'Key required' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        created: true,
        replayed: false,
        ticket: {
          id: 201,
          orderTypeId: parsedBody.orderTypeId || 1,
          guestCount: parsedBody.guestCount || 2,
          total: 0.00,
          revision: 'rev_initial_201',
          tableNumbers: [1],
          items: []
        }
      }));
    }

    if (req.url === '/v1/tickets/201/items' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        replayed: false,
        ticket: {
          id: 201,
          orderTypeId: 1,
          guestCount: 2,
          total: 14.95,
          revision: 'rev_items_added_201',
          tableNumbers: [1],
          items: [
            {
              id: 501,
              menuItemId: 10,
              name: 'Fish & Chips',
              quantity: 1,
              seatNumber: 1,
              unitPrice: 14.95,
              total: 14.95,
              kitchenEligible: true,
              sentToKitchen: false,
              instructions: ['No salt']
            }
          ]
        }
      }));
    }

    if (req.url === '/v1/tickets/201/send' && req.method === 'POST') {
      if (parsedBody.deliveryMode !== 'kitchen_display') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Must use kitchen_display' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        delivery: 'persisted_to_kitchen_display',
        kitchenTicketIds: [8801],
        ticket: {
          id: 201,
          total: 14.95,
          revision: 'rev_sent_201',
          items: [
            {
              id: 501,
              name: 'Fish & Chips',
              quantity: 1,
              kitchenEligible: true,
              sentToKitchen: true
            }
          ]
        }
      }));
    }

    if (req.url === '/v1/tickets/101') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ticket: { id: 101, tableNumbers: [2], total: 24.50, items: [] }
      }));
    }

    if (req.url === '/v1/tickets/101/kitchen') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ticketId: 101,
        kitchenTickets: [
          { id: 701, status: 'WAITING', tableNumbers: [2], sequenceNumber: 1, items: [{ name: 'Yorkshire Pudding', quantity: 2, cookable: true }] }
        ]
      }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
});

async function runTests() {
  await new Promise(r => mockPosServer.listen(MOCK_POS_PORT, '127.0.0.1', r));
  console.log('✓ Mock POS API running on port', MOCK_POS_PORT);

  // Set environment for Web POS server
  process.env.PORT = String(WEB_PORT);
  process.env.POS_API_URL = `http://127.0.0.1:${MOCK_POS_PORT}/v1`;
  process.env.POS_API_TOKEN = 'mock-pos-token-for-testing-1234567890';

  require('./server.js');
  await new Promise(r => setTimeout(r, 400));
  console.log('✓ POS Web Server running on port', WEB_PORT);

  const base = `http://localhost:${WEB_PORT}`;

  // Test 1: Health check through proxy
  const healthRes = await fetch(`${base}/api/health`);
  const healthJson = await healthRes.json();
  if (healthRes.status !== 200 || healthJson.status !== 'ready') {
    throw new Error('Health check failed: ' + JSON.stringify(healthJson));
  }
  console.log('✓ Health check passed (proxied successfully without Origin header)');

  // Test 2: Tables list
  const tablesRes = await fetch(`${base}/api/tables`);
  const tablesJson = await tablesRes.json();
  if (tablesRes.status !== 200 || tablesJson.tables.length !== 2) {
    throw new Error('Tables failed');
  }
  console.log('✓ Tables list fetched successfully');

  // Test 3: Menu list
  const menuRes = await fetch(`${base}/api/menu`);
  const menuJson = await menuRes.json();
  if (menuRes.status !== 200 || menuJson.items.length !== 2) {
    throw new Error('Menu failed');
  }
  console.log('✓ Menu items list fetched successfully');

  // Test 4: Open Table Tab (POST with auto Idempotency-Key)
  const tabRes = await fetch(`${base}/api/tables/1/tab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderTypeId: 1, guestCount: 4 })
  });
  const tabJson = await tabRes.json();
  if (tabRes.status !== 200 || !tabJson.created || tabJson.ticket.id !== 201) {
    throw new Error('Open tab failed: ' + JSON.stringify(tabJson));
  }
  console.log('✓ Open tab succeeded (auto UUID Idempotency-Key attached)');

  // Test 5: Add items to Ticket
  const itemsRes = await fetch(`${base}/api/tickets/201/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: 'rev_initial_201',
      items: [{ menuItemId: 10, quantity: 1, seatNumber: 1, instructions: ['No salt'] }]
    })
  });
  const itemsJson = await itemsRes.json();
  if (itemsRes.status !== 200 || itemsJson.ticket.items.length !== 1) {
    throw new Error('Add items failed: ' + JSON.stringify(itemsJson));
  }
  console.log('✓ Added order lines to ticket');

  // Test 6: Send to kitchen with kitchen_display deliveryMode
  const sendRes = await fetch(`${base}/api/tickets/201/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: 'rev_items_added_201',
      confirmed: true
    })
  });
  const sendJson = await sendRes.json();
  if (sendRes.status !== 200 || sendJson.delivery !== 'persisted_to_kitchen_display') {
    throw new Error('Send to kitchen failed: ' + JSON.stringify(sendJson));
  }
  console.log('✓ Send to kitchen succeeded with virtual KDS delivery');

  // Test 7: KDS Feed Aggregator
  const kdsRes = await fetch(`${base}/api/kds`);
  const kdsJson = await kdsRes.json();
  if (kdsRes.status !== 200 || kdsJson.tickets.length === 0) {
    throw new Error('KDS aggregator failed: ' + JSON.stringify(kdsJson));
  }
  console.log('✓ KDS live feed aggregated successfully');

  console.log('\n====================================================');
  console.log(' ALL INTEGRATION TESTS PASSED!');
  console.log('====================================================');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Integration test failure:', err);
  process.exit(1);
});

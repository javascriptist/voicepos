// pos-web/test-voice.js
// Automated verification for Sora voice assistant bridge
const assert = require('node:assert');
const http = require('node:http');
const { matchMenuItem, findMenuMatches, formatGbp, splitOrderSegments, parseOrderLine, registerVoiceRoutes } = require('./voice-bridge');

const sampleMenu = [
  { id: 1, name: 'Full English Breakfast', price: 11.95, categoryName: 'BRUNCH' },
  { id: 32, name: 'Cola', price: 3.25, categoryName: 'DRINKS' },
  { id: 53, name: 'Fish & Chips', price: 15.95, categoryName: 'PUB CLASSICS' },
  { id: 67, name: 'Beef Burger', price: 14.95, categoryName: 'PUB CLASSICS' },
  { id: 68, name: 'Veggie Burger', price: 13.95, categoryName: 'PUB CLASSICS' },
  { id: 70, name: 'Chocolate Brownie', price: 6.5, categoryName: 'PUDDINGS' },
  { id: 71, name: "Shepherd's Pie", price: 14.5, categoryName: 'PUB CLASSICS' },
  { id: 72, name: 'Steak & Ale Pie', price: 15.5, categoryName: 'PUB CLASSICS' },
  { id: 80, name: 'Sirloin Steak', price: 24.0, categoryName: 'PUB CLASSICS', hasModifiers: true },
  { id: 90, name: 'Mojito', price: 9.5, categoryName: 'COCKTAILS', beverage: true, description: 'White rum, fresh mint, lime, sugar and soda.' }
];

// Test formatting
assert.strictEqual(formatGbp(15.95), '£15.95');
assert.strictEqual(formatGbp(0), '£0.00');

// Test matching by exact name
assert.strictEqual(matchMenuItem('Fish & Chips', sampleMenu).id, 53);

// Test matching by spoken synonyms
assert.strictEqual(matchMenuItem('coke', sampleMenu).id, 32);
assert.strictEqual(matchMenuItem('cheeseburger', sampleMenu).id, 67);
assert.strictEqual(matchMenuItem('fish and chips', sampleMenu).id, 53);
assert.strictEqual(matchMenuItem('shepherds pie', sampleMenu).id, 71);
assert.strictEqual(matchMenuItem('veggie burger', sampleMenu).id, 68);
assert.strictEqual(matchMenuItem('brownies', sampleMenu).id, 70);

// Test matching by ID
assert.strictEqual(matchMenuItem('53', sampleMenu).id, 53);
assert.strictEqual(matchMenuItem(67, sampleMenu).id, 67);

// Regressions: substring matching used to map "chocolate brownie" -> Cola, and ties were guessed
assert.strictEqual(matchMenuItem('chocolate brownie', [sampleMenu[1], sampleMenu[5]]).id, 70);
assert.strictEqual(matchMenuItem('lasagne', sampleMenu), null);
const pie = findMenuMatches('pie', sampleMenu);
assert.strictEqual(pie.match, null);
assert.deepStrictEqual(pie.candidates.map(c => c.id).sort(), [71, 72]);

// Playground parsing keeps "fish and chips" whole and does not take the table number as quantity
assert.deepStrictEqual(splitOrderSegments('two fish and chips and a coke', sampleMenu), ['two fish and chips', 'a coke']);
assert.deepStrictEqual(parseOrderLine('2 sirloin steaks medium rare no onions'), {
  name: 'sirloin steaks', quantity: 2, instructions: ['medium rare', 'no onions'], modifiers: []
});

console.log('✓ All Voice Bridge unit tests passed!');

// --- End-to-end tool tests against a stateful mock POS -----------------------------------------

function createMockPos() {
  const state = {
    tickets: {
      101: { id: 101, tableNumbers: [2], guestCount: 4, items: [], closed: false, paid: false, voided: false, rev: 1 }
    },
    seenKeys: new Map(),
    calls: [],
    failNextAppendStale: false,
    timeoutNextSend: false
  };
  const menuDetail = {
    80: {
      id: 80,
      modifierGroups: [{
        id: 5, name: 'Cooking', minQuantity: 1, maxQuantity: 1,
        modifiers: [{ id: 1, name: 'Rare' }, { id: 2, name: 'Medium Rare' }, { id: 3, name: 'Well Done' }]
      }]
    }
  };
  const snapshot = t => {
    const total = t.items.reduce((s, i) => s + i.total, 0);
    return { ...t, total, subtotal: total, tax: 0, revision: `r${t.rev}` };
  };
  const tables = () => [1, 2, 3, 4].map(n => {
    const open = Object.values(state.tickets).filter(t => t.tableNumbers.includes(n) && !t.closed).map(t => t.id);
    return { number: n, disabled: false, free: open.length === 0 && n !== 4, booked: false, dirty: n === 4, openTicketIds: open };
  });

  async function forwardToPos(method, posPath, body, { idempotencyKey } = {}) {
    state.calls.push(`${method} ${posPath}`);
    const ok = data => ({ status: 200, data });
    const err = (status, code, message) => ({ status, data: { error: { code, message } } });

    if (method === 'POST' && idempotencyKey && state.seenKeys.has(idempotencyKey)) {
      return state.seenKeys.get(idempotencyKey);
    }
    const remember = result => {
      if (idempotencyKey) state.seenKeys.set(idempotencyKey, result);
      return result;
    };

    if (posPath === '/tables') return ok({ tables: tables() });
    if (posPath === '/menu') return ok({ items: sampleMenu });
    if (posPath === '/order-types') return ok({ orderTypes: [{ id: 3, name: 'BAR TAB', tableOrderingSupported: false }, { id: 7, name: 'DINE IN', tableOrderingSupported: true }] });
    let m = posPath.match(/^\/menu\/(\d+)$/);
    if (m) return menuDetail[m[1]] ? ok(menuDetail[m[1]]) : ok({ id: +m[1], modifierGroups: [] });

    m = posPath.match(/^\/tables\/(\d+)\/tab$/);
    if (m) {
      const n = +m[1];
      assert.strictEqual(body.orderTypeId, 7, 'dine-in order type should be discovered');
      const table = tables().find(t => t.number === n);
      if (!table) return err(404, 'table_not_found', 'Table number not found.');
      const existing = Object.values(state.tickets).find(t => t.tableNumbers.includes(n));
      if (existing) {
        if (existing.guestCount !== body.guestCount) return err(409, 'tab_details_mismatch', 'mismatch');
        return remember(ok({ ticket: snapshot(existing), created: false }));
      }
      if (!table.free) return err(409, 'table_unavailable', 'Table is occupied, disabled, booked or dirty.');
      const id = 200 + n;
      state.tickets[id] = { id, tableNumbers: [n], guestCount: body.guestCount, items: [], closed: false, paid: false, voided: false, rev: 1 };
      return remember(ok({ ticket: snapshot(state.tickets[id]), created: true }));
    }

    m = posPath.match(/^\/tickets\/(\d+)(\/items|\/send)?$/);
    if (m) {
      const t = state.tickets[m[1]];
      if (!t) return err(404, 'ticket_not_found', 'Ticket not found.');
      if (method === 'GET') return ok({ ticket: snapshot(t) });
      if (state.failNextAppendStale && m[2] === '/items') {
        state.failNextAppendStale = false;
        t.rev++; // someone edited on the till
      }
      if (body.expectedRevision !== `r${t.rev}`) return err(409, 'stale_ticket', 'The tab changed.');
      if (m[2] === '/items') {
        for (const line of body.items) {
          assert.ok(!JSON.stringify(line).includes('{{'), 'template placeholders must not reach the POS');
          const item = sampleMenu.find(i => i.id === line.menuItemId);
          const required = (menuDetail[item.id] || { modifierGroups: [] }).modifierGroups.filter(g => g.minQuantity > 0);
          for (const g of required) {
            if (!line.modifiers.some(x => x.groupId === g.id)) return err(400, 'invalid_request', `Modifier group ${g.id} requires 1`);
          }
          t.items.push({ name: item.name, menuItemId: item.id, quantity: line.quantity, total: item.price * line.quantity,
            kitchenEligible: item.categoryName !== 'DRINKS', sentToKitchen: false, instructions: line.instructions,
            modifiers: line.modifiers.map(x => ({ name: menuDetail[item.id].modifierGroups[0].modifiers.find(o => o.id === x.modifierId).name })) });
        }
        t.rev++;
        return remember(ok({ ticket: snapshot(t) }));
      }
      const pending = t.items.filter(i => i.kitchenEligible && !i.sentToKitchen);
      if (!pending.length) return err(409, 'nothing_to_send', 'There are no new kitchen-eligible items to send.');
      pending.forEach(i => { i.sentToKitchen = true; });
      t.rev++;
      const result = remember(ok({ ticket: snapshot(t), kitchenTicketIds: [900 + t.id], delivery: 'persisted_to_kitchen_display' }));
      if (state.timeoutNextSend) {
        state.timeoutNextSend = false;
        return { status: 504, data: { error: { code: 'pos_timeout', message: 'timeout' } } }; // applied, but response lost
      }
      return result;
    }
    return err(404, 'not_found', 'Unknown API endpoint.');
  }

  return { state, forwardToPos };
}

async function runEndToEnd() {
  const mock = createMockPos();
  const handleVoice = registerVoiceRoutes(null, mock.forwardToPos);
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!(await handleVoice(req, res, pathname, req.method))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, ...(await res.json()) };
  };

  // Tables: dirty table 4 must not be reported as available
  let r = await call('GET', '/api/voice/tables');
  assert.deepStrictEqual(r.availableTables, [1, 3]);
  assert.deepStrictEqual(r.unavailableTables, [{ table: 4, status: 'dirty' }]);

  // Open tab with an un-substituted guestCount template, then re-open the existing tab with a different guest count
  r = await call('POST', '/api/voice/open-tab', { tableNumber: '1', guestCount: '{{args.guestCount}}' });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.errorCode, 'missing_guest_count');
  assert.strictEqual(r.say, 'How many guests?');
  r = await call('POST', '/api/voice/open-tab', { tableNumber: '1', guestCount: '2' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.action, 'created_new_tab');
  r = await call('POST', '/api/voice/open-tab', { tableNumber: 2, guestCount: 2 });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.action, 'reused_existing_tab');
  assert.match(r.note, /4 guests/);

  // Unavailable table -> readable failure with HTTP 200
  r = await call('POST', '/api/voice/open-tab', { tableNumber: 4 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /Table 4 is dirty and can't be opened/);

  // Add item with placeholder instructions/modifiers and a stale ticket ID from another table
  r = await call('POST', '/api/voice/add-items', {
    tableNumber: 1, ticketId: 101, itemName: 'fish and chips', quantity: '2',
    instructions: '{{args.instructions}}', modifiers: '{{args.modifiers}}'
  });
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(r.total, '£31.90');
  assert.strictEqual(r.say, 'Added 2 Fish & Chips. £31.90.');

  // Required modifier: asked for, nothing added; then satisfied from the instruction "medium rare"
  r = await call('POST', '/api/voice/add-items', { tableNumber: 1, itemName: 'sirloin steak', quantity: 1 });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.errorCode, 'needs_choice');
  assert.deepStrictEqual(r.needsChoice[0].options, ['Rare', 'Medium Rare', 'Well Done']);
  r = await call('POST', '/api/voice/add-items', { tableNumber: 1, itemName: 'sirloin steak', quantity: 1, instructions: 'medium rare' });
  assert.strictEqual(r.success, true, r.error);

  // Ambiguous item -> options, nothing added
  r = await call('POST', '/api/voice/add-items', { tableNumber: 1, itemName: 'pie', quantity: 1 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /Shepherd's Pie or Steak & Ale Pie|Steak & Ale Pie or Shepherd's Pie/);

  // Concurrent edit on the till -> stale revision is reloaded and retried once
  mock.state.failNextAppendStale = true;
  r = await call('POST', '/api/voice/add-items', { tableNumber: 1, itemName: 'coke', quantity: 1 });
  assert.strictEqual(r.success, true, r.error);

  // Parallel adds to the same ticket are serialized instead of conflicting
  const parallel = await Promise.all(['cola', 'beef burger', 'chocolate brownie'].map(itemName =>
    call('POST', '/api/voice/add-items', { tableNumber: 1, itemName, quantity: 1 })));
  assert.ok(parallel.every(p => p.success), JSON.stringify(parallel));

  // Ticket review
  r = await call('POST', '/api/voice/get-ticket', { tableNumber: 1 });
  assert.strictEqual(r.items.length, 6);
  assert.deepStrictEqual(r.items[1].modifiers, ['Medium Rare']);
  assert.strictEqual(r.kitchenStatus, 'not_sent');

  // Send: response lost to a timeout, retried with the same idempotency key -> exactly one dispatch
  mock.state.timeoutNextSend = true;
  r = await call('POST', '/api/voice/send-kitchen', { tableNumber: 1, ticketId: '{{args.ticketId}}' });
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(r.say, 'Table 1 sent to the kitchen.');
  assert.strictEqual(mock.state.calls.filter(c => c === 'POST /tickets/201/send').length, 2);
  r = await call('POST', '/api/voice/send-kitchen', { tableNumber: 1 });
  assert.strictEqual(r.status, 'nothing_new_to_send');

  // Menu is cached between calls
  const menuCalls = mock.state.calls.filter(c => c === 'GET /menu').length;
  assert.strictEqual(menuCalls, 1);
  r = await call('GET', '/api/voice/menu?search=sticky%20toffee');
  assert.strictEqual(r.exactMatch, false);

  // One-shot ordering: whole order as text, open-and-add, add-and-send, short spoken replies
  r = await call('POST', '/api/voice/add-items', { tableNumber: 3, order: '2 fish and chips no vinegar, a coke' });
  assert.strictEqual(r.errorCode, 'table_not_open');
  assert.strictEqual(r.say, "Table 3 isn't open. How many guests?");
  r = await call('POST', '/api/voice/add-items', { tableNumber: 3, order: '2 fish and chips no vinegar, a coke', guestCount: '4', sendToKitchen: 'true' });
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(r.say, 'Opened table 3 for 4, added 2 Fish & Chips and a Cola and sent it to the kitchen.');
  r = await call('POST', '/api/voice/get-ticket', { tableNumber: 3 });
  assert.strictEqual(r.say, 'Table 3: 2 Fish & Chips and a Cola. £35.15.');
  assert.deepStrictEqual(r.items[0].instructions, ['no vinegar']);
  r = await call('POST', '/api/voice/add-items', { tableNumber: 3, order: 'a sirloin steak' });
  assert.strictEqual(r.say, 'How would they like the Sirloin Steak: Rare, Medium Rare or Well Done?');
  r = await call('POST', '/api/voice/add-items', { tableNumber: 3, order: 'sirloin steak medium rare 2 mojitos', sendToKitchen: '{{args.sendToKitchen}}' });
  assert.strictEqual(r.say, 'Added a Sirloin Steak and 2 Mojitos. £78.15.');
  r = await call('POST', '/api/voice/add-items', { tableNumber: 3, order: 'a pie' });
  assert.match(r.say, /^Which one: (Shepherd's Pie or Steak & Ale Pie|Steak & Ale Pie or Shepherd's Pie)\?$/);
  r = await call('POST', '/api/voice/send-kitchen', { tableNumber: 3 });
  assert.strictEqual(r.say, 'Table 3 sent to the kitchen.');
  r = await call('GET', '/api/voice/menu?search=mojito');
  assert.strictEqual(r.say, 'Mojito, £9.50 from the bar. White rum, fresh mint, lime, sugar and soda.');
  r = await call('GET', '/api/voice/menu?search=lasagne');
  assert.strictEqual(r.say, "We don't have lasagne.");
  r = await call('GET', '/api/voice/tables?status=available');
  assert.strictEqual(r.say, 'No tables are free.');
  // The rule-based tests below expect table 3 free again
  mock.state.tickets = { 101: mock.state.tickets[101], 201: mock.state.tickets[201] };

  // Conversational agent (rule-based brain, no OPENAI_API_KEY): memory across turns
  const sessionId = 'test-session';
  const say = async text => {
    const out = await call('POST', '/api/voice/command', { text, sessionId });
    assert.strictEqual(out.status, 200, JSON.stringify(out));
    return out.reply;
  };
  assert.strictEqual(await say('Add two fish and chips and a coke to table 3'), "Table 3 isn't open. How many guests?");
  assert.strictEqual(await say('yes'), 'How many guests?');
  assert.strictEqual(await say('four'), 'Opened table 3 for 4, added 2 Fish & Chips and a Cola. £35.15.');
  assert.strictEqual(await say("what's the total?"), 'Table 3: 2 Fish & Chips and a Cola. £35.15, one item not sent yet.');
  assert.strictEqual(await say('add another coke'), 'Added a Cola. £38.40.');
  assert.strictEqual(await say('how much is a mojito'), 'Mojito is £9.50.');
  assert.strictEqual(await say("what's in the mojito?"), 'Mojito, £9.50 from the bar. White rum, fresh mint, lime, sugar and soda.');
  assert.match(await say('Add a lasagne'), /"lasagne" is not on the menu\./);
  assert.strictEqual(await say('open table 1'), 'Table 1 is already open for 2.');
  assert.match(await say('a sirloin steak'), /Sirloin Steak needs a Cooking choice/);
  assert.strictEqual(await say('two veggie burgers and send it'), 'Added 2 Veggie Burgers and sent it to the kitchen.');
  assert.strictEqual(await say('send it to the kitchen'), 'Nothing new to send for table 1.');
  // Regression: the transcript from the floor (misheard numbers, "yeah send it")
  assert.match(await say('752 fish and chips'), /752 Fish & Chips sounds wrong, say the quantity again/);
  assert.strictEqual(await say('table 1 to fish and chips'), 'Added 2 Fish & Chips. £' + (await call('POST', '/api/voice/get-ticket', { tableNumber: 1 })).total.slice(1) + '.');
  assert.strictEqual(await say('yeah send it'), 'Table 1 sent to the kitchen.');

  // Order with no table yet -> asks which table; an unusable table keeps the order held
  const other = async text => (await call('POST', '/api/voice/command', { text, sessionId: 'second' })).reply;
  assert.strictEqual(await other('two cokes'), 'Which table is 2 cokes for?');
  assert.strictEqual(await other('table 4'), "Table 4 is dirty and can't be opened. Pick another table.");
  assert.match(await other('table 1'), /^Added 2 Colas. £\d+\.\d\d\.$/);
  assert.strictEqual(await other('three mojitos for table 3, fire it'), 'Added 3 Mojitos and sent it to the kitchen.');

  server.close();
  console.log('✓ All Voice Bridge end-to-end tool tests passed!');
}

runEndToEnd().catch(err => {
  console.error(err);
  process.exit(1);
});

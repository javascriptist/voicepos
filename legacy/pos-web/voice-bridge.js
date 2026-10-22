// pos-web/voice-bridge.js
// Voice Assistant Bridge for Agora Conversational AI Agent (Sora)
// Exposes high-level, resilient endpoints that map natural spoken requests to Floreant POS 2.0.1 operations.
//
// Tool endpoints always answer HTTP 200 with `success: true|false` so the LLM receives a readable
// result instead of a transport failure. The typed playground endpoint (/api/voice/command) keeps
// real HTTP status codes for the browser UI.

const crypto = require('node:crypto');
const agoraAgent = require('./agora-agent');
const { createVoiceAgent } = require('./voice-agent');

const MENU_CACHE_MS = parseInt(process.env.VOICE_MENU_CACHE_MS || '60000', 10);
const ORDER_TYPE_CACHE_MS = 10 * 60 * 1000;
const RETRYABLE_TRANSPORT_CODES = new Set(['pos_unreachable', 'pos_timeout']);
const MAX_INSTRUCTION_LENGTH = 200;

function formatGbp(amount) {
  const num = typeof amount === 'number' ? amount : parseFloat(amount) || 0;
  return `£${num.toFixed(2)}`;
}

// Clean string for fuzzy comparison
function normalizeStr(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Light stemming applied to both sides of a comparison: "fingers" -> "finger", and
// "fishing" -> "fish" (speech recognition often adds endings).
function singular(token) {
  let t = token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  return t;
}

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'with', 'of', 'on', 'in', 'please', 'some']);

function significantTokens(s) {
  return normalizeStr(s).split(' ').filter(Boolean).map(singular).filter(t => !STOPWORDS.has(t));
}

// Spoken shorthand -> menu names (The Crown & Copper menu)
const SYNONYMS = {
  'coke': 'cola',
  'coca cola': 'cola',
  'cheeseburger': 'beef burger',
  'burger': 'beef burger',
  'chips': 'skin on chips',
  'fries': 'skin on chips',
  'french fries': 'skin on chips',
  'full english': 'full english breakfast',
  'fry up': 'full english breakfast',
  'tea': 'english breakfast tea',
  'coffee': 'americano',
  'bangers': 'bangers and mash',
  'sausage and mash': 'bangers and mash',
  'fish chips': 'fish and chips',
  'scampi': 'scampi and chips',
  'steak pie': 'steak and ale pie',
  'cod': 'beer battered cod',
  'fish fingers': 'mini fish fingers and chips',
  'cider': 'apple cider pint',
  'ipa': 'session ipa pint',
  'porter': 'london porter pint',
  'red wine': 'house red wine 175ml',
  'white wine': 'house white wine 175ml',
  'glass of red': 'house red wine 175ml',
  'glass of white': 'house white wine 175ml',
  'lemonade': 'homemade lemonade',
  'milkshake': 'chocolate milkshake'
};

function synonymFor(norm) {
  if (SYNONYMS[norm]) return SYNONYMS[norm];
  const singularPhrase = norm.split(' ').map(singular).join(' ');
  return SYNONYMS[singularPhrase] || null;
}

// 0-100 similarity between a spoken phrase and a menu/modifier name, using whole words only
// (substring matching made "chocolate brownie" match "Cola").
// Size/variant words: when the waiter doesn't say them, the standard item wins
// ("bitter" -> the pint, not the half or two pints; "fish and chips" -> adult, not kids).
const VARIANT_WORDS = new Set(['half', 'two', 'bottle', '250ml', 'kid', 'mini', 'double', 'decaf', 'vegetarian']);

function variantPenalty(q, it) {
  return it.filter(t => VARIANT_WORDS.has(t) && !q.includes(t)).length * 6;
}

function scoreTokens(q, it) {
  if (q.length === 0 || it.length === 0) return 0;
  if (q.join(' ') === it.join(' ') || q.join('') === it.join('')) return 100;
  const queryInItem = q.filter(t => it.includes(t)).length;
  if (queryInItem === q.length) return 90 - Math.min(20, (it.length - q.length) * 5);
  const itemInQuery = it.filter(t => q.includes(t)).length;
  if (itemInQuery === it.length) return 75 - Math.min(20, (q.length - it.length) * 5);
  if (queryInItem === 0) return 0;
  return Math.round((50 * queryInItem) / Math.max(q.length, it.length));
}

// Returns { match, candidates }. `match` is null when nothing scores well enough or when the
// best options tie, so the agent can ask "did you mean X or Y?" instead of guessing.
function findMenuMatches(query, items, minScore = 40) {
  if (query === null || query === undefined || !Array.isArray(items) || items.length === 0) {
    return { match: null, candidates: [] };
  }

  if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
    const id = parseInt(query, 10);
    const byId = items.find(i => i.id === id);
    if (byId) return { match: byId, candidates: [] };
  }

  const rawNorm = normalizeStr(query);
  if (!rawNorm) return { match: null, candidates: [] };
  const variants = [{ tokens: significantTokens(rawNorm), weight: 1 }];
  const syn = synonymFor(rawNorm);
  if (syn) variants.push({ tokens: significantTokens(syn), weight: 0.99 });

  const scored = items
    .map(item => {
      const itemTokens = significantTokens(item.name);
      const score = Math.max(...variants.map(v => {
        const base = scoreTokens(v.tokens, itemTokens);
        return base > 0 ? (base - (base < 100 ? variantPenalty(v.tokens, itemTokens) : 0)) * v.weight : 0;
      }));
      return { item, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < minScore) {
    return { match: null, candidates: scored.filter(s => s.score >= 25).slice(0, 3).map(s => s.item) };
  }
  // Near-ties ("pie" -> Shepherd's Pie 85 vs Steak & Ale Pie 80) are ambiguous unless the name was exact.
  // Items listed twice under the same name count once (the newest entry wins).
  const tied = scored.filter(s => s.score >= top.score - 10);
  const tiedNames = [...new Set(tied.map(s => normalizeStr(s.item.name)))];
  if (tiedNames.length === 1 && tied.length > 1) {
    return { match: tied.map(s => s.item).sort((a, b) => b.id - a.id)[0], candidates: [] };
  }
  if (tiedNames.length > 1 && top.score < 99) {
    const seen = new Set();
    const unique = tied.filter(s => !seen.has(normalizeStr(s.item.name)) && seen.add(normalizeStr(s.item.name)));
    return { match: null, candidates: unique.slice(0, 5).map(s => s.item) };
  }
  return { match: top.item, candidates: [] };
}

function matchMenuItem(query, items) {
  return findMenuMatches(query, items).match;
}

// --- Argument helpers -------------------------------------------------------------------------

const NUMBER_WORDS = {
  a: 1, an: 1, another: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, pair: 2
};

// Agora substitutes "{{args.x}}" templates; when the LLM omits an optional argument the literal
// placeholder (or an empty string) can arrive, so treat those as missing.
function cleanArg(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s || /^\{\{.*\}\}$/.test(s) || s === 'undefined' || s === 'null') return undefined;
  return s;
}

function pickArg(body, ...names) {
  for (const name of names) {
    const v = cleanArg(body[name]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function toPositiveNumber(value, { allowFraction = false } = {}) {
  const v = cleanArg(value);
  if (v === undefined) return undefined;
  let n;
  if (typeof v === 'number') n = v;
  else if (NUMBER_WORDS[String(v).toLowerCase()]) n = NUMBER_WORDS[String(v).toLowerCase()];
  else n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return allowFraction ? n : Math.trunc(n) || undefined;
}

function toList(value, splitter = /[,;\n]/) {
  const v = cleanArg(value);
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : String(v).split(splitter);
  return list.map(s => cleanArg(String(s))).filter(Boolean).map(s => s.slice(0, MAX_INSTRUCTION_LENGTH));
}

function errorCode(res) {
  return res && res.data && res.data.error && typeof res.data.error === 'object' ? res.data.error.code : undefined;
}

const POS_ERROR_MESSAGES = {
  pos_unreachable: 'The POS is not reachable right now.',
  pos_timeout: 'The POS took too long to respond.',
  pos_not_ready: 'The POS is not logged in. Someone needs to log in on the till with an active shift.',
  table_not_found: 'That table number does not exist.',
  table_unavailable: 'That table is occupied, booked, dirty or disabled.',
  ambiguous_table_tab: 'That table has more than one open tab; it needs to be handled on the till.',
  ticket_in_pos_editor: 'That table is open on the till right now. Close it on the till first.',
  ticket_not_open: 'That tab is already paid, voided or closed.',
  stale_ticket: 'The tab was changed on the till. Review it again before continuing.',
  kitchen_delivery_uncertain: 'A previous kitchen send is unconfirmed. A manager must check the kitchen screen and reconcile it before this tab can change.',
  operation_not_completed: 'A previous kitchen send was not completed. Check the kitchen screen before doing anything else on this tab.',
  dispatch_state_changed: 'The kitchen send state changed. A manager must reconcile it.',
  missing_kitchen_route: 'Some items have no kitchen station set up in the POS, so nothing was sent.',
  kitchen_disabled: 'Kitchen dispatch is turned off for this order type.',
  operation_limit: 'This tab reached the voice ordering limit. Continue on the till.'
};

function posError(res, fallback) {
  const code = errorCode(res) || `http_${res.status}`;
  const posMessage = res.data && res.data.error && res.data.error.message;
  return { code, message: POS_ERROR_MESSAGES[code] || posMessage || fallback };
}

function isOpenTicket(t) {
  return t && !t.closed && !t.voided && !t.paid;
}

// --- Core operations (shared by the Agora tool endpoints and the typed playground) -------------

function cached(ttlMs, loader) {
  let value;
  let expires = 0;
  let pending = null;
  return async function get() {
    if (value !== undefined && Date.now() < expires) return value;
    if (!pending) {
      pending = loader()
        .then(result => {
          if (result !== undefined) {
            value = result;
            expires = Date.now() + ttlMs;
          }
          return result;
        })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}

function createVoiceOps(forwardToPos) {
  // Serialize mutations per ticket so parallel tool calls don't trip over each other's revisions.
  const ticketLocks = new Map();
  function withTicketLock(ticketId, fn) {
    const prev = ticketLocks.get(ticketId) || Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.catch(() => {});
    ticketLocks.set(ticketId, tail);
    tail.then(() => {
      if (ticketLocks.get(ticketId) === tail) ticketLocks.delete(ticketId);
    });
    return run;
  }

  // The POS bridge deduplicates by Idempotency-Key, so a transport failure can be retried safely
  // with the same key and identical body.
  async function posMutation(posPath, body) {
    const idempotencyKey = crypto.randomUUID();
    let res = await forwardToPos('POST', posPath, body, { idempotencyKey });
    if (RETRYABLE_TRANSPORT_CODES.has(errorCode(res))) {
      res = await forwardToPos('POST', posPath, body, { idempotencyKey });
    }
    return res;
  }

  const getMenu = cached(MENU_CACHE_MS, async () => {
    const res = await forwardToPos('GET', '/menu');
    return res.status === 200 && Array.isArray(res.data.items) ? res.data.items : undefined;
  });

  const menuDetails = new Map();
  function getMenuItemDetail(id) {
    if (!menuDetails.has(id)) {
      menuDetails.set(id, cached(MENU_CACHE_MS, async () => {
        const res = await forwardToPos('GET', `/menu/${id}`);
        return res.status === 200 ? res.data : undefined;
      }));
    }
    return menuDetails.get(id)();
  }

  const getOrderTypeId = cached(ORDER_TYPE_CACHE_MS, async () => {
    if (process.env.VOICE_ORDER_TYPE_ID) return parseInt(process.env.VOICE_ORDER_TYPE_ID, 10);
    const res = await forwardToPos('GET', '/order-types');
    if (res.status !== 200 || !Array.isArray(res.data.orderTypes)) return undefined;
    const tableTypes = res.data.orderTypes.filter(t => t.tableOrderingSupported);
    const dineIn = tableTypes.find(t => /dine/i.test(t.name || '')) || tableTypes[0];
    return dineIn ? dineIn.id : undefined;
  });

  async function getTables() {
    const res = await forwardToPos('GET', '/tables');
    if (res.status !== 200) return { error: posError(res, 'Could not read the tables.') };
    const tables = (res.data.tables || [])
      .map(t => {
        const ticketIds = Array.isArray(t.openTicketIds) ? t.openTicketIds : [];
        let status = 'available';
        if (ticketIds.length > 0) status = 'occupied';
        else if (t.disabled) status = 'disabled';
        else if (t.booked) status = 'booked';
        else if (t.dirty) status = 'dirty';
        else if (t.free === false) status = 'occupied';
        return { number: t.number, status, ticketId: ticketIds[0] ?? null, ticketIds };
      })
      .sort((a, b) => a.number - b.number);
    return { tables };
  }

  async function fetchTicket(ticketId) {
    const res = await forwardToPos('GET', `/tickets/${ticketId}`);
    if (res.status === 200 && res.data.ticket) return { ticket: res.data.ticket };
    return { error: posError(res, `Could not read ticket ${ticketId}.`) };
  }

  // Finds the open ticket for a table (preferred) or a ticket ID. A ticket ID that belongs to a
  // different table is ignored rather than trusted, since LLMs can carry stale IDs between tables.
  async function resolveTicket({ tableNumber, ticketId }) {
    if (ticketId) {
      const { ticket } = await fetchTicket(ticketId);
      const tables = (ticket && ticket.tableNumbers) || [];
      if (ticket && (!tableNumber || tables.includes(tableNumber))) {
        if (isOpenTicket(ticket)) return { ticket, tableNumber: tableNumber || tables[0] || null };
        if (!tableNumber) return { error: { code: 'ticket_not_open', message: POS_ERROR_MESSAGES.ticket_not_open } };
      } else if (!tableNumber) {
        return { error: { code: 'ticket_not_found', message: `Ticket ${ticketId} was not found. Which table is it for?` } };
      }
    }

    if (!tableNumber) {
      return { error: { code: 'missing_table', message: 'Which table is this for?' } };
    }

    const { tables, error } = await getTables();
    if (error) return { error, tableNumber };
    const table = tables.find(t => t.number === tableNumber);
    if (!table) {
      return { error: { code: 'table_not_found', message: `Table ${tableNumber} does not exist.` }, tableNumber };
    }
    if (table.ticketIds.length === 0) {
      // A table that can't take a new tab (dirty, booked, another server's) shouldn't prompt for guests.
      if (table.status !== 'available') {
        const why = table.status === 'occupied' ? 'in use by another server' : table.status;
        return {
          error: { code: 'table_unavailable', message: `Table ${tableNumber} is ${why} and can't be opened. Pick another table.` },
          tableNumber
        };
      }
      return {
        error: { code: 'no_open_tab', message: `Table ${tableNumber} has no open tab. Open the table first.` },
        tableNumber
      };
    }
    if (table.ticketIds.length > 1) {
      return {
        error: {
          code: 'ambiguous_table_tab',
          message: `Table ${tableNumber} has ${table.ticketIds.length} open tabs. Which ticket: ${table.ticketIds.join(' or ')}?`
        },
        tableNumber
      };
    }
    const fetched = await fetchTicket(table.ticketIds[0]);
    if (fetched.error) return { error: fetched.error, tableNumber };
    return { ticket: fetched.ticket, tableNumber };
  }

  async function openTab(tableNumber, guestCount) {
    const orderTypeId = (await getOrderTypeId()) || 1;
    const res = await posMutation(`/tables/${tableNumber}/tab`, { orderTypeId, guestCount: guestCount || 2 });
    if (res.status === 200 || res.status === 201) {
      return { ticket: res.data.ticket || {}, created: Boolean(res.data.created) };
    }
    // An existing tab with a different guest count is still the tab the waiter wants.
    if (errorCode(res) === 'tab_details_mismatch') {
      const existing = await resolveTicket({ tableNumber });
      if (existing.ticket) {
        const note = guestCount && existing.ticket.guestCount !== guestCount
          ? `The existing tab is set for ${existing.ticket.guestCount} guests; the guest count was not changed.`
          : undefined;
        return { ticket: existing.ticket, created: false, note };
      }
    }
    return { error: posError(res, `Could not open Table ${tableNumber}.`) };
  }

  function summarizeTicket(ticket, tableNumber) {
    const items = (ticket.items || []).map(i => {
      const line = {
        name: i.name,
        quantity: i.quantity,
        total: formatGbp(i.total),
        status: i.sentToKitchen ? 'sent_to_kitchen' : (i.kitchenEligible === false ? 'bar_item' : 'not_sent')
      };
      const modifiers = (i.modifiers || []).map(m => m.name).filter(Boolean);
      if (modifiers.length) line.modifiers = modifiers;
      if (i.instructions && i.instructions.length) line.instructions = i.instructions;
      if (i.seatNumber) line.seat = i.seatNumber;
      return line;
    });
    const kitchenItems = items.filter(i => i.status !== 'bar_item');
    const pending = kitchenItems.filter(i => i.status === 'not_sent');
    let kitchenStatus = 'nothing_for_kitchen';
    if (kitchenItems.length) {
      if (pending.length === 0) kitchenStatus = 'all_sent';
      else if (pending.length === kitchenItems.length) kitchenStatus = 'not_sent';
      else kitchenStatus = 'partially_sent';
    }
    return {
      ticketId: ticket.id,
      tableNumber: tableNumber || (ticket.tableNumbers ? ticket.tableNumbers[0] : null),
      guestCount: ticket.guestCount,
      items,
      subtotal: formatGbp(ticket.subtotal),
      tax: formatGbp(ticket.tax),
      total: formatGbp(ticket.total),
      paid: Boolean(ticket.paid),
      kitchenStatus,
      notYetSent: pending.map(i => `${i.quantity}x ${i.name}`)
    };
  }

  async function resolveModifiers(item, line) {
    const detail = await getMenuItemDetail(item.id);
    if (!detail) {
      return { modifiers: [], instructions: [...line.instructions, ...line.modifiers], missing: [], notes: [] };
    }
    const groups = detail.modifierGroups || [];
    const optionsFor = g => (g.modifiers || []).filter(m => m.supported !== false).map(m => ({ ...m, groupId: g.id }));
    const allOptions = groups.flatMap(optionsFor);
    const selected = new Map();
    const instructions = [...line.instructions];
    const notes = [];

    const select = (option, type) => {
      selected.set(`${option.groupId}:${option.id}`, { groupId: option.groupId, modifierId: option.id, quantity: 1, type });
    };

    for (const phrase of line.modifiers) {
      let { match } = findMenuMatches(phrase, allOptions, 70);
      let type = 'normal';
      if (!match && /^extra\s+/i.test(phrase)) {
        match = findMenuMatches(phrase.replace(/^extra\s+/i, ''), allOptions, 70).match;
        type = 'extra';
      }
      if (match) {
        select(match, type);
      } else {
        instructions.push(phrase);
        notes.push(`"${phrase}" is not an option for ${item.name}, so it was added as a kitchen note.`);
      }
    }

    // Required choices can be satisfied by an exactly matching note, e.g. "medium rare".
    const countFor = g => [...selected.values()].filter(s => s.groupId === g.id).length;
    for (const g of groups) {
      for (let k = instructions.length - 1; k >= 0 && countFor(g) < (g.minQuantity || 0); k--) {
        const { match } = findMenuMatches(instructions[k], optionsFor(g), 99);
        if (match) {
          select(match, 'normal');
          instructions.splice(k, 1);
        }
      }
    }

    const missing = groups
      .filter(g => (g.minQuantity || 0) > countFor(g))
      .map(g => ({
        item: item.name,
        choice: g.name,
        choose: g.minQuantity,
        options: optionsFor(g).slice(0, 10).map(m => m.name)
      }));

    return { modifiers: [...selected.values()], instructions, missing, notes };
  }

  // Resolves spoken lines against the menu without touching any ticket, so an order can be
  // validated (and held) before its table is opened.
  // lines: [{ name, quantity, instructions: [], modifiers: [], seatNumber }]
  async function prepareItems(lines) {
    const menuItems = await getMenu();
    if (!menuItems) return { error: { code: 'menu_unavailable', message: 'Could not load the menu from the POS.' } };

    const problems = [];
    const needsChoice = [];
    const notes = [];
    const payloadItems = [];
    const added = [];

    for (const line of lines) {
      const { match, candidates } = findMenuMatches(line.name, menuItems);
      if (!match) {
        problems.push(candidates.length
          ? `"${line.name}" could be ${candidates.map(c => c.name).join(' or ')}`
          : `"${line.name}" is not on the menu`);
        continue;
      }
      if (match.supported === false) {
        problems.push(`${match.name} has to be ordered on the till`);
        continue;
      }
      const quantity = toPositiveNumber(line.quantity, { allowFraction: Boolean(match.fractionalQuantity) }) || 1;
      // A misheard number ("752 fish and chips") must never reach the till.
      if (quantity > 30) {
        problems.push(`${quantity} ${match.name} sounds wrong, say the quantity again`);
        continue;
      }
      const resolved = match.hasModifiers
        ? await resolveModifiers(match, line)
        : { modifiers: [], instructions: [...line.instructions, ...line.modifiers], missing: [], notes: [] };
      if (resolved.missing.length) {
        needsChoice.push(...resolved.missing);
        continue;
      }
      notes.push(...resolved.notes);
      const payload = { menuItemId: match.id, quantity, instructions: resolved.instructions.slice(0, 10), modifiers: resolved.modifiers };
      if (line.seatNumber) payload.seatNumber = line.seatNumber;
      payloadItems.push(payload);
      added.push({ name: match.name, quantity, unitPrice: formatGbp(match.price) });
    }

    if (problems.length || needsChoice.length) {
      const messages = [
        ...problems,
        ...needsChoice.map(c => `${c.item} needs a ${c.choice} choice (${c.options.join(', ')})`)
      ];
      return {
        error: {
          code: needsChoice.length ? 'needs_choice' : 'item_not_found',
          message: `${messages.join('. ')}. Nothing was added.`
        },
        needsChoice
      };
    }
    return { payloadItems, added, notes };
  }

  // Either every line is added in one atomic POS batch or nothing is added.
  async function addItems(ticket, lines) {
    const prepared = await prepareItems(lines);
    if (prepared.error) return prepared;
    const { payloadItems, added, notes } = prepared;

    return withTicketLock(ticket.id, async () => {
      let revision = ticket.revision;
      for (let attempt = 0; ; attempt++) {
        const res = await posMutation(`/tickets/${ticket.id}/items`, { expectedRevision: revision, items: payloadItems });
        if (res.status === 200) return { ticket: res.data.ticket || {}, added, notes };
        // Appends are additive and a stale revision means nothing was written, so reload and retry once.
        if (errorCode(res) === 'stale_ticket' && attempt === 0) {
          const fresh = await fetchTicket(ticket.id);
          if (fresh.ticket && isOpenTicket(fresh.ticket)) {
            revision = fresh.ticket.revision;
            continue;
          }
        }
        return { error: posError(res, 'Could not add the items to the tab.') };
      }
    });
  }

  async function sendToKitchen(ticket) {
    return withTicketLock(ticket.id, async () => {
      const pending = (ticket.items || []).filter(i => i.kitchenEligible !== false && !i.sentToKitchen);
      const res = await posMutation(`/tickets/${ticket.id}/send`, {
        expectedRevision: ticket.revision,
        confirmed: true,
        deliveryMode: 'kitchen_display' // Virtual KDS delivery - no physical printer needed!
      });

      if (res.status === 200) {
        return {
          status: 'sent_to_kitchen_display',
          kitchenTicketIds: res.data.kitchenTicketIds || [],
          sentItems: pending.map(i => `${i.quantity}x ${i.name}`),
          deliveryUncertain: Boolean(res.data.kitchenDeliveryUncertain)
        };
      }
      const code = errorCode(res);
      if (code === 'nothing_to_send') return { status: 'nothing_new_to_send', kitchenTicketIds: [], sentItems: [] };
      if (RETRYABLE_TRANSPORT_CODES.has(code)) {
        return {
          error: {
            code: 'delivery_unknown',
            message: 'I could not confirm the kitchen send. Check the kitchen screen before sending again.'
          }
        };
      }
      return { error: posError(res, 'Could not send the order to the kitchen.') };
    });
  }

  return { getTables, getMenu, getMenuItemDetail, resolveTicket, openTab, summarizeTicket, prepareItems, addItems, sendToKitchen };
}

// --- Playground text parsing ------------------------------------------------------------------

const QUANTITY_PREFIX = /^(\d+|a couple of|a pair of|couple of|another|to|too|for|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:x\s+)?(.*)$/i;
const DONENESS = /\b(medium rare|medium well|well done|rare)\b/;
const NOTE_PATTERNS = [
  /\b(?:no|without|hold the)\s+[a-z]+(?:\s+(?:sauce|dressing|cheese|mayo))?/g,
  /\b(?:on the side|gluten free|dairy free|[a-z]+ allergy)\b/g
];

function splitQuantity(phrase) {
  const m = phrase.match(QUANTITY_PREFIX);
  if (!m) return { quantity: 1, name: phrase };
  const word = m[1].toLowerCase().replace(/^a (couple|pair) of$/, '$1').replace(/ of$/, '');
  // Speech recognition writes "two"/"four" as "to"/"too"/"for" ("table 7 to fish and chips").
  const homophones = { to: 2, too: 2, for: 4 };
  return { quantity: homophones[word] || NUMBER_WORDS[word] || parseInt(word, 10) || 1, name: m[2] };
}

function parseOrderLine(segment) {
  let text = segment.trim();
  const instructions = [];
  const modifiers = [];
  const doneness = text.match(DONENESS);
  if (doneness) {
    instructions.push(doneness[1]);
    text = text.replace(DONENESS, ' ');
  }
  for (const pattern of NOTE_PATTERNS) {
    text = text.replace(pattern, m => {
      instructions.push(m.trim());
      return ' ';
    });
  }
  text = text.replace(/\bextra\s+[a-z]+/g, m => {
    modifiers.push(m.trim());
    return ' ';
  });
  const { quantity, name } = splitQuantity(text.replace(/\s+/g, ' ').trim());
  return { name: name.replace(/^(?:a|an|the)\s+/, '').trim(), quantity, instructions, modifiers };
}

// "two fish and chips and a coke" -> ["two fish and chips", "a coke"]: split on "and"/commas, then
// re-join neighbours whenever the joined phrase is itself a strong menu match.
function splitOrderSegments(phrase, menuItems) {
  // Split on commas, "and", "plus", and where a new quantity starts ("2 burgers 3 cokes").
  const pieces = phrase.split(/\s*(?:,|\band\b|\bplus\b)\s*|\s+(?=\d+\s+[a-z])/).filter(Boolean);
  const segments = [];
  for (let i = 0; i < pieces.length;) {
    let taken = 1;
    for (let j = pieces.length; j > i + 1; j--) {
      const { name } = parseOrderLine(pieces.slice(i, j).join(' and '));
      if (findMenuMatches(name, menuItems, 90).match) {
        taken = j - i;
        break;
      }
    }
    segments.push(pieces.slice(i, i + taken).join(' and '));
    i += taken;
  }
  return segments;
}

function extractTable(lower) {
  const m = lower.match(/\btable\s+(?:number\s+)?(\d+|[a-z]+)\b/);
  return m ? toPositiveNumber(m[1]) : undefined;
}

// --- Agent tools ------------------------------------------------------------------------------
// One implementation of each tool, shared by the Agora (Sora) HTTP tool endpoints and the
// in-app agent. Every tool takes LLM-style arguments and returns { success, ... }.

function modifierPrice(m) {
  const price = (m.prices || []).map(p => p.normal).find(n => n > 0);
  return price ? ` (+${formatGbp(price)})` : '';
}

function createVoiceTools(ops) {
  function tableArgs(args) {
    return {
      tableNumber: toPositiveNumber(pickArg(args, 'tableNumber', 'table_number', 'table')),
      ticketId: toPositiveNumber(pickArg(args, 'ticketId', 'ticket_id'))
    };
  }

  // Every result carries `say`: one short spoken line the agent can repeat as-is, so replies stay
  // brief and the LLM doesn't need another round to phrase them.
  const fail = (error, extra = {}) => ({ success: false, error: error.message, errorCode: error.code, say: error.message, ...extra });

  // "2x Fish & Chips, 1x Cola" -> "2 Fish & Chips and a Cola" (read aloud naturally)
  function spokenList(entries, max = 4) {
    const plural = name => (/s$/i.test(name) ? name : `${name}s`);
    const parts = entries.map(e => (e.quantity === 1 ? `a ${e.name}` : `${e.quantity} ${plural(e.name)}`));
    const shown = parts.slice(0, max);
    if (parts.length > max) shown.push(`${parts.length - max} more`);
    return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : (shown[0] || '');
  }

  function namesList(names, max = 3) {
    if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] || '');
    return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
  }

  const truthy = v => v === true || /^(true|yes|1)$/i.test(String(cleanArg(v) || ''));

  async function describeItem(item) {
    const info = {
      name: item.name,
      price: formatGbp(item.price),
      category: item.categoryName || undefined,
      preparedAt: item.beverage === undefined ? undefined : (item.beverage ? 'bar' : 'kitchen'),
      description: item.description || null
    };
    if (item.hasModifiers) {
      const detail = await ops.getMenuItemDetail(item.id);
      const groups = (detail && detail.modifierGroups) || [];
      if (groups.length) {
        info.options = groups.map(g => ({
          choice: g.name,
          required: (g.minQuantity || 0) > 0,
          options: (g.modifiers || []).filter(m => m.supported !== false).map(m => `${m.name}${modifierPrice(m)}`)
        }));
      }
    }
    return info;
  }

  async function getTables(args = {}) {
    const statusFilter = cleanArg(args.status);
    const { tables, error } = await ops.getTables();
    if (error) return fail(error);

    const available = tables.filter(t => t.status === 'available');
    const occupied = tables.filter(t => t.status === 'occupied');
    const unavailable = tables.filter(t => t.status !== 'available' && t.status !== 'occupied');
    const payload = { success: true, availableCount: available.length, occupiedCount: occupied.length };
    if (statusFilter !== 'occupied') payload.availableTables = available.map(t => t.number);
    if (statusFilter !== 'available') payload.occupiedTables = occupied.map(t => t.number);
    if (!statusFilter || statusFilter === 'all') payload.unavailableTables = unavailable.map(t => ({ table: t.number, status: t.status }));
    payload.say = statusFilter === 'occupied'
      ? (occupied.length ? `Occupied: ${namesList(occupied.map(t => String(t.number)), 6)}.` : 'No tables are occupied.')
      : (available.length ? `Free: ${namesList(available.map(t => String(t.number)), 6)}.` : 'No tables are free.');
    return payload;
  }

  async function getMenu(args = {}) {
    const categoryFilter = cleanArg(args.category);
    const searchQuery = cleanArg(args.search);

    let items = await ops.getMenu();
    if (!items) return fail({ code: 'menu_unavailable', message: 'I can\'t load the menu right now.' });
    const categories = [...new Set(items.map(i => i.categoryName).filter(Boolean))];

    if (categoryFilter) {
      const catNorm = normalizeStr(categoryFilter);
      items = items.filter(i => normalizeStr(i.categoryName).includes(catNorm) || normalizeStr(i.groupName).includes(catNorm));
    }

    if (searchQuery) {
      const { match, candidates } = findMenuMatches(searchQuery, items);
      if (!match) {
        return {
          success: true,
          exactMatch: false,
          items: candidates.map(i => ({ name: i.name, price: formatGbp(i.price) })),
          say: candidates.length ? `Do you mean ${namesList(candidates.map(c => c.name)).replace(/ and (?=[^,]*$)/, ' or ')}?` : `We don't have ${searchQuery}.`
        };
      }
      const info = await describeItem(match);
      const required = (info.options || []).filter(o => o.required).map(o => `${o.choice.toLowerCase()}: ${o.options.join(', ')}`);
      const place = info.preparedAt ? ` from the ${info.preparedAt}` : '';
      const desc = info.description ? ` ${String(info.description).replace(/\.$/, '')}.` : ' No description on the system.';
      return {
        success: true,
        exactMatch: true,
        item: info,
        say: `${info.name}, ${info.price}${place}.${desc}${required.length ? ` Choose ${required.join('; ')}.` : ''}`
      };
    }

    const byCategory = {};
    for (const i of items) {
      const cat = i.categoryName || i.groupName || 'OTHER';
      const desc = categoryFilter && i.description ? ` - ${String(i.description).slice(0, 90)}` : '';
      (byCategory[cat] = byCategory[cat] || []).push(`${i.name} ${formatGbp(i.price)}${desc}`);
    }
    const say = categoryFilter
      ? (items.length ? `${namesList(items.map(i => `${i.name} ${formatGbp(i.price)}`), 4)}.` : `Nothing under ${categoryFilter}.`)
      : `We have ${namesList(categories.map(c => c.charAt(0) + c.slice(1).toLowerCase()), 8)}.`;
    return { success: true, categories, menu: byCategory, say };
  }

  async function openTableTab(args = {}) {
    const { tableNumber } = tableArgs(args);
    const guestCount = toPositiveNumber(pickArg(args, 'guestCount', 'guest_count', 'guests'));
    if (!tableNumber) return fail({ code: 'missing_table', message: 'Which table?' });

    if (!guestCount) {
      // Reusing an open tab needs no guest count; a new one does.
      const existing = await ops.resolveTicket({ tableNumber });
      if (existing.ticket) {
        const t = existing.ticket;
        return { success: true, action: 'reused_existing_tab', tableNumber, guestCount: t.guestCount, say: `Table ${tableNumber} is already open for ${t.guestCount}.` };
      }
      if (existing.error && existing.error.code !== 'no_open_tab') return fail(existing.error, { tableNumber });
      return fail({ code: 'missing_guest_count', message: 'How many guests?' }, { tableNumber });
    }

    const result = await ops.openTab(tableNumber, guestCount);
    if (result.error) return fail(result.error, { tableNumber });
    const { ticket, created, note } = result;
    return {
      success: true,
      action: created ? 'created_new_tab' : 'reused_existing_tab',
      tableNumber,
      guestCount: ticket.guestCount,
      note,
      say: created ? `Table ${tableNumber} open for ${ticket.guestCount}.` : `Table ${tableNumber} is already open for ${ticket.guestCount}.`
    };
  }

  async function getTicket(args = {}) {
    const { ticket, tableNumber, error } = await ops.resolveTicket(tableArgs(args));
    if (error) return fail(error, { tableNumber });
    const summary = ops.summarizeTicket(ticket, tableNumber);
    const items = summary.items.map(i => ({ name: i.name, quantity: i.quantity }));
    const unsent = summary.notYetSent.length;
    summary.say = items.length
      ? `Table ${summary.tableNumber}: ${spokenList(items, 5)}. ${summary.total}${unsent ? `, ${unsent === 1 ? 'one item' : `${unsent} items`} not sent yet` : ''}.`
      : `Table ${summary.tableNumber} has nothing on it yet.`;
    return { success: true, ...summary };
  }

  // Order text ("2 fish and chips no vinegar, a coke, steak medium rare") or the older single-item fields.
  async function orderLines(args) {
    const orderText = cleanArg(args.order);
    if (typeof orderText === 'string') {
      const menuItems = (await ops.getMenu()) || [];
      const text = orderText.toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9, ]/g, ' ').replace(/\s+/g, ' ').trim();
      return splitOrderSegments(text, menuItems).map(parseOrderLine).filter(l => l.name)
        .map(l => ({ ...l, instructions: [...l.instructions, ...toList(args.instructions, /[;\n]/)] }));
    }
    const rawLines = Array.isArray(args.items) && args.items.length ? args.items : [args];
    return rawLines
      .map(l => ({
        name: pickArg(l, 'itemName', 'item_name', 'dish', 'name', 'item'),
        quantity: pickArg(l, 'quantity', 'count', 'qty'),
        instructions: toList(l.instructions || l.notes, /[;\n]/),
        modifiers: toList(l.modifiers || l.options),
        seatNumber: toPositiveNumber(pickArg(l, 'seatNumber', 'seat'))
      }))
      .filter(l => l.name);
  }

  function choiceQuestion(result) {
    const choice = result.needsChoice && result.needsChoice[0];
    if (choice) return `How would they like the ${choice.item}: ${namesList(choice.options, 5).replace(/ and (?=[^,]*$)/, ' or ')}?`;
    return result.error.message.replace(/\. Nothing was added\.$/, '?').replace(/^"(.+?)" could be (.+)\?$/, 'Which one: $2?');
  }

  // One call to: add a whole order, open the table first if it's closed and the guest count is
  // known, and optionally send it to the kitchen.
  async function addTicketItems(args = {}) {
    const lines = await orderLines(args);
    if (!lines.length) return fail({ code: 'missing_item', message: 'What would they like?' });
    const guestCount = toPositiveNumber(pickArg(args, 'guestCount', 'guest_count', 'guests'));
    const andSend = truthy(args.sendToKitchen);

    let { ticket, tableNumber, error } = await ops.resolveTicket(tableArgs(args));
    let openedFor = null;
    if (error) {
      if (error.code !== 'no_open_tab') return fail(error, { tableNumber });
      // Validate first so the waiter isn't asked about guests for an order we can't take.
      const prepared = await ops.prepareItems(lines);
      if (prepared.error) {
        return { ...fail(prepared.error, { tableNumber, needsChoice: prepared.needsChoice }), say: choiceQuestion(prepared) };
      }
      if (!guestCount) {
        return {
          ...fail({ code: 'table_not_open', message: `Table ${tableNumber} isn't open. How many guests?` }, { tableNumber }),
          heldOrder: prepared.added.map(a => `${a.quantity} ${a.name}`).join(', '),
          instruction: 'Nothing was added. When the waiter gives a guest count, call addToOrder again with the same order and guestCount.'
        };
      }
      const opened = await ops.openTab(tableNumber, guestCount);
      if (opened.error) return fail(opened.error, { tableNumber });
      ticket = opened.ticket;
      openedFor = opened.ticket.guestCount;
    }

    const result = await ops.addItems(ticket, lines);
    if (result.error) {
      return { ...fail(result.error, { tableNumber, needsChoice: result.needsChoice }), say: choiceQuestion(result) };
    }

    const updated = result.ticket;
    const what = spokenList(result.added);
    const prefix = openedFor ? `Opened table ${tableNumber} for ${openedFor}, added ${what}` : `Added ${what}`;
    const payload = {
      success: true,
      tableNumber,
      added: result.added.map(a => `${a.quantity} ${a.name}`),
      notes: result.notes.length ? result.notes : undefined,
      total: formatGbp(updated.total),
      sentToKitchen: false,
      say: `${prefix}. ${formatGbp(updated.total)}.`
    };

    if (andSend) {
      const sent = await ops.sendToKitchen(updated);
      if (sent.error) {
        payload.say = `${prefix}, but it didn't go to the kitchen: ${sent.error.message}`;
      } else {
        payload.sentToKitchen = sent.status !== 'nothing_new_to_send';
        payload.say = payload.sentToKitchen
          ? `${prefix} and sent it to the kitchen.`
          : `${prefix}. Nothing needed the kitchen.`;
      }
    }
    return payload;
  }

  async function sendToKitchen(args = {}) {
    const { ticket, tableNumber, error } = await ops.resolveTicket(tableArgs(args));
    if (error) return fail(error, { tableNumber });

    const result = await ops.sendToKitchen(ticket);
    if (result.error) return fail(result.error, { tableNumber });
    if (result.status === 'nothing_new_to_send') {
      return { success: true, status: result.status, tableNumber, say: `Nothing new to send for table ${tableNumber}.` };
    }
    return {
      success: true,
      status: result.status,
      tableNumber,
      sentItems: result.sentItems,
      deliveryUncertain: result.deliveryUncertain || undefined,
      say: `Table ${tableNumber} sent to the kitchen.`
    };
  }

  return { getTables, getMenu, openTableTab, getTicket, addTicketItems, addToOrder: addTicketItems, sendToKitchen };
}

// --- HTTP routes ------------------------------------------------------------------------------

const TOOL_ROUTES = {
  'GET /api/voice/tables': 'getTables',
  'GET /api/voice/menu': 'getMenu',
  'POST /api/voice/open-tab': 'openTableTab',
  'POST /api/voice/get-ticket': 'getTicket',
  'GET /api/voice/ticket': 'getTicket',
  'POST /api/voice/ticket': 'getTicket',
  'POST /api/voice/add-items': 'addTicketItems',
  'POST /api/voice/send-kitchen': 'sendToKitchen'
};

function registerVoiceRoutes(server, forwardToPos) {
  const ops = createVoiceOps(forwardToPos);
  const tools = createVoiceTools(ops);
  const agent = createVoiceAgent({
    tools,
    helpers: { normalizeStr, extractTable, toPositiveNumber, splitOrderSegments, parseOrderLine, formatGbp, NUMBER_WORDS },
    getMenu: ops.getMenu,
    prepareItems: ops.prepareItems
  });

  return async function handleVoiceRequest(req, res, pathname, method) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Agora tool endpoints: always HTTP 200 so the LLM gets a readable result.
    const toolName = TOOL_ROUTES[`${method} ${pathname}`];
    if (toolName) {
      const args = method === 'POST' ? await parseVoiceJsonBody(req) : Object.fromEntries(url.searchParams);
      return sendVoiceJson(res, 200, await tools[toolName](args));
    }

    // In-app conversational agent (typed text and the browser call). Keeps per-session memory.
    if (pathname === '/api/voice/command' && method === 'POST') {
      const body = await parseVoiceJsonBody(req);
      const text = String(body.text || body.command || '').trim();
      if (!text) return sendVoiceJson(res, 400, { error: { code: 'empty_command', message: 'Please enter a voice command.' } });
      try {
        return sendVoiceJson(res, 200, await agent.handle(String(body.sessionId || 'default'), text));
      } catch (err) {
        console.error('Voice agent error:', err);
        return sendVoiceJson(res, 502, { error: { code: 'agent_error', message: err.message } });
      }
    }

    if (pathname === '/api/voice/session/reset' && method === 'POST') {
      const body = await parseVoiceJsonBody(req);
      agent.reset(String(body.sessionId || 'default'));
      return sendVoiceJson(res, 200, { success: true });
    }

    // Agora agent lifecycle (local UI only; the server blocks these paths through the tunnel)
    if (pathname === '/api/voice/agent' && method === 'GET') {
      const status = await agoraAgent.status();
      return sendVoiceJson(res, 200, { ...status, brain: agent.mode });
    }

    if (pathname === '/api/voice/reconnect' && method === 'POST') {
      try {
        const joined = await agoraAgent.join();
        return sendVoiceJson(res, 200, {
          success: true,
          agentId: joined.agentId,
          channel: joined.channel,
          message: `Sora joined channel ${joined.channel} (agent ${joined.agentId}).`
        });
      } catch (err) {
        return sendVoiceJson(res, 502, { error: { code: 'agent_join_failed', message: err.message } });
      }
    }

    // Route not found in voice endpoints
    return false;
  };
}

function parseVoiceJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendVoiceJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
  return true;
}

module.exports = {
  registerVoiceRoutes,
  createVoiceOps,
  createVoiceTools,
  formatGbp,
  matchMenuItem,
  findMenuMatches,
  splitOrderSegments,
  parseOrderLine
};

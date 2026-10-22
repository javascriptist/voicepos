// pos-web/voice-agent.js
// The in-app Sora: a conversational agent with per-session memory for the web playground and the
// browser call. It uses the same system prompt and tool definitions as the Agora agent
// (agora-join-payload.json) so the playground behaves like Sora on the headset.
//
// With OPENAI_API_KEY set it runs the real LLM tool loop (VOICE_LLM_MODEL, default gpt-4.1-mini,
// matching the Agora pipeline; OPENAI_BASE_URL for any OpenAI-compatible endpoint). Without a key it
// falls back to a rule-based assistant that still remembers the table and held orders.

const fs = require('node:fs');
const path = require('node:path');

const PAYLOAD_PATH = path.join(__dirname, 'agora-join-payload.json');
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_HISTORY = 40;
const MAX_TOOL_ROUNDS = 6;

function loadAgentDefinition() {
  const payload = JSON.parse(fs.readFileSync(PAYLOAD_PATH, 'utf8'));
  const llm = payload.properties.llm;
  return {
    system: llm.system_messages.map(m => m.content).join('\n\n'),
    tools: llm.tools.map(t => ({ type: 'function', function: t.function }))
  };
}

function createVoiceAgent({ tools, helpers, getMenu, prepareItems }) {
  const sessions = new Map();
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.VOICE_LLM_MODEL || 'gpt-4.1-mini';
  const mode = apiKey ? `llm:${model}` : 'rules';

  function session(id) {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(key);
    }
    if (!sessions.has(id)) sessions.set(id, { messages: [], state: {}, lastSeen: now });
    const s = sessions.get(id);
    s.lastSeen = now;
    return s;
  }

  // Drop the oldest turns, cutting only at a user message so tool calls stay paired with results.
  function trimHistory(messages) {
    if (messages.length <= MAX_HISTORY) return;
    let cut = messages.length - MAX_HISTORY;
    while (cut < messages.length && messages[cut].role !== 'user') cut++;
    messages.splice(0, cut);
  }

  async function runTool(name, args, actions) {
    const fn = tools[name];
    const result = fn ? await fn(args) : { success: false, error: `Unknown tool ${name}` };
    actions.push({ tool: name, args, result });
    return result;
  }

  async function llmTurn(s, text) {
    const definition = loadAgentDefinition();
    const turnStart = s.messages.length;
    s.messages.push({ role: 'user', content: text });
    const actions = [];
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            temperature: 0.3,
            parallel_tool_calls: false,
            tools: definition.tools,
            messages: [{ role: 'system', content: definition.system }, ...s.messages]
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) throw new Error(`LLM request failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
        const message = (await res.json()).choices[0].message;
        s.messages.push({ role: 'assistant', content: message.content || null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) });

        if (!message.tool_calls || message.tool_calls.length === 0) {
          trimHistory(s.messages);
          return { reply: message.content || '', actions };
        }
        for (const call of message.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {}
          const result = await runTool(call.function.name, args, actions);
          s.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      trimHistory(s.messages);
      return { reply: 'Sorry, that took too many steps. Could you say it again?', actions };
    } catch (err) {
      // Don't leave a half-finished turn in memory.
      s.messages.length = turnStart;
      throw err;
    }
  }

  const rules = createRuleBasedAgent({ helpers, getMenu, prepareItems, runTool });

  return {
    mode,
    reset(id) {
      sessions.delete(id);
    },
    async handle(id, text) {
      const s = session(id);
      const result = apiKey ? await llmTurn(s, text) : await rules.turn(s.state, text);
      const last = result.actions[result.actions.length - 1];
      return { reply: result.reply, action: last ? last.tool : null, actions: result.actions, brain: mode };
    }
  };
}

// --- Rule-based fallback ----------------------------------------------------------------------
// Remembers the current table and an order held for a table that isn't open yet.

function createRuleBasedAgent({ helpers, getMenu, prepareItems, runTool }) {
  const { normalizeStr, extractTable, toPositiveNumber, splitOrderSegments, parseOrderLine, NUMBER_WORDS } = helpers;

  const YES = /^(yes|yeah|yep|yup|sure|ok|okay|please|go ahead|do it|open it|confirm|correct|right)\b/;
  const NO = /^(no|nope|nah|cancel|never mind|forget it|dont|do not|leave it)\b/;
  const NUMBER = '(\\d+|' + Object.keys(NUMBER_WORDS).filter(w => w.length > 2).join('|') + ')';

  function extractGuests(lower) {
    const m = lower.match(new RegExp(`\\b(?:for|with|party of|table of)\\s+${NUMBER}\\b(?!\\s*(?:minutes|mins))`))
      || lower.match(new RegExp(`\\b${NUMBER}\\s+(?:guests?|people|pax|covers|persons?|of us)\\b`))
      || lower.match(new RegExp(`^(?:yes |yeah |ok |okay |sure )?${NUMBER}(?: please)?$`));
    return m ? toPositiveNumber(m[1]) : undefined;
  }

  const describeLines = lines => lines.map(l => (l.quantity === 1 ? `a ${l.name}` : `${l.quantity} ${l.name}`)).join(', ');
  const toolLines = lines => lines.map(l => ({ itemName: l.name, quantity: l.quantity, instructions: l.instructions, modifiers: l.modifiers }));

  // Opens the table and adds any held order in one tool call.
  async function openAndAdd(state, actions, tableNumber, guestCount) {
    const pending = state.pending;
    const lines = pending && pending.lines.length ? pending.lines : null;
    const result = lines
      ? await runTool('addToOrder', { tableNumber, guestCount, items: toolLines(lines), sendToKitchen: pending.send }, actions)
      : await runTool('openTableTab', { tableNumber, guestCount }, actions);
    if (result.success) {
      state.pending = null;
      state.lastTable = tableNumber;
    }
    return result.say;
  }

  async function addLines(state, actions, tableNumber, lines, send = false) {
    const result = await runTool('addToOrder', { tableNumber, items: toolLines(lines), sendToKitchen: send }, actions);
    if (result.success) state.lastTable = tableNumber;
    if (result.errorCode === 'table_not_open') state.pending = { table: tableNumber, lines, send };
    return result.say;
  }

  async function itemQuestion(actions, phrase, kind) {
    const result = await runTool('getMenu', { search: phrase }, actions);
    if (!result.success || !result.exactMatch) return result.say;
    const item = result.item;
    if (kind === 'price') return `${item.name} is ${item.price}.`;
    return result.say;
  }

  async function turn(state, text) {
    const actions = [];
    const reply = message => ({ reply: message, actions });
    const lower = normalizeStr(text);
    const mentionedTable = extractTable(lower);
    const table = mentionedTable || state.lastTable;

    // 1. Follow-ups to a held order: "yes, four of us" / "no" / "table 5"
    if (state.pending) {
      if (NO.test(lower)) {
        state.pending = null;
        return reply('Okay, I dropped that order.');
      }
      if (!state.pending.table && mentionedTable) {
        const { lines, send } = state.pending;
        state.pending = null;
        const message = await addLines(state, actions, mentionedTable, lines, send);
        // Not added and not held for that table (e.g. it's dirty): keep holding the order.
        if (!state.pending && state.lastTable !== mentionedTable) state.pending = { table: null, lines, send };
        return reply(message);
      }
      const guests = extractGuests(lower);
      if (state.pending.table && guests) return reply(await openAndAdd(state, actions, state.pending.table, guests));
      if (state.pending.table && YES.test(lower)) return reply('How many guests?');
    }

    // 2. Open a table: "open table 5 for 4", "seat table 12"
    const openMatch = lower.match(/\b(?:open|seat|start)\b.*?\btable\s+(?:number\s+)?(\w+)/);
    if (openMatch) {
      const tableNumber = toPositiveNumber(openMatch[1]);
      if (!tableNumber) return reply('Which table number?');
      const guests = extractGuests(lower);
      if (!guests) {
        const result = await runTool('openTableTab', { tableNumber }, actions);
        if (result.success) state.lastTable = tableNumber;
        if (result.errorCode === 'missing_guest_count') {
          const held = state.pending && state.pending.table === tableNumber ? state.pending : null;
          state.pending = { table: tableNumber, lines: held ? held.lines : [], send: held ? held.send : false };
        }
        return reply(result.say);
      }
      if (!state.pending || state.pending.table !== tableNumber) state.pending = { table: tableNumber, lines: [] };
      return reply(await openAndAdd(state, actions, tableNumber, guests));
    }

    // 3. Send to kitchen: "send it", "fire table 7"
    // An order that ends in "...and send it" is handled with the order below, in one call.
    const SEND = /\b(?:and\s+)?(?:send (?:it|that|them|this)(?: (?:to|through to) the kitchen| through| away)?|send (?:it )?to (?:the )?kitchen|fire (?:it|that|away))\b/;
    const FILLER = /\b(?:table\s+\w+|please|now|ok|okay|yes|yeah|yep|yup|sure|right|go ahead|cheers|thanks|thank you|then|can you|could you|just)\b/g;
    const onlySend = SEND.test(lower) && !lower.replace(SEND, '').replace(FILLER, '').trim();
    if (onlySend || /^(?:send|fire)\b.*\btable\s+\w+/.test(lower)) {
      if (!table) return reply('Which table?');
      const result = await runTool('sendToKitchen', { tableNumber: table }, actions);
      if (result.success) state.lastTable = table;
      return reply(result.say);
    }

    // 4. Review: "what's the total", "what's on table 7", "read it back"
    if (/\b(total|bill|review|read it back|read back|whats on table|what is on table|whats on the order|the order so far)\b/.test(lower)) {
      if (!table) return reply('Which table?');
      const result = await runTool('getTicket', { tableNumber: table }, actions);
      if (result.success) state.lastTable = table;
      return reply(result.say);
    }

    // 5. Tables: "which tables are free"
    if (/\btables?\b/.test(lower) && /\b(available|free|empty|open|which|status|check)\b/.test(lower)) {
      return reply((await runTool('getTables', { status: 'available' }, actions)).say);
    }

    // 6. Questions about one item: price, contents, where it comes from
    const price = lower.match(/\b(?:how much (?:is|are|for|does)?|price (?:of|for)|cost of)\s+(?:a |an |the )?(.+?)(?:\s+cost)?$/);
    if (price) return reply(await itemQuestion(actions, price[1], 'price'));
    const where = lower.match(/\bwhere (?:is|are|does|do|s)\s+(?:a |an |the )?(.+?)(?:\s+(?:come from|made|go|served|from|on the menu))?$/);
    if (where) return reply(await itemQuestion(actions, where[1], 'where'));
    const about = lower.match(/\b(?:whats in|what is in|what goes in|ingredients (?:of|in)|tell me about|describe|what comes with|whats|what is)\s+(?:a |an |the )?(.+)$/);
    if (about && !/\b(menu|special|drinks|food)\b/.test(about[1])) return reply(await itemQuestion(actions, about[1], 'about'));

    // 7. Menu listing: "what drinks do you have", "what's on the menu"
    if (/\b(menu|drinks|food|desserts|puddings|starters|mains|wines?|beers?|cocktails?)\b/.test(lower) && /\b(what|which|list|show|got|have)\b/.test(lower)) {
      const menuItems = await getMenu();
      const categories = [...new Set((menuItems || []).map(i => i.categoryName).filter(Boolean))];
      const wanted = categories.find(c => normalizeStr(c).split(' ').some(w => w.length > 3 && lower.includes(w.replace(/s$/, ''))));
      return reply((await runTool('getMenu', wanted ? { category: wanted } : {}, actions)).say);
    }

    // 8. Adding items: "two fish and chips and a coke", "add a burger medium rare to table 5"
    const menuItems = await getMenu();
    if (!menuItems) return reply('I can\'t load the menu from the POS right now.');
    const send = SEND.test(lower);
    const phrase = lower
      .replace(SEND, '')
      .replace(/^table\s+(?:number\s+)?\w+\s+/, '')
      .replace(/^(?:please\s+)?(?:(?:can|could)\s+(?:i|we|you)\s+(?:get|have|add)|i(?:d| would) like|we(?:d| would) like|add|order|get|have)\s+/, '')
      .replace(/\s*\b(?:to|for|on)\s+table\s+(?:number\s+)?\w+/, '')
      .replace(/\b(?:please|as well|too|also)\b/g, '')
      .trim();
    const lines = splitOrderSegments(phrase, menuItems).map(parseOrderLine).filter(l => l.name);
    const looksLikeOrder = /^(?:please |table \w+ )?(?:add|order|get|have|can|could|id|i d|we|\d+|a|an|one|two|three|four|five|six)\b/.test(lower);
    const prepared = lines.length ? await prepareItems(lines) : null;
    if (!prepared || (prepared.error && !looksLikeOrder)) {
      return reply('Sorry, I didn\'t catch that. Try "Table 5, two fish and chips" or "What\'s in the mojito?"');
    }
    if (prepared.error) return reply(prepared.error.message.replace(/\. Nothing was added\.$/, '.'));
    if (!table) {
      state.pending = { table: null, lines, send };
      return reply(`Which table is ${describeLines(lines)} for?`);
    }
    return reply(await addLines(state, actions, table, lines, send));
  }

  return { turn };
}

module.exports = { createVoiceAgent };

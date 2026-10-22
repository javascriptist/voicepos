import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { groupsFor, searchMenu, toggleOption, unitPrice, describeLine } from './order'
import { initialState, reduce } from './state'
import type { Menu, MenuItem, Ticket } from './types'

// data/menu.json as the server sends it (the server fills in defaults the file leaves out).
type RawMenu = Omit<Menu, 'items'> & { items: (Pick<MenuItem, 'id'> & Partial<MenuItem>)[] }
const raw = JSON.parse(
  readFileSync(new URL('../../data/menu.json', import.meta.url), 'utf8'),
) as RawMenu
const defaults = { price: null, default_size: null, sizes: [], aliases: [], modifier_groups: [] }
const menu = { ...raw, items: raw.items.map((i) => ({ ...defaults, ...i })) } as Menu
const item = (id: string) => {
  const found = menu.items.find((i) => i.id === id)
  if (!found) throw new Error(id)
  return found
}

describe('prices', () => {
  it('uses the default size when none is chosen', () => {
    expect(unitPrice(menu, item('yorkshire_bitter'), null, [])).toBe(5.25)
    expect(unitPrice(menu, item('yorkshire_bitter'), 'half', [])).toBe(3)
  })
  it('adds paid options (matches the server)', () => {
    expect(unitPrice(menu, item('beef_burger'), null, ['bacon', 'extra cheese'])).toBe(17.45)
  })
})

describe('options', () => {
  const group = (itemId: string, groupId: string) => {
    const found = groupsFor(menu, item(itemId)).find((g) => g.id === groupId)
    if (!found) throw new Error(groupId)
    return found
  }
  const milk = group('flat_white', 'milk')
  const extras = group('beef_burger', 'burger_extras')
  it('swaps single-choice options', () => {
    expect(toggleOption(milk, ['oat milk'], 'soy milk')).toEqual(['soy milk'])
  })
  it('respects the group maximum', () => {
    const three = ['extra cheese', 'bacon', 'fried egg']
    expect(toggleOption(extras, three.slice(0, 2), 'fried egg')).toEqual(three)
    expect(toggleOption(extras, three, 'extra cheese')).toEqual(['bacon', 'fried egg'])
  })
})

describe('search', () => {
  it('finds items by spoken alias', () => {
    expect(searchMenu(menu, 'coke').map((i) => i.id)).toEqual(['cola'])
  })
})

describe('reducer', () => {
  const ticket: Ticket = { table: 5, lines: [], total: 0, unsent: 0 }
  it('loads the snapshot and applies ticket updates', () => {
    let state = reduce(initialState, {
      type: 'snapshot',
      menu,
      table_count: 24,
      tickets: [ticket],
      batches: [],
      events: [],
    })
    expect(state.tickets[5]).toEqual(ticket)
    state = reduce(state, { type: 'ticket', ticket: { ...ticket, total: 6.5 } })
    expect(state.tickets[5]?.total).toBe(6.5)
  })
})

describe('labels', () => {
  it('describes a line', () => {
    expect(describeLine({ qty: 2, name: 'Merlot', size_name: '250ml glass', modifiers: [] })).toBe(
      '2 × Merlot (250ml glass)',
    )
  })
})

describe('toasts', () => {
  const event = {
    event_id: 7,
    source: 'voice' as const,
    transcript: 'table 5 two cokes',
    order: {
      table: 5,
      intent: 'add_items' as const,
      confidence: 1,
      items: [{ menu_id: 'cola', qty: 2, size: null, modifiers: [], notes: [] }],
    },
    path: 'fast_path',
    fast_path_reason: '',
    send_ignored: false,
    llm_attempts: 0,
    result: { ok: true, message: 'Added.', table: 5, changed: true },
    timings: {
      started_at: null,
      speech_end: 1000,
      stt_done: 1080,
      parse_done: 1090,
      pos_updated: null,
      stt_ms: 80,
      parse_ms: 2,
    },
  }
  it('shows what was said and done, then dismisses', () => {
    let state = reduce({ ...initialState, menu }, { type: 'event', ...event, toastId: 1 })
    expect(state.toasts).toEqual([
      { id: 1, tone: 'ok', text: '"table 5 two cokes" · Table 5: Added. 2 × Cola' },
    ])
    state = reduce(state, { type: 'dismiss', id: 1 })
    expect(state.toasts).toEqual([])
  })
})

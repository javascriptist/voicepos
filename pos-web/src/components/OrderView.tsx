import { useMemo, useState } from 'react'

import {
  describeLine,
  formatMoney,
  line,
  needsOptions,
  now,
  searchMenu,
  touchOrder,
} from '../order'
import type { Menu, MenuItem, Order, OrderItem, Ticket, TicketLine } from '../types'
import { Icon } from './Icon'
import { ItemSheet } from './ItemSheet'

interface Props {
  menu: Menu
  table: number | null
  ticket: Ticket | undefined
  sendOrder: (order: Omit<Order, 'confidence'>, startedAt: number) => boolean
  onPickTable: () => void
}

export function OrderView({ menu, table, ticket, sendOrder, onPickTable }: Props) {
  const [category, setCategory] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [sheet, setSheet] = useState<{ item: MenuItem; startedAt: number } | null>(null)

  const items = useMemo(() => {
    const found = searchMenu(menu, query)
    return query || category === 'all' ? found : found.filter((i) => i.category === category)
  }, [menu, query, category])

  if (table === null) {
    return (
      <section className="view empty-view">
        <Icon name="grid" size={28} />
        <h2>No table selected</h2>
        <p className="muted">Pick a table to start an order.</p>
        <button className="btn btn-primary" onClick={onPickTable}>
          Go to tables
        </button>
      </section>
    )
  }

  // Every touch action is timed from the tap that started it (voice vs touch comparison).
  const add = (lines: OrderItem[], startedAt = now()) =>
    sendOrder(touchOrder('add_items', table, lines), startedAt)

  const tap = (item: MenuItem) => {
    if (needsOptions(item)) setSheet({ item, startedAt: now() })
    else add([line(item.id)])
  }

  const again = (l: TicketLine) =>
    add([line(l.menu_id, { size: l.size, modifiers: l.modifiers, notes: l.notes })])
  const removeOne = (l: TicketLine) =>
    sendOrder(touchOrder('remove_item', table, [line(l.menu_id, { size: l.size })]), now())

  const lines = ticket?.lines ?? []
  const unsent = ticket?.unsent ?? 0

  return (
    <section className="order-layout">
      <div className="catalog">
        <label className="search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Search menu"
            aria-label="Search menu"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="pills" role="tablist" aria-label="Categories">
          {[{ id: 'all', name: 'All' }, ...menu.categories].map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={category === c.id && !query}
              className={`pill-button${category === c.id && !query ? ' is-active' : ''}`}
              onClick={() => {
                setCategory(c.id)
                setQuery('')
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="menu-grid">
          {items.map((item) => (
            <button key={item.id} className="menu-card" onClick={() => tap(item)}>
              <span className="menu-name">{item.name}</span>
              <span className="menu-meta">
                <span className="menu-price">
                  {formatMoney(
                    item.price ?? item.sizes.find((s) => s.id === item.default_size)?.price ?? 0,
                  )}
                </span>
                {needsOptions(item) && <span className="pill">Options</span>}
              </span>
            </button>
          ))}
          {items.length === 0 && <p className="muted">Nothing matches "{query}".</p>}
        </div>
      </div>

      <aside className="ticket" aria-label={`Table ${table} ticket`}>
        <div className="ticket-header">
          <div>
            <span className="eyebrow">Table</span>
            <h2>{table}</h2>
          </div>
          <button className="btn btn-ghost" onClick={onPickTable}>
            Change
          </button>
        </div>

        <ul className="ticket-lines">
          {lines.length === 0 && <li className="muted ticket-empty">Nothing ordered yet.</li>}
          {lines.map((l) => (
            <li key={l.line_id} className={`ticket-line${l.sent ? ' is-sent' : ''}`}>
              <div className="ticket-line-main">
                <span>{describeLine(l)}</span>
                <span className="money">{formatMoney(l.unit_price * l.qty)}</span>
              </div>
              {l.notes.length > 0 && (
                <div className="ticket-note">
                  <Icon name="alert" size={14} />
                  {l.notes.join(', ')}
                </div>
              )}
              <div className="ticket-line-actions">
                {l.sent ? (
                  <span className="pill pill-ok">Sent</span>
                ) : (
                  <>
                    <span className="pill pill-warn">Not sent</span>
                    <div className="stepper stepper-sm">
                      <button onClick={() => removeOne(l)} aria-label={`One less ${l.name}`}>
                        <Icon name="minus" />
                      </button>
                      <span>{l.qty}</span>
                      <button onClick={() => again(l)} aria-label={`One more ${l.name}`}>
                        <Icon name="plus" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="ticket-footer">
          <div className="ticket-total">
            <span>Total</span>
            <span className="money">{formatMoney(ticket?.total ?? 0)}</span>
          </div>
          <div className="ticket-buttons">
            <button
              className="btn btn-secondary"
              disabled={unsent === 0}
              onClick={() => sendOrder(touchOrder('cancel', table), now())}
            >
              Clear unsent
            </button>
            <button
              className="btn btn-primary btn-lg"
              disabled={unsent === 0}
              onClick={() => sendOrder(touchOrder('send_order', table), now())}
            >
              <Icon name="send" />
              {unsent === 0 ? 'All sent' : `Send ${unsent}`}
            </button>
          </div>
        </div>
      </aside>

      {sheet && (
        <ItemSheet
          menu={menu}
          item={sheet.item}
          onClose={() => setSheet(null)}
          onAdd={(orderLine) => {
            add([orderLine], sheet.startedAt)
            setSheet(null)
          }}
        />
      )}
    </section>
  )
}

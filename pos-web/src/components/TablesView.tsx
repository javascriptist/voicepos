import { formatMoney } from '../order'
import type { Ticket } from '../types'

interface Props {
  tableCount: number
  tickets: Record<number, Ticket>
  selected: number | null
  onSelect: (table: number) => void
}

export function TablesView({ tableCount, tickets, selected, onSelect }: Props) {
  const tables = Array.from({ length: tableCount }, (_, i) => i + 1)
  const open = tables.filter((t) => (tickets[t]?.lines.length ?? 0) > 0).length

  return (
    <section className="view">
      <div className="view-header">
        <h1>Tables</h1>
        <span className="muted">
          {open} open · {tableCount - open} free
        </span>
      </div>
      <div className="tables-grid">
        {tables.map((table) => {
          const ticket = tickets[table]
          const open = ticket && ticket.lines.length > 0 ? ticket : null
          return (
            <button
              key={table}
              className={`table-card${open ? ' is-open' : ''}${selected === table ? ' is-selected' : ''}`}
              onClick={() => onSelect(table)}
              aria-label={`Table ${table}${open ? `, ${formatMoney(open.total)}` : ', free'}`}
            >
              <span className="table-number">{table}</span>
              {open ? (
                <span className="table-meta">
                  <span>{formatMoney(open.total)}</span>
                  {open.unsent > 0 && <span className="pill pill-warn">{open.unsent} unsent</span>}
                </span>
              ) : (
                <span className="table-meta muted">Free</span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}

import { describeLine } from '../order'
import type { KitchenBatch } from '../types'
import { Icon } from './Icon'

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function KitchenView({ batches }: { batches: KitchenBatch[] }) {
  return (
    <section className="view">
      <div className="view-header">
        <h1>Kitchen &amp; bar</h1>
        <span className="muted">Newest first</span>
      </div>
      {batches.length === 0 ? (
        <div className="empty-view">
          <Icon name="chef" size={28} />
          <p className="muted">Orders appear here when a table is sent.</p>
        </div>
      ) : (
        <div className="batch-grid">
          {batches.map((batch) => (
            <article key={batch.batch_id} className="batch">
              <header className="batch-header">
                <h2>Table {batch.table}</h2>
                <span className="muted">{time(batch.sent_at)}</span>
              </header>
              {(['kitchen', 'bar'] as const).map((station) => {
                const lines = batch.lines.filter((l) => l.station === station)
                if (lines.length === 0) return null
                return (
                  <div key={station} className="batch-station">
                    <span className="eyebrow">{station === 'kitchen' ? 'Kitchen' : 'Bar'}</span>
                    <ul>
                      {lines.map((l) => (
                        <li key={l.line_id}>
                          {describeLine(l)}
                          {l.notes.length > 0 && (
                            <div className="ticket-note">{l.notes.join(', ')}</div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

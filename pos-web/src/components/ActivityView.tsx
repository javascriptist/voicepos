import { latency } from '../order'
import type { OrderEvent } from '../types'
import { Icon } from './Icon'

const PATH_LABEL: Record<string, string> = {
  fast_path: 'Fast path',
  llm: 'LLM',
  none: 'Not understood',
  touch: 'Touch',
  text: 'Typed',
}

export function ActivityView({ events }: { events: OrderEvent[] }) {
  return (
    <section className="view">
      <div className="view-header">
        <h1>Activity</h1>
        <span className="muted">Every voice and touch order, newest first</span>
      </div>
      {events.length === 0 ? (
        <div className="empty-view">
          <Icon name="activity" size={28} />
          <p className="muted">Orders from the headsets and this screen show up here.</p>
        </div>
      ) : (
        <ol className="activity">
          {events.map((event) => {
            const ms = latency(event)
            return (
              <li
                key={event.event_id}
                className={`activity-row${event.result.ok ? '' : ' is-failed'}`}
              >
                <span className="activity-source" title={event.source}>
                  <Icon name={event.source === 'touch' ? 'hand' : 'mic'} />
                </span>
                <div className="activity-body">
                  <div className="activity-line">
                    {event.transcript
                      ? `"${event.transcript}"`
                      : event.order.intent.replace('_', ' ')}
                  </div>
                  <div className="activity-meta">
                    {event.result.table !== null && <span>Table {event.result.table}</span>}
                    <span>{event.result.message}</span>
                    {event.send_ignored && (
                      <span className="pill pill-warn">Say "send" separately</span>
                    )}
                    {event.fast_path_reason && event.path !== 'fast_path' && (
                      <span className="muted">{event.fast_path_reason}</span>
                    )}
                  </div>
                </div>
                <div className="activity-stats">
                  <span className="pill">{PATH_LABEL[event.path] ?? event.path}</span>
                  {ms !== null && <span className="money">{ms} ms</span>}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

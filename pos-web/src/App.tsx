import { useState } from 'react'

import { ActivityView } from './components/ActivityView'
import { Icon, type IconName } from './components/Icon'
import { KitchenView } from './components/KitchenView'
import { OrderView } from './components/OrderView'
import { TablesView } from './components/TablesView'
import { useServer } from './useServer'

type View = 'tables' | 'order' | 'kitchen' | 'activity'

const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: 'tables', label: 'Tables', icon: 'grid' },
  { id: 'order', label: 'Order', icon: 'receipt' },
  { id: 'kitchen', label: 'Kitchen', icon: 'chef' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
]

function useTheme() {
  const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const forced = document.documentElement.dataset.theme
    return forced === 'light' || forced === 'dark' ? forced : prefersDark() ? 'dark' : 'light'
  })
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('pos-theme', next)
    } catch {
      // private mode: the choice just won't persist
    }
    setTheme(next)
  }
  return { theme, toggle }
}

export default function App() {
  const { state, sendOrder } = useServer()
  const [view, setView] = useState<View>('tables')
  const [table, setTable] = useState<number | null>(null)
  const { theme, toggle } = useTheme()

  const status = {
    open: { label: 'Connected', tone: 'ok' },
    connecting: { label: 'Connecting', tone: 'warn' },
    closed: { label: 'Offline, retrying', tone: 'error' },
  }[state.connection]

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            C&amp;C
          </span>
          <span className="brand-title">Crown &amp; Copper</span>
        </div>
        <nav className="nav" aria-label="Sections">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`nav-button${view === v.id ? ' is-active' : ''}`}
              aria-current={view === v.id ? 'page' : undefined}
              onClick={() => setView(v.id)}
            >
              <Icon name={v.icon} />
              <span className="nav-label">{v.label}</span>
              {v.id === 'order' && table !== null && <span className="count">T{table}</span>}
            </button>
          ))}
        </nav>
        <div className="header-right">
          <span className={`status status-${status.tone}`} role="status">
            <span className="dot" />
            <span className="status-label">{status.label}</span>
          </span>
          <button
            className="btn btn-ghost btn-icon"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </div>
      </header>

      <main className="main">
        {!state.menu ? (
          <div className="empty-view">
            <p className="muted">
              {state.connection === 'closed'
                ? "Can't reach the voice server. Start it with: uv run uvicorn voicepos.app:app"
                : 'Connecting to the voice server...'}
            </p>
          </div>
        ) : view === 'tables' ? (
          <TablesView
            tableCount={state.tableCount}
            tickets={state.tickets}
            selected={table}
            onSelect={(t) => {
              setTable(t)
              setView('order')
            }}
          />
        ) : view === 'order' ? (
          <OrderView
            menu={state.menu}
            table={table}
            ticket={table !== null ? state.tickets[table] : undefined}
            sendOrder={sendOrder}
            onPickTable={() => setView('tables')}
          />
        ) : view === 'kitchen' ? (
          <KitchenView batches={state.batches} />
        ) : (
          <ActivityView events={state.events} />
        )}
      </main>

      <div className="toasts" aria-live="polite">
        {state.toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === 'ok' ? 'check' : 'alert'} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

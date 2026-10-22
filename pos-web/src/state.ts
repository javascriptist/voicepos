import { describeLine } from './order'
import type { KitchenBatch, Menu, OrderEvent, ServerMessage, Ticket } from './types'

export type Connection = 'connecting' | 'open' | 'closed'

export interface Toast {
  id: number
  tone: 'ok' | 'error'
  text: string
}

export interface PosState {
  connection: Connection
  menu: Menu | null
  tableCount: number
  tickets: Record<number, Ticket>
  batches: KitchenBatch[]
  events: OrderEvent[] // newest first
  toasts: Toast[] // newest first
}

export const initialState: PosState = {
  connection: 'connecting',
  menu: null,
  tableCount: 0,
  tickets: {},
  batches: [],
  events: [],
  toasts: [],
}

const KEEP_EVENTS = 50
const KEEP_BATCHES = 50
const KEEP_TOASTS = 3

/** Server messages that show a toast carry an id (from the connection hook) to dismiss it by. */
export type Action =
  | (ServerMessage & { toastId?: number })
  | { type: 'connection'; connection: Connection }
  | { type: 'dismiss'; id: number }

/** One line for the screen: what was said (voice), the table, and the outcome. */
export function toastText(event: OrderEvent, menu: Menu | null): string {
  const name = (id: string) => menu?.items.find((i) => i.id === id)?.name ?? id
  const items = event.order.items
    .map((i) => describeLine({ qty: i.qty, name: name(i.menu_id), modifiers: i.modifiers }))
    .join(', ')
  const said = event.source === 'touch' ? '' : `"${event.transcript}" · `
  const table = event.result.table !== null ? `Table ${event.result.table}: ` : ''
  const detail = event.result.ok && items ? ` ${items}` : ''
  return `${said}${table}${event.result.message}${detail}`
}

function withToast(state: PosState, toast: Toast | null): Toast[] {
  return toast ? [toast, ...state.toasts].slice(0, KEEP_TOASTS) : state.toasts
}

export function reduce(state: PosState, action: Action): PosState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.connection }
    case 'snapshot':
      return {
        ...state,
        menu: action.menu,
        tableCount: action.table_count,
        tickets: Object.fromEntries(action.tickets.map((t) => [t.table, t])),
        batches: [...action.batches].reverse(),
        events: [...action.events].reverse(),
      }
    case 'ticket':
      return { ...state, tickets: { ...state.tickets, [action.ticket.table]: action.ticket } }
    case 'batch':
      return { ...state, batches: [action.batch, ...state.batches].slice(0, KEEP_BATCHES) }
    case 'event': {
      const { type: _type, toastId, ...event } = action
      const toast: Toast | null =
        toastId === undefined
          ? null
          : {
              id: toastId,
              tone: event.result.ok ? 'ok' : 'error',
              text: toastText(event, state.menu),
            }
      return {
        ...state,
        events: [event, ...state.events].slice(0, KEEP_EVENTS),
        toasts: withToast(state, toast),
      }
    }
    case 'error': {
      const toast: Toast | null =
        action.toastId === undefined
          ? null
          : { id: action.toastId, tone: 'error', text: action.message }
      return { ...state, toasts: withToast(state, toast) }
    }
    case 'dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
  }
}

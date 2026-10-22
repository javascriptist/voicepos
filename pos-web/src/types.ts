// Mirrors server/src/voicepos (order.py, menu.py, tickets.py, app.py). The order contract's
// JSON Schema is in data/order.schema.json.

export type Intent =
  'add_items' | 'remove_item' | 'modify_item' | 'set_table' | 'send_order' | 'cancel' | 'unknown'

export interface OrderItem {
  menu_id: string
  qty: number
  size: string | null
  modifiers: string[]
  notes: string[]
}

export interface Order {
  table: number | null
  items: OrderItem[]
  intent: Intent
  confidence: number
}

export interface Category {
  id: string
  name: string
}

export interface ModifierOption {
  name: string
  price: number
}

export interface ModifierGroup {
  id: string
  name: string
  max: number
  default: string | null
  options: ModifierOption[]
}

export interface Size {
  id: string
  name: string
  price: number
}

export interface MenuItem {
  id: string
  name: string
  category: string
  station: 'kitchen' | 'bar'
  price: number | null
  default_size: string | null
  sizes: Size[]
  aliases: string[]
  modifier_groups: string[]
}

export interface Menu {
  version: number
  currency: string
  venue: string
  categories: Category[]
  modifier_groups: ModifierGroup[]
  items: MenuItem[]
}

export interface TicketLine {
  line_id: number
  menu_id: string
  name: string
  qty: number
  size: string | null
  size_name: string | null
  modifiers: string[]
  notes: string[]
  unit_price: number
  station: 'kitchen' | 'bar'
  sent: boolean
}

export interface Ticket {
  table: number
  lines: TicketLine[]
  total: number
  unsent: number
}

export interface KitchenBatch {
  batch_id: number
  table: number
  sent_at: number
  lines: TicketLine[]
}

export interface ApplyResult {
  ok: boolean
  message: string
  table: number | null
  changed: boolean
}

export interface Timings {
  started_at: number | null
  speech_end: number | null
  stt_done: number | null
  parse_done: number
  pos_updated: number | null
  stt_ms: number | null
  parse_ms: number
}

export interface OrderEvent {
  event_id: number
  source: 'voice' | 'text' | 'touch'
  transcript: string
  order: Order
  path: string
  fast_path_reason: string
  send_ignored: boolean
  llm_attempts: number
  result: ApplyResult
  timings: Timings
}

export type ServerMessage =
  | {
      type: 'snapshot'
      menu: Menu
      table_count: number
      tickets: Ticket[]
      batches: KitchenBatch[]
      events: OrderEvent[]
    }
  | ({ type: 'event' } & OrderEvent)
  | { type: 'ticket'; ticket: Ticket }
  | { type: 'batch'; batch: KitchenBatch }
  | { type: 'error'; message: string }

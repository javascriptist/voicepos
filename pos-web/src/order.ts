import type { Menu, MenuItem, ModifierGroup, Order, OrderEvent, OrderItem } from './types'

/** Wall-clock ms, the same clock the server stamps timings with. Touch timings go through here
 * so there is one place to swap in a synchronised clock for multi-device measurements. */
export function now(): number {
  return Date.now()
}

export function formatMoney(amount: number): string {
  return `£${amount.toFixed(2)}`
}

export function groupsFor(menu: Menu, item: MenuItem): ModifierGroup[] {
  return item.modifier_groups
    .map((id) => menu.modifier_groups.find((g) => g.id === id))
    .filter((g): g is ModifierGroup => g !== undefined)
}

/** Items that need a choice before adding (a size or options) open the options sheet. */
export function needsOptions(item: MenuItem): boolean {
  return item.sizes.length > 0 || item.modifier_groups.length > 0
}

export function unitPrice(
  menu: Menu,
  item: MenuItem,
  size: string | null,
  modifiers: string[],
): number {
  const base =
    item.sizes.find((s) => s.id === (size ?? item.default_size))?.price ?? item.price ?? 0
  const extras = groupsFor(menu, item)
    .flatMap((g) => g.options)
    .filter((o) => modifiers.includes(o.name))
    .reduce((sum, o) => sum + o.price, 0)
  return Math.round((base + extras) * 100) / 100
}

/** Toggle an option, respecting the group's maximum (single-choice groups swap). */
export function toggleOption(group: ModifierGroup, selected: string[], option: string): string[] {
  if (selected.includes(option)) return selected.filter((m) => m !== option)
  const inGroup = selected.filter((m) => group.options.some((o) => o.name === m))
  if (group.max === 1) {
    return [...selected.filter((m) => !inGroup.includes(m)), option]
  }
  if (inGroup.length >= group.max) return selected
  return [...selected, option]
}

export function line(menuId: string, fields: Partial<Omit<OrderItem, 'menu_id'>> = {}): OrderItem {
  return { menu_id: menuId, qty: 1, size: null, modifiers: [], notes: [], ...fields }
}

/** Touch orders use the same contract as voice; the server validates both the same way. */
export function touchOrder(
  intent: Order['intent'],
  table: number,
  items: OrderItem[] = [],
): Omit<Order, 'confidence'> {
  return { table, intent, items }
}

export function describeLine(item: {
  qty: number
  name: string
  size_name?: string | null
  modifiers: string[]
}): string {
  const size = item.size_name ? ` (${item.size_name})` : ''
  const options = item.modifiers.length ? `, ${item.modifiers.join(', ')}` : ''
  return `${item.qty} × ${item.name}${size}${options}`
}

/** Search over names and spoken aliases, so staff can type what they'd say. */
export function searchMenu(menu: Menu, query: string): MenuItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return menu.items
  return menu.items.filter(
    (i) => i.name.toLowerCase().includes(q) || i.aliases.some((a) => a.includes(q)),
  )
}

/** End of input (speech end, or the first tap for touch) to the order being applied. */
export function latency(event: OrderEvent): number | null {
  const start = event.timings.speech_end ?? event.timings.started_at
  return start === null ? null : Math.round(event.timings.parse_done - start)
}

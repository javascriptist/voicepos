import { useEffect, useRef, useState } from 'react'

import { formatMoney, groupsFor, toggleOption, unitPrice } from '../order'
import type { Menu, MenuItem, OrderItem } from '../types'
import { Icon } from './Icon'

interface Props {
  menu: Menu
  item: MenuItem
  onAdd: (line: OrderItem) => void
  onClose: () => void
}

/** Sizes, options, notes and quantity for one item. Options are full-width rows: the whole row
 * is the tap target and a selected row shows a check on the right. */
export function ItemSheet({ menu, item, onAdd, onClose }: Props) {
  const [size, setSize] = useState<string | null>(item.default_size)
  const [modifiers, setModifiers] = useState<string[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [qty, setQty] = useState(1)
  const dialog = useRef<HTMLDivElement>(null)
  const groups = groupsFor(menu, item)
  const price = unitPrice(menu, item, size, modifiers) * qty

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('button, input')?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const addNote = () => {
    const note = draft.trim()
    if (note && !notes.includes(note)) setNotes([...notes, note])
    setDraft('')
  }

  const submit = () => {
    const pending = draft.trim()
    onAdd({
      menu_id: item.id,
      qty,
      // The server fills in the default size; send it only when it differs.
      size: size && size !== item.default_size ? size : null,
      modifiers,
      notes: pending && !notes.includes(pending) ? [...notes, pending] : notes,
    })
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <div>
            <h2 id="sheet-title">{item.name}</h2>
            <span className="muted">{formatMoney(unitPrice(menu, item, size, modifiers))}</span>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        <div className="sheet-body">
          {item.sizes.length > 0 && (
            <fieldset className="option-group">
              <legend className="option-title">Size</legend>
              <div className="segmented" role="radiogroup">
                {item.sizes.map((s) => (
                  <button
                    key={s.id}
                    role="radio"
                    aria-checked={size === s.id}
                    className={`segment${size === s.id ? ' is-active' : ''}`}
                    onClick={() => setSize(s.id)}
                  >
                    <span>{s.name}</span>
                    <span className="segment-price">{formatMoney(s.price)}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          {groups.map((group) => (
            <fieldset key={group.id} className="option-group">
              <legend className="option-title">
                <span>{group.name}</span>
                <span className="muted">
                  {group.max === 1 ? 'Choose one' : `Up to ${group.max}`}
                </span>
              </legend>
              <div className="option-list" role={group.max === 1 ? 'radiogroup' : 'group'}>
                {group.options.map((option) => {
                  const checked = modifiers.includes(option.name)
                  return (
                    <button
                      key={option.name}
                      role={group.max === 1 ? 'radio' : 'checkbox'}
                      aria-checked={checked}
                      className="option-row"
                      onClick={() => setModifiers(toggleOption(group, modifiers, option.name))}
                    >
                      <span className="option-label">
                        {option.name}
                        {group.default === option.name && <span className="muted"> · usual</span>}
                      </span>
                      {option.price > 0 && (
                        <span className="option-price">+{formatMoney(option.price)}</span>
                      )}
                      <span className="option-check">
                        <Icon name="check" />
                      </span>
                    </button>
                  )
                })}
              </div>
            </fieldset>
          ))}

          <div className="option-group">
            <label className="option-title" htmlFor="note-input">
              Note for the kitchen
            </label>
            <div className="input-row">
              <input
                id="note-input"
                className="input"
                value={draft}
                placeholder="e.g. no vinegar, nut allergy"
                maxLength={200}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addNote()}
              />
              <button className="btn btn-secondary" onClick={addNote} disabled={!draft.trim()}>
                Add
              </button>
            </div>
            {notes.length > 0 && (
              <div className="chips">
                {notes.map((note) => (
                  <span key={note} className="chip">
                    {note}
                    <button
                      className="chip-remove"
                      aria-label={`Remove note ${note}`}
                      onClick={() => setNotes(notes.filter((n) => n !== note))}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="sheet-footer">
          <div className="stepper" aria-label="Quantity">
            <button onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Fewer">
              <Icon name="minus" />
            </button>
            <span aria-live="polite">{qty}</span>
            <button onClick={() => setQty(Math.min(30, qty + 1))} aria-label="More">
              <Icon name="plus" />
            </button>
          </div>
          <button className="btn btn-primary btn-lg" onClick={submit}>
            Add · {formatMoney(price)}
          </button>
        </div>
      </div>
    </div>
  )
}

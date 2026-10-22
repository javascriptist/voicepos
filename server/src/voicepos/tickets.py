"""Open tickets per table, changed only by applying validated orders.

Voice and touch both send order JSON (the CLAUDE.md contract) and go through `TicketStore.apply`,
so both input methods are handled, timed and logged the same way. In memory for now; SQLite
persistence comes with the timing logs.
"""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field

from pydantic import BaseModel

from .menu import Menu
from .order import Intent, Order, OrderItem

TABLE_COUNT = 24


class TicketLine(BaseModel):
    line_id: int
    menu_id: str
    name: str
    qty: int
    size: str | None = None
    size_name: str | None = None
    modifiers: list[str] = []
    notes: list[str] = []
    unit_price: float
    station: str
    sent: bool = False

    @property
    def total(self) -> float:
        return round(self.unit_price * self.qty, 2)


class KitchenBatch(BaseModel):
    """What one "send" put in front of the kitchen or bar."""

    batch_id: int
    table: int
    sent_at: float
    lines: list[TicketLine]


class Ticket(BaseModel):
    table: int
    lines: list[TicketLine] = []
    total: float = 0.0
    unsent: int = 0


class ApplyResult(BaseModel):
    ok: bool
    message: str  # short, suitable for a TTS confirmation or a toast
    table: int | None = None
    changed: bool = False


@dataclass
class TicketStore:
    menu: Menu
    table_count: int = TABLE_COUNT
    tickets: dict[int, list[TicketLine]] = field(default_factory=dict)
    batches: list[KitchenBatch] = field(default_factory=list)
    _ids: itertools.count = field(default_factory=lambda: itertools.count(1))

    # -- reading ------------------------------------------------------------------------------

    def ticket(self, table: int) -> Ticket:
        lines = self.tickets.get(table, [])
        return Ticket(
            table=table,
            lines=lines,
            total=round(sum(line.total for line in lines), 2),
            unsent=sum(1 for line in lines if not line.sent),
        )

    def open_tickets(self) -> list[Ticket]:
        return [self.ticket(t) for t in sorted(self.tickets) if self.tickets[t]]

    # -- applying orders ----------------------------------------------------------------------

    def apply(self, order: Order) -> ApplyResult:
        table = order.table
        if order.intent == Intent.UNKNOWN:
            return ApplyResult(ok=False, message="Sorry, say that again?", table=table)
        if table is None:
            return ApplyResult(ok=False, message="Which table?")
        if not 1 <= table <= self.table_count:
            return ApplyResult(ok=False, message=f"There's no table {table}.", table=table)
        if order.intent == Intent.SET_TABLE:
            return ApplyResult(ok=True, message=f"Table {table}.", table=table)

        lines = self.tickets.setdefault(table, [])
        handler = {
            Intent.ADD_ITEMS: self._add,
            Intent.REMOVE_ITEM: self._remove,
            Intent.MODIFY_ITEM: self._modify,
            Intent.SEND_ORDER: self._send,
            Intent.CANCEL: self._cancel,
        }[order.intent]
        ok, message = handler(table, lines, order.items)
        return ApplyResult(ok=ok, message=message, table=table, changed=ok)

    def _line(self, item: OrderItem) -> TicketLine:
        menu_item = self.menu.item(item.menu_id)
        assert menu_item is not None  # orders are validated against the menu first
        size = menu_item.size(item.size) if item.size else None
        price = size.price if size else (menu_item.price or 0.0)
        for group in self.menu.groups_for(menu_item):
            for modifier in item.modifiers:
                option = group.option(modifier)
                if option:
                    price += option.price
        return TicketLine(
            line_id=next(self._ids),
            menu_id=menu_item.id,
            name=menu_item.name,
            qty=item.qty,
            size=item.size,
            size_name=size.name if size else None,
            modifiers=item.modifiers,
            notes=item.notes,
            unit_price=round(price, 2),
            station=menu_item.station,
        )

    @staticmethod
    def _same(line: TicketLine, item: OrderItem) -> bool:
        return (line.menu_id, line.size, line.modifiers, line.notes) == (
            item.menu_id, item.size, item.modifiers, item.notes,
        )  # fmt: skip

    def _add(self, table: int, lines: list[TicketLine], items: list[OrderItem]) -> tuple[bool, str]:
        for item in items:
            match = next((ln for ln in lines if not ln.sent and self._same(ln, item)), None)
            if match:
                match.qty += item.qty
            else:
                lines.append(self._line(item))
        return True, "Added."

    def _matching_unsent(self, lines: list[TicketLine], item: OrderItem) -> list[TicketLine]:
        # Newest first: "remove the coke" means the coke just added.
        return [
            ln
            for ln in reversed(lines)
            if not ln.sent and ln.menu_id == item.menu_id and item.size in (None, ln.size)
        ]

    def _remove(
        self, table: int, lines: list[TicketLine], items: list[OrderItem]
    ) -> tuple[bool, str]:
        for item in items:
            matches = self._matching_unsent(lines, item)
            if not matches:
                sent = any(ln.menu_id == item.menu_id for ln in lines)
                name = self.menu.item(item.menu_id).name  # type: ignore[union-attr]
                return False, (f"{name} has already gone to the kitchen." if sent
                               else f"There's no {name} on table {table}.")  # fmt: skip
            left = item.qty
            for line in matches:
                take = min(left, line.qty)
                line.qty -= take
                left -= take
                if line.qty == 0:
                    lines.remove(line)
                if left == 0:
                    break
        return True, "Removed."

    def _modify(
        self, table: int, lines: list[TicketLine], items: list[OrderItem]
    ) -> tuple[bool, str]:
        for item in items:
            matches = self._matching_unsent(lines, OrderItem(menu_id=item.menu_id))
            if not matches:
                name = self.menu.item(item.menu_id).name  # type: ignore[union-attr]
                return False, f"There's no unsent {name} on table {table} to change."
            line = matches[0]
            updated = self._line(
                OrderItem(
                    menu_id=item.menu_id,
                    qty=item.qty,
                    size=item.size or line.size,
                    modifiers=item.modifiers or line.modifiers,
                    notes=item.notes or line.notes,
                )
            )
            lines[lines.index(line)] = updated.model_copy(update={"line_id": line.line_id})
        return True, "Changed."

    def _send(
        self, table: int, lines: list[TicketLine], items: list[OrderItem]
    ) -> tuple[bool, str]:
        unsent = [line for line in lines if not line.sent]
        if not unsent:
            return False, f"Nothing new to send for table {table}."
        for line in unsent:
            line.sent = True
        self.batches.append(
            KitchenBatch(
                batch_id=len(self.batches) + 1,
                table=table,
                sent_at=round(time.time() * 1000, 1),
                lines=[line.model_copy() for line in unsent],
            )
        )
        return True, f"Table {table} sent."

    def _cancel(
        self, table: int, lines: list[TicketLine], items: list[OrderItem]
    ) -> tuple[bool, str]:
        unsent = [line for line in lines if not line.sent]
        if not unsent:
            return False, "Nothing to cancel."
        lines[:] = [line for line in lines if line.sent]
        return True, "Cancelled."

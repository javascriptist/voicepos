from __future__ import annotations

from typing import Any

import pytest

from voicepos.menu import Menu
from voicepos.order import parse_order
from voicepos.tickets import TicketStore


@pytest.fixture
def store(menu: Menu) -> TicketStore:
    return TicketStore(menu)


def apply(store: TicketStore, intent: str, *items: dict[str, Any], table: int | None = 4):
    order = parse_order(
        {"table": table, "intent": intent, "items": list(items), "confidence": 1}, store.menu
    )
    return store.apply(order)


def lines(store: TicketStore, table: int = 4) -> list[tuple[str, int, bool]]:
    return [(ln.menu_id, ln.qty, ln.sent) for ln in store.ticket(table).lines]


def test_add_merges_identical_unsent_lines(store: TicketStore) -> None:
    apply(store, "add_items", {"menu_id": "cola"})
    apply(store, "add_items", {"menu_id": "cola", "qty": 2})
    apply(store, "add_items", {"menu_id": "cola", "notes": ["no ice"]})
    assert lines(store) == [("cola", 3, False), ("cola", 1, False)]


def test_prices_include_sizes_and_options(store: TicketStore) -> None:
    apply(store, "add_items", {"menu_id": "house_red_wine", "size": "bottle"},
          {"menu_id": "beef_burger", "modifiers": ["bacon", "extra cheese"]}, {"menu_id": "yorkshire_bitter", "qty": 2})  # fmt: skip
    ticket = store.ticket(4)
    assert [(ln.unit_price, ln.total) for ln in ticket.lines] == [
        (23.95, 23.95),
        (17.45, 17.45),
        (5.25, 10.5),
    ]
    assert ticket.total == 51.9
    assert ticket.lines[0].size_name == "bottle"


def test_remove_takes_newest_unsent_first(store: TicketStore) -> None:
    apply(store, "add_items", {"menu_id": "cola", "qty": 2})
    apply(store, "send_order")
    apply(store, "add_items", {"menu_id": "cola"})
    assert apply(store, "remove_item", {"menu_id": "cola"}).ok
    assert lines(store) == [("cola", 2, True)]
    result = apply(store, "remove_item", {"menu_id": "cola"})
    assert not result.ok
    assert result.message == "Cola has already gone to the kitchen."
    assert (
        apply(store, "remove_item", {"menu_id": "merlot"}).message
        == "There's no Merlot on table 4."
    )


def test_modify_changes_the_latest_unsent_line(store: TicketStore) -> None:
    apply(store, "add_items", {"menu_id": "flat_white", "modifiers": ["oat milk"]})
    assert apply(store, "modify_item", {"menu_id": "flat_white", "qty": 3}).ok
    line = store.ticket(4).lines[0]
    assert (line.qty, line.modifiers, line.unit_price) == (3, ["oat milk"], 3.8)
    assert not apply(store, "modify_item", {"menu_id": "cola", "qty": 2}).ok


def test_send_creates_a_kitchen_batch_once(store: TicketStore) -> None:
    apply(store, "add_items", {"menu_id": "fish_and_chips"}, {"menu_id": "cola"})
    assert apply(store, "send_order").message == "Table 4 sent."
    assert [(ln.menu_id, ln.station) for ln in store.batches[0].lines] == [
        ("fish_and_chips", "kitchen"),
        ("cola", "bar"),
    ]
    assert apply(store, "send_order").message == "Nothing new to send for table 4."
    assert len(store.batches) == 1


def test_cancel_drops_only_unsent(store: TicketStore) -> None:
    apply(store, "add_items", {"menu_id": "cola"})
    apply(store, "send_order")
    apply(store, "add_items", {"menu_id": "merlot"})
    assert apply(store, "cancel").ok
    assert lines(store) == [("cola", 1, True)]


@pytest.mark.parametrize(
    ("intent", "table", "message"),
    [
        ("add_items", None, "Which table?"),
        ("add_items", 99, "There's no table 99."),
        ("unknown", 4, "Sorry, say that again?"),
    ],
)
def test_rejected_orders_change_nothing(
    store: TicketStore, intent: str, table: int | None, message: str
) -> None:
    items = [{"menu_id": "cola"}] if intent == "add_items" else []
    result = apply(store, intent, *items, table=table)
    assert (result.ok, result.changed, result.message) == (False, False, message)
    assert store.open_tickets() == []

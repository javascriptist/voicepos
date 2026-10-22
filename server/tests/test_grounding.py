from __future__ import annotations

import pytest

from voicepos.grounding import ungrounded
from voicepos.menu import Menu
from voicepos.order import parse_order


def check(menu: Menu, text: str, items: list, intent: str = "add_items", table=None, current=None):
    order = parse_order({"table": table, "intent": intent, "items": items, "confidence": 0.9}, menu)
    return ungrounded(order, text, menu, current)


def item(menu_id: str, **extra) -> dict:
    return {"menu_id": menu_id, **extra}


@pytest.mark.parametrize(
    ("text", "items", "intent"),
    [
        ("two fish and chips", [item("fish_and_chips", qty=2)], "add_items"),
        ("fishing fingers for the kid", [item("mini_fish_fingers_and_chips")], "add_items"),
        ("a coke", [item("cola")], "add_items"),  # via alias
        ("large merlot", [item("merlot", size="250ml")], "add_items"),
        ("burger with bacon", [item("beef_burger", modifiers=["bacon"])], "add_items"),
        ("actually make the cokes three", [item("cola", qty=3)], "modify_item"),
        ("take the garlic bread off", [item("garlic_bread")], "remove_item"),
        ("that's it, send it through", [], "send_order"),
    ],
)
def test_grounded(menu: Menu, text: str, items: list, intent: str) -> None:
    assert check(menu, text, items, intent) is None


@pytest.mark.parametrize(
    ("text", "items", "intent", "problem"),
    [
        ("a pie", [item("beef_burger")], "add_items", "beef_burger wasn't mentioned"),
        ("a coke and a word with the manager", [item("cola", qty=3)], "add_items", "quantity 3"),
        ("a merlot", [item("merlot", size="bottle")], "add_items", "size bottle"),
        ("a burger", [item("beef_burger", modifiers=["bacon"])], "add_items", "option 'bacon'"),
        ("make that three cokes", [], "send_order", "intent send_order"),
    ],
)
def test_ungrounded(menu: Menu, text: str, items: list, intent: str, problem: str) -> None:
    assert problem in (check(menu, text, items, intent) or "")


def test_table_must_be_said_unless_current(menu: Menu) -> None:
    assert check(menu, "a coke", [item("cola")], table=7, current=7) is None
    assert "table 9" in (check(menu, "a coke", [item("cola")], table=9, current=7) or "")
    assert check(menu, "a coke for table nine", [item("cola")], table=9, current=7) is None

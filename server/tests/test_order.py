from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from voicepos.menu import Menu
from voicepos.order import Intent, Order, parse_order
from voicepos.schema import SCHEMA_PATH, order_schema_json


def order(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "table": 4,
        "items": [{"menu_id": "flat_white", "qty": 2, "modifiers": ["oat milk"]}],
        "intent": "add_items",
        "confidence": 0.92,
    }
    base.update(overrides)
    return base


def line(**fields: Any) -> dict[str, Any]:
    return order(items=[fields])


def test_valid_order(menu: Menu) -> None:
    parsed = parse_order(order(), menu)
    assert parsed.intent is Intent.ADD_ITEMS
    assert parsed.items[0].menu_id == "flat_white"
    assert parsed.items[0].qty == 2


def test_json_string_input(menu: Menu) -> None:
    assert parse_order(json.dumps(order()), menu).table == 4


def test_default_size_is_filled_in(menu: Menu) -> None:
    parsed = parse_order(line(menu_id="yorkshire_bitter"), menu)
    assert parsed.items[0].size == "pint"


def test_explicit_size_is_kept(menu: Menu) -> None:
    parsed = parse_order(line(menu_id="house_red_wine", size="bottle"), menu)
    assert parsed.items[0].size == "bottle"


def test_notes_are_kept_verbatim(menu: Menu) -> None:
    parsed = parse_order(
        line(menu_id="fish_and_chips", notes=["  Nut allergy,  tell the chef ", ""]), menu
    )
    assert parsed.items[0].notes == ["Nut allergy, tell the chef"]


def test_notes_are_limited(menu: Menu) -> None:
    with pytest.raises(ValidationError, match="at most 200 characters"):
        parse_order(line(menu_id="cola", notes=["x" * 201]), menu)
    with pytest.raises(ValidationError, match="at most 5 items"):
        parse_order(line(menu_id="cola", notes=[f"note {i}" for i in range(6)]), menu)


def test_modifiers_are_normalised(menu: Menu) -> None:
    parsed = parse_order(
        line(menu_id="beef_burger", modifiers=[" Extra  Cheese", "extra cheese", "No Onions"]), menu
    )
    assert parsed.items[0].modifiers == ["extra cheese", "no onions"]


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (line(menu_id="lasagne"), "not on the menu"),
        (line(menu_id="yorkshire_bitter", size="large"), "has no size 'large'"),
        (line(menu_id="fish_and_chips", size="large"), "does not come in sizes"),
        (
            line(menu_id="fish_and_chips", modifiers=["oat milk"]),
            "not an option for 'fish_and_chips'",
        ),
        (line(menu_id="flat_white", modifiers=["oat milk", "soy milk"]), "at most 1 milk"),
        (line(menu_id="cola", qty=0), "greater than or equal to 1"),
        (line(menu_id="cola", qty=752), "less than or equal to 30"),
        (order(items=[]), "needs at least one item"),
        (order(intent="remove_item", items=[]), "needs at least one item"),
        (order(intent="set_table", table=None, items=[]), "needs a table"),
        (order(intent="buy_everything"), "Input should be"),
        (order(confidence=1.5), "less than or equal to 1"),
        (order(table=0), "greater than or equal to 1"),
        (order(notes="hi"), "Extra inputs are not permitted"),
    ],
)
def test_invalid_orders_are_rejected(menu: Menu, data: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        parse_order(data, menu)


@pytest.mark.parametrize("intent", ["send_order", "cancel", "unknown"])
def test_intents_without_items(menu: Menu, intent: str) -> None:
    assert parse_order(order(intent=intent, items=[]), menu).items == []


def test_set_table(menu: Menu) -> None:
    assert parse_order(order(intent="set_table", table=7, items=[]), menu).table == 7


def test_structure_is_checked_without_a_menu() -> None:
    # Without a menu in context only the shape is validated (used by the JSON Schema/TS side).
    assert Order.model_validate(line(menu_id="anything")).items[0].menu_id == "anything"


def test_schema_file_is_up_to_date() -> None:
    assert SCHEMA_PATH.read_text(encoding="utf-8") == order_schema_json(), (
        "data/order.schema.json is stale; run: uv run python -m voicepos.schema"
    )

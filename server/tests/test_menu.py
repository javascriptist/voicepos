from __future__ import annotations

import copy
import json

import pytest
from pydantic import ValidationError

from voicepos.menu import DEFAULT_MENU_PATH, Menu


@pytest.fixture
def raw_menu() -> dict:
    return json.loads(DEFAULT_MENU_PATH.read_text(encoding="utf-8"))


def test_menu_loads(menu: Menu) -> None:
    assert len(menu.items) == 80
    assert menu.currency == "GBP"


def test_lookup_by_id(menu: Menu) -> None:
    item = menu.item("fish_and_chips")
    assert item is not None
    assert item.name == "Fish & Chips"
    assert item.station == "kitchen"
    assert menu.item("lasagne") is None


def test_sized_items_have_a_default(menu: Menu) -> None:
    bitter = menu.item("yorkshire_bitter")
    assert bitter is not None
    assert bitter.price is None
    assert bitter.default_size == "pint"
    assert [s.id for s in bitter.sizes] == ["half", "pint", "two_pints"]


def test_modifier_groups_resolve(menu: Menu) -> None:
    burger = menu.item("beef_burger")
    assert burger is not None
    assert [g.id for g in menu.groups_for(burger)] == ["sauce", "burger_extras", "burger_remove"]


def _mutated(raw: dict, change) -> dict:
    data = copy.deepcopy(raw)
    change(data)
    return data


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda m: m["items"].append(copy.deepcopy(m["items"][0])), "duplicate item ids"),
        (lambda m: m["items"][0].update(category="tapas"), "unknown category"),
        (lambda m: m["items"][0].update(modifier_groups=["gravy_boat"]), "unknown modifier groups"),
        (lambda m: m["items"][0].update(price=None), "has no price"),
        (
            lambda m: m["items"][1].update(aliases=m["items"][0]["aliases"] + ["full english"]),
            "alias",
        ),
        (lambda m: m["items"][0].update(id="Fish Chips!"), "should match pattern"),
        (lambda m: m["modifier_groups"][0].update(default="goat milk"), "is not an option"),
    ],
)
def test_broken_menus_are_rejected(raw_menu: dict, change, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        Menu.model_validate(_mutated(raw_menu, change))


def test_sized_item_cannot_also_have_a_price(raw_menu: dict) -> None:
    def change(m: dict) -> None:
        sized = next(i for i in m["items"] if i.get("sizes"))
        sized["price"] = 5.0

    with pytest.raises(ValidationError, match="both a price and sizes"):
        Menu.model_validate(_mutated(raw_menu, change))

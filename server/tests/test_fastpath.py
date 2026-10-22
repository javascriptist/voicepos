from __future__ import annotations

from typing import Any

import pytest

from voicepos.fastpath import FastPath, normalise, split_segments
from voicepos.menu import Menu


@pytest.fixture(scope="module")
def fast(menu: Menu) -> FastPath:
    return FastPath(menu)


def compact(fast: FastPath, text: str, table: int | None = None) -> dict[str, Any] | str:
    result = fast.parse(text, current_table=table)
    if result.order is None:
        return f"LLM: {result.reason}"
    return result.order.model_dump(mode="json", exclude_defaults=True, exclude={"confidence"})


def add(*items: dict[str, Any], table: int | None = None) -> dict[str, Any]:
    order: dict[str, Any] = {"items": list(items), "intent": "add_items"}
    if table is not None:
        order = {"table": table, **order}
    return order


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # The CLAUDE.md example, spoken
        ("Table 4, two flat whites with oat milk",
         add({"menu_id": "flat_white", "qty": 2, "modifiers": ["oat milk"]}, table=4)),
        # From a real floor transcript: "to" heard for "two", misheard fish fingers
        ("table 7 to fish and chips", add({"menu_id": "fish_and_chips", "qty": 2}, table=7)),
        ("fishing fingers", add({"menu_id": "mini_fish_fingers_and_chips"})),
        # Aliases and plurals
        ("two cokes", add({"menu_id": "cola", "qty": 2})),
        ("cheeseburger", add({"menu_id": "beef_burger"})),
        ("sticky toffee", add({"menu_id": "sticky_toffee_pudding"})),
        # Standard dish beats variants when the waiter doesn't say "kids"
        ("fish and chips", add({"menu_id": "fish_and_chips"})),
        ("kids fish and chips", add({"menu_id": "kids_fish_and_chips"})),
        # Sizes: default pint / 175ml, spoken sizes
        ("a pint of bitter and a half of lager",
         add({"menu_id": "yorkshire_bitter", "size": "pint"},
             {"menu_id": "copper_house_lager", "size": "half"})),
        ("bitter", add({"menu_id": "yorkshire_bitter", "size": "pint"})),
        ("large glass of red", add({"menu_id": "house_red_wine", "size": "250ml"})),
        ("bottle of house white", add({"menu_id": "house_white_wine", "size": "bottle"})),
        ("glass of red", add({"menu_id": "house_red_wine", "size": "175ml"})),
        # Several items, split on commas, "and", or a new quantity
        ("two cokes three lagers",
         add({"menu_id": "cola", "qty": 2}, {"menu_id": "copper_house_lager", "qty": 3, "size": "pint"})),
        ("um two cokes, a fish and chips, no vinegar",
         add({"menu_id": "cola", "qty": 2}, {"menu_id": "fish_and_chips", "notes": ["no vinegar"]})),
        # Modifiers (menu options) vs notes (free text for the kitchen)
        ("beef burger no onions extra cheese",
         add({"menu_id": "beef_burger", "modifiers": ["extra cheese", "no onions"]})),
        ("full english poached eggs", add({"menu_id": "full_english_breakfast", "modifiers": ["poached eggs"]})),
        ("chips with curry sauce", add({"menu_id": "skin_on_chips", "modifiers": ["curry sauce"]})),
        ("flat white no milk", add({"menu_id": "flat_white", "modifiers": ["no milk"]})),
        ("Fish and chips, no vinegar, he's got a nut allergy.",
         add({"menu_id": "fish_and_chips", "notes": ["no vinegar", "hes got a nut allergy"]})),
        ("a burger, she's allergic to sesame",
         add({"menu_id": "beef_burger", "notes": ["shes allergic to sesame"]})),
        ("fish and chips no vinegar, nut allergy tell the chef",
         add({"menu_id": "fish_and_chips", "notes": ["no vinegar", "nut allergy tell the chef"]})),
        # A note never swallows the next item (seen live: the merlot vanished into the note)
        ("table 12 fish and chips no vinegar, nut allergy tell the chef, a large merlot",
         add({"menu_id": "fish_and_chips", "notes": ["no vinegar", "nut allergy tell the chef"]},
             {"menu_id": "merlot", "size": "250ml"}, table=12)),
        ("a burger, she's allergic to sesame and a coke",
         add({"menu_id": "beef_burger", "notes": ["shes allergic to sesame"]}, {"menu_id": "cola"})),
        # Polite / hesitant phrasing
        ("uh can I get a coke please", add({"menu_id": "cola"})),
        ("could we have 2 x cola", add({"menu_id": "cola", "qty": 2})),
        # Other intents
        ("send it", {"intent": "send_order"}),
        ("yeah send it to the kitchen", {"intent": "send_order"}),
        ("send table 5", {"table": 5, "intent": "send_order"}),
        ("table nine", {"table": 9, "intent": "set_table"}),
        ("cancel", {"intent": "cancel"}),
        ("scratch that", {"intent": "cancel"}),
        ("remove the coke", {"items": [{"menu_id": "cola"}], "intent": "remove_item"}),
        # One intent per utterance: items are added, "send it" is left for the waiter to repeat
        ("two fish and chips and send it", add({"menu_id": "fish_and_chips", "qty": 2})),
        ("a coke, then fire it", add({"menu_id": "cola"})),
    ],
)  # fmt: skip
def test_fast_path_parses(fast: FastPath, text: str, expected: dict[str, Any]) -> None:
    assert compact(fast, text) == expected


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("752 fish and chips", "quantity 752 out of range"),  # misheard number
        ("a pie", "ambiguous"),  # four pies: ask, don't guess
        ("steak", "ambiguous"),
        ("make that three", "modification needs context"),
        ("lasagne", "no menu item named"),
        ("a coke and a quick word with the manager", "no menu item named"),
        ("fish and chips large", "has no sizes"),
        ("", "empty utterance"),
    ],
)
def test_fast_path_defers_to_llm(fast: FastPath, text: str, reason: str) -> None:
    result = fast.parse(text)
    assert result.order is None
    assert reason in result.reason


def test_current_table_is_used_when_none_is_said(fast: FastPath) -> None:
    assert compact(fast, "two cokes", table=3) == add({"menu_id": "cola", "qty": 2}, table=3)
    assert compact(fast, "table 8 two cokes", table=3)["table"] == 8  # type: ignore[index]


def test_confidence_reflects_match_quality(fast: FastPath) -> None:
    exact = fast.parse("fish and chips")
    partial = fast.parse("large glass of red")
    assert exact.order is not None and partial.order is not None
    assert exact.confidence == 1.0
    assert 0.8 <= partial.confidence < 1.0


def test_normalise() -> None:
    assert normalise("Fish & Chips, 2 x Coke!") == "fish and chips, 2 x coke"
    assert normalise("a 250 ML glass of Shepherd's") == "a 250ml glass of shepherds"


def test_split_segments() -> None:
    assert split_segments("two cokes, a burger and three lagers") == [
        "two cokes", "a burger", "three lagers",
    ]  # fmt: skip

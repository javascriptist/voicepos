from __future__ import annotations

import os

import pytest
from fakes import ScriptedGenerator

from voicepos.llm import (
    LLMParser,
    build_system_prompt,
    coerce_shape,
    extract_json,
    json_complete,
    user_message,
)
from voicepos.menu import Menu
from voicepos.order import Intent

FISH = {"menu_id": "fish_and_chips", "qty": 2, "size": None, "modifiers": [], "notes": []}


def reply(intent: str = "add_items", items: list | None = None, table: int | None = None) -> dict:
    return {"table": table, "intent": intent, "items": [FISH] if items is None else items}


def test_valid_reply(menu: Menu) -> None:
    gen = ScriptedGenerator(reply())
    result = LLMParser(menu, gen).parse("two fish and chips", current_table=5)
    assert result.valid
    assert result.order.table == 5  # current table filled in
    assert result.order.items[0].menu_id == "fish_and_chips"
    assert 0.9 < result.order.confidence <= 1.0  # from token log-probs, not the model's say-so
    assert len(result.attempts) == 1


def test_retry_once_with_the_error(menu: Menu) -> None:
    lasagne = {**FISH, "menu_id": "lasagne"}
    gen = ScriptedGenerator(reply(items=[lasagne]), reply())
    result = LLMParser(menu, gen).parse("two fish and chips")
    assert result.valid
    assert len(result.attempts) == 2
    assert "not on the menu" in gen.prompts[1]


def test_gives_up_as_unknown_after_two_bad_replies(menu: Menu) -> None:
    gen = ScriptedGenerator("sorry, I can't", "{not json")
    result = LLMParser(menu, gen).parse("two fish and chips", current_table=2)
    assert not result.valid
    assert result.order.intent is Intent.UNKNOWN
    assert result.order.table == 2
    assert result.order.confidence == 0.0


def test_ungrounded_reply_is_rejected(menu: Menu) -> None:
    # Valid JSON, valid menu item, but the waiter said "a pie": never put that on screen.
    burger = {**FISH, "menu_id": "beef_burger", "qty": 1, "modifiers": ["bacon"]}
    gen = ScriptedGenerator(reply(items=[burger]), reply(items=[burger]))
    result = LLMParser(menu, gen).parse("a pie")
    assert result.order.intent is Intent.UNKNOWN
    assert "beef_burger wasn't mentioned" in result.error


def test_formatting_slips_are_repaired(menu: Menu) -> None:
    sloppy = '{"table": null, "intent": "add_items", "items": [{"menu_id": "fish_and_chips", "qty": 2, "size": null, "modifiers": "", "notes": "no vinegar"}]]}'
    result = LLMParser(menu, ScriptedGenerator(sloppy)).parse("two fish and chips no vinegar")
    assert result.valid
    assert result.order.items[0].notes == ["no vinegar"]


def test_extract_json_ignores_prose_and_repairs_brackets() -> None:
    assert extract_json('Sure! {"a": [1]}] trailing') == {"a": [1]}
    assert extract_json('{"a": [{"b": 1}]]}') == {"a": [{"b": 1}]}
    with pytest.raises(ValueError, match="no JSON"):
        extract_json("nothing here")


def test_unknown_carries_no_items() -> None:
    assert coerce_shape({"intent": "unknown", "items": [{"menu_id": "lasagne"}]})["items"] == []


def test_json_complete_ignores_braces_in_strings() -> None:
    assert not json_complete('{"notes": ["a } b"]')
    assert json_complete('{"notes": ["a } b"]} extra')


def test_prompt_is_stable_and_complete(menu: Menu) -> None:
    prompt = build_system_prompt(menu)
    assert prompt == build_system_prompt(menu)  # cached prefix must not change between calls
    assert all(item.id in prompt for item in menu.items)
    assert (
        "yorkshire_bitter: Yorkshire Bitter | (also: bitter) | sizes: half, pint*, two_pints"
        in prompt
    )


def test_user_message_carries_context() -> None:
    message = user_message("make that three", 4, ["2x cola"])
    assert message == "Current table: 4\nAlready ordered: 2x cola\nWaiter: make that three"


@pytest.mark.skipif(
    not os.environ.get("VOICEPOS_RUN_LLM"), reason="set VOICEPOS_RUN_LLM=1 to load the real model"
)
def test_real_model_contract(menu: Menu) -> None:
    """Properties that must hold whatever the model's accuracy (accuracy is measured in /eval)."""
    parser = LLMParser.load(menu)
    first = parser.parse("can I get a large glass of merlot for table 6", current_table=2)
    second = parser.parse("can I get a large glass of merlot for table 6", current_table=2)
    assert first.order == second.order  # greedy decoding: same input, same output
    assert first.order.table in (2, 6)
    assert len(first.attempts) <= 2
    assert all(a.ms < 2000 for a in first.attempts)  # cached system prefix keeps calls short

from __future__ import annotations

from fakes import ScriptedGenerator

from voicepos.llm import LLMParser
from voicepos.menu import Menu
from voicepos.order import Intent
from voicepos.pipeline import Pipeline


def test_fast_path_first_no_llm_call(menu: Menu) -> None:
    gen = ScriptedGenerator()
    result = Pipeline(menu, LLMParser(menu, gen)).parse("two cokes", current_table=3)
    assert result.path == "fast_path"
    assert result.order.table == 3
    assert gen.prompts == []


def test_llm_when_fast_path_declines(menu: Menu) -> None:
    modify = {"table": None, "intent": "modify_item", "items": [{"menu_id": "cola", "qty": 3}]}
    gen = ScriptedGenerator(modify)
    result = Pipeline(menu, LLMParser(menu, gen)).parse(
        "make that three cokes", current_table=3, previous=["2x cola"]
    )
    assert result.path == "llm"
    assert result.fast_path_reason == "modification needs context"
    assert result.order.intent is Intent.MODIFY_ITEM
    assert "Already ordered: 2x cola" in gen.prompts[0]


def test_without_llm_returns_unknown(menu: Menu) -> None:
    result = Pipeline(menu).parse("a pie", current_table=1)
    assert result.path == "none"
    assert result.order.intent is Intent.UNKNOWN
    assert "ambiguous" in result.fast_path_reason


def test_send_in_same_utterance_is_flagged(menu: Menu) -> None:
    result = Pipeline(menu).parse("two fish and chips and send it")
    assert result.order.intent is Intent.ADD_ITEMS
    assert result.send_ignored
    assert not Pipeline(menu).parse("two fish and chips").send_ignored
    assert not Pipeline(menu).parse("send it").send_ignored

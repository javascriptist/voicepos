"""Text in, validated order out: fast path first, LLM only when it fails (CLAUDE.md)."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Literal

from .fastpath import FastPath, normalise
from .llm import LLMParser
from .menu import Menu
from .order import Intent, Order

# Fast-path matches below this confidence go to the LLM instead.
FAST_PATH_MIN_CONFIDENCE = 0.8

Path = Literal["fast_path", "llm", "none"]

SEND_WORDS = re.compile(r"\b(?:send|fire)\b")


@dataclass
class ParseResult:
    order: Order
    path: Path
    parse_ms: float
    fast_path_reason: str = ""  # why the fast path declined, for the evaluation
    llm_attempts: int = 0
    llm_error: str = ""
    # Items were added but "send it" in the same utterance was not acted on (one intent per
    # utterance); the confirmation should prompt the waiter to say "send" on its own.
    send_ignored: bool = False


class Pipeline:
    def __init__(self, menu: Menu, llm: LLMParser | None = None) -> None:
        self.menu = menu
        self.fast = FastPath(menu)
        self.llm = llm

    def parse(
        self,
        text: str,
        current_table: int | None = None,
        previous: list[str] | None = None,
    ) -> ParseResult:
        start = time.perf_counter()
        result = self._parse(text, current_table, previous, start)
        result.send_ignored = result.order.intent == Intent.ADD_ITEMS and bool(
            SEND_WORDS.search(normalise(text))
        )
        return result

    def _parse(
        self, text: str, current_table: int | None, previous: list[str] | None, start: float
    ) -> ParseResult:
        fast = self.fast.parse(text, current_table=current_table)
        if fast.order is not None and fast.confidence >= FAST_PATH_MIN_CONFIDENCE:
            return ParseResult(fast.order, "fast_path", _ms(start))
        reason = fast.reason or f"low confidence {fast.confidence:.2f}"

        if self.llm is None:
            unknown = Order(table=current_table, intent=Intent.UNKNOWN, confidence=0.0)
            return ParseResult(unknown, "none", _ms(start), fast_path_reason=reason)

        result = self.llm.parse(text, current_table=current_table, previous=previous)
        return ParseResult(
            result.order,
            "llm",
            _ms(start),
            fast_path_reason=reason,
            llm_attempts=len(result.attempts),
            llm_error=result.error,
        )


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 2)

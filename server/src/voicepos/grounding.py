"""Grounding check for LLM output: everything in the order must be supported by the words the
waiter actually said.

A small model can return a perfectly valid order for the wrong thing ("a pie" -> chicken burger
with bacon) and be confident about it, so validity and token probabilities aren't enough. Each
item, option, size, quantity, table and intent must be traceable to the transcript; otherwise the
order is rejected.
"""

from __future__ import annotations

import re

from .fastpath import NUMBER_WORDS, normalise, stem, tokens_match
from .menu import Menu
from .order import Intent, Order

# Too common in names to show that a specific dish was meant on their own.
WEAK_TOKENS = {"and", "with", "of", "the", "a", "an", "on", "in", "chip", "no", "extra", "side"}

INTENT_CUES = {
    Intent.SEND_ORDER: r"\b(?:send|sent|fire|kitchen|through)\b",
    Intent.CANCEL: r"\b(?:cancel|scratch|scrap|forget|never ?mind|start (?:again|over))\b",
    Intent.REMOVE_ITEM: r"\b(?:remove|take|off|delete|drop|scratch|cancel|without)\b",
    Intent.MODIFY_ITEM: r"\b(?:make|change|instead|actually|swap|switch|should be|wait)\b",
}
SIZE_CUES = {
    "half": r"\bhalf\b",
    "two_pints": r"\b(?:two|2) pints\b",
    "250ml": r"\b(?:large|250ml|250)\b",
    "175ml": r"\b(?:small|175ml|175)\b",
    "bottle": r"\bbottles?\b",
}
QTY_CUES = r"\b(?:\d+|" + "|".join(NUMBER_WORDS) + r"|couple|pair|to|too|for|both|all)\b"


def _said(tokens: list[str], phrase: str) -> bool:
    """True if a distinctive word of `phrase` was said (allowing for mishearing)."""
    wanted = [stem(t) for t in normalise(phrase).replace(",", " ").split()]
    wanted = [t for t in wanted if t not in WEAK_TOKENS] or wanted
    return any(tokens_match(w, t) is not None for w in wanted for t in tokens)


def ungrounded(order: Order, text: str, menu: Menu, current_table: int | None) -> str | None:
    """Why `order` isn't supported by `text`, or None if it is."""
    said = normalise(text)
    tokens = [stem(t) for t in said.replace(",", " ").split()]

    cue = INTENT_CUES.get(order.intent)
    if cue and not re.search(cue, said):
        return f"intent {order.intent.value} but the waiter didn't ask for that"
    table_changed = order.table is not None and order.table != current_table
    if table_changed and str(order.table) not in said.split() and "table" not in said.split():
        return f"table {order.table} wasn't said"

    for line in order.items:
        item = menu.item(line.menu_id)
        assert item is not None  # parse_order already checked
        if not any(_said(tokens, phrase) for phrase in [item.name, *item.aliases]):
            return f"{line.menu_id} wasn't mentioned"
        if line.qty > 1 and not re.search(QTY_CUES, said):
            return f"quantity {line.qty} for {line.menu_id} wasn't said"
        if line.size and line.size != item.default_size:
            size_cue = SIZE_CUES.get(line.size)
            if size_cue and not re.search(size_cue, said):
                return f"size {line.size} for {line.menu_id} wasn't said"
        for modifier in line.modifiers:
            if not _said(tokens, modifier):
                return f"option {modifier!r} for {line.menu_id} wasn't said"
    return None

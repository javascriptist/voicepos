"""The order JSON contract (see CLAUDE.md). Every voice path must produce an `Order` that passes
`parse_order` before it reaches the POS.

Validation against the menu runs when a `Menu` is passed in the validation context. It rejects
invented `menu_id`s, unknown sizes and modifiers, and fills in the default size so the POS
always receives a complete line.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

from .menu import Menu

# Larger quantities are almost always misheard numbers ("752 fish and chips").
MAX_QTY = 30
MAX_NOTES = 5
MAX_NOTE_LENGTH = 200


class Intent(StrEnum):
    ADD_ITEMS = "add_items"
    REMOVE_ITEM = "remove_item"
    MODIFY_ITEM = "modify_item"
    SET_TABLE = "set_table"
    SEND_ORDER = "send_order"
    CANCEL = "cancel"
    UNKNOWN = "unknown"


ITEM_INTENTS = {Intent.ADD_ITEMS, Intent.REMOVE_ITEM, Intent.MODIFY_ITEM}


class OrderItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    menu_id: str
    qty: int = Field(default=1, ge=1, le=MAX_QTY)
    size: str | None = None
    modifiers: list[str] = Field(default_factory=list)
    # Free text for the kitchen that isn't a menu option, e.g. "nut allergy, tell the chef".
    # Kept word for word; never interpreted as a guarantee that a dish is allergen-safe.
    notes: list[str] = Field(default_factory=list, max_length=MAX_NOTES)

    @field_validator("notes")
    @classmethod
    def _clean_notes(cls, value: list[str]) -> list[str]:
        cleaned = [" ".join(n.split()) for n in value]
        for note in cleaned:
            if len(note) > MAX_NOTE_LENGTH:
                raise ValueError(f"notes must be at most {MAX_NOTE_LENGTH} characters")
        return list(dict.fromkeys(n for n in cleaned if n))

    @field_validator("modifiers")
    @classmethod
    def _normalise_modifiers(cls, value: list[str]) -> list[str]:
        # "Oat Milk " and "oat milk" are the same choice; keep first-mention order, drop repeats.
        cleaned = [" ".join(m.lower().split()) for m in value]
        return list(dict.fromkeys(m for m in cleaned if m))


class Order(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table: int | None = Field(default=None, ge=1)
    items: list[OrderItem] = Field(default_factory=list)
    intent: Intent
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _check_intent(self) -> Order:
        if self.intent in ITEM_INTENTS and not self.items:
            raise ValueError(f"intent {self.intent.value!r} needs at least one item")
        if self.intent == Intent.SET_TABLE and self.table is None:
            raise ValueError("intent 'set_table' needs a table")
        return self

    @model_validator(mode="after")
    def _check_against_menu(self, info: ValidationInfo) -> Order:
        menu: Menu | None = (info.context or {}).get("menu")
        if menu is None:
            return self
        for line in self.items:
            item = menu.item(line.menu_id)
            if item is None:
                raise ValueError(f"menu_id {line.menu_id!r} is not on the menu")

            if item.sizes:
                if line.size is None:
                    line.size = item.default_size
                elif item.size(line.size) is None:
                    allowed = [s.id for s in item.sizes]
                    raise ValueError(f"{item.id!r} has no size {line.size!r} (sizes: {allowed})")
            elif line.size is not None:
                raise ValueError(f"{item.id!r} does not come in sizes")

            groups = menu.groups_for(item)
            per_group: dict[str, int] = {}
            for modifier in line.modifiers:
                group = next((g for g in groups if g.option(modifier)), None)
                if group is None:
                    raise ValueError(f"{modifier!r} is not an option for {item.id!r}")
                per_group[group.id] = per_group.get(group.id, 0) + 1
                if per_group[group.id] > group.max:
                    raise ValueError(f"{item.id!r} allows at most {group.max} {group.name.lower()}")
        return self


def parse_order(data: str | bytes | dict[str, Any], menu: Menu) -> Order:
    """Validate raw order JSON (string or dict) against the menu.

    Raises `pydantic.ValidationError` with a readable message for each problem.
    """
    context = {"menu": menu}
    if isinstance(data, (str, bytes)):
        return Order.model_validate_json(data, context=context)
    return Order.model_validate(data, context=context)

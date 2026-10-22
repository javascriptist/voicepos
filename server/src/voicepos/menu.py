"""The menu: the single source of truth for what can be ordered.

`data/menu.json` is loaded once and validated on load, so a broken menu fails at server start
rather than mid-service.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MENU_PATH = REPO_ROOT / "data" / "menu.json"

Slug = Field(pattern=r"^[a-z0-9_]+$")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Category(_Strict):
    id: str = Slug
    name: str


class ModifierOption(_Strict):
    name: str
    price: float = Field(ge=0)


class ModifierGroup(_Strict):
    id: str = Slug
    name: str
    max: int = Field(ge=1)
    default: str | None = None
    options: list[ModifierOption] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_options(self) -> ModifierGroup:
        names = [o.name for o in self.options]
        if len(names) != len(set(names)):
            raise ValueError(f"modifier group {self.id!r} has duplicate options")
        if self.default is not None and self.default not in names:
            raise ValueError(
                f"modifier group {self.id!r} default {self.default!r} is not an option"
            )
        return self

    def option(self, name: str) -> ModifierOption | None:
        return next((o for o in self.options if o.name == name), None)


class Size(_Strict):
    id: str
    name: str
    price: float = Field(ge=0)


class MenuItem(_Strict):
    id: str = Slug
    name: str
    category: str
    station: Literal["kitchen", "bar"]
    price: float | None = Field(default=None, ge=0)
    default_size: str | None = None
    sizes: list[Size] = Field(default_factory=list)
    aliases: list[str] = Field(default_factory=list)
    modifier_groups: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_pricing(self) -> MenuItem:
        # An item is priced either once, or per size with a default size.
        if self.sizes:
            if self.price is not None:
                raise ValueError(f"item {self.id!r} has both a price and sizes")
            if self.default_size not in {s.id for s in self.sizes}:
                raise ValueError(
                    f"item {self.id!r} default_size {self.default_size!r} is not a size"
                )
        elif self.price is None:
            raise ValueError(f"item {self.id!r} has no price")
        elif self.default_size is not None:
            raise ValueError(f"item {self.id!r} has default_size but no sizes")
        return self

    def size(self, size_id: str) -> Size | None:
        return next((s for s in self.sizes if s.id == size_id), None)


class Menu(_Strict):
    version: int
    currency: str
    venue: str
    categories: list[Category]
    modifier_groups: list[ModifierGroup]
    items: list[MenuItem]

    # Lookups built once at load; the parser resolves items on every request.
    _items_by_id: dict[str, MenuItem] = PrivateAttr(default_factory=dict)
    _groups_by_id: dict[str, ModifierGroup] = PrivateAttr(default_factory=dict)

    def model_post_init(self, __context: object) -> None:
        self._items_by_id = {i.id: i for i in self.items}
        self._groups_by_id = {g.id: g for g in self.modifier_groups}

    @model_validator(mode="after")
    def _check_references(self) -> Menu:
        for kind, ids in (
            ("category", [c.id for c in self.categories]),
            ("modifier group", [g.id for g in self.modifier_groups]),
            ("item", [i.id for i in self.items]),
        ):
            dupes = {i for i in ids if ids.count(i) > 1}
            if dupes:
                raise ValueError(f"duplicate {kind} ids: {sorted(dupes)}")

        categories = {c.id for c in self.categories}
        groups = {g.id for g in self.modifier_groups}
        spoken: dict[str, str] = {}
        for item in self.items:
            if item.category not in categories:
                raise ValueError(f"item {item.id!r} has unknown category {item.category!r}")
            unknown = set(item.modifier_groups) - groups
            if unknown:
                raise ValueError(f"item {item.id!r} has unknown modifier groups {sorted(unknown)}")
            # A spoken name may point at one item only, or the fast path can't resolve it.
            for phrase in [item.name.lower(), *item.aliases]:
                owner = spoken.setdefault(phrase, item.id)
                if owner != item.id:
                    raise ValueError(f"alias {phrase!r} used by both {owner!r} and {item.id!r}")
        return self

    def item(self, menu_id: str) -> MenuItem | None:
        return self._items_by_id.get(menu_id)

    def groups_for(self, item: MenuItem) -> list[ModifierGroup]:
        return [self._groups_by_id[g] for g in item.modifier_groups]


def load_menu(path: str | Path | None = None) -> Menu:
    """Load and validate the menu. `VOICEPOS_MENU` overrides the default path."""
    menu_path = Path(path or os.environ.get("VOICEPOS_MENU") or DEFAULT_MENU_PATH)
    return Menu.model_validate(json.loads(menu_path.read_text(encoding="utf-8")))

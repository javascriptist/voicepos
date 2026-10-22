"""LLM fallback: turns an utterance the fast path couldn't handle into order JSON.

The system prompt (rules, the whole menu and examples) is fixed, so its KV cache is computed
once at start-up and reused for every request; only the short user turn is processed per call.
Output is validated with `parse_order`; invalid output is retried once with the error, then
reported as intent "unknown".
"""

from __future__ import annotations

import copy
import json
import math
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import ValidationError

from .grounding import ungrounded
from .menu import Menu
from .order import Intent, Order, parse_order

DEFAULT_MODEL = "mlx-community/LFM2.5-1.2B-Instruct-4bit"
MAX_NEW_TOKENS = 200

RULES = """You turn a waiter's spoken words into order JSON for a pub POS.
Reply with exactly one JSON object and nothing else.

Format:
{"table": <int or null>, "intent": "<intent>", "items": [{"menu_id": "<id>", "qty": <int>, "size": <size id or null>, "modifiers": [<option>], "notes": [<text>]}]}

Intents: add_items, remove_item, modify_item, set_table, send_order, cancel, unknown.

Rules:
- menu_id must be an item id from the menu below. Never invent one, and never use a modifier
  group as an item. If the item isn't on the menu, or several items could match ("a sandwich"),
  reply with intent "unknown" and an empty items list.
- qty is 1 unless a number is said. Speech recognition writes "two" as "to" or "too" and "four"
  as "for".
- size only for items that have sizes. Use null for the default size (marked with *).
- modifiers only from the options of that item's groups, spelled exactly as listed.
- modifiers and notes are lists. Leave them empty unless the waiter said something.
- notes: anything else for the kitchen, word for word (allergies, "no vinegar").
- If the waiter orders items and also says to send, use add_items for the items.
- table: the number if a table is said, otherwise null.
- "take off" / "remove": remove_item. "make that three" / "change": modify_item with the item as
  it should be now. "send it" / "fire": send_order with no items. "cancel": cancel."""  # noqa: E501


def _line(menu_id: str, qty: int = 1, size: str | None = None, modifiers=(), notes=()) -> dict:
    return {
        "menu_id": menu_id,
        "qty": qty,
        "size": size,
        "modifiers": list(modifiers),
        "notes": list(notes),
    }


# Varied on purpose: a 1.2B model copies whatever the examples repeat.
# ruff: noqa: E501 (example table reads better one case per line)
EXAMPLES = [
    ("table 4 two flat whites with oat milk",
     {"table": 4, "intent": "add_items", "items": [_line("flat_white", 2, modifiers=["oat milk"])]}),
    ("uh lemme get a chicken burger with bacon and a large glass of merlot",
     {"table": None, "intent": "add_items", "items": [
         _line("chicken_burger", modifiers=["bacon"]), _line("merlot", size="250ml")]}),
    ("three scampi, one no tartare, he's got a shellfish allergy, tell the chef",
     {"table": None, "intent": "add_items", "items": [
         _line("scampi_and_chips", 3, notes=["one no tartare", "shellfish allergy, tell the chef"])]}),
    ("half of porter for table twelve",
     {"table": 12, "intent": "add_items", "items": [_line("london_porter", size="half")]}),
    ("actually make the lemonades two", {"table": None, "intent": "modify_item",
     "items": [_line("homemade_lemonade", 2)]}),
    ("take the garlic bread off", {"table": None, "intent": "remove_item",
     "items": [_line("garlic_bread")]}),
    ("a sandwich", {"table": None, "intent": "unknown", "items": []}),
    ("do you do lasagne", {"table": None, "intent": "unknown", "items": []}),
    ("that's everything, send it through", {"table": None, "intent": "send_order", "items": []}),
]  # fmt: skip


def build_system_prompt(menu: Menu) -> str:
    """Deterministic for a given menu, so the cached prefix stays valid."""
    groups = "\n".join(
        f"{g.id}: {', '.join(o.name for o in g.options)}" for g in menu.modifier_groups
    )
    lines = []
    for item in menu.items:
        parts = [f"{item.id}: {item.name}"]
        if item.aliases:
            parts.append(f"(also: {', '.join(item.aliases)})")
        if item.sizes:
            sizes = ", ".join(f"{s.id}*" if s.id == item.default_size else s.id for s in item.sizes)
            parts.append(f"sizes: {sizes}")
        if item.modifier_groups:
            parts.append(f"groups: {', '.join(item.modifier_groups)}")
        lines.append(" | ".join(parts))
    examples = "\n".join(
        f"Waiter: {said}\n{json.dumps(reply, separators=(',', ':'))}" for said, reply in EXAMPLES
    )
    return (
        f"{RULES}\n\nModifier groups:\n{groups}\n\nMenu:\n" + "\n".join(lines) + "\n\n"
        f"Examples:\n{examples}"
    )


def user_message(text: str, current_table: int | None, previous: list[str] | None) -> str:
    parts = [f"Current table: {current_table if current_table is not None else 'none'}"]
    if previous:
        parts.append(f"Already ordered: {', '.join(previous)}")
    parts.append(f"Waiter: {text}")
    return "\n".join(parts)


# ---------------------------------------------------------------------------------------------


@dataclass
class Generation:
    text: str
    mean_logprob: float  # mean log-probability of the generated tokens
    tokens: int
    ms: float


class Generator(Protocol):
    def __call__(self, message: str) -> Generation: ...


def json_complete(text: str) -> bool:
    """True once the first JSON object in `text` has closed (ignoring braces inside strings)."""
    depth, in_string, escaped, started = 0, False, False, False
    for ch in text:
        if in_string:
            escaped = not escaped and ch == "\\"
            if ch == '"' and not escaped:
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
            started = True
        elif ch == "}":
            depth -= 1
            if started and depth == 0:
                return True
    return False


def extract_json(text: str) -> dict[str, Any]:
    """Parse the first JSON object, repairing stray closing brackets (a common small-model slip:
    `...}]]}`). Anything worse is left to the retry."""
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in reply")
    candidate = text[start:]
    for _ in range(3):
        try:
            obj, _ = json.JSONDecoder().raw_decode(candidate)
            break
        except json.JSONDecodeError as err:
            if err.pos < len(candidate) and candidate[err.pos] in "]}":
                candidate = candidate[: err.pos] + candidate[err.pos + 1 :]
                continue
            raise ValueError(f"invalid JSON: {err.msg}") from err
    else:
        raise ValueError("invalid JSON")
    if not isinstance(obj, dict):
        raise ValueError("reply is not a JSON object")
    return obj


def coerce_shape(data: dict[str, Any]) -> dict[str, Any]:
    """Fix formatting slips only (a string where the contract wants a list). Content mistakes,
    such as an invented menu_id or option, are left for validation to reject."""
    items = data.get("items")
    if data.get("intent") == Intent.UNKNOWN.value:
        data["items"] = []  # "unknown" carries no items, whatever the model guessed
    elif isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            for key in ("modifiers", "notes"):
                value = item.get(key)
                if isinstance(value, str):
                    item[key] = [value] if value.strip() else []
                elif value is None:
                    item[key] = []
    return data


class MLXGenerator:
    """Loads the model once and caches the system prompt's KV state."""

    def __init__(self, system_prompt: str, model_id: str = DEFAULT_MODEL) -> None:
        import mlx.core as mx
        from mlx_lm import load
        from mlx_lm.models.cache import make_prompt_cache
        from mlx_lm.sample_utils import make_sampler

        self.model_id = model_id
        self.model, self.tokenizer = load(model_id)
        self._sampler = make_sampler(temp=0.0)  # greedy: same input, same output

        system = [{"role": "system", "content": system_prompt}]
        self._system = system
        prefix = self.tokenizer.apply_chat_template(system, tokenize=False)
        self._prefix_tokens = self.tokenizer.encode(prefix)
        self._prefix_cache = make_prompt_cache(self.model)
        self.model(mx.array(self._prefix_tokens)[None], cache=self._prefix_cache)
        mx.eval([c.state for c in self._prefix_cache])

    def __call__(self, message: str) -> Generation:
        from mlx_lm import stream_generate

        start = time.perf_counter()
        chat = [*self._system, {"role": "user", "content": message}]
        full = self.tokenizer.encode(
            self.tokenizer.apply_chat_template(chat, add_generation_prompt=True, tokenize=False)
        )
        if full[: len(self._prefix_tokens)] != self._prefix_tokens:
            raise RuntimeError("chat template changed the cached system prefix")
        cache = copy.deepcopy(self._prefix_cache)

        text, logprob_sum, count = "", 0.0, 0
        for step in stream_generate(
            self.model,
            self.tokenizer,
            prompt=full[len(self._prefix_tokens) :],
            prompt_cache=cache,
            max_tokens=MAX_NEW_TOKENS,
            sampler=self._sampler,
        ):
            text += step.text
            logprob_sum += float(step.logprobs[step.token])
            count += 1
            if json_complete(text):
                break
        mean = logprob_sum / count if count else -math.inf
        return Generation(text, mean, count, (time.perf_counter() - start) * 1000)


# ---------------------------------------------------------------------------------------------


@dataclass
class LLMResult:
    order: Order
    attempts: list[Generation] = field(default_factory=list)
    error: str = ""

    @property
    def valid(self) -> bool:
        return not self.error


class LLMParser:
    def __init__(self, menu: Menu, generator: Generator) -> None:
        self.menu = menu
        self.generate = generator

    @classmethod
    def load(cls, menu: Menu, model_id: str = DEFAULT_MODEL) -> LLMParser:
        return cls(menu, MLXGenerator(build_system_prompt(menu), model_id))

    def parse(
        self,
        text: str,
        current_table: int | None = None,
        previous: list[str] | None = None,
    ) -> LLMResult:
        message = user_message(text, current_table, previous)
        attempts: list[Generation] = []
        error = ""
        for _ in range(2):  # one retry, told what was wrong
            prompt = message if not error else (
                f"{message}\nYour previous reply was invalid: {error}\n"
                "Reply with the corrected JSON object only."
            )  # fmt: skip
            generation = self.generate(prompt)
            attempts.append(generation)
            try:
                data = coerce_shape(extract_json(generation.text))
                if data.get("table") is None:
                    data["table"] = current_table
                # Confidence comes from the model's own token probabilities, not its say-so.
                data["confidence"] = round(min(1.0, math.exp(generation.mean_logprob)), 3)
                order = parse_order(data, self.menu)
                problem = ungrounded(order, text, self.menu, current_table)
                if problem is None:
                    return LLMResult(order, attempts)
                error = problem
            except ValidationError as err:
                error = "; ".join(e["msg"] for e in err.errors())
            except (ValueError, json.JSONDecodeError) as err:
                error = str(err)
        fallback = Order(table=current_table, intent=Intent.UNKNOWN, confidence=0.0)
        return LLMResult(fallback, attempts, error)

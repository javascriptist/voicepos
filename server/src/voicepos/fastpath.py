"""Fast path: rule-based parsing of simple orders against the menu, with no LLM.

It is deliberately conservative. It returns an `Order` only when every word of the utterance is
accounted for (item, quantity, size, modifier, note, table or filler) and each item match is
unambiguous; otherwise it returns `None` with a reason, and the pipeline falls back to the LLM.
A wrong order on the screen costs more than an LLM call.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from pydantic import ValidationError
from rapidfuzz import fuzz

from .menu import Menu, MenuItem
from .order import MAX_QTY, Intent, Order, OrderItem

# ---------------------------------------------------------------------------------------------
# Text normalisation

NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
}  # fmt: skip
# Quantity words that only count at the start of an item: speech recognition writes
# "two"/"four" as "to"/"too"/"for" ("table 7 to fish and chips").
QTY_ONLY_WORDS = {"a": 1, "an": 1, "another": 1, "couple": 2, "to": 2, "too": 2, "for": 4}

NUMBER = r"(?:\d+|" + "|".join(NUMBER_WORDS) + r")"


def to_number(word: str) -> int | None:
    if word.isdigit():
        return int(word)
    return NUMBER_WORDS.get(word)


def normalise(text: str) -> str:
    """Lowercase, spell out '&', drop apostrophes and punctuation; commas stay as separators."""
    t = text.lower().replace("&", " and ").replace("’", "").replace("'", "")
    t = re.sub(r"(\d+)\s*ml\b", r"\1ml", t)
    t = re.sub(r"[^a-z0-9, ]+", " ", t)
    t = re.sub(r"\s*,\s*", ", ", t)
    return re.sub(r"\s+", " ", t).strip(" ,")


def stem(token: str) -> str:
    """Light stemming used on both sides of every comparison ("fingers" -> "finger",
    "fishing" -> "fish"; recognisers often add endings)."""
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        token = token[:-1]
    if len(token) > 5 and token.endswith("ing"):
        token = token[:-3]
    return token


STOPWORDS = {"and", "with", "of", "the", "a", "an", "on", "in"}


def sig_tokens(words: list[str]) -> list[str]:
    return [stem(w) for w in words if w not in STOPWORDS]


# ---------------------------------------------------------------------------------------------
# Menu index

# Words that mark a variant of a dish; when the waiter doesn't say them, the standard dish wins
# ("fish and chips" -> adult, not kids).
VARIANT_WORDS = {"kid", "mini", "double", "decaf", "vegetarian"}


@dataclass(frozen=True)
class Phrase:
    item: MenuItem
    tokens: tuple[str, ...]
    is_alias: bool


@dataclass(frozen=True)
class OptionKey:
    option: str
    tokens: tuple[str, ...]


GENERIC_OPTION_WORDS = {"milk", "sauce", "egg", "pea", "extra"}
# A shorthand made only of these would match any "no ..." ("no peas" -> "no" -> "no vinegar").
WEAK_OPTION_WORDS = {"no", "without", "extra", "with"}


class MenuIndex:
    """Precomputed spoken forms of every item and modifier option. Built once per menu."""

    def __init__(self, menu: Menu) -> None:
        self.menu = menu
        self.phrases: list[Phrase] = []
        for item in menu.items:
            for text, is_alias in [(item.name, False), *((a, True) for a in item.aliases)]:
                tokens = tuple(sig_tokens(normalise(text).replace(",", " ").split()))
                if tokens:
                    self.phrases.append(Phrase(item, tokens, is_alias))
        self.option_keys: dict[str, list[OptionKey]] = {}
        for item in menu.items:
            keys: list[OptionKey] = []
            for group in menu.groups_for(item):
                for option in group.options:
                    full = tuple(sig_tokens(option.name.split()))
                    keys.append(OptionKey(option.name, full))
                    short = tuple(t for t in full if t not in GENERIC_OPTION_WORDS)
                    if short and short != full and not set(short) <= WEAK_OPTION_WORDS:
                        keys.append(OptionKey(option.name, short))
            # Longest keys first so "no onion" wins over "onion".
            keys.sort(key=lambda k: -len(k.tokens))
            self.option_keys[item.id] = keys


def tokens_match(a: str, b: str) -> int | None:
    """0 for an exact (stemmed) match, a penalty for a near miss from mishearing, None otherwise."""
    if a == b:
        return 0
    # Misheard words ("merlet" for "merlot"): close spelling and the same first sound.
    if len(a) >= 5 and len(b) >= 5 and a[0] == b[0] and fuzz.ratio(a, b) >= 80:
        return 5
    return None


def score_phrase(span: list[str], phrase: Phrase) -> int:
    """0-100: how well a span of spoken (stemmed) words names this menu phrase."""
    target = list(phrase.tokens)
    if not span:
        return 0
    if span == target or "".join(span) == "".join(target):
        return 100
    penalty = 0
    remaining = target.copy()
    for word in span:
        hit = next(((t, p) for t in remaining if (p := tokens_match(word, t)) is not None), None)
        if hit is None:
            return 0
        remaining.remove(hit[0])
        penalty += hit[1]
    if not remaining:  # every word matched, only fuzzily
        return 100 - penalty
    # All spoken words are in the name, which has extra words ("fish" -> "fish and chips").
    variants = sum(1 for t in remaining if t in VARIANT_WORDS) * 6
    return max(0, 90 - min(20, 5 * len(remaining)) - variants - penalty)


# ---------------------------------------------------------------------------------------------
# Parsing


@dataclass
class FastPathResult:
    order: Order | None
    reason: str = ""
    confidence: float = 0.0
    lines: list[dict] = field(default_factory=list)


ACCEPT_SCORE = 80  # weaker matches go to the LLM
AMBIGUITY_MARGIN = 10

FILLER = {
    "please", "thanks", "thank", "you", "cheers", "as", "well", "too", "also", "then", "and",
    "with", "of", "the", "some", "for", "me", "us", "them", "just", "x", "on", "a", "an",
    "ok", "okay", "right", "yeah", "yes", "now", "next", "lovely", "great",
}  # fmt: skip

LEADING_VERBS = re.compile(
    r"^(?:(?:can|could|may) (?:i|we|you) (?:get|have|add|grab)(?: me| us)?|"
    r"(?:i|we)(?: d| ll| will| would)? (?:like|have|take|want|get)|"
    r"(?:get|give|grab) (?:me|us)|add|order|get|have|plus|and)\b\s*"
)
TABLE = re.compile(r"\b(?:(?:for|on|to|at) )?table (?:number )?(" + NUMBER + r")\b")
SEND = re.compile(
    r"^(?:(?:ok|okay|right|yeah|yes|great|thats it|thats everything|thats all),? )*"
    r"(?:send|fire)(?: it| that| them| this| the order| everything| away)?"
    r"(?: (?:to|through to) the kitchen| through| off| away)?$"
)
CANCEL = re.compile(
    r"^(?:cancel(?: that| it| the order| everything| all)?|scratch that|forget (?:it|that)|"
    r"never ?mind|start (?:again|over))$"
)
REMOVE = re.compile(r"^(?:remove|take off|take away|delete|drop|scratch|cancel)\s+(.+)$")
# "... and send it" after items: one intent per utterance, so the items are added and the waiter
# sends separately (decision 2026-10-22). Dropping the items instead would lose the order.
SEND_SUFFIX = re.compile(r"(?:,\s*|\s+)(?:and\s+|then\s+)?(?:send|fire)\b.*$")
MODIFY = re.compile(r"\b(?:make (?:that|it)|change|instead|actually|swap|no make)\b")

SIZE_WORDS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(?:a )?half(?: pint)?(?: of)?\b"), "half"),
    (re.compile(r"\bbottles? of\b|\bbottles?\b"), "bottle"),
    (re.compile(r"\b(?:large(?: glass(?:es)?)?|250ml)(?: of)?\b"), "250ml"),
    (re.compile(r"\b(?:small(?: glass(?:es)?)?|175ml)(?: of)?\b"), "175ml"),
    (re.compile(r"\bglass(?:es)? of\b"), "glass"),  # "a glass of red": the default glass
    (re.compile(r"\bpints?(?: of)?\b"), "pint"),
]

# "he's got a", "she has a", "one of them has a severe" ... before an allergy.
WHO_HAS = (
    r"(?:(?:hes|shes|theyve|theyre|he|she|they|someone|one of them|the guest) "
    r"(?:has |have |is |are )?(?:got )?)?(?:an? )?"
)
# An allergy note ends at a known tail ("tell the chef"), never at the end of the sentence:
# a greedy match once swallowed the next item ("..., nut allergy, a large merlot").
TELL_CHEF = (
    r"(?:,? (?:please )?(?:tell|let|warn|inform|notify) (?:the )?(?:chef|kitchen)(?: know)?)?"
)
NOTE_PATTERNS = [
    re.compile(
        r"\b"
        + WHO_HAS
        + r"(?:(?:severe|bad|serious) )?(?:nut|peanut|gluten|dairy|shellfish|egg|soy|sesame|"
        r"fish|milk|lactose|celery|mustard)s? (?:allergy|allergies|intolerance|intolerant)\b"
        + TELL_CHEF
    ),
    re.compile(r"\b" + WHO_HAS + r"allergic to (?:\w+ and )?\w+" + TELL_CHEF),
    re.compile(r"\b(?:gluten|dairy) free\b"),
    re.compile(r"\b(?:on the side|well done|medium rare|medium well|no ice|extra hot|no rush)\b"),
]
NEGATION = re.compile(r"\b(?:no|without|hold the)\s+(\w+)(?: (\w+))?")
DISFLUENCY = re.compile(r"\b(?:u+h+|u+m+|e+r+m*|a+h+|h+m+)\b")


ALLERGENS = re.compile(r"\b(?:allerg\w*|intoleran\w*|free)\b")


def _is_allergen_note(note: str) -> bool:
    """ "fish allergy" names fish but is an allergy, not a swallowed fish dish."""
    return bool(ALLERGENS.search(note)) and len(note.split()) <= 8


def notes_only(segment: str) -> list[str] | None:
    """Notes in a segment that holds nothing else (", nut allergy tell the chef"), else None."""
    text, notes = f" {segment} ", []
    for pattern in [*NOTE_PATTERNS, NEGATION]:
        for match in list(pattern.finditer(text)):
            notes.append(match.group(0).strip())
            text = text.replace(match.group(0), " ")
    if notes and all(w in FILLER for w in text.split()):
        return notes
    return None


def split_segments(text: str) -> list[str]:
    """Split on commas and "and"/"plus", and before a new quantity ("two cokes three lagers").
    Pieces are re-joined later when together they name one dish ("fish and chips")."""
    pieces = re.split(r"\s*,\s*|\s+(?:and|plus)\s+|\s+(?=" + NUMBER + r"\s+[a-z])", text)
    return [p.strip() for p in pieces if p and p.strip()]


@dataclass
class Line:
    item: MenuItem
    qty: int
    size: str | None
    modifiers: list[str]
    notes: list[str]
    score: int


class FastPath:
    def __init__(self, menu: Menu) -> None:
        self.menu = menu
        self.index = MenuIndex(menu)

    # -- item matching ------------------------------------------------------------------------

    def best_item(self, words: list[str]) -> tuple[int, int, MenuItem | None, int, str]:
        """Find the span of `words` that best names a menu item.

        Returns (start, end, item, score, problem). `item` is None when nothing matches well
        enough or two different items match the same words about equally well.
        """
        stems = [stem(w) if w not in STOPWORDS else "" for w in words]
        best: tuple[int, int, int, list[tuple[int, MenuItem]]] | None = None
        for start in range(len(words)):
            for end in range(start + 1, len(words) + 1):
                span = [s for s in stems[start:end] if s]
                if not span or not stems[start] or not stems[end - 1]:
                    continue
                per_item: dict[str, tuple[int, MenuItem]] = {}
                for phrase in self.index.phrases:
                    score = score_phrase(span, phrase)
                    if score and score > per_item.get(phrase.item.id, (0, phrase.item))[0]:
                        per_item[phrase.item.id] = (score, phrase.item)
                if not per_item:
                    continue
                ranked = sorted(per_item.values(), key=lambda s: -s[0])
                key = (ranked[0][0], end - start)
                if best is None or key > (best[2], best[1] - best[0]):
                    best = (start, end, ranked[0][0], ranked)
        if best is None:
            return 0, 0, None, 0, "no menu item named"
        start, end, score, ranked = best
        if score < ACCEPT_SCORE:
            return start, end, None, score, f"weak match {ranked[0][1].id} ({score})"
        rivals = [r for r in ranked[1:] if r[0] >= score - AMBIGUITY_MARGIN]
        if rivals and score < 100:
            names = ", ".join(r[1].id for r in [ranked[0], *rivals])
            return start, end, None, score, f"ambiguous: {names}"
        return start, end, ranked[0][1], score, ""

    # -- one item line ------------------------------------------------------------------------

    def parse_line(self, segment: str) -> tuple[Line | None, str]:
        text = f" {segment} "
        qty: int | None = None

        notes: list[str] = []
        for pattern in NOTE_PATTERNS:
            match = pattern.search(text)
            if match:
                notes.append(match.group(0).strip())
                text = text[: match.start()] + " " + text[match.end() :]

        # Quantity: a leading number word, or "x2" / "2x".
        words = text.split()
        if words and (to_number(words[0]) is not None or words[0] in QTY_ONLY_WORDS):
            qty = to_number(words[0]) or QTY_ONLY_WORDS.get(words[0])
            words = words[1:]
            if words and words[0] == "of":  # "a couple of"
                words = words[1:]
        text = " ".join(words)
        times = re.search(r"\b(?:x ?(\d+)|(\d+) ?x)\b", text)
        if times and qty is None:
            qty = int(times.group(1) or times.group(2))
            text = text[: times.start()] + text[times.end() :]

        # First matching size phrase wins; "a glass of" just means the default glass.
        size: str | None = None
        for pattern, size_id in SIZE_WORDS:
            if pattern.search(text):
                text = pattern.sub(" ", text)
                size = None if size_id == "glass" else size_id
                break

        words = text.split()
        start, end, item, score, problem = self.best_item(words)
        if item is None:
            return None, f"{problem} in '{segment}'"

        modifiers, leftover = self.match_options(item, words[:start] + words[end:])
        # "no X" that isn't a menu option is a kitchen note ("no vinegar").
        rest = " ".join(leftover)
        for negation in NEGATION.finditer(rest):
            phrase = negation.group(0)
            if negation.group(2) in FILLER or negation.group(2) is None:
                phrase = f"no {negation.group(1)}"
            notes.append(phrase)
            rest = rest.replace(negation.group(0), " ")
        unknown = [w for w in rest.split() if w not in FILLER]
        if unknown:
            return None, f"unrecognised words {unknown} in '{segment}'"

        if size is not None and item.size(size) is None:
            if not item.sizes:
                return None, f"{item.id} has no sizes but '{size}' was said"
            return None, f"{item.id} has no size {size}"

        # A note that names a menu item means an item got swallowed; refuse so the caller tries
        # splitting the segments instead.
        for note in notes:
            note_words = note.split()
            _, _, swallowed, swallowed_score, _ = self.best_item(note_words)
            if swallowed is not None and swallowed_score >= 90 and not _is_allergen_note(note):
                return None, f"note '{note}' names {swallowed.id}"
        # Keep notes in the order they were said.
        notes.sort(key=lambda n: segment.find(n) if n in segment else len(segment))
        return Line(item, qty or 1, size, modifiers, notes, score), ""

    def match_options(self, item: MenuItem, words: list[str]) -> tuple[list[str], list[str]]:
        """Pick out the item's modifier options from the words around its name."""
        stems = [stem(w) for w in words]
        used = [False] * len(words)
        found: list[str] = []
        for key in self.index.option_keys.get(item.id, []):
            n = len(key.tokens)
            for i in range(len(stems) - n + 1):
                if any(used[i : i + n]):
                    continue
                if tuple(stems[i : i + n]) == key.tokens:
                    if key.option not in found:
                        found.append(key.option)
                    used[i : i + n] = [True] * n
        leftover = [w for w, u in zip(words, used, strict=True) if not u]
        return found, leftover

    # -- whole utterance ----------------------------------------------------------------------

    def parse(self, text: str, current_table: int | None = None) -> FastPathResult:
        t = re.sub(r"\s+", " ", DISFLUENCY.sub(" ", normalise(text))).strip(" ,")
        table = current_table
        table_match = TABLE.search(t)
        if table_match:
            table = to_number(table_match.group(1))
            t = (t[: table_match.start()] + " " + t[table_match.end() :]).strip(" ,")
            t = re.sub(r"\s+", " ", t)
        bare = re.sub(r"\b(?:please|now|ok|okay|thanks|cheers)\b", "", t).strip(" ,")
        bare = re.sub(r"\s+", " ", bare)

        if not bare:
            if table_match:
                return self._result(Intent.SET_TABLE, table, [], 1.0)
            return FastPathResult(None, "empty utterance")
        if CANCEL.match(bare):
            return self._result(Intent.CANCEL, table, [], 1.0)
        if SEND.match(bare):
            return self._result(Intent.SEND_ORDER, table, [], 1.0)
        if MODIFY.search(bare):
            return FastPathResult(None, "modification needs context")
        bare = SEND_SUFFIX.sub("", bare).strip(" ,")

        intent = Intent.ADD_ITEMS
        remove = REMOVE.match(bare)
        if remove:
            intent, bare = Intent.REMOVE_ITEM, remove.group(1)
        bare = LEADING_VERBS.sub("", bare).strip(" ,")

        lines, problem = self._parse_lines(bare)
        if problem:
            return FastPathResult(None, problem)
        if any(line.qty > MAX_QTY for line in lines):
            big = next(line for line in lines if line.qty > MAX_QTY)
            return FastPathResult(None, f"quantity {big.qty} out of range")
        confidence = min(line.score for line in lines) / 100
        items = [
            OrderItem(
                menu_id=line.item.id,
                qty=line.qty,
                size=line.size,
                modifiers=line.modifiers,
                notes=line.notes,
            )
            for line in lines
        ]
        return self._result(intent, table, items, confidence)

    def _parse_lines(self, text: str) -> tuple[list[Line], str]:
        segments = split_segments(text)
        if not segments:
            return [], "no items"
        lines: list[Line] = []
        i = 0
        while i < len(segments):
            extra_notes = notes_only(segments[i]) if lines else None
            if extra_notes:
                lines[-1].notes.extend(extra_notes)
                i += 1
                continue
            # Prefer the longest run of pieces that parses as one line ("fish and chips").
            # If none parses, report why the longest one failed: it's the most informative.
            first_problem = ""
            for j in range(len(segments), i, -1):
                joined = " and ".join(segments[i:j])
                line, problem = self.parse_line(joined)
                if line is not None:
                    lines.append(line)
                    i = j
                    break
                first_problem = first_problem or problem
                if j == i + 1:
                    return [], first_problem
        return lines, ""

    def _result(
        self, intent: Intent, table: int | None, items: list[OrderItem], confidence: float
    ) -> FastPathResult:
        try:
            order = Order.model_validate(
                {
                    "table": table,
                    "items": [i.model_dump() for i in items],
                    "intent": intent,
                    "confidence": round(confidence, 2),
                },
                context={"menu": self.menu},
            )
        except ValidationError as err:
            return FastPathResult(None, f"invalid: {err.errors()[0]['msg']}")
        return FastPathResult(order, confidence=order.confidence)

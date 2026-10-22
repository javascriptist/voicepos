"""Try the text pipeline from a terminal.

uv run python -m voicepos.cli                 # interactive, keeps the current table
uv run python -m voicepos.cli "table 4 two flat whites"
uv run python -m voicepos.cli --no-llm ...    # fast path only
"""

from __future__ import annotations

import argparse
import time

from .llm import DEFAULT_MODEL, LLMParser
from .menu import load_menu
from .pipeline import Pipeline


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("text", nargs="*", help="utterances to parse (omit for interactive mode)")
    parser.add_argument("--no-llm", action="store_true", help="fast path only")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--table", type=int, default=None, help="starting table")
    args = parser.parse_args()

    menu = load_menu()
    llm = None
    if not args.no_llm:
        start = time.perf_counter()
        llm = LLMParser.load(menu, args.model)
        print(f"Loaded {args.model} in {time.perf_counter() - start:.1f}s")
    pipeline = Pipeline(menu, llm)
    table = args.table

    def run(text: str) -> None:
        nonlocal table
        result = pipeline.parse(text, current_table=table)
        table = result.order.table or table
        detail = f" ({result.fast_path_reason})" if result.path != "fast_path" else ""
        print(f"[{result.path} {result.parse_ms:.0f}ms]{detail}")
        print(result.order.model_dump_json(exclude_defaults=True))

    if args.text:
        for text in args.text:
            run(text)
        return
    try:
        while text := input("> ").strip():
            run(text)
    except (EOFError, KeyboardInterrupt):
        print()


if __name__ == "__main__":
    main()

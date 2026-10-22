"""Write the order JSON Schema to data/order.schema.json for the TypeScript apps.

Run with: uv run python -m voicepos.schema
"""

from __future__ import annotations

import json

from .menu import REPO_ROOT
from .order import Order

SCHEMA_PATH = REPO_ROOT / "data" / "order.schema.json"


def order_schema_json() -> str:
    return json.dumps(Order.model_json_schema(), indent=2) + "\n"


def main() -> None:
    SCHEMA_PATH.write_text(order_schema_json(), encoding="utf-8")
    print(f"Wrote {SCHEMA_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()

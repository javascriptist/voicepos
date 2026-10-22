from __future__ import annotations

import json
from typing import Any

from voicepos.llm import Generation


class ScriptedGenerator:
    """Stands in for the model: returns scripted replies in order and records the prompts."""

    def __init__(self, *replies: str | dict[str, Any]) -> None:
        self.replies = [r if isinstance(r, str) else json.dumps(r) for r in replies]
        self.prompts: list[str] = []

    def __call__(self, message: str) -> Generation:
        self.prompts.append(message)
        return Generation(self.replies.pop(0), mean_logprob=-0.05, tokens=20, ms=1.0)

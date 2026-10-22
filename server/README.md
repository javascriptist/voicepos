# voicepos server

Speech → validated order JSON for the voice POS. See the repo `CLAUDE.md` for the architecture.

```sh
uv sync                              # install
uv run pytest                        # tests
uv run ruff check . && uv run ruff format --check .
uv run python -m voicepos.schema     # regenerate data/order.schema.json after changing the contract
```

- `voicepos.menu`: loads and validates `data/menu.json` (`VOICEPOS_MENU` overrides the path).
- `voicepos.order`: the order contract; `parse_order(data, menu)` rejects invented items,
  sizes and modifiers and fills in default sizes.
- `voicepos.fastpath`: rule-based parsing of simple orders (no LLM, 0–3 ms).
- `voicepos.llm`: LFM2.5 fallback via `mlx-lm` with a cached system prompt, validation and retry.
- `voicepos.grounding`: rejects LLM output that isn't supported by the words said.
- `voicepos.pipeline`: fast path first, LLM when it declines.
- `voicepos.stt`: Phonon-2 speech to text via `mlx-audio`; audio is decoded in memory only.
- `voicepos.app`: FastAPI server (`/parse`, `/transcribe`, `/ws/audio`); see its docstring for the
  WebSocket protocol.

Run the server (loads both models once, ~10 s):

```sh
uv run uvicorn voicepos.app:app --host 0.0.0.0 --port 8000
curl -s localhost:8000/health
curl -s --data-binary @clip.wav localhost:8000/transcribe?table=4
VOICEPOS_LLM=0 VOICEPOS_STT=0 uv run uvicorn voicepos.app:app   # no models, text fast path only
```

Try it:

```sh
uv run python -m voicepos.cli                       # interactive; keeps the current table
uv run python -m voicepos.cli --no-llm "table 4 two flat whites with oat milk"
VOICEPOS_RUN_LLM=1 uv run pytest -k real            # also run the test that loads the model
```

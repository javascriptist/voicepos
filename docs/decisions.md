# Decisions log

Choices that affect the system or its evaluation, with date and reason. Feeds the methodology chapter.

## 2026-10-22: New direction; prototype moved to `/legacy`

- **Decision:** Build an own simplified POS and a local voice service, per `CLAUDE.md`.
  The earlier prototype (Floreant POS 2.0.1 with a Java API bridge, a Node web POS, and an
  Agora Conversational AI voice agent using Deepgram, OpenAI and MiniMax) is kept in `/legacy`
  for reference and comparison, not extended.
- **Reason:** The cloud voice pipeline sends audio and transcripts off the restaurant server,
  which conflicts with the local-models and ethics constraints, and its latency can't be measured
  per stage. Floreant ties the voice layer to one POS; the new voice service has a clean API.
- **Carried over:** menu data (converted to `data/menu.json`), the fuzzy-matching rules
  (default sizes, misheard numbers, synonyms, asking when ambiguous), and test phrases.

## 2026-10-22: Python environment managed with `uv`

- **Decision:** `uv` manages the server's Python environment and lockfile.
- **Reason:** Fast, reproducible installs (`uv.lock`) on Apple Silicon.

## 2026-10-22: Menu format (`data/menu.json`)

- **Decision:** The mock menu is derived from the legacy Floreant demo menu
  (`legacy/floreant-menu-export.json`, converted by `data/tools/build_menu_from_legacy.py`).
  Drinks sold in several measures are one item with `sizes` (half / pint / two pints;
  175ml / 250ml / bottle) and a `default_size` (pint; 175ml), matching the `size` field of the
  order contract. 119 POS rows became 80 items.
- **Normalisation:** duplicate rows were merged, keeping the newer entry (two "Steak & Ale Pie"
  rows at £14.50 / £14.95, two "Yorkshire Bitter Half Pint" rows at £3.25 / £3.00). Missing
  measures were given mock prices so each draught has half / pint / two pints and each wine
  175ml / 250ml / bottle. The legacy POS had no modifier groups, so a small mock set was added
  (milk, eggs, peas, sauce, burger extras, burger removals).
- **Aliases:** each item lists spoken names ("coke" → `cola`, "bitter" → `yorkshire_bitter`);
  the menu loader rejects an alias claimed by two items so the fast path can't be ambiguous.
- **Reason:** One item per drink keeps `menu_id`s stable and makes size an explicit, checkable
  field rather than part of the name, which simplifies both fuzzy matching and LLM output.

## 2026-10-22: Order validation rules

- `qty` is limited to 1–30: larger numbers are almost always misheard (a real transcript
  produced "752 fish and chips").
- A missing `size` is filled with the item's default during validation; an unknown size, a size
  on an unsized item, an unknown modifier, or more options than a group allows is rejected.
- `add_items`, `remove_item` and `modify_item` need at least one item; `set_table` needs a table.

## 2026-10-22: `notes` added to order items

- **Decision:** `OrderItem` gains an optional `notes: list[str]` (max 5, 200 characters each) for
  kitchen notes that aren't menu options, such as allergies. The contract in `CLAUDE.md` is
  otherwise unchanged.
- **Reason:** Allergy and preparation notes must reach the kitchen word for word; forcing them
  into `modifiers` would either reject them (not a menu option) or invite the LLM to invent
  options. Notes are passed through as text and never treated as an allergen-safety guarantee.

## 2026-10-22: Fast path design (`server/src/voicepos/fastpath.py`)

- **Decision:** Rule-based parser with `rapidfuzz` for misheard words. It returns an order only
  when every word is accounted for (item, quantity, size, option, note, table or filler) and
  the item match is unambiguous; otherwise it defers to the LLM and records why
  (`fast_path_reason`). Orders below confidence 0.8 also go to the LLM.
- **Rules carried over from the legacy prototype:** standard items beat variants (kids, mini,
  decaf, double) unless said; "to"/"too"/"for" at the start of an item mean 2/2/4; light
  stemming ("fishing" → "fish"); quantities above 30 are rejected as misheard.
- **Measured:** 0–3 ms per utterance on the M4.
- **Reason:** CLAUDE.md latency rule (fast path first); conservative so a wrong order never
  reaches the screen without the LLM getting a chance.

## 2026-10-22: LLM fallback setup (`server/src/voicepos/llm.py`)

- **Model:** `mlx-community/LFM2.5-1.2B-Instruct-4bit` via `mlx-lm` 0.32 (8-bit comparison later).
- **Prompt caching:** one fixed system prompt (rules, full menu, 9 varied examples). Its KV
  cache is computed once at start-up and copied per request. Measured with a 1.6k-token prefix:
  ~1,570 ms per call without the cache vs ~290 ms with it.
- **Decoding:** greedy (temperature 0) so results are reproducible; generation stops as soon as
  the JSON object closes.
- **Validation:** formatting slips are repaired (stray closing brackets; a string where a list is
  expected; items on an "unknown" order dropped). Content is never repaired: an invented item or
  option fails validation and gets one retry with the error message, then becomes "unknown".
- **Confidence:** exp(mean token log-probability) of the reply. Observed to be poorly
  calibrated on the base model (0.89–0.98 on wrong answers), so it is not used as a safety gate.
- **Examples are varied deliberately:** with repeated example content the 1.2B model copied it
  (e.g. "steak" → beef burger with the example's "extra cheese, no onions").

## 2026-10-22: Grounding check on LLM output (`server/src/voicepos/grounding.py`)

- **Decision:** after validation, every item, option, non-default size, quantity above 1, new
  table and non-add intent must be traceable to words in the transcript; otherwise the reply is
  rejected (retry once, then "unknown").
- **Reason:** the base model returned valid but wrong orders with high confidence ("a pie" →
  chicken burger with bacon). Validity and token probabilities can't catch that; grounding can.
  Expected effect on evaluation: fewer wrong orders, more "unknown" (a re-ask) on the base model.
- **Known limit:** grounding checks that a word was said, not that it was meant ("battered fish
  for the kid" → battered sausage passes because "battered" was said).

## 2026-10-22: One intent per utterance

- **Decision:** An utterance maps to exactly one intent. "Two fish and chips and send it" adds the
  items (`add_items`) and does not send; the pipeline flags `send_ignored` so the confirmation can
  prompt the waiter to say "send" on its own.
- **Reason:** keeps the order contract unchanged and avoids the worse failure seen in testing,
  where the LLM chose `send_order` and dropped the items. The cost (an extra "send it") is
  measurable in the voice-vs-touch timing.

## 2026-10-22: Speech to text (`server/src/voicepos/stt.py`)

- **Decision:** Phonon-2 is run through the community MLX port `mlx-community/Phonon-2`
  (≈350 MB, preconverted from `FermionResearch/Phonon-2`) with `mlx-audio` 0.6, rather than
  Fermion's own runtime (`fermion-research`). Backup: `mlx-community/parakeet-tdt-0.6b-v3`
  (`VOICEPOS_STT_MODEL`).
- **Reason:** `mlx-audio` is already in the stack for Kokoro TTS, so no extra runtime; the port
  states it was validated against the official packed runtime. It transcribes whole clips (no
  live streaming), which matches the design: the phone's VAD sends one finished utterance.
- **Measured (synthetic `say` voice, M4):** first call ≈2.2 s (kernel compile), so the server
  warms the model at start-up; afterwards 63–155 ms per 1–3 s clip.
- **Audio handling:** clips are decoded in memory (`miniaudio`, any rate → 16 kHz mono) and the
  buffer is dropped after transcription; nothing is written to disk. Clips under 0.2 s are
  treated as no speech; over 30 s are rejected.
- **Mishearing tolerance:** after seeing "merlot" transcribed as "merlet", the fast path accepts
  words of 5+ letters with ≥80 % similarity and the same first letter (was ≥85 %).

## 2026-10-22: Server (`server/src/voicepos/app.py`)

- FastAPI with `POST /parse` (text), `POST /transcribe` (one clip as the request body; no
  multipart, so no extra dependency) and `WS /ws/audio` (PCM16 frames, then `{"type":"end"}`).
- All model work runs on one worker thread: MLX GPU streams belong to the creating thread, and
  a single thread serialises access to the models.
- Each response carries `speech_end`, `stt_done` and `parse_done` timestamps plus durations,
  ready for the SQLite timing log (build step 6).
- **Measured end to end (end of speech → validated order):** fast-path utterances 63–154 ms;
  utterances needing the LLM 0.8–1.3 s, mostly ending "unknown" with the base model.

## 2026-10-22: POS and ticket handling (build step 4)

- **One path for voice and touch:** the server owns open tickets (`server/src/voicepos/tickets.py`)
  and changes them only by applying validated order JSON. The POS sends touch actions as orders
  in the same contract over `/ws/pos`; voice orders come from `/ws/audio` or `/transcribe`. Both
  are logged as events with the same timing fields, so the voice-vs-touch comparison measures
  input method, not two different code paths.
- **Timing stages:** voice events carry `speech_end`, `stt_done`, `parse_done`; touch events carry
  `started_at` (the tap that began the action) and `parse_done`. Each POS screen acknowledges an
  event after the browser has painted it (two animation frames); the first ack sets `pos_updated`.
- **Ticket rules:** identical unsent lines merge; "remove" takes from the newest unsent matching
  line and refuses lines already sent; "modify" changes the newest unsent line of that item;
  "send" moves all unsent lines into a kitchen batch; "cancel" drops unsent lines only. Tickets
  are in memory until SQLite storage is added with the timing logs (step 6). 24 tables (mock).
- **POS stack:** React 19 + Vite 8 + TypeScript strict (plus `noUncheckedIndexedAccess`), ESLint
  (typescript-eslint strict, react-hooks) and Prettier as CLAUDE.md specifies (the Vite template's
  default oxlint was replaced); Vitest for unit tests (dev-only).
- **Bug found in the live run, fixed:** an allergy note matched to the end of the sentence and
  swallowed the next item ("..., nut allergy tell the chef, a large merlot" lost the merlot).
  Allergy notes now end at a known tail ("tell the chef"), and a note that names a menu item is
  refused so the parser splits it out instead.

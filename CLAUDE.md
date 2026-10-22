# CLAUDE.md — Voice POS (Final Year Project)

## What this project is
A voice-first point-of-sale system for restaurants. Waiting staff speak orders through AirPods
connected to a phone app; a local server turns speech into a structured order and pushes it
to a POS screen. Touch input exists as a fallback.

This is a BSc Data Science & AI final-year project (UEL, module CN6000). The code is the
deliverable and the evaluation data feeds the dissertation, so **measurability matters as much
as features**.

Core research question: can a local, fine-tuned voice pipeline take restaurant orders faster
than touch input with acceptable accuracy (target: < 1s from end of speech to order on screen)?

## Architecture

```
[Phone app + AirPods]
  wake word / push-to-talk  ->  on-device VAD  ->  speech clip
        | WebSocket (restaurant Wi-Fi)
        v
[Server — Mac M4, later optional Raspberry Pi 5]
  STT  ->  fast path (fuzzy menu match)  ->  LLM fallback  ->  order JSON (validated)
        | WebSocket
        v
[POS web app]  order ticket, tables, modifiers, touch input
        +
[Phone]  confirmation beep / short TTS in AirPods + on-screen order
```

Key decisions (already made, don't change without asking):
- **Own simplified POS**, not an extension of an existing open-source POS. The voice layer is a
  separate service with a clean API so it could plug into any POS later.
- **Models run on the server, not the phone**: same model for all staff, central logging.
- **Nothing leaves the phone before the wake word / PTT press.** Raw audio is never stored.
- **Wake word is default, AirPods stem press (push-to-talk) is fallback.** Both must exist so
  they can be compared.

## Stack

### Server (`/server`) — Python 3.11+, Apple Silicon
| Stage | Tool |
|---|---|
| API | FastAPI + WebSockets, uvicorn |
| VAD (server-side backup) | `silero-vad` |
| STT | `FermionResearch/Phonon-2` (MLX Parakeet). Backup: `nvidia/parakeet-tdt-0.6b-v3` |
| LLM | `mlx-community/LFM2.5-1.2B-Instruct-4bit` via `mlx-lm` (also test `-8bit`) |
| TTS | `mlx-community/Kokoro-82M-bf16` via `mlx-audio` |
| Fuzzy match | `rapidfuzz` |
| Validation | Pydantic v2 |
| Storage | SQLite (orders, menu, timing logs) |
| Fine-tuning | `mlx_lm.lora` (fallback: Unsloth on Colab, convert back to MLX) |

Pi 5 port (stretch goal only): llama.cpp GGUF for the LLM, sherpa-onnx or whisper.cpp for STT,
Piper for TTS.

### Mobile app (`/mobile`) — React Native (Expo dev client, TypeScript)
- Wake word: Picovoice Porcupine React Native SDK (custom 3+ syllable word, not "order").
- PTT: native iOS module using `AVAudioApplication` input-mute handler (AirPods stem press).
  Android: media button events.
- On-device VAD before sending audio.
- iOS background audio mode enabled; listening starts when a shift starts.

### POS web app (`/pos-web`) — React + Vite + TypeScript
- Menu with categories and modifiers, tables, order ticket, send-to-kitchen.
- Touch ordering must work fully on its own (needed for the voice vs touch comparison).

## Order JSON contract
All voice paths must output this, validated with Pydantic before reaching the POS:

```json
{
  "table": 4,
  "items": [
    { "menu_id": "flat_white", "qty": 2, "size": null, "modifiers": ["oat milk"], "notes": [] }
  ],
  "intent": "add_items",
  "confidence": 0.92
}
```
Intents: `add_items`, `remove_item`, `modify_item`, `set_table`, `send_order`, `cancel`, `unknown`.
`menu_id` must exist in the menu table — never let the LLM invent items.

## Latency rules
- Load all models once at server start; never cold-load per request.
- Fast path first: fuzzy-match simple orders against the menu; only call the LLM when it fails.
- Keep the LLM system prompt and menu fixed so they are cached; output must be constrained or
  validated JSON (retry once on invalid output).
- Short confirmations only (beep / "added"); TTS is optional per action.

## Logging (required for the dissertation)
Every request logs timestamps for each stage to SQLite:
`speech_end -> stt_done -> parse_done (fast_path | llm) -> pos_updated -> confirmation_played`
plus transcript, final JSON, path used, and whether the staff member corrected it.
Provide a script in `/eval` that exports these to CSV and prints per-stage mean / p50 / p95.

## Evaluation experiments to support
1. Voice vs touch: time per order, error rate (same app).
2. Wake word vs push-to-talk: false triggers per hour, missed triggers, time per order.
3. LLM base vs LoRA fine-tuned: accuracy on a held-out test set, latency.
4. 4-bit vs 8-bit LLM: accuracy vs latency tradeoff.
5. (Stretch) Mac M4 vs Raspberry Pi 5.

## Fine-tuning data
- Synthetic only: generate 1–2k utterance → JSON pairs from the menu (templates + paraphrasing).
  Include slang, disfluencies ("uh, can I get…"), corrections ("no, make that three").
- Keep a fixed held-out test set in `/data/test` and never train on it.
- For STT robustness tests, generate menu-phrase audio with Kokoro (no real voices needed).

## Ethics constraints (do not break)
- No storing raw audio. Transcripts only, with no names or customer data.
- Mock menu and fake transactions only; no real payments or card data.
- No real customer or staff data in the repo.

## Repo layout
```
/server     FastAPI app, pipeline (vad, stt, parser, llm, tts), models loader
/mobile     React Native app
/pos-web    React POS
/data       menu.json, synthetic training data, /test held-out set
/finetune   data generation + mlx_lm.lora scripts
/eval       benchmark + log export scripts
/docs       architecture notes, decisions log
```

## Build order
1. `/data/menu.json` + order JSON schema + Pydantic models
2. Server: text-in → fast path → LLM → JSON (no audio yet), with tests
3. Add STT (file upload first, then WebSocket streaming)
4. POS web app connected over WebSocket
5. Mobile app: PTT first, then wake word
6. Timing logs + eval scripts
7. Synthetic data + LoRA fine-tune + comparison
8. (Stretch) Pi 5 port

## Working conventions
- Keep it simple; this is a 1-person project with a fixed deadline (report due 4 May 2027).
- Python: type hints, `ruff` + `pytest`. TS: strict mode, ESLint + Prettier.
- Small commits with clear messages.
- When a choice affects the evaluation (model, quantisation, prompt), note it in
  `/docs/decisions.md` with the date and reason — this feeds the methodology chapter.
- Ask before adding a new major dependency or changing a key decision above.
- Claude writes and explains code; the dissertation write-up itself is written by me
  (UEL generative AI policy). Keep chat/AI history where possible.

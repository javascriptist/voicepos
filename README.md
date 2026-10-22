# voicepos

Voice-first restaurant POS: waiters speak orders through AirPods, a local server turns speech into a validated order, and it appears on a React POS screen. Final-year project (UEL CN6000).

- `server/` — FastAPI voice pipeline (STT → fast path → LLM → order JSON)
- `pos-web/` — React POS (tables, touch ordering, kitchen view, activity log)
- `data/` — menu and order schema
- `docs/` — decisions log

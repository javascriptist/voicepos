"""FastAPI server: speech, text or touch in; validated orders applied to tickets; POS screens
updated over WebSocket.

    uv run uvicorn voicepos.app:app --host 0.0.0.0 --port 8000

Environment: VOICEPOS_LLM=0 / VOICEPOS_STT=0 skip loading a model; VOICEPOS_LLM_MODEL and
VOICEPOS_STT_MODEL pick others (e.g. the 8-bit LLM, or the Parakeet backup).

Phone / waiter socket (`/ws/audio`):
    client -> {"type": "start", "table": 4}      optional; sets the table for this session
    client -> binary frames                      16 kHz mono PCM16 little-endian, any size
    client -> {"type": "end"}                    end of speech: transcribe, parse, apply, reply
    client -> {"type": "text", "text": "..."}   parse text directly (testing, typed input)
    server -> {"type": "result", ...}            see `VoiceResult`
    server -> {"type": "error", "message": ...}

POS socket (`/ws/pos`):
    server -> {"type": "snapshot", "menu", "table_count", "tickets", "batches", "events"}
    server -> {"type": "event", ...}             every voice or touch order and its outcome
    server -> {"type": "ticket", "ticket"}      a table's ticket after a change
    server -> {"type": "batch", "batch"}        what a "send" put in front of the kitchen/bar
    client -> {"type": "order", "order": {...}, "started_at": ms}   touch input, same contract
    client -> {"type": "ack", "event_id": n, "rendered_at": ms}     screen updated (pos_updated)
"""

from __future__ import annotations

import asyncio
import itertools
import json
import os
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypeVar

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, ValidationError

from .llm import DEFAULT_MODEL, LLMParser
from .menu import Menu, load_menu
from .order import Intent, Order, parse_order
from .pipeline import ParseResult, Pipeline
from .stt import (
    DEFAULT_STT_MODEL,
    AudioError,
    SpeechToText,
    Transcript,
    decode_audio,
    pcm16_to_float,
)
from .tickets import ApplyResult, TicketStore

T = TypeVar("T")
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
KEEP_EVENTS = 1000


class Transcriber(Protocol):
    model_id: str

    def transcribe(self, audio: np.ndarray) -> Transcript: ...


def now_ms() -> float:
    return round(time.time() * 1000, 1)


# ---------------------------------------------------------------------------------------------
# Messages


class Timings(BaseModel):
    """Wall-clock stamps (ms since epoch) for the CLAUDE.md stages, plus durations.
    `pos_updated` arrives later, in the POS screen's ack."""

    started_at: float | None = None  # touch: when the waiter began the order on screen
    speech_end: float | None = None
    stt_done: float | None = None
    parse_done: float
    pos_updated: float | None = None
    stt_ms: float | None = None
    parse_ms: float = 0.0


class VoiceResult(BaseModel):
    event_id: int
    source: Literal["voice", "text", "touch"]
    transcript: str
    order: Order
    path: str
    fast_path_reason: str = ""
    send_ignored: bool = False
    llm_attempts: int = 0
    result: ApplyResult
    timings: Timings


class TextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    table: int | None = Field(default=None, ge=1)
    session: str = "default"


@dataclass
class Session:
    """One waiter's context: the table they're working on."""

    table: int | None = None


# ---------------------------------------------------------------------------------------------


class Engine:
    """Owns the models, the tickets and the connected POS screens.

    All model work runs on one worker thread: MLX GPU streams belong to the thread that created
    them, and one thread also serialises requests to the models."""

    def __init__(
        self,
        menu: Menu,
        make_pipeline: Callable[[Menu], Pipeline],
        make_stt: Callable[[], Transcriber | None],
    ) -> None:
        self.menu = menu
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="models")
        self.pipeline: Pipeline = self._executor.submit(make_pipeline, menu).result()
        self.stt: Transcriber | None = self._executor.submit(make_stt).result()
        self.sessions: dict[str, Session] = {}
        self.tickets = TicketStore(menu)
        self.pos_screens: set[WebSocket] = set()
        self.events: OrderedDict[int, VoiceResult] = OrderedDict()
        self._event_ids = itertools.count(1)

    async def run(self, fn: Callable[..., T], *args: Any) -> T:
        return await asyncio.get_running_loop().run_in_executor(self._executor, fn, *args)

    def session(self, key: str) -> Session:
        return self.sessions.setdefault(key, Session())

    def previous(self, table: int | None) -> list[str]:
        """What's already on the table, as context for "make that three"."""
        if table is None:
            return []
        return [f"{line.qty}x {line.menu_id}" for line in self.tickets.ticket(table).lines][-10:]

    # -- applying an order and telling the POS screens ----------------------------------------

    async def commit(
        self,
        *,
        source: Literal["voice", "text", "touch"],
        transcript: str,
        order: Order,
        timings: Timings,
        parse: ParseResult | None = None,
        session: Session | None = None,
    ) -> VoiceResult:
        if order.table is None and session is not None:
            order = order.model_copy(update={"table": session.table})
        batches_before = len(self.tickets.batches)
        result = self.tickets.apply(order)
        if session is not None and result.table is not None and result.ok:
            session.table = result.table
        event = VoiceResult(
            event_id=next(self._event_ids),
            source=source,
            transcript=transcript,
            order=order,
            path=parse.path if parse else source,
            fast_path_reason=parse.fast_path_reason if parse else "",
            send_ignored=parse.send_ignored if parse else False,
            llm_attempts=parse.llm_attempts if parse else 0,
            result=result,
            timings=timings,
        )
        self.events[event.event_id] = event
        while len(self.events) > KEEP_EVENTS:
            self.events.popitem(last=False)

        await self.broadcast({"type": "event", **event.model_dump(mode="json")})
        if result.changed and result.table is not None:
            ticket = self.tickets.ticket(result.table)
            await self.broadcast({"type": "ticket", "ticket": ticket.model_dump(mode="json")})
        for batch in self.tickets.batches[batches_before:]:
            await self.broadcast({"type": "batch", "batch": batch.model_dump(mode="json")})
        return event

    async def broadcast(self, message: dict[str, Any]) -> None:
        for screen in list(self.pos_screens):
            try:
                await screen.send_json(message)
            except Exception:  # a screen that went away mid-send
                self.pos_screens.discard(screen)

    def acknowledge(self, event_id: int, rendered_at: float) -> None:
        event = self.events.get(event_id)
        if event and event.timings.pos_updated is None:
            event.timings.pos_updated = rendered_at

    def snapshot(self) -> dict[str, Any]:
        return {
            "type": "snapshot",
            "menu": self.menu.model_dump(mode="json"),
            "table_count": self.tickets.table_count,
            "tickets": [t.model_dump(mode="json") for t in self.tickets.open_tickets()],
            "batches": [b.model_dump(mode="json") for b in self.tickets.batches[-50:]],
            # Recent activity, oldest first, so a screen that (re)connects isn't blank.
            "events": [e.model_dump(mode="json") for e in list(self.events.values())[-50:]],
        }

    # -- input paths --------------------------------------------------------------------------

    async def handle_text(
        self,
        text: str,
        session: Session,
        *,
        source: Literal["voice", "text"] = "text",
        transcript: Transcript | None = None,
        speech_end: float | None = None,
        stt_done: float | None = None,
    ) -> VoiceResult:
        parse: ParseResult = await self.run(
            self.pipeline.parse, text, session.table, self.previous(session.table)
        )
        timings = Timings(
            speech_end=speech_end,
            stt_done=stt_done,
            parse_done=now_ms(),
            stt_ms=round(transcript.ms, 1) if transcript else None,
            parse_ms=parse.parse_ms,
        )
        return await self.commit(
            source=source, transcript=text, order=parse.order, timings=timings,
            parse=parse, session=session,
        )  # fmt: skip

    async def handle_audio(
        self, audio: np.ndarray, session: Session, speech_end: float
    ) -> VoiceResult:
        if self.stt is None:
            raise AudioError("speech recognition is not loaded (VOICEPOS_STT=0)")
        transcript = await self.run(self.stt.transcribe, audio)
        stt_done = now_ms()
        if not transcript.text:
            order = Order(table=session.table, intent=Intent.UNKNOWN, confidence=0.0)
            timings = Timings(
                speech_end=speech_end, stt_done=stt_done, parse_done=now_ms(),
                stt_ms=round(transcript.ms, 1),
            )  # fmt: skip
            no_speech = ParseResult(order, "none", 0.0, fast_path_reason="no speech")
            return await self.commit(
                source="voice", transcript="", order=order, timings=timings,
                parse=no_speech, session=session,
            )  # fmt: skip
        return await self.handle_text(
            transcript.text, session, source="voice", transcript=transcript,
            speech_end=speech_end, stt_done=stt_done,
        )  # fmt: skip

    async def handle_touch(self, data: dict[str, Any], started_at: float | None) -> VoiceResult:
        """Touch orders use the same contract and validation as voice."""
        order = parse_order({"confidence": 1.0, **data}, self.menu)
        timings = Timings(started_at=started_at, parse_done=now_ms())
        return await self.commit(source="touch", transcript="", order=order, timings=timings)

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)


def default_pipeline(menu: Menu) -> Pipeline:
    llm = None
    if os.environ.get("VOICEPOS_LLM", "1") != "0":
        llm = LLMParser.load(menu, os.environ.get("VOICEPOS_LLM_MODEL", DEFAULT_MODEL))
    return Pipeline(menu, llm)


def default_stt() -> Transcriber | None:
    if os.environ.get("VOICEPOS_STT", "1") == "0":
        return None
    return SpeechToText(os.environ.get("VOICEPOS_STT_MODEL", DEFAULT_STT_MODEL))


def create_app(
    make_pipeline: Callable[[Menu], Pipeline] = default_pipeline,
    make_stt: Callable[[], Transcriber | None] = default_stt,
    menu: Menu | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Load every model once at start-up; never per request (CLAUDE.md latency rules).
        engine = Engine(menu or load_menu(), make_pipeline, make_stt)
        app.state.engine = engine
        yield
        engine.close()

    app = FastAPI(title="Voice POS", lifespan=lifespan)

    def engine_of(request: Request | WebSocket) -> Engine:
        return request.app.state.engine

    @app.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        engine = engine_of(request)
        llm = engine.pipeline.llm
        return {
            "status": "ok",
            "menu_items": len(engine.menu.items),
            "llm": getattr(getattr(llm, "generate", None), "model_id", None) if llm else None,
            "stt": engine.stt.model_id if engine.stt else None,
            "pos_screens": len(engine.pos_screens),
        }

    @app.post("/parse")
    async def parse_text(body: TextRequest, request: Request) -> VoiceResult:
        engine = engine_of(request)
        session = engine.session(body.session)
        if body.table is not None:
            session.table = body.table
        return await engine.handle_text(body.text, session)

    @app.post("/transcribe")
    async def transcribe(
        request: Request,
        table: int | None = Query(default=None, ge=1),
        session: str = "default",
    ) -> VoiceResult:
        """Body: one audio clip (WAV, FLAC, MP3 or Ogg). Decoded in memory, never stored."""
        speech_end = now_ms()
        data = await request.body()
        if not data:
            raise HTTPException(400, "empty body; send the audio clip as the request body")
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "clip too large")
        engine = engine_of(request)
        state = engine.session(session)
        if table is not None:
            state.table = table
        try:
            audio = decode_audio(data)
            del data
            return await engine.handle_audio(audio, state, speech_end)
        except AudioError as err:
            raise HTTPException(422, str(err)) from err

    @app.websocket("/ws/audio")
    async def audio_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        engine = engine_of(websocket)
        state = Session()
        buffer = bytearray()
        max_bytes = 2 * 16_000 * 30  # 30 s of PCM16
        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    buffer.extend(message["bytes"])
                    if len(buffer) > max_bytes:
                        buffer.clear()
                        await websocket.send_json(
                            {"type": "error", "message": "clip over 30s dropped"}
                        )
                    continue
                control = _json_message(message)
                if control is None:
                    await websocket.send_json({"type": "error", "message": "invalid JSON"})
                    continue
                kind = control.get("type")
                if kind == "start":
                    buffer.clear()
                    if isinstance(control.get("table"), int):
                        state.table = control["table"]
                elif kind == "end":
                    speech_end = now_ms()
                    try:
                        audio = pcm16_to_float(bytes(buffer))
                        buffer.clear()  # raw audio is dropped as soon as it's decoded
                        result = await engine.handle_audio(audio, state, speech_end)
                        await websocket.send_json(
                            {"type": "result", **result.model_dump(mode="json")}
                        )
                    except AudioError as err:
                        buffer.clear()
                        await websocket.send_json({"type": "error", "message": str(err)})
                elif kind == "text" and isinstance(control.get("text"), str):
                    result = await engine.handle_text(control["text"], state)
                    await websocket.send_json({"type": "result", **result.model_dump(mode="json")})
                else:
                    await websocket.send_json(
                        {"type": "error", "message": f"unknown message {kind!r}"}
                    )
        except WebSocketDisconnect:
            pass
        finally:
            buffer.clear()

    @app.websocket("/ws/pos")
    async def pos_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        engine = engine_of(websocket)
        await websocket.send_json(engine.snapshot())
        engine.pos_screens.add(websocket)
        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                control = _json_message(message)
                if control is None:
                    await websocket.send_json({"type": "error", "message": "invalid JSON"})
                    continue
                kind = control.get("type")
                if kind == "order" and isinstance(control.get("order"), dict):
                    started = control.get("started_at")
                    try:
                        await engine.handle_touch(
                            control["order"], started if isinstance(started, (int, float)) else None
                        )
                    except ValidationError as err:
                        problems = "; ".join(e["msg"] for e in err.errors())
                        await websocket.send_json({"type": "error", "message": problems})
                elif kind == "ack" and isinstance(control.get("event_id"), int):
                    engine.acknowledge(
                        control["event_id"], float(control.get("rendered_at") or now_ms())
                    )
                else:
                    await websocket.send_json(
                        {"type": "error", "message": f"unknown message {kind!r}"}
                    )
        except WebSocketDisconnect:
            pass
        finally:
            engine.pos_screens.discard(websocket)

    return app


def _json_message(message: dict[str, Any]) -> dict[str, Any] | None:
    with suppress(ValueError, TypeError):
        data = json.loads(message.get("text") or "")
        if isinstance(data, dict):
            return data
    return None


def __getattr__(name: str) -> Any:
    # `uvicorn voicepos.app:app` builds the real app lazily, so importing this module (e.g. in
    # tests) doesn't load any models.
    if name == "app":
        return create_app()
    raise AttributeError(name)

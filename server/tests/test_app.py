from __future__ import annotations

import io
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

from voicepos.app import create_app
from voicepos.menu import Menu
from voicepos.pipeline import Pipeline
from voicepos.stt import SAMPLE_RATE, AudioError, Transcript, decode_audio, pcm16_to_float


class FakeSTT:
    """Returns scripted transcripts; checks it receives 16 kHz float audio."""

    model_id = "fake-stt"

    def __init__(self, *texts: str) -> None:
        self.texts = list(texts)
        self.seen: list[np.ndarray] = []

    def transcribe(self, audio: np.ndarray) -> Transcript:
        assert audio.dtype == np.float32
        self.seen.append(audio)
        return Transcript(self.texts.pop(0), 12.0, len(audio) / SAMPLE_RATE)


def wav_bytes(seconds: float = 1.0, rate: int = SAMPLE_RATE) -> bytes:
    samples = (np.sin(np.linspace(0, 440 * seconds * 6.28, int(rate * seconds))) * 8000).astype(
        "<i2"
    )
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return out.getvalue()


@pytest.fixture
def stt() -> FakeSTT:
    return FakeSTT("Table seven, two fish and chips.", "Send it.")


@pytest.fixture
def client(menu: Menu, stt: FakeSTT):
    app = create_app(make_pipeline=lambda m: Pipeline(m), make_stt=lambda: stt, menu=menu)
    with TestClient(app) as test_client:
        yield test_client


def test_health(client: TestClient) -> None:
    assert client.get("/health").json() == {
        "status": "ok",
        "menu_items": 80,
        "llm": None,
        "stt": "fake-stt",
        "pos_screens": 0,
    }


def test_parse_text_and_session_table(client: TestClient) -> None:
    first = client.post("/parse", json={"text": "table 4 two cokes", "session": "s1"}).json()
    assert first["order"]["table"] == 4
    assert first["path"] == "fast_path"
    assert first["timings"]["parse_ms"] >= 0
    second = client.post("/parse", json={"text": "a bitter", "session": "s1"}).json()
    assert second["order"]["table"] == 4  # remembered for this waiter's session
    assert second["order"]["items"] == [
        {"menu_id": "yorkshire_bitter", "qty": 1, "size": "pint", "modifiers": [], "notes": []}
    ]


def test_transcribe_upload(client: TestClient, stt: FakeSTT) -> None:
    response = client.post(
        "/transcribe", content=wav_bytes(), headers={"content-type": "audio/wav"}
    )
    body = response.json()
    assert response.status_code == 200, body
    assert body["transcript"] == "Table seven, two fish and chips."
    assert body["order"]["table"] == 7
    assert body["order"]["items"][0] == {
        "menu_id": "fish_and_chips",
        "qty": 2,
        "size": None,
        "modifiers": [],
        "notes": [],
    }
    timings = body["timings"]
    assert timings["speech_end"] <= timings["stt_done"] <= timings["parse_done"]
    assert stt.seen[0].shape == (SAMPLE_RATE,)


def test_transcribe_resamples_other_rates(client: TestClient, stt: FakeSTT) -> None:
    client.post("/transcribe", content=wav_bytes(1.0, rate=44_100))
    assert abs(len(stt.seen[0]) - SAMPLE_RATE) < 50


@pytest.mark.parametrize(("data", "status"), [(b"", 400), (b"not audio at all", 422)])
def test_transcribe_rejects_bad_input(client: TestClient, data: bytes, status: int) -> None:
    assert client.post("/transcribe", content=data).status_code == status


def test_websocket_audio_flow(client: TestClient) -> None:
    pcm = (np.zeros(SAMPLE_RATE, dtype="<i2")).tobytes()
    with client.websocket_connect("/ws/audio") as ws:
        ws.send_json({"type": "start", "table": 3})
        ws.send_bytes(pcm[:10_000])
        ws.send_bytes(pcm[10_000:])
        ws.send_json({"type": "end"})
        first = ws.receive_json()
        assert first["type"] == "result"
        assert first["order"]["intent"] == "add_items"
        assert first["order"]["table"] == 7  # said in the clip; overrides the start table
        ws.send_bytes(pcm)
        ws.send_json({"type": "end"})
        second = ws.receive_json()
        assert second["order"] == {
            "table": 7,
            "items": [],
            "intent": "send_order",
            "confidence": 1.0,
        }


def test_websocket_text_and_errors(client: TestClient) -> None:
    with client.websocket_connect("/ws/audio") as ws:
        ws.send_json({"type": "text", "text": "table 2 a coke"})
        assert ws.receive_json()["order"]["table"] == 2
        ws.send_json({"type": "dance"})
        assert ws.receive_json() == {"type": "error", "message": "unknown message 'dance'"}
        ws.send_text("{oops")
        assert ws.receive_json()["message"] == "invalid JSON"


def test_short_clip_is_not_speech(menu: Menu) -> None:
    class SilentSTT(FakeSTT):
        def transcribe(self, audio: np.ndarray) -> Transcript:
            return Transcript("", 0.0, len(audio) / SAMPLE_RATE)

    app = create_app(make_pipeline=lambda m: Pipeline(m), make_stt=lambda: SilentSTT(), menu=menu)
    with TestClient(app) as test_client:
        body = test_client.post("/transcribe", content=wav_bytes(0.1)).json()
    assert body["order"]["intent"] == "unknown"
    assert body["fast_path_reason"] == "no speech"


def test_audio_helpers() -> None:
    assert decode_audio(wav_bytes(0.5)).shape == (SAMPLE_RATE // 2,)
    assert pcm16_to_float(np.array([0, 16384, -32768], dtype="<i2").tobytes()).tolist() == [
        0.0,
        0.5,
        -1.0,
    ]
    with pytest.raises(AudioError):
        pcm16_to_float(b"\x00")


def test_pos_screen_sees_voice_and_touch_orders(client: TestClient) -> None:
    with client.websocket_connect("/ws/pos") as pos:
        snapshot = pos.receive_json()
        assert snapshot["type"] == "snapshot"
        assert snapshot["table_count"] == 24
        assert len(snapshot["menu"]["items"]) == 80
        assert snapshot["tickets"] == []
        assert snapshot["events"] == []

        # Voice (here typed through the waiter socket) reaches the POS screen
        with client.websocket_connect("/ws/audio") as waiter:
            waiter.send_json({"type": "text", "text": "table 5 two cokes"})
            assert waiter.receive_json()["result"] == {
                "ok": True,
                "message": "Added.",
                "table": 5,
                "changed": True,
            }
        event = pos.receive_json()
        assert event["type"] == "event"
        assert event["source"] == "text"
        assert event["transcript"] == "table 5 two cokes"
        ticket = pos.receive_json()
        assert ticket["type"] == "ticket"
        assert ticket["ticket"]["table"] == 5
        assert ticket["ticket"]["total"] == 6.5

        # Touch uses the same contract; then the screen acknowledges it rendered the update
        pos.send_json(
            {
                "type": "order",
                "started_at": 1000.0,
                "order": {"table": 5, "intent": "send_order", "items": []},
            }
        )
        touch = pos.receive_json()
        assert touch["source"] == "touch"
        assert touch["result"]["message"] == "Table 5 sent."
        assert touch["timings"]["started_at"] == 1000.0
        assert pos.receive_json()["type"] == "ticket"
        batch = pos.receive_json()
        assert batch["type"] == "batch"
        assert [line["menu_id"] for line in batch["batch"]["lines"]] == ["cola"]
        pos.send_json({"type": "ack", "event_id": touch["event_id"], "rendered_at": 2000.0})

        # Invalid touch orders are rejected by the same validation as voice
        pos.send_json(
            {
                "type": "order",
                "order": {"table": 5, "intent": "add_items", "items": [{"menu_id": "lasagne"}]},
            }
        )
        assert "not on the menu" in pos.receive_json()["message"]

    engine = client.app.state.engine  # type: ignore[attr-defined]
    assert engine.events[touch["event_id"]].timings.pos_updated == 2000.0


def test_unknown_voice_changes_nothing(client: TestClient) -> None:
    body = client.post("/parse", json={"text": "a pie", "table": 3}).json()
    assert body["order"]["intent"] == "unknown"
    assert body["result"] == {
        "ok": False,
        "message": "Sorry, say that again?",
        "table": 3,
        "changed": False,
    }

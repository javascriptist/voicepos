"""Speech to text with Phonon-2 (Parakeet TDT 0.6B v3, low-bit MLX port) via mlx-audio.

Audio stays in memory: clips are decoded from bytes and dropped after transcription. Raw audio
is never written to disk (ethics constraint in CLAUDE.md).
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16_000
DEFAULT_STT_MODEL = "mlx-community/Phonon-2"
BACKUP_STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
MIN_SECONDS = 0.2  # shorter clips are a stray tap or click, not speech
MAX_SECONDS = 30.0  # one order; longer means the end-of-speech signal was missed


class AudioError(ValueError):
    pass


def decode_audio(data: bytes) -> np.ndarray:
    """Decode a WAV/FLAC/MP3/Ogg clip from memory to 16 kHz mono float32."""
    import miniaudio

    try:
        decoded = miniaudio.decode(
            data,
            output_format=miniaudio.SampleFormat.FLOAT32,
            nchannels=1,
            sample_rate=SAMPLE_RATE,
        )
    except miniaudio.DecodeError as err:
        raise AudioError(f"could not decode audio: {err}") from err
    return np.frombuffer(decoded.samples, dtype=np.float32).copy()


def pcm16_to_float(data: bytes) -> np.ndarray:
    """Raw 16-bit little-endian mono PCM at 16 kHz (the WebSocket format) to float32."""
    if len(data) % 2:
        raise AudioError("PCM16 data must have an even number of bytes")
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


@dataclass
class Transcript:
    text: str
    ms: float
    audio_seconds: float


class SpeechToText:
    """Loads the model once (and warms it up) so no request pays for a cold start."""

    def __init__(self, model_id: str = DEFAULT_STT_MODEL) -> None:
        from mlx_audio.stt import load

        self.model_id = model_id
        self.model = load(model_id)
        self.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))  # first call compiles kernels

    def transcribe(self, audio: np.ndarray) -> Transcript:
        import mlx.core as mx

        seconds = len(audio) / SAMPLE_RATE
        if seconds > MAX_SECONDS:
            raise AudioError(f"clip is {seconds:.1f}s; the limit is {MAX_SECONDS:.0f}s")
        start = time.perf_counter()
        if seconds < MIN_SECONDS:
            return Transcript("", 0.0, seconds)
        result = self.model.generate(mx.array(audio))
        text = " ".join(result.text.split())
        return Transcript(text, (time.perf_counter() - start) * 1000, seconds)

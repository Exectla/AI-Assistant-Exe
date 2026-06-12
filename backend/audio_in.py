"""A.B.D. — Microphone côté noyau (sounddevice) + transcription Whisper.

Le moteur web embarqué (WebView2) ne donne pas un accès fiable au
microphone : comme pour la caméra, la capture se fait donc côté Python.
Deux modes :
  - prise unique (bouton « Parler ») : start() … stop() → octets WAV à
    transcrire ;
  - continu (Shadow Workspace) : segments de 4 s filtrés par jauge RMS,
    transcrits en arrière-plan, récupérés via drain().

Module optionnel : sans le paquet ``sounddevice`` ou sans périphérique
d'entrée, l'interface bascule sur le micro du navigateur.
"""

import io
import logging
import os
import threading
import wave
from array import array
from collections import deque

logger = logging.getLogger("abd.mic")

SAMPLE_RATE = 16_000
CHANNELS = 1
SAMPLE_WIDTH = 2  # int16

SEGMENT_SECONDS = 4.0
# Seuil de silence sur échantillons int16 (~1 % de la pleine échelle) :
# les segments muets ne partent jamais en transcription.
SILENCE_RMS = 300

# Garde-fou : une prise unique ne peut excéder 60 s.
MAX_TAKE_SECONDS = 60.0


def _rms(pcm: bytes) -> float:
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if not samples:
        return 0.0
    total = 0
    for value in samples:
        total += value * value
    return (total / len(samples)) ** 0.5


def _wav_bytes(pcm: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(CHANNELS)
        handle.setsampwidth(SAMPLE_WIDTH)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm)
    return buffer.getvalue()


def transcribe_wav(data: bytes) -> str:
    """Whisper via Groq (même clé API que le reste du noyau)."""
    from groq import Groq

    api_key = os.getenv("GROQ_API_KEY")
    if not api_key or api_key == "votre_cle_ici":
        raise RuntimeError("GROQ_API_KEY absente — transcription impossible")
    client = Groq(api_key=api_key)
    result = client.audio.transcriptions.create(
        file=("audio.wav", data),
        model="whisper-large-v3-turbo",
        language="fr",
    )
    return (result.text or "").strip()


class MicEngine:
    """Capture micro exclusive : une seule prise ou un seul flux continu
    à la fois (le périphérique n'est ouvert que pendant l'écoute)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stream = None
        self._frames: list[bytes] = []
        self._continuous = False
        self._segment_frames = 0
        self.transcripts: deque[str] = deque()

    # ----- cycle de vie ------------------------------------------------

    def start(self, continuous: bool) -> None:
        try:
            import sounddevice as sd
        except ImportError as exc:
            raise RuntimeError(
                "module sounddevice manquant : pip install sounddevice"
            ) from exc

        with self._lock:
            if self._stream is not None:
                raise RuntimeError("micro déjà en cours d'utilisation")
            self._frames = []
            self._segment_frames = 0
            self._continuous = continuous

        try:
            stream = sd.RawInputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype="int16",
                callback=self._on_audio,
            )
            stream.start()
        except Exception as exc:
            with self._lock:
                self._stream = None
            raise RuntimeError(f"micro indisponible : {exc}") from exc

        with self._lock:
            self._stream = stream
        logger.info(
            "Micro noyau ouvert (%s)", "continu" if continuous else "prise unique"
        )

    def stop(self) -> bytes | None:
        """Ferme le micro. Mode prise unique : renvoie le WAV capturé."""
        with self._lock:
            stream = self._stream
            self._stream = None
            pcm = b"".join(self._frames)
            self._frames = []
            continuous = self._continuous
            self._continuous = False

        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass
            logger.info("Micro noyau fermé")

        if continuous:
            # Dernier segment entamé : transcrit s'il contient de la voix.
            self._queue_segment(pcm)
            return None
        return _wav_bytes(pcm) if pcm else None

    @property
    def active(self) -> bool:
        with self._lock:
            return self._stream is not None

    # ----- flux audio ---------------------------------------------------

    def _on_audio(self, indata, frames, _time, status) -> None:
        if status:
            logger.warning("Micro : %s", status)
        with self._lock:
            if self._stream is None:
                return
            # Garde-fou : une prise unique pleine cesse d'accumuler.
            if (
                not self._continuous
                and self._segment_frames >= SAMPLE_RATE * MAX_TAKE_SECONDS
            ):
                return
            self._frames.append(bytes(indata))
            self._segment_frames += frames

            if (
                not self._continuous
                or self._segment_frames < SAMPLE_RATE * SEGMENT_SECONDS
            ):
                return
            pcm = b"".join(self._frames)
            self._frames = []
            self._segment_frames = 0
        self._queue_segment(pcm)

    def _queue_segment(self, pcm: bytes) -> None:
        if not pcm or _rms(pcm) < SILENCE_RMS:
            return
        threading.Thread(
            target=self._transcribe_segment, args=(pcm,), daemon=True
        ).start()

    def _transcribe_segment(self, pcm: bytes) -> None:
        try:
            text = transcribe_wav(_wav_bytes(pcm))
        except Exception as exc:
            logger.error("Transcription du segment impossible : %s", exc)
            return
        if text:
            with self._lock:
                self.transcripts.append(text)

    def drain(self) -> list[str]:
        """Récupère (et vide) les transcriptions du mode continu."""
        with self._lock:
            lines = list(self.transcripts)
            self.transcripts.clear()
        return lines


_engine: MicEngine | None = None
_engine_lock = threading.Lock()


def get_engine() -> MicEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = MicEngine()
        return _engine

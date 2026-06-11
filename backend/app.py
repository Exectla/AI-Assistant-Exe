"""A.B.D. (Advanced Brain Understanding) — Backend FastAPI.

Expose /api/chat : relaie les messages vers Groq (Llama-3) et diffuse la
réponse en streaming (fragments de texte transmis dès réception).
"""

import logging
import os
import sys
from collections.abc import Iterator
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from groq import Groq
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="[A.B.D.] %(levelname)s — %(message)s")
logger = logging.getLogger("abd")


def _load_env() -> None:
    """Charge .env depuis l'emplacement le plus pertinent.

    Ordre : à côté de l'exécutable (mode gelé PyInstaller), racine du
    projet, puis répertoire courant — pour que le lancement fonctionne
    quel que soit le dossier d'où l'on démarre.
    """
    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / ".env")
    candidates.append(Path(__file__).resolve().parent.parent / ".env")
    candidates.append(Path.cwd() / ".env")

    for candidate in candidates:
        if candidate.is_file():
            load_dotenv(candidate)
            logger.info("Configuration chargée : %s", candidate)
            return
    logger.warning(
        "Aucun fichier .env trouvé (emplacements testés : %s). "
        "Créez-le à partir de .env.example avec votre GROQ_API_KEY.",
        ", ".join(str(c) for c in candidates),
    )


_load_env()

app = FastAPI(title="A.B.D. Core", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

SYSTEM_PROMPT = (
    "Tu es A.B.D. (Advanced Brain Understanding), une intelligence artificielle "
    "élégante, calme et précise. Tu réponds toujours en français, de manière "
    "concise et raffinée."
)

MODEL = "llama-3.3-70b-versatile"


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []


class TTSRequest(BaseModel):
    text: str


TTS_VOICE = "fr-FR-HenriNeural"


def get_client() -> Groq:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key or api_key == "votre_cle_ici":
        logger.error("GROQ_API_KEY absente ou non remplacée dans .env")
        raise HTTPException(
            status_code=503,
            detail=(
                "Clé API Groq absente. Créez un fichier .env à côté de "
                "l'application contenant : GROQ_API_KEY=votre_vraie_cle "
                "(clé gratuite sur console.groq.com)."
            ),
        )
    return Groq(api_key=api_key)


@app.get("/api/health")
def health() -> dict:
    api_key = os.getenv("GROQ_API_KEY")
    return {
        "status": "online",
        "system": "A.B.D.",
        "key_configured": bool(api_key and api_key != "votre_cle_ici"),
    }


@app.post("/api/chat")
def chat(request: ChatRequest) -> StreamingResponse:
    client = get_client()
    logger.info("Requête reçue (%d caractères, %d messages d'historique)",
                len(request.message), len(request.history))

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages += [{"role": m.role, "content": m.content} for m in request.history]
    messages.append({"role": "user", "content": request.message})

    try:
        stream = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            temperature=0.7,
            max_tokens=1024,
            stream=True,
        )
    except Exception as exc:  # erreurs réseau / API Groq
        logger.error("Échec de l'appel Groq : %s", exc)
        raise HTTPException(status_code=502, detail=f"Erreur Groq : {exc}") from exc

    def token_generator() -> Iterator[str]:
        for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta

    return StreamingResponse(
        token_generator(),
        media_type="text/plain; charset=utf-8",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@app.post("/api/tts")
async def tts(request: TTSRequest) -> StreamingResponse:
    """Synthèse vocale neuronale (Edge-TTS, voix fr-FR-HenriNeural).

    Diffuse le MP3 au fil de la génération. Gratuit, sans clé API —
    nécessite simplement une connexion internet.
    """
    try:
        import edge_tts
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="Module edge-tts manquant : pip install edge-tts",
        ) from exc

    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Texte vide.")

    logger.info("Synthèse vocale (%d caractères, voix %s)", len(text), TTS_VOICE)
    communicate = edge_tts.Communicate(text, TTS_VOICE)
    stream = communicate.stream()

    # On valide le premier fragment AVANT de répondre : une panne du
    # service devient un 502 franc et le client bascule immédiatement
    # sur la synthèse locale, au lieu de recevoir un 200 vide.
    first_audio = None
    try:
        async for chunk in stream:
            if chunk["type"] == "audio":
                first_audio = chunk["data"]
                break
    except Exception as exc:
        logger.error("Échec de la synthèse Edge-TTS : %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Service de synthèse vocale injoignable : {exc}",
        ) from exc

    if first_audio is None:
        raise HTTPException(status_code=502, detail="Aucun audio produit par Edge-TTS.")

    async def audio_stream():
        yield first_audio
        try:
            async for chunk in stream:
                if chunk["type"] == "audio":
                    yield chunk["data"]
        except Exception as exc:
            # Coupure en cours de flux : le client jouera ce qu'il a reçu.
            logger.error("Flux Edge-TTS interrompu : %s", exc)

    return StreamingResponse(audio_stream(), media_type="audio/mpeg")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8756)

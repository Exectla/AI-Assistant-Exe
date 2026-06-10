"""A.B.D. (Advanced Brain Understanding) — Backend FastAPI.

Expose /api/chat : relaie les messages vers Groq (Llama-3) et diffuse la
réponse en streaming (fragments de texte transmis dès réception).
"""

import os
from collections.abc import Iterator

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from groq import Groq
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="A.B.D. Core", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
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


def get_client() -> Groq:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY manquante (voir .env.example)")
    return Groq(api_key=api_key)


@app.get("/api/health")
def health() -> dict:
    return {"status": "online", "system": "A.B.D."}


@app.post("/api/chat")
def chat(request: ChatRequest) -> StreamingResponse:
    client = get_client()

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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8756)

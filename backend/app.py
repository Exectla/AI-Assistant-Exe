"""A.B.D. (Advanced Brain Understanding) — Backend FastAPI.

Expose /api/chat : relaie les messages vers Groq (Llama-3) et renvoie la réponse.
"""

import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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


class ChatResponse(BaseModel):
    reply: str


def get_client() -> Groq:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY manquante (voir .env.example)")
    return Groq(api_key=api_key)


@app.get("/api/health")
def health() -> dict:
    return {"status": "online", "system": "A.B.D."}


@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    client = get_client()

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages += [{"role": m.role, "content": m.content} for m in request.history]
    messages.append({"role": "user", "content": request.message})

    try:
        completion = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            temperature=0.7,
            max_tokens=1024,
        )
    except Exception as exc:  # erreurs réseau / API Groq
        raise HTTPException(status_code=502, detail=f"Erreur Groq : {exc}") from exc

    reply = completion.choices[0].message.content or ""
    return ChatResponse(reply=reply)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8756)

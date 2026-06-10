"""A.B.D. — Lanceur natif.

Démarre le backend FastAPI en arrière-plan puis ouvre l'interface dans une
fenêtre pywebview sans bordures, thème sombre.
"""

import sys
import threading
import time
from pathlib import Path

import webview

ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = ROOT / "frontend" / "index.html"

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8756


def start_backend() -> None:
    sys.path.insert(0, str(ROOT))
    import uvicorn

    from backend.app import app

    uvicorn.run(app, host=BACKEND_HOST, port=BACKEND_PORT, log_level="warning")


def main() -> None:
    backend = threading.Thread(target=start_backend, daemon=True)
    backend.start()
    time.sleep(1.0)  # laisse le serveur s'initialiser

    window = webview.create_window(
        title="A.B.D.",
        url=INDEX_HTML.as_uri(),
        width=1280,
        height=800,
        frameless=True,
        easy_drag=True,
        background_color="#000000",
    )
    webview.start(gui=None, debug=False)
    _ = window


if __name__ == "__main__":
    main()

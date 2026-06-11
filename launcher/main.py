"""A.B.D. — Lanceur natif.

Démarre le backend FastAPI en arrière-plan puis ouvre l'interface dans une
fenêtre pywebview sans bordures, thème sombre.
"""

import os
import sys
import threading
import time
import urllib.request
from pathlib import Path

import webview

# En mode exécutable PyInstaller, les ressources sont extraites dans _MEIPASS.
if getattr(sys, "frozen", False):
    ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
else:
    ROOT = Path(__file__).resolve().parent.parent

INDEX_HTML = ROOT / "frontend" / "index.html"

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8756


def start_backend() -> None:
    try:
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import uvicorn

        from backend.app import app

        uvicorn.run(app, host=BACKEND_HOST, port=BACKEND_PORT, log_level="info")
    except Exception as exc:  # rend visible un crash du thread serveur
        print(f"[A.B.D.] ERREUR FATALE du noyau : {exc}", file=sys.stderr)


def wait_for_backend(timeout_s: float = 15.0) -> bool:
    """Sonde /api/health jusqu'à ce que le noyau réponde (ou expiration)."""
    url = f"http://{BACKEND_HOST}:{BACKEND_PORT}/api/health"
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1):
                return True
        except Exception:
            time.sleep(0.25)
    return False


class SystemApi:
    """API exposée au JavaScript via window.pywebview.api."""

    def __init__(self) -> None:
        self.window = None

    def quit(self) -> None:
        """Kill switch (touche Échap) : fermeture instantanée et propre."""
        print("[A.B.D.] Kill switch — extinction immédiate")
        try:
            if self.window is not None:
                self.window.destroy()
        finally:
            os._exit(0)


def main() -> None:
    print("[A.B.D.] Démarrage du noyau…")
    backend = threading.Thread(target=start_backend, daemon=True)
    backend.start()

    if wait_for_backend():
        print(f"[A.B.D.] Noyau en ligne : http://{BACKEND_HOST}:{BACKEND_PORT}")
    else:
        print(
            "[A.B.D.] AVERTISSEMENT : le noyau ne répond pas après 15 s — "
            "l'interface tentera une reconnexion automatique.",
            file=sys.stderr,
        )

    api = SystemApi()
    window = webview.create_window(
        title="A.B.D.",
        url=INDEX_HTML.as_uri(),
        fullscreen=True,
        frameless=True,
        background_color="#000000",
        js_api=api,
    )
    api.window = window
    webview.start(gui=None, debug=False)


if __name__ == "__main__":
    main()

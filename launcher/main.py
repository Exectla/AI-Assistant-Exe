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
    """API exposée au JavaScript via window.pywebview.api.

    Important : la référence à la fenêtre est PRIVÉE (préfixe _) —
    pywebview expose et sérialise tous les attributs publics de cet
    objet vers le JavaScript, et exposer la fenêtre native déclenche
    une introspection récursive infinie des objets COM Windows.
    """

    def __init__(self) -> None:
        self._window = None

    def _attach(self, window) -> None:
        """Privé : non exposé au pont JavaScript."""
        self._window = window

    def quit(self) -> None:
        """Kill switch (touche Échap) : fermeture instantanée et propre."""
        print("[A.B.D.] Kill switch — extinction immédiate")
        try:
            if self._window is not None:
                self._window.destroy()
        finally:
            os._exit(0)


def force_media_permissions() -> None:
    """Autorise d'office micro et caméra dans le moteur web.

    Équivalent pywebview/WebView2 du setPermissionRequestHandler
    d'Electron : ces drapeaux Chromium font accepter automatiquement
    toute demande getUserMedia (audioCapture/videoCapture) sans boîte
    de dialogue, et libèrent la lecture audio sans clic préalable.
    Doit être positionné AVANT la création du moteur WebView2.
    """
    flags = (
        "--use-fake-ui-for-media-stream "
        "--enable-media-stream "
        "--autoplay-policy=no-user-gesture-required"
    )
    existing = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"{existing} {flags}".strip()


def main() -> None:
    print("[A.B.D.] Démarrage du noyau…")
    force_media_permissions()
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
    # Verrouillage absolu (mode kiosque) : fenêtre ancrée de manière rigide —
    # ni déplaçable, ni redimensionnable, toujours au premier plan.
    # easy_drag=False est crucial : pywebview l'active par défaut sur les
    # fenêtres frameless, ce qui permettait de saisir et déplacer la fenêtre
    # avec la souris depuis n'importe quel point de l'interface.
    window = webview.create_window(
        title="A.B.D.",
        url=INDEX_HTML.as_uri(),
        fullscreen=True,
        frameless=True,
        easy_drag=False,
        resizable=False,
        on_top=True,
        background_color="#000000",
        js_api=api,
    )
    api._attach(window)
    webview.start(gui=None, debug=False)


if __name__ == "__main__":
    main()

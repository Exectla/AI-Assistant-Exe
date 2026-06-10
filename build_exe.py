"""A.B.D. — Script de build d'un exécutable autonome (PyInstaller).

Produit un fichier unique (dist/ABD ou dist/ABD.exe) embarquant le backend
FastAPI, le lanceur pywebview et toutes les ressources frontend. Python
n'est pas requis sur la machine cible.

Usage :
    pip install pyinstaller
    python build_exe.py
"""

import os
import sys
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent
SEP = os.pathsep  # ':' sous Linux/macOS, ';' sous Windows

ARGS = [
    str(ROOT / "launcher" / "main.py"),
    "--name=ABD",
    "--onefile",
    "--windowed",
    "--noconfirm",
    "--clean",
    # Résolution des imports du projet (backend.app)
    f"--paths={ROOT}",
    "--hidden-import=backend",
    "--hidden-import=backend.app",
    # Ressources statiques embarquées dans l'exécutable
    f"--add-data={ROOT / 'frontend'}{SEP}frontend",
    # Sous-modules chargés dynamiquement par uvicorn
    "--hidden-import=uvicorn.logging",
    "--hidden-import=uvicorn.loops",
    "--hidden-import=uvicorn.loops.auto",
    "--hidden-import=uvicorn.protocols",
    "--hidden-import=uvicorn.protocols.http",
    "--hidden-import=uvicorn.protocols.http.auto",
    "--hidden-import=uvicorn.protocols.websockets",
    "--hidden-import=uvicorn.protocols.websockets.auto",
    "--hidden-import=uvicorn.lifespan",
    "--hidden-import=uvicorn.lifespan.on",
    "--hidden-import=uvicorn.lifespan.off",
]


def main() -> None:
    print(f"[A.B.D.] Build PyInstaller — plateforme : {sys.platform}")
    PyInstaller.__main__.run(ARGS)
    suffix = ".exe" if sys.platform.startswith("win") else ""
    print(f"[A.B.D.] Exécutable généré : {ROOT / 'dist' / ('ABD' + suffix)}")
    print("[A.B.D.] Placez un fichier .env (GROQ_API_KEY=...) à côté de l'exécutable.")


if __name__ == "__main__":
    main()

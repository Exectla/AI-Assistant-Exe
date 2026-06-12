"""A.B.D. — Spatial RAG (Reasoning & Awareness Graph).

Indexe le répertoire local ``ABD_Database`` (créé automatiquement avec
ses sous-dossiers par défaut) et extrait le texte des documents pour les
charger dans le contexte du modèle. Chaque fichier devient un nœud du
graphe spatial ; une pince sur un nœud ouvre le panneau de lecture.
"""

import logging
import sys
from datetime import datetime
from pathlib import Path

logger = logging.getLogger("abd.rag")

DATABASE_NAME = "ABD_Database"
# Ancien nom (avant la rectification d'identité du système) : migré
# automatiquement au démarrage pour préserver les documents existants.
LEGACY_DATABASE_NAME = "IRIS_Database"

DEFAULT_FOLDERS = {
    "Bac_SES_2026": (
        "Notes_de_cadrage.txt",
        "Base de connaissances Bac SES 2026.\n\n"
        "Déposez ici vos fiches de révision, annales et plans de\n"
        "dissertation (formats .txt, .md ou .pdf). Chaque fichier\n"
        "apparaîtra comme un nœud dans l'ordinateur spatial.\n",
    ),
    "Projet_Robots_Shenzhen": (
        "Brief_initial.txt",
        "Projet Robots Shenzhen.\n\n"
        "Centralisez ici les specs, comptes-rendus fournisseurs et\n"
        "nomenclatures. Une pince sur un nœud ouvre le document et\n"
        "permet de l'interroger à la voix.\n",
    ),
    "Checklists_A320neo": (
        "Memo_checklists.txt",
        "Checklists A320neo.\n\n"
        "Stockez ici vos checklists et procédures au format texte ou\n"
        "PDF pour les consulter dans le panneau de lecture.\n",
    ),
}

TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".log", ".json"}
PDF_EXTENSIONS = {".pdf"}
INDEXED_EXTENSIONS = TEXT_EXTENSIONS | PDF_EXTENSIONS

MAX_CONTENT_CHARS = 40_000


def database_root() -> Path:
    """ABD_Database à la racine du projet (ou à côté de l'exécutable)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / DATABASE_NAME
    return Path(__file__).resolve().parent.parent / DATABASE_NAME


def _migrate_legacy_database(root: Path) -> None:
    """Renomme l'ancien dossier IRIS_Database en ABD_Database."""
    legacy = root.parent / LEGACY_DATABASE_NAME
    if legacy.is_dir() and not root.exists():
        try:
            legacy.rename(root)
            logger.info("Base migrée : %s → %s", legacy.name, root.name)
        except OSError as exc:
            logger.warning("Migration de %s impossible : %s", legacy, exc)


def ensure_database() -> Path:
    """Crée l'arborescence par défaut au premier lancement."""
    root = database_root()
    _migrate_legacy_database(root)
    created = not root.exists()
    for folder, (sample_name, sample_text) in DEFAULT_FOLDERS.items():
        directory = root / folder
        directory.mkdir(parents=True, exist_ok=True)
        sample = directory / sample_name
        if created or not any(directory.iterdir()):
            sample.write_text(sample_text, encoding="utf-8")
    if created:
        logger.info("Base spatiale initialisée : %s", root)
    return root


def build_index() -> dict:
    """Arborescence {dossiers: [fichiers]} consommée par le graphe 3D."""
    root = ensure_database()
    folders = []
    for directory in sorted(p for p in root.iterdir() if p.is_dir()):
        files = []
        for path in sorted(directory.rglob("*")):
            if path.is_file() and path.suffix.lower() in INDEXED_EXTENSIONS:
                files.append({
                    "name": path.name,
                    "path": str(path.relative_to(root)).replace("\\", "/"),
                    "size": path.stat().st_size,
                    "ext": path.suffix.lower().lstrip("."),
                })
        folders.append({"name": directory.name, "files": files})
    return {"root": str(root), "folders": folders}


def read_document(relative_path: str) -> dict:
    """Extrait le texte d'un document de la base (txt/md/pdf).

    Refuse tout chemin sortant de ABD_Database (traversée interdite).
    """
    root = ensure_database().resolve()
    target = (root / relative_path).resolve()
    if root not in target.parents and target != root:
        raise PermissionError("chemin hors de ABD_Database")
    if not target.is_file():
        raise FileNotFoundError(relative_path)

    suffix = target.suffix.lower()
    if suffix in TEXT_EXTENSIONS:
        content = target.read_text(encoding="utf-8", errors="replace")
    elif suffix in PDF_EXTENSIONS:
        content = _extract_pdf(target)
    else:
        raise ValueError(f"format non indexé : {suffix}")

    truncated = len(content) > MAX_CONTENT_CHARS
    if truncated:
        content = content[:MAX_CONTENT_CHARS]

    return {
        "name": target.name,
        "path": relative_path,
        "content": content,
        "truncated": truncated,
    }


SHADOW_LOGS_FOLDER = "Shadow_Logs"


def export_shadow_log(lines: list) -> dict:
    """Export manuel du Shadow Workspace : fichier .md horodaté.

    C'est l'UNIQUE voie de persistance du brouillon : tant que ce
    bouton n'est pas actionné, les lignes vivent exclusivement en
    mémoire vive de l'interface et disparaissent avec le kill switch.
    Le fichier rejoint ABD_Database/Shadow_Logs/ et devient donc un
    nœud du graphe spatial comme tout autre document.
    """
    root = ensure_database()
    folder = root / SHADOW_LOGS_FOLDER
    folder.mkdir(parents=True, exist_ok=True)

    now = datetime.now()
    path = folder / f"Shadow_{now.strftime('%Y-%m-%d_%H-%M-%S')}.md"
    header = f"# Shadow Workspace — {now.strftime('%d/%m/%Y %H:%M:%S')}\n"
    body = "\n".join(f"- {line}" for line in lines)
    path.write_text(f"{header}\n{body}\n", encoding="utf-8")
    logger.info("Shadow Workspace exporté : %s (%d lignes)", path.name, len(lines))

    return {
        "name": path.name,
        "path": str(path.relative_to(root)).replace("\\", "/"),
        "lines": len(lines),
    }


def _extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError(
            "module pypdf manquant pour lire les PDF : pip install pypdf"
        ) from exc

    reader = PdfReader(str(path))
    pages = []
    for page in reader.pages:
        pages.append(page.extract_text() or "")
        if sum(len(p) for p in pages) > MAX_CONTENT_CHARS:
            break
    return "\n\n".join(pages)

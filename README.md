# A.B.D. — Advanced Brain Understanding

Assistant IA de bureau « Dark Luxury » : backend FastAPI + Groq (Llama-3),
fenêtre native sans bordures (pywebview), audio 100 % procédural (Web Audio
API) et interaction vocale en français.

## Architecture

```
backend/app.py      Serveur FastAPI — /api/chat en streaming (Groq Llama-3)
launcher/main.py    Lanceur natif pywebview (frameless, thème sombre)
frontend/           index.html, style.css, app.js (AudioEngine, UISystem, SpeechController)
build_exe.py        Build d'un exécutable autonome (PyInstaller)
```

## Démarrage (développement)

```bash
pip install -r requirements.txt
cp .env.example .env        # renseigner GROQ_API_KEY
python launcher/main.py
```

Le backend écoute sur `http://127.0.0.1:8756` ; les réponses de `/api/chat`
sont diffusées en streaming (fragments de texte transmis dès réception) et
affichées progressivement dans l'interface (effet « typing »).

## Build exécutable autonome

Produit un fichier unique embarquant le backend, le lanceur et toutes les
ressources `frontend/` — aucun Python requis sur la machine cible.

```bash
pip install -r requirements.txt pyinstaller
python build_exe.py
```

Résultat : `dist/ABD` (Linux/macOS) ou `dist/ABD.exe` (Windows).

> **Important** : placez un fichier `.env` contenant `GROQ_API_KEY=...`
> à côté de l'exécutable avant de le lancer.
>
> L'exécutable doit être construit sur la plateforme cible (PyInstaller
> ne cross-compile pas : un `.exe` Windows se construit sous Windows).

## Configuration

| Variable       | Description                          |
| -------------- | ------------------------------------ |
| `GROQ_API_KEY` | Clé API Groq (https://console.groq.com) |

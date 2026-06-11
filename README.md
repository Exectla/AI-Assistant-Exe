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

## Voix

Les réponses sont lues par la voix neuronale **fr-FR-HenriNeural**
(Edge-TTS, gratuit, sans clé API — nécessite internet), traitée par la
Web Audio API : EQ basses renforcées + légère réverbération métallique.
Hors connexion, l'application bascule automatiquement sur la synthèse
vocale locale du système.

## Ordinateur spatial (HUD)

Faites le **signe « V »** (index et majeur levés) devant la webcam pendant
0,5 s — ou appuyez sur la **touche V** — pour que l'orbe se métamorphose
en HUD plein écran : graphe de connaissances 3D, curseur spatial suivant
la main, parallaxe caméra. Refaites le geste pour replier le HUD.

La détection gestuelle (MediaPipe, côté serveur Python) est optionnelle :

```bash
pip install mediapipe
```

Sans webcam ou sans ce module, la touche V reste pleinement fonctionnelle.

## Spatial RAG — IRIS_Database

Au premier lancement, un dossier **`IRIS_Database/`** est créé à la racine
du projet (sous-dossiers d'exemple : `Bac_SES_2026`,
`Projet_Robots_Shenzhen`, `Checklists_A320neo`). Déposez-y vos documents
(`.txt`, `.md`, `.pdf`…) : chacun devient un **nœud 3D** dans l'ordinateur
spatial.

Survolez un nœud avec le curseur spatial puis faites une **pince**
(pouce + index joints) — ou un simple clic — pour ouvrir le document dans
un panneau de verre flottant. Le contenu est chargé dans le contexte du
noyau : posez vos questions à la voix ou au clavier, A.B.D. répond en
s'appuyant sur ce document précis.

## Contrôles

| Action | Effet |
| ------ | ----- |
| Signe ✌️ (0,5 s) ou touche `V` | Déployer / replier l'ordinateur spatial |
| Pince 🤏 ou clic sur un nœud | Ouvrir le document dans le panneau de lecture |
| Geste 👌 (0,8 s) ou touche `B` | **Scan biométrique** — Face Mesh 468 points, flux caméra, nappe 30 Hz |
| Touche `Échap` | **Kill switch** — extinction instantanée de l'application |

L'application démarre en **plein écran strict** (fenêtre sans bordures).

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

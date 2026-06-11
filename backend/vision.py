"""A.B.D. — Moteur de vision gestuelle (MediaPipe Hands).

Capture la webcam côté serveur, détecte le signe "V" (index et majeur
levés, annulaire et auriculaire repliés) avec un debounce de 0,5 s, et
publie la position de la main pour le curseur spatial et la parallaxe.

Compatible avec les deux générations de MediaPipe :
  - API héritée ``mediapipe.solutions.hands`` (anciennes versions) ;
  - API "Tasks" ``HandLandmarker`` (versions récentes / Python 3.13+),
    avec téléchargement automatique du modèle au premier lancement.

Module entièrement optionnel : si `mediapipe` n'est pas installé ou
qu'aucune caméra n'est disponible, l'application fonctionne normalement
(le geste est remplacé par la touche V au clavier).
"""

import logging
import sys
import threading
import time
import urllib.request
from collections import deque
from pathlib import Path

logger = logging.getLogger("abd.vision")

# Debounce : maintien stable requis avant déclenchement, puis temps de
# relâche minimal avant de pouvoir re-déclencher.
HOLD_SECONDS = 0.5
RELEASE_SECONDS = 0.4

CAPTURE_WIDTH = 640
CAPTURE_HEIGHT = 360
CAPTURE_FPS = 30

# Modèle de l'API Tasks (~8 Mo), téléchargé une seule fois puis mis en cache.
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)


def is_pinch(landmarks) -> bool:
    """Pince : pouce (4) et index (8) joints.

    Le seuil est relatif à la taille de la main (distance poignet 0 →
    base du majeur 9) pour rester stable quelle que soit la distance
    à la caméra.
    """
    dx = landmarks[4].x - landmarks[8].x
    dy = landmarks[4].y - landmarks[8].y
    pinch_dist = (dx * dx + dy * dy) ** 0.5

    hx = landmarks[0].x - landmarks[9].x
    hy = landmarks[0].y - landmarks[9].y
    hand_size = (hx * hx + hy * hy) ** 0.5

    if hand_size < 1e-5:
        return False
    return pinch_dist < hand_size * 0.45


def is_v_sign(landmarks) -> bool:
    """Détection stricte du signe "V" (Peace).

    Index (8) et majeur (12) tendus : leur extrémité est plus haute à
    l'écran (Y inférieur) que leur articulation PIP respective (6, 10).
    Annulaire (16) et auriculaire (20) repliés : extrémité plus basse
    (Y supérieur) que leur PIP (14, 18).
    """
    return (
        landmarks[8].y < landmarks[6].y
        and landmarks[12].y < landmarks[10].y
        and landmarks[16].y > landmarks[14].y
        and landmarks[20].y > landmarks[18].y
    )


def _model_dir() -> Path:
    """Dossier de cache du modèle (à côté de l'exécutable en mode gelé)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "models"
    return Path(__file__).resolve().parent / "models"


def _ensure_model() -> Path:
    """Télécharge hand_landmarker.task au premier usage, puis le réutilise."""
    path = _model_dir() / "hand_landmarker.task"
    if path.is_file() and path.stat().st_size > 1_000_000:
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Téléchargement du modèle de détection de main (~8 Mo)…")
    tmp = path.with_suffix(".tmp")
    urllib.request.urlretrieve(MODEL_URL, tmp)
    tmp.replace(path)
    logger.info("Modèle enregistré : %s", path)
    return path


class _LegacyHandsAdapter:
    """API héritée : mediapipe.solutions.hands (mediapipe ≤ 0.10.x)."""

    def __init__(self, mp_module) -> None:
        self._hands = mp_module.solutions.hands.Hands(
            static_image_mode=False,
            max_num_hands=1,
            model_complexity=0,
            min_detection_confidence=0.6,
            min_tracking_confidence=0.5,
        )

    def detect(self, rgb_frame, _timestamp_ms: int):
        result = self._hands.process(rgb_frame)
        if result.multi_hand_landmarks:
            return result.multi_hand_landmarks[0].landmark
        return None

    def close(self) -> None:
        self._hands.close()


class _TasksHandsAdapter:
    """API moderne : mediapipe.tasks HandLandmarker (Python 3.13+)."""

    def __init__(self, mp_module) -> None:
        from mediapipe.tasks import python as tasks_python
        from mediapipe.tasks.python import vision as tasks_vision

        self._mp = mp_module
        options = tasks_vision.HandLandmarkerOptions(
            base_options=tasks_python.BaseOptions(
                model_asset_path=str(_ensure_model())
            ),
            running_mode=tasks_vision.RunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=0.6,
            min_tracking_confidence=0.5,
        )
        self._landmarker = tasks_vision.HandLandmarker.create_from_options(options)

    def detect(self, rgb_frame, timestamp_ms: int):
        image = self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB, data=rgb_frame
        )
        result = self._landmarker.detect_for_video(image, timestamp_ms)
        if result.hand_landmarks:
            return result.hand_landmarks[0]
        return None

    def close(self) -> None:
        self._landmarker.close()


def _create_adapter(mp_module):
    """Choisit l'API disponible dans la version de MediaPipe installée."""
    if hasattr(mp_module, "solutions") and hasattr(mp_module.solutions, "hands"):
        logger.info("MediaPipe : API héritée (solutions.hands)")
        return _LegacyHandsAdapter(mp_module)
    logger.info("MediaPipe : API Tasks (HandLandmarker)")
    return _TasksHandsAdapter(mp_module)


class GestureEngine:
    """Boucle de capture dans un thread dédié.

    État partagé sous verrou : position de main la plus récente et file
    d'événements gestuels — consommés par le WebSocket /ws/vision.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread = None
        self._running = False
        self._clients = 0

        self.available = False
        self.reason = "non démarré"
        self.hand = {"present": False, "x": 0.5, "y": 0.5}
        self.events: deque = deque(maxlen=16)

    # ----- cycle de vie -------------------------------------------------

    def acquire(self) -> None:
        """Un client WebSocket se connecte : démarre la capture si besoin."""
        with self._lock:
            self._clients += 1
            if not self._running:
                self._running = True
                self._thread = threading.Thread(target=self._loop, daemon=True)
                self._thread.start()

    def release(self) -> None:
        """Un client se déconnecte : coupe la caméra quand plus personne n'écoute."""
        with self._lock:
            self._clients = max(0, self._clients - 1)
            if self._clients == 0:
                self._running = False

    # ----- accès thread-safe pour le WebSocket --------------------------

    def snapshot(self) -> dict:
        with self._lock:
            events = list(self.events)
            self.events.clear()
            return {
                "available": self.available,
                "reason": self.reason,
                "hand": dict(self.hand),
                "events": events,
            }

    def _set_unavailable(self, reason: str) -> None:
        with self._lock:
            self.available = False
            self.reason = reason
            self._running = False
        logger.warning("Vision indisponible — %s", reason)

    # ----- boucle de capture --------------------------------------------

    def _loop(self) -> None:
        capture = None
        adapter = None
        try:
            try:
                import cv2
            except ImportError:
                self._set_unavailable(
                    "module cv2 manquant (pip install opencv-python)"
                )
                return
            try:
                import mediapipe as mp
            except ImportError:
                self._set_unavailable(
                    "module mediapipe manquant (pip install mediapipe)"
                )
                return

            backend = (
                cv2.CAP_DSHOW if sys.platform.startswith("win") else cv2.CAP_ANY
            )
            capture = cv2.VideoCapture(0, backend)
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_WIDTH)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_HEIGHT)
            capture.set(cv2.CAP_PROP_FPS, CAPTURE_FPS)

            if not capture.isOpened():
                self._set_unavailable(
                    "aucune caméra détectée (vérifiez les autorisations Windows)"
                )
                return

            adapter = _create_adapter(mp)

            with self._lock:
                self.available = True
                self.reason = ""
            logger.info("Vision gestuelle active (MediaPipe Hands, caméra 0)")

            origin = time.monotonic()
            v_since = None      # début du maintien du signe V
            fired = False       # déjà déclenché pour ce maintien
            released_at = 0.0   # instant de la dernière relâche
            pinch_frames = 0    # frames consécutives en pince
            pinch_active = False

            while True:
                with self._lock:
                    if not self._running:
                        break

                ok, frame = capture.read()
                if not ok:
                    time.sleep(0.05)
                    continue

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                now = time.monotonic()
                landmarks = adapter.detect(rgb, int((now - origin) * 1000))

                present = landmarks is not None
                hand_x, hand_y = 0.5, 0.5
                v_now = False
                pinch_now = False

                if present:
                    # Paume (repère 9), X miroir pour un contrôle naturel
                    hand_x = 1.0 - landmarks[9].x
                    hand_y = landmarks[9].y
                    v_now = is_v_sign(landmarks)
                    pinch_now = is_pinch(landmarks)

                # Pince : 2 frames stables avant déclenchement (anti-bruit),
                # un seul événement par fermeture de pince.
                if pinch_now:
                    pinch_frames += 1
                    if pinch_frames >= 2 and not pinch_active:
                        pinch_active = True
                        with self._lock:
                            self.events.append(
                                {"type": "gesture", "name": "pinch"}
                            )
                else:
                    pinch_frames = 0
                    pinch_active = False

                if v_now:
                    if v_since is None:
                        v_since = now
                    held = now - v_since
                    if (
                        not fired
                        and held >= HOLD_SECONDS
                        and now - released_at >= RELEASE_SECONDS
                    ):
                        fired = True
                        with self._lock:
                            self.events.append(
                                {"type": "gesture", "name": "v_sign"}
                            )
                        logger.info("Signe V validé (maintenu %.2f s)", held)
                else:
                    if fired:
                        released_at = now
                    v_since = None
                    fired = False

                with self._lock:
                    self.hand = {
                        "present": present,
                        "x": round(hand_x, 4),
                        "y": round(hand_y, 4),
                        "pinch": pinch_active,
                    }

                time.sleep(1.0 / CAPTURE_FPS)

            with self._lock:
                self.available = False
                self.reason = "caméra arrêtée"
            logger.info("Vision gestuelle arrêtée")
        except Exception as exc:
            # Quoi qu'il arrive, le moteur signale la cause exacte au lieu
            # de mourir silencieusement (et la caméra est toujours libérée).
            logger.exception("Échec du moteur de vision")
            self._set_unavailable(f"{type(exc).__name__} : {exc}")
        finally:
            if adapter is not None:
                try:
                    adapter.close()
                except Exception:
                    pass
            if capture is not None:
                capture.release()


_engine: GestureEngine | None = None
_engine_lock = threading.Lock()


def get_engine() -> GestureEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = GestureEngine()
        return _engine

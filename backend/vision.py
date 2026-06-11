"""A.B.D. — Moteur de vision gestuelle (MediaPipe Hands).

Capture la webcam côté serveur, détecte le signe "V" (index et majeur
levés, annulaire et auriculaire repliés) avec un debounce de 0,5 s, et
publie la position de la main pour le curseur spatial et la parallaxe.

Module entièrement optionnel : si `mediapipe` n'est pas installé ou
qu'aucune caméra n'est disponible, l'application fonctionne normalement
(le geste est remplacé par la touche V au clavier).
"""

import logging
import threading
import time
from collections import deque

logger = logging.getLogger("abd.vision")

# Debounce : maintien stable requis avant déclenchement, puis temps de
# relâche minimal avant de pouvoir re-déclencher.
HOLD_SECONDS = 0.5
RELEASE_SECONDS = 0.4

CAPTURE_WIDTH = 640
CAPTURE_HEIGHT = 360
CAPTURE_FPS = 30


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

    # ----- boucle de capture --------------------------------------------

    def _loop(self) -> None:
        try:
            import cv2
            import mediapipe as mp
        except ImportError as exc:
            with self._lock:
                self.available = False
                self.reason = f"module manquant : {exc.name} (pip install mediapipe)"
                self._running = False
            logger.warning("Vision indisponible — %s", self.reason)
            return

        import sys

        backend = cv2.CAP_DSHOW if sys.platform.startswith("win") else cv2.CAP_ANY
        capture = cv2.VideoCapture(0, backend)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_WIDTH)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_HEIGHT)
        capture.set(cv2.CAP_PROP_FPS, CAPTURE_FPS)

        if not capture.isOpened():
            with self._lock:
                self.available = False
                self.reason = "aucune caméra détectée"
                self._running = False
            logger.warning("Vision indisponible — aucune caméra")
            return

        hands = mp.solutions.hands.Hands(
            static_image_mode=False,
            max_num_hands=1,
            model_complexity=0,
            min_detection_confidence=0.6,
            min_tracking_confidence=0.5,
        )

        with self._lock:
            self.available = True
            self.reason = ""
        logger.info("Vision gestuelle active (MediaPipe Hands, caméra 0)")

        v_since = None      # début du maintien du signe V
        fired = False       # déjà déclenché pour ce maintien
        released_at = 0.0   # instant de la dernière relâche

        try:
            while True:
                with self._lock:
                    if not self._running:
                        break

                ok, frame = capture.read()
                if not ok:
                    time.sleep(0.05)
                    continue

                frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = hands.process(frame)

                now = time.monotonic()
                present = bool(result.multi_hand_landmarks)
                hand_x, hand_y = 0.5, 0.5
                v_now = False

                if present:
                    landmarks = result.multi_hand_landmarks[0].landmark
                    # Paume (repère 9), X miroir pour un contrôle naturel
                    hand_x = 1.0 - landmarks[9].x
                    hand_y = landmarks[9].y
                    v_now = is_v_sign(landmarks)

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
                            self.events.append({"type": "gesture", "name": "v_sign"})
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
                    }

                time.sleep(1.0 / CAPTURE_FPS)
        finally:
            hands.close()
            capture.release()
            with self._lock:
                self.available = False
                self.reason = "caméra arrêtée"
            logger.info("Vision gestuelle arrêtée")


_engine: GestureEngine | None = None
_engine_lock = threading.Lock()


def get_engine() -> GestureEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = GestureEngine()
        return _engine

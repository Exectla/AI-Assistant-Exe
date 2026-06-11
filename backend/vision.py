"""A.B.D. — Moteur de vision gestuelle (MediaPipe Hands + Face Mesh).

Capture la webcam côté serveur et fournit :
  - le signe "V" (debounce 0,5 s) — déploiement de l'ordinateur spatial ;
  - la pince pouce/index (distance euclidienne 3D, point médian publié
    pour une sélection chirurgicale des nœuds) ;
  - le geste "OK" (cercle pouce/index, trois doigts déployés, maintien
    0,8 s) — protocole de scan biométrique ;
  - en mode scan : flux JPEG de la caméra, 468 points du visage
    (Face Mesh) et squelette complet des mains, en temps réel.

Compatible avec les deux générations de MediaPipe (API héritée
``solutions`` et API "Tasks", modèles auto-téléchargés). Module
entièrement optionnel : sans caméra ni MediaPipe, l'application
fonctionne au clavier.
"""

import logging
import sys
import threading
import time
import urllib.request
from collections import deque
from pathlib import Path

logger = logging.getLogger("abd.vision")

# Debounce du signe V : maintien stable requis avant déclenchement.
HOLD_SECONDS = 0.5
# Debounce du geste OK (protocole de scan) : maintien plus long.
OK_HOLD_SECONDS = 0.8
RELEASE_SECONDS = 0.4

# Pince : distance euclidienne 3D pouce(4)/index(8). Plancher absolu de
# la spec (0.03) + adaptation à la taille apparente de la main pour
# rester utilisable loin de la caméra.
PINCH_DIST_3D = 0.03
PINCH_RELATIVE = 0.30

CAPTURE_WIDTH = 640
CAPTURE_HEIGHT = 360
CAPTURE_FPS = 30

SCAN_JPEG_WIDTH = 480
SCAN_JPEG_QUALITY = 70

HAND_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)


# ----------------------------------------------------------------------
# Géométrie des gestes
# ----------------------------------------------------------------------

def _dist3(a, b) -> float:
    dx = a.x - b.x
    dy = a.y - b.y
    dz = getattr(a, "z", 0.0) - getattr(b, "z", 0.0)
    return (dx * dx + dy * dy + dz * dz) ** 0.5


def _hand_size(landmarks) -> float:
    """Taille apparente : poignet (0) → base du majeur (9)."""
    return _dist3(landmarks[0], landmarks[9])


def thumb_index_touching(landmarks) -> bool:
    """Pouce et index joints — distance euclidienne 3D (spec : < 0.03)."""
    threshold = max(PINCH_DIST_3D, _hand_size(landmarks) * PINCH_RELATIVE)
    return _dist3(landmarks[4], landmarks[8]) < threshold


def fingers_extended(landmarks) -> bool:
    """Majeur, annulaire et auriculaire entièrement déployés."""
    return (
        landmarks[12].y < landmarks[10].y
        and landmarks[16].y < landmarks[14].y
        and landmarks[20].y < landmarks[18].y
    )


def is_pinch(landmarks) -> bool:
    """Pince : pouce/index joints, autres doigts non déployés (≠ OK)."""
    return thumb_index_touching(landmarks) and not fingers_extended(landmarks)


def is_ok_sign(landmarks) -> bool:
    """Geste "OK" : cercle pouce/index + trois doigts déployés."""
    return thumb_index_touching(landmarks) and fingers_extended(landmarks)


def pinch_midpoint(landmarks) -> tuple:
    """Point central exact entre le pouce (4) et l'index (8) — le
    "rayon" de sélection part de ce point précis."""
    return (
        (landmarks[4].x + landmarks[8].x) / 2.0,
        (landmarks[4].y + landmarks[8].y) / 2.0,
    )


def is_v_sign(landmarks) -> bool:
    """Signe "V" : index/majeur tendus, annulaire/auriculaire repliés."""
    return (
        landmarks[8].y < landmarks[6].y
        and landmarks[12].y < landmarks[10].y
        and landmarks[16].y > landmarks[14].y
        and landmarks[20].y > landmarks[18].y
    )


# ----------------------------------------------------------------------
# Modèles et adaptateurs MediaPipe
# ----------------------------------------------------------------------

def _model_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "models"
    return Path(__file__).resolve().parent / "models"


def _ensure_model(url: str, filename: str) -> Path:
    path = _model_dir() / filename
    if path.is_file() and path.stat().st_size > 500_000:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Téléchargement du modèle %s…", filename)
    tmp = path.with_suffix(".tmp")
    urllib.request.urlretrieve(url, tmp)
    tmp.replace(path)
    logger.info("Modèle enregistré : %s", path)
    return path


class _LegacyHandsAdapter:
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
    def __init__(self, mp_module) -> None:
        from mediapipe.tasks import python as tasks_python
        from mediapipe.tasks.python import vision as tasks_vision

        self._mp = mp_module
        options = tasks_vision.HandLandmarkerOptions(
            base_options=tasks_python.BaseOptions(
                model_asset_path=str(
                    _ensure_model(HAND_MODEL_URL, "hand_landmarker.task")
                )
            ),
            running_mode=tasks_vision.RunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=0.6,
            min_tracking_confidence=0.5,
        )
        self._landmarker = tasks_vision.HandLandmarker.create_from_options(options)

    def detect(self, rgb_frame, timestamp_ms: int):
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb_frame)
        result = self._landmarker.detect_for_video(image, timestamp_ms)
        if result.hand_landmarks:
            return result.hand_landmarks[0]
        return None

    def close(self) -> None:
        self._landmarker.close()


class _LegacyFaceAdapter:
    def __init__(self, mp_module) -> None:
        self._mesh = mp_module.solutions.face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=False,
            min_detection_confidence=0.6,
            min_tracking_confidence=0.5,
        )

    def detect(self, rgb_frame, _timestamp_ms: int):
        result = self._mesh.process(rgb_frame)
        if result.multi_face_landmarks:
            return result.multi_face_landmarks[0].landmark
        return None

    def close(self) -> None:
        self._mesh.close()


class _TasksFaceAdapter:
    def __init__(self, mp_module) -> None:
        from mediapipe.tasks import python as tasks_python
        from mediapipe.tasks.python import vision as tasks_vision

        self._mp = mp_module
        options = tasks_vision.FaceLandmarkerOptions(
            base_options=tasks_python.BaseOptions(
                model_asset_path=str(
                    _ensure_model(FACE_MODEL_URL, "face_landmarker.task")
                )
            ),
            running_mode=tasks_vision.RunningMode.VIDEO,
            num_faces=1,
        )
        self._landmarker = tasks_vision.FaceLandmarker.create_from_options(options)

    def detect(self, rgb_frame, timestamp_ms: int):
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb_frame)
        result = self._landmarker.detect_for_video(image, timestamp_ms)
        if result.face_landmarks:
            return result.face_landmarks[0]
        return None

    def close(self) -> None:
        self._landmarker.close()


def _create_hands_adapter(mp_module):
    if hasattr(mp_module, "solutions") and hasattr(mp_module.solutions, "hands"):
        logger.info("MediaPipe mains : API héritée (solutions.hands)")
        return _LegacyHandsAdapter(mp_module)
    logger.info("MediaPipe mains : API Tasks (HandLandmarker)")
    return _TasksHandsAdapter(mp_module)


def _create_face_adapter(mp_module):
    if hasattr(mp_module, "solutions") and hasattr(mp_module.solutions, "face_mesh"):
        logger.info("MediaPipe visage : API héritée (solutions.face_mesh)")
        return _LegacyFaceAdapter(mp_module)
    logger.info("MediaPipe visage : API Tasks (FaceLandmarker)")
    return _TasksFaceAdapter(mp_module)


# ----------------------------------------------------------------------
# Moteur
# ----------------------------------------------------------------------

class GestureEngine:
    """Boucle de capture dans un thread dédié.

    État partagé sous verrou, consommé par /ws/vision et
    /api/vision/frame.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread = None
        self._running = False
        self._clients = 0

        self.available = False
        self.reason = "non démarré"
        self.hand = {"present": False, "x": 0.5, "y": 0.5, "pinch": False}
        self.events: deque = deque(maxlen=16)

        # Protocole de scan biométrique
        self.scan_active = False
        self.scan = {"face": [], "hands": []}
        self.frame_jpeg: bytes | None = None

    # ----- cycle de vie -------------------------------------------------

    def acquire(self) -> None:
        with self._lock:
            self._clients += 1
            if not self._running:
                self._running = True
                self._thread = threading.Thread(target=self._loop, daemon=True)
                self._thread.start()

    def release(self) -> None:
        with self._lock:
            self._clients = max(0, self._clients - 1)
            if self._clients == 0:
                self._running = False
                self.scan_active = False

    def set_scan(self, active: bool) -> None:
        with self._lock:
            self.scan_active = bool(active)
            if not active:
                self.scan = {"face": [], "hands": []}
                self.frame_jpeg = None
        logger.info("Scan biométrique %s", "ACTIVÉ" if active else "désactivé")

    # ----- accès thread-safe --------------------------------------------

    def snapshot(self) -> dict:
        with self._lock:
            events = list(self.events)
            self.events.clear()
            return {
                "available": self.available,
                "reason": self.reason,
                "hand": dict(self.hand),
                "events": events,
                "scan_active": self.scan_active,
                "scan": {
                    "face": self.scan["face"],
                    "hands": self.scan["hands"],
                },
            }

    def latest_frame(self) -> bytes | None:
        with self._lock:
            return self.frame_jpeg

    def _set_unavailable(self, reason: str) -> None:
        with self._lock:
            self.available = False
            self.reason = reason
            self._running = False
        logger.warning("Vision indisponible — %s", reason)

    # ----- boucle de capture --------------------------------------------

    def _loop(self) -> None:
        capture = None
        hands = None
        face = None
        try:
            try:
                import cv2
            except ImportError:
                self._set_unavailable("module cv2 manquant (pip install opencv-python)")
                return
            try:
                import mediapipe as mp
            except ImportError:
                self._set_unavailable("module mediapipe manquant (pip install mediapipe)")
                return

            backend = cv2.CAP_DSHOW if sys.platform.startswith("win") else cv2.CAP_ANY
            capture = cv2.VideoCapture(0, backend)
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_WIDTH)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_HEIGHT)
            capture.set(cv2.CAP_PROP_FPS, CAPTURE_FPS)

            if not capture.isOpened():
                self._set_unavailable(
                    "aucune caméra détectée (vérifiez les autorisations Windows)"
                )
                return

            hands = _create_hands_adapter(mp)

            with self._lock:
                self.available = True
                self.reason = ""
            logger.info("Vision gestuelle active (MediaPipe Hands, caméra 0)")

            origin = time.monotonic()
            v_since = None
            v_fired = False
            v_released_at = 0.0
            ok_since = None
            ok_fired = False
            ok_released_at = 0.0
            pinch_frames = 0
            pinch_active = False

            while True:
                with self._lock:
                    if not self._running:
                        break
                    scan_on = self.scan_active

                ok_read, frame = capture.read()
                if not ok_read:
                    time.sleep(0.05)
                    continue

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                now = time.monotonic()
                stamp = int((now - origin) * 1000)
                landmarks = hands.detect(rgb, stamp)

                present = landmarks is not None
                hand_x, hand_y = 0.5, 0.5
                v_now = pinch_now = ok_now = False
                mid = (0.5, 0.5)

                if present:
                    hand_x = 1.0 - landmarks[9].x
                    hand_y = landmarks[9].y
                    v_now = is_v_sign(landmarks)
                    pinch_now = is_pinch(landmarks)
                    ok_now = is_ok_sign(landmarks)
                    mid = pinch_midpoint(landmarks)

                # --- Signe V : maintien 0,5 s ---
                if v_now:
                    if v_since is None:
                        v_since = now
                    if (
                        not v_fired
                        and now - v_since >= HOLD_SECONDS
                        and now - v_released_at >= RELEASE_SECONDS
                    ):
                        v_fired = True
                        with self._lock:
                            self.events.append({"type": "gesture", "name": "v_sign"})
                        logger.info("Signe V validé")
                else:
                    if v_fired:
                        v_released_at = now
                    v_since = None
                    v_fired = False

                # --- Geste OK : maintien 0,8 s → scan biométrique ---
                if ok_now:
                    if ok_since is None:
                        ok_since = now
                    if (
                        not ok_fired
                        and now - ok_since >= OK_HOLD_SECONDS
                        and now - ok_released_at >= RELEASE_SECONDS
                    ):
                        ok_fired = True
                        with self._lock:
                            self.events.append({"type": "gesture", "name": "ok_sign"})
                        logger.info("Geste OK validé (maintenu %.2f s)", now - ok_since)
                else:
                    if ok_fired:
                        ok_released_at = now
                    ok_since = None
                    ok_fired = False

                # --- Pince : sélection chirurgicale au point médian ---
                if pinch_now:
                    pinch_frames += 1
                    if pinch_frames >= 2 and not pinch_active:
                        pinch_active = True
                        with self._lock:
                            self.events.append({
                                "type": "gesture",
                                "name": "pinch",
                                "x": round(1.0 - mid[0], 4),
                                "y": round(mid[1], 4),
                            })
                else:
                    pinch_frames = 0
                    pinch_active = False

                # --- Mode scan : visage 468 points + main complète + flux ---
                if scan_on:
                    if face is None:
                        try:
                            face = _create_face_adapter(mp)
                        except Exception as exc:
                            logger.error("Face Mesh indisponible : %s", exc)
                            face = False  # n'essaie plus
                    face_points = []
                    if face:
                        face_lm = face.detect(rgb, stamp)
                        if face_lm:
                            face_points = [
                                [round(p.x, 3), round(p.y, 3)] for p in face_lm
                            ]
                    hand_points = []
                    if present:
                        hand_points = [
                            [round(p.x, 3), round(p.y, 3)] for p in landmarks
                        ]

                    scale = SCAN_JPEG_WIDTH / frame.shape[1]
                    small = cv2.resize(frame, None, fx=scale, fy=scale)
                    ok_enc, encoded = cv2.imencode(
                        ".jpg", small,
                        [int(cv2.IMWRITE_JPEG_QUALITY), SCAN_JPEG_QUALITY],
                    )

                    with self._lock:
                        self.scan = {
                            "face": face_points,
                            "hands": [hand_points] if hand_points else [],
                        }
                        if ok_enc:
                            self.frame_jpeg = encoded.tobytes()

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
            logger.exception("Échec du moteur de vision")
            self._set_unavailable(f"{type(exc).__name__} : {exc}")
        finally:
            for adapter in (hands, face):
                if adapter:
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

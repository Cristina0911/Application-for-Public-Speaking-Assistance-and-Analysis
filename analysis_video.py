"""Analiza video: față, privire spre cameră, zâmbet și mâini (MediaPipe Tasks).

Din fiecare secundă de video se analizează 4 cadre. Rezultatele sunt aproximări:
  - „contact vizual" = privești spre cameră (nu spre slide-uri sau notițe);
  - „zâmbet" și „privire în jos" vin din scorurile de expresie ale feței;
  - „gesturi" = mâinile sunt vizibile și se mișcă.
"""
import math
import urllib.request
from pathlib import Path

MODEL_DIR = Path(__file__).parent / "models"
MODELS = {
    "face": ("face_landmarker.task",
             "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"),
    "hand": ("hand_landmarker.task",
             "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"),
}

SAMPLE_FPS = 4          # câte cadre analizăm pe secundă
MAX_WIDTH = 640         # cadrele mari se micșorează (mai rapid, același rezultat)
WINDOW = 30.0           # secunde, pentru graficul de contact vizual
GAZE_SIDE_MAX = 0.35    # cât de mult poți privi într-o parte și încă „privești spre cameră"
GAZE_UP_MAX = 0.40
GAZE_DOWN_MAX = 0.55    # peste: te uiți în jos (notițe / ecran)
YAW_MAX = 30.0          # grade de întoarcere a capului
SMILE_MIN = 0.35
HAND_SPEED_MIN = 0.06   # cât de repede se mișcă mâinile (fracțiune din cadru pe secundă)
LOOK_DOWN_RUN = 3.0     # secunde: de la cât numărăm „privire în jos prelungită"


# ---------- modele ----------
def ensure_model(kind: str) -> str:
    name, url = MODELS[kind]
    MODEL_DIR.mkdir(exist_ok=True)
    path = MODEL_DIR / name
    if path.exists() and path.stat().st_size > 100_000:
        return str(path)
    tmp = path.with_suffix(".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as out:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        tmp.replace(path)
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Nu am putut descărca modelul „{name}”. Verifică conexiunea la internet. ({e})")
    return str(path)


class MediaPipeBackend:
    """Detectoare reale. Pentru teste se poate înlocui cu o clasă care are aceleași metode."""

    def __init__(self):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision
        self.mp = mp
        face_path, hand_path = ensure_model("face"), ensure_model("hand")
        self.face = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=face_path), running_mode=vision.RunningMode.VIDEO,
            num_faces=1, output_face_blendshapes=True, output_facial_transformation_matrixes=True))
        self.hand = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=hand_path), running_mode=vision.RunningMode.VIDEO,
            num_hands=2))

    def detect(self, rgb, ts_ms):
        import numpy as np
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        return self.face.detect_for_video(image, ts_ms), self.hand.detect_for_video(image, ts_ms)

    def close(self):
        for d in (self.face, self.hand):
            try:
                d.close()
            except Exception:
                pass


# ---------- trăsături pe cadru ----------
def head_yaw(face_result):
    mats = getattr(face_result, "facial_transformation_matrixes", None)
    if mats is None or len(mats) == 0:
        return None
    import numpy as np
    m = np.asarray(mats[0], dtype=float)[:3, :3]
    m = m / (np.linalg.norm(m, axis=0) + 1e-9)
    return math.degrees(math.atan2(-m[2, 0], math.hypot(m[2, 1], m[2, 2])))


def frame_features(t, face_result, hand_result):
    f = {"t": t, "face": False, "looking": False, "smile": False, "down": False, "hands": 0, "pos": None,
         "raw": None}
    if face_result is not None and len(face_result.face_landmarks) > 0:
        f["face"] = True
        s = {}
        if face_result.face_blendshapes:
            s = {c.category_name: c.score for c in face_result.face_blendshapes[0]}
        g = lambda k: s.get(k, 0.0)
        side = max((g("eyeLookInLeft") + g("eyeLookOutRight")) / 2, (g("eyeLookOutLeft") + g("eyeLookInRight")) / 2)
        up = (g("eyeLookUpLeft") + g("eyeLookUpRight")) / 2
        down = (g("eyeLookDownLeft") + g("eyeLookDownRight")) / 2
        yaw = head_yaw(face_result)
        f["down"] = down >= GAZE_DOWN_MAX
        f["looking"] = (side < GAZE_SIDE_MAX and up < GAZE_UP_MAX and down < GAZE_DOWN_MAX
                        and (yaw is None or abs(yaw) < YAW_MAX))
        smile = (g("mouthSmileLeft") + g("mouthSmileRight")) / 2
        f["smile"] = smile >= SMILE_MIN
        f["raw"] = {"smile": smile, "down": down, "side": side, "up": up, "yaw": abs(yaw) if yaw is not None else 0.0}
    if hand_result is not None and len(hand_result.hand_landmarks) > 0:
        f["hands"] = len(hand_result.hand_landmarks)
        pts = [(p.x, p.y) for hand in hand_result.hand_landmarks for p in hand]
        f["pos"] = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    return f


# ---------- analiza unui video ----------
def analyze(path, on_progress, backend=None):
    return summarize(collect(path, on_progress, backend))


def collect(path, on_progress, backend=None):
    """Citește videoul și întoarce trăsăturile fiecărui cadru analizat."""
    import cv2
    backend = backend or MediaPipeBackend()
    feats = []
    cap = cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened():
            raise RuntimeError("Nu am putut deschide fișierul video.")
        fps = cap.get(cv2.CAP_PROP_FPS)
        if not (1 <= fps <= 240):
            fps = 30.0
        total = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        step = max(1, round(fps / SAMPLE_FPS))
        idx = 0
        while cap.grab():
            if idx % step == 0:
                ok, frame = cap.retrieve()
                if ok:
                    h, w = frame.shape[:2]
                    if w > MAX_WIDTH:
                        frame = cv2.resize(frame, (MAX_WIDTH, max(1, int(h * MAX_WIDTH / w))))
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    t = idx / fps
                    face, hands = backend.detect(rgb, int(t * 1000))
                    feats.append(frame_features(t, face, hands))
                    if total > 0 and len(feats) % 5 == 0:
                        on_progress(min(idx / total, 0.99))
            idx += 1
    finally:
        cap.release()
        backend.close()
    return feats


def pct(a, b):
    return round(100 * a / b) if b else 0


def summarize(feats):
    n = len(feats)
    if n < 4:
        return {"available": False, "error": "Videoul e prea scurt sau nu am putut citi cadre din el."}
    dt = 1.0 / SAMPLE_FPS
    faces = [f for f in feats if f["face"]]
    nf = len(faces)
    looking = sum(f["looking"] for f in feats)
    smiling = sum(f["smile"] for f in faces)
    hands = sum(1 for f in feats if f["hands"] > 0)

    # gesturi: mâinile vizibile și în mișcare între două cadre consecutive
    moving = 0
    for a, b in zip(feats, feats[1:]):
        if a["pos"] and b["pos"] and a["hands"] == b["hands"] and 0 < b["t"] - a["t"] <= 1.0:
            speed = math.dist(a["pos"], b["pos"]) / (b["t"] - a["t"])
            if speed >= HAND_SPEED_MIN:
                moving += 1

    # privire în jos prelungită
    runs, start, last = [], None, None
    for f in feats:
        if f["down"]:
            start = f["t"] if start is None else start
            last = f["t"]
        elif start is not None:
            runs.append(last - start + dt)
            start = None
    if start is not None:
        runs.append(last - start + dt)
    long_runs = [r for r in runs if r >= LOOK_DOWN_RUN]

    # contact vizual pe ferestre de 30 s
    timeline, t0, end = [], 0.0, feats[-1]["t"]
    while t0 <= end:
        w = [f for f in feats if t0 <= f["t"] < t0 + WINDOW]
        if len(w) >= 3:
            timeline.append({"t": round(t0, 1), "pct": pct(sum(f["looking"] for f in w), len(w))})
        t0 += WINDOW

    r = {
        "available": True, "samples": n, "duration": round(end + dt, 1),
        "face_pct": pct(nf, n),
        "eye_pct": pct(looking, n),
        "smile_pct": pct(smiling, nf),
        "hands_pct": pct(hands, n),
        "gesture_pct": pct(moving, max(n - 1, 1)),
        "down_count": len(long_runs), "down_total": round(sum(long_runs), 1),
        "eye_timeline": timeline,
    }
    r["feedback"] = make_feedback(r)
    return r


def make_feedback(r):
    fb = []

    def add(key, level, title, text):
        fb.append({"key": key, "level": level, "title": title, "text": text})

    if r["face_pct"] >= 85:
        add("face", "good", "Ești bine încadrat(ă)", f"Fața ta e vizibilă în {r['face_pct']}% din înregistrare.")
    elif r["face_pct"] >= 60:
        add("face", "warn", "Uneori ieși din cadru", f"Fața e vizibilă doar în {r['face_pct']}% din timp. Verifică poziția camerei și lumina.")
    else:
        add("face", "bad", "Fața se vede puțin", f"Fața e detectată doar în {r['face_pct']}% din înregistrare. Pune camera la nivelul ochilor, cu lumină din față.")

    e = r["eye_pct"]
    if e >= 60:
        add("eye", "good", "Contact vizual bun", f"Privești spre cameră în {e}% din timp.")
    elif e >= 35:
        add("eye", "warn", "Contact vizual mediu", f"Privești spre cameră în {e}% din timp. Încearcă să te uiți mai des în cameră, ca și cum ai privi publicul, nu slide-urile.")
    else:
        add("eye", "bad", "Contact vizual redus", f"Privești spre cameră doar în {e}% din timp. Exersează prezentarea până o știi suficient ca să nu citești de pe ecran sau din notițe.")

    if r["down_count"] >= 3 or r["down_total"] >= 0.15 * r["duration"]:
        add("down", "warn", "Privești des în jos",
            f"Am găsit {r['down_count']} momente în care te uiți în jos mai mult de 3 secunde (în total {r['down_total']:.0f} s). Probabil citești din notițe sau de pe ecran.")
    else:
        add("down", "good", "Fără priviri lungi în jos", "Nu am găsit momente lungi în care să te uiți în jos.")

    s = r["smile_pct"]
    if s < 5:
        add("smile", "warn", "Expresie foarte serioasă", f"Zâmbești în {s}% din timp. Un zâmbet la început și la final face prezentarea mai caldă.")
    else:
        add("smile", "good", "Expresie naturală", f"Zâmbești în {s}% din timp.")

    h, g = r["hands_pct"], r["gesture_pct"]
    if h < 10:
        add("gesture", "warn", "Mâinile nu se văd",
            f"Mâinile sunt vizibile doar în {h}% din timp. Dacă vrei să folosești gesturi, ține-le în cadru, deasupra mesei.")
    elif g < 5:
        add("gesture", "warn", "Gesturi puține", f"Mâinile se văd ({h}% din timp), dar aproape nu se mișcă. Câteva gesturi la ideile importante fac prezentarea mai vie.")
    elif g > 45:
        add("gesture", "warn", "Multă mișcare a mâinilor", f"Mâinile se mișcă în {g}% din timp. Încearcă să le liniștești între idei, ca gesturile importante să se vadă.")
    else:
        add("gesture", "good", "Gesturi echilibrate", f"Mâinile se văd în {h}% din timp și se mișcă activ în {g}%.")
    return fb
"""Compară ce ai spus (transcrierea cu timpi) cu textul din slide-uri.

Pentru fiecare moment din înregistrare ghicim la ce slide erai (după cuvintele spuse),
apoi calculăm cât ai stat pe fiecare slide și ce puncte de pe slide ai acoperit.
Totul e euristic: o potrivire de cuvinte, nu o înțelegere a sensului.
"""
import math
import re
import shutil
import subprocess
import tempfile
import unicodedata
from pathlib import Path

import slides_parse

BIN = 4.0            # secunde: cât de fină e urmărirea
SPAN = 1             # câte intervale vecine se iau în calcul (12 s în total)
NEIGHBOR_W = 0.6     # ponderea intervalelor vecine
COVER_RATIO = 0.5    # câte din cuvintele-cheie ale unui punct trebuie spuse ca să-l numim acoperit
FWD = 1.5            # penalizare: trecere la slide-ul următor
JUMP = 1.0           # penalizare în plus pentru fiecare slide sărit
BACK = 3.0           # penalizare: întoarcere la un slide anterior
START = 3.0          # penalizare: să nu începi cu primul slide
MIN_VOCAB = 8        # sub atâtea cuvinte-cheie în tot documentul, nu putem potrivi nimic
BIG_SHARE = 40       # % din timp peste care un slide e „prea lung" (când sunt cel puțin 4 slide-uri)

STOP = set(("si sau dar care este sunt pentru cand cum mai din prin intr unei unui acest aceasta aceste aceea fost fiind "
            "poate foarte despre catre dupa fara intre asupra doar cele celor acesta acestea sale lui lor ale the and for with "
            "that this from are was were have has will can not but you your our their into about which what when they them then than there").split())


def tokens(text):
    s = unicodedata.normalize("NFD", (text or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    out = []
    for w in s.split():
        if len(w) >= 4 and w not in STOP:
            out.append(w[:6])
    return out


def mmss(sec):
    sec = int(round(sec))
    return f"{sec // 60}:{sec % 60:02d}"


# ---------- citirea slide-urilor din fișierul încărcat ----------
def _convert(path, target_ext, soffice):
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / ("in" + path.suffix.lower())
        shutil.copy(path, src)
        try:
            subprocess.run([soffice, "--headless", "--norestore", "-env:UserInstallation=" + (Path(tmp) / "profile").as_uri(),
                            "--convert-to", target_ext.lstrip("."), "--outdir", tmp, str(src)], capture_output=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise ValueError("Conversia fișierului a durat prea mult.")
        out = Path(tmp) / ("in" + target_ext)
        if not out.exists():
            raise ValueError("Nu am putut converti fișierul vechi (.ppt/.doc).")
        return out.read_bytes()


def _from_pdf(path):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise ValueError("Lipsește biblioteca pypdf. Rulează „python -m pip install -r requirements.txt” și repornește serverul.")
    try:
        pages = PdfReader(str(path)).pages[: slides_parse.MAX_SLIDES]
        slides = []
        for p in pages:
            lines = [slides_parse._clean(l) for l in (p.extract_text() or "").split("\n")]
            lines = [l for l in lines if l]
            slides.append(slides_parse._slide(lines[0] if lines else "", lines[1:]))
    except Exception:
        raise ValueError("Nu am putut citi PDF-ul (poate e protejat cu parolă sau conține doar imagini).")
    return slides


def load_slides(path, soffice=None):
    ext = path.suffix.lower()
    if ext in slides_parse.PARSERS:
        return slides_parse.parse(ext, path.read_bytes())
    if ext == ".pdf":
        return _from_pdf(path)
    if ext in (".ppt", ".doc"):
        if not soffice:
            raise ValueError("Formatul vechi (.ppt/.doc) nu poate fi citit fără LibreOffice. Salvează-l ca .pptx/.docx sau PDF.")
        new = ".pptx" if ext == ".ppt" else ".docx"
        return slides_parse.parse(new, _convert(path, new, soffice))
    raise ValueError("Format de slide-uri neacceptat pentru comparație.")


# ---------- potrivirea cu transcrierea ----------
def analyze(path, words, duration, soffice=None):
    raw = load_slides(path, soffice)
    n = len(raw)
    slides = []
    for s in raw:
        points = [{"text": p, "kw": set(tokens(p))} for p in s["points"]]
        vocab = set(tokens(s["title"]))
        for p in points:
            vocab |= p["kw"]
        slides.append({"title": s["title"], "points": points, "vocab": vocab})
    all_vocab = set().union(*(s["vocab"] for s in slides)) if slides else set()
    if n == 0 or len(all_vocab) < MIN_VOCAB:
        return {"available": False, "reason": "no_text",
                "error": "Slide-urile conțin prea puțin text (poate sunt doar imagini), așa că nu pot face comparația."}
    if not words:
        return {"available": False, "error": "Nu există transcriere cu care să compar slide-urile."}

    df = {}
    for s in slides:
        for t in s["vocab"]:
            df[t] = df.get(t, 0) + 1
    idf = {t: math.log(1 + n / d) for t, d in df.items()}

    t_start = words[0]["s"]
    t_end = max(words[-1]["e"], t_start + BIN)
    nb = max(1, int(math.ceil((t_end - t_start) / BIN)))
    bin_tokens = [[] for _ in range(nb)]
    for w in words:
        b = min(nb - 1, max(0, int((w["s"] - t_start) / BIN)))
        bin_tokens[b].extend(tokens(w["w"]))

    # emisia: cât de bine se potrivesc cuvintele din jurul intervalului cu fiecare slide
    emit = []
    for b in range(nb):
        wmap = {}
        for k in range(-SPAN, SPAN + 1):
            if 0 <= b + k < nb:
                wt = 1.0 if k == 0 else NEIGHBOR_W
                for t in bin_tokens[b + k]:
                    if wt > wmap.get(t, 0):
                        wmap[t] = wt
        emit.append([sum(idf[t] * wt for t, wt in wmap.items() if t in s["vocab"]) for s in slides])

    # Viterbi: traseul cu potrivirea cea mai bună, penalizând sărituri și întoarceri
    def pen(i, j):
        if j == i:
            return 0.0
        if j > i:
            return FWD + JUMP * (j - i - 1)
        return BACK + JUMP * (i - j - 1)

    score = [emit[0][j] - (START + j if j else 0) for j in range(n)]
    back = []
    for b in range(1, nb):
        new, ptr = [], []
        for j in range(n):
            best_i = max(range(n), key=lambda i: score[i] - pen(i, j))
            new.append(score[best_i] - pen(best_i, j) + emit[b][j])
            ptr.append(best_i)
        score = new
        back.append(ptr)
    state = [max(range(n), key=lambda j: score[j])]
    for ptr in reversed(back):
        state.append(ptr[state[-1]])
    state.reverse()

    # segmente de timp
    timeline = []
    for b, st in enumerate(state):
        a, e = t_start + b * BIN, min(t_start + (b + 1) * BIN, t_end)
        if timeline and timeline[-1]["slide"] == st + 1:
            timeline[-1]["end"] = e
        else:
            timeline.append({"slide": st + 1, "start": a, "end": e})
    total = sum(t["end"] - t["start"] for t in timeline) or 1.0
    time_on = [0.0] * n
    for t in timeline:
        time_on[t["slide"] - 1] += t["end"] - t["start"]

    # ce puncte ai acoperit pe fiecare slide (cuvintele spuse cât erai acolo, cu o marjă de un interval)
    spoken = [set() for _ in range(n)]
    for b, st in enumerate(state):
        for k in range(-1, 2):
            if 0 <= b + k < nb:
                spoken[st].update(bin_tokens[b + k])
    items, cov_total, pts_total = [], 0, 0
    for i, s in enumerate(slides):
        pts, c, m = [], 0, 0
        for p in s["points"]:
            if not p["kw"]:
                continue
            hit = len(p["kw"] & spoken[i])
            ok = time_on[i] > 0 and hit >= max(1, math.ceil(len(p["kw"]) * COVER_RATIO))
            pts.append({"text": p["text"], "covered": ok})
            m += 1
            c += ok
        cov_total += c
        pts_total += m
        items.append({"n": i + 1, "title": s["title"], "time": round(time_on[i], 1), "share": round(100 * time_on[i] / total),
                      "coverage": round(100 * c / m) if m else None, "points": pts})

    skipped = [i + 1 for i in range(n) if time_on[i] <= 0]
    backs = sum(1 for a, b in zip(timeline, timeline[1:]) if b["slide"] < a["slide"])
    overall = round(100 * cov_total / pts_total) if pts_total else None
    return {
        "available": True, "count": n, "overall_coverage": overall, "visited": n - len(skipped),
        "skipped": skipped, "backtracks": backs,
        "timeline": [{"slide": t["slide"], "start": round(t["start"], 1), "end": round(t["end"], 1)} for t in timeline],
        "items": items, "feedback": make_feedback(items, overall, skipped, backs, n),
    }


def make_feedback(items, overall, skipped, backs, n):
    out = []

    def add(key, level, title, text):
        out.append({"key": key, "level": level, "title": title, "text": text})

    if overall is not None:
        miss = sum(1 for it in items for p in it["points"] if not p["covered"])
        if overall >= 75:
            add("cov", "good", "Ai acoperit bine slide-urile", f"Ai atins aproximativ {overall}% din punctele scrise pe slide-uri.")
        elif overall >= 50:
            add("cov", "warn", "Ai lăsat unele puncte nespuse",
                f"Ai atins aproximativ {overall}% din punctele de pe slide-uri; {miss} puncte nu apar în ce ai spus. Le vezi mai jos, slide cu slide.")
        else:
            add("cov", "bad", "Multe puncte din slide-uri nu apar în vorbire",
                f"Doar aproximativ {overall}% din punctele de pe slide-uri apar în ce ai spus. Fie ai improvizat mult, fie ai sărit conținut.")
    if skipped:
        lst = ", ".join(str(s) for s in skipped[:8]) + ("…" if len(skipped) > 8 else "")
        lab = "slide-ul" if len(skipped) == 1 else "slide-urile"
        add("skip", "warn", "Slide-uri neacoperite" if len(skipped) > 1 else "Un slide neacoperit",
            f"Nu am găsit nimic din {lab} {lst} în ce ai spus. Poate l-ai sărit sau l-ai explicat cu alte cuvinte." if len(skipped) == 1
            else f"Nu am găsit nimic din {lab} {lst} în ce ai spus. Poate le-ai sărit sau le-ai explicat cu alte cuvinte.")
    elif n > 1:
        add("skip", "good", "Ai trecut prin toate slide-urile", "Am găsit conținut din fiecare slide în vorbirea ta.")
    if n >= 4:
        big = max(items, key=lambda it: it["share"])
        if big["share"] >= BIG_SHARE:
            add("time", "warn", "Un slide a luat mult timp",
                f"Slide-ul {big['n']} a durat {mmss(big['time'])} ({big['share']}% din prezentare). Verifică dacă merită atât față de celelalte.")
    if backs >= 2:
        add("order", "warn", "Te-ai întors la slide-uri anterioare", f"Am observat {backs} întoarceri la slide-uri deja prezentate. Poate ordinea ideilor nu e cea din slide-uri.")
    return out
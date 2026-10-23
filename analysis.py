"""Analiza unei prezentări: transcriere (faster-whisper) și indicatori de vorbire."""
import re
from collections import Counter

WHISPER_MODEL = "small"   # dacă e prea lent pe laptop: "base"; mai precis (dar mai lent): "medium"
LONG_PAUSE = 2.0          # secunde: de la cât considerăm o pauză „lungă"
WINDOW = 30.0             # secunde: fereastra pentru graficul de ritm

# sunete de ezitare
HESITATIONS = {
    "ro": {"ă", "ăă", "ăăă", "ăăăă", "ăm", "ăăm", "mm", "mmm", "mmmm", "hm", "hmm", "hmmm",
           "ee", "eee", "eeee", "eh", "ehh", "ehm", "ehmm"},
    "en": {"um", "umm", "uh", "uhh", "uhm", "er", "erm", "eh", "ah", "ahh", "hm", "hmm", "mm", "mmm"},
}
# cuvinte de umplutură (pot fi și cuvinte normale: sunt doar „posibile")
FILLER_WORDS = {
    "ro": {"deci", "practic", "adică", "păi", "gen", "cumva", "efectiv"},
    "en": {"basically", "actually", "literally", "honestly"},
}
FILLER_PHRASES = {
    "ro": [("cum", "să", "zic"), ("să", "zicem"), ("să", "spunem"), ("în", "principiu"), ("ca", "să", "zic", "așa")],
    "en": [("you", "know"), ("i", "mean"), ("kind", "of"), ("sort", "of")],
}
# Whisper „curăță" de obicei ezitările; un exemplu în prompt îl încurajează să le păstreze
PROMPTS = {
    "ro": "Ăă, deci, păi, ăăă, adică, mmm, practic, ăm, eee.",
    "en": "Um, uh, so, you know, uhm, I mean, hmm, er.",
}

_CED = str.maketrans({"ş": "ș", "Ş": "Ș", "ţ": "ț", "Ţ": "Ț"})
_model = None


def norm(word: str) -> str:
    w = word.translate(_CED).lower()
    return re.sub(r"^\W+|\W+$", "", w)


# ---------- transcriere ----------
def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel  # import târziu: serverul pornește și fără el
        _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    return _model


def transcribe(path, language, on_progress):
    """Întoarce (cuvinte, segmente, limbă, durată).
    cuvinte: [{"w": text, "s": start, "e": sfârșit}], segmente: [(index_primul_cuvânt, index_după_ultimul)]"""
    model = get_model()
    lang = None if language == "auto" else language
    segments, info = model.transcribe(
        str(path), language=lang, word_timestamps=True, vad_filter=True,
        initial_prompt=PROMPTS.get(lang), beam_size=1, condition_on_previous_text=False,
    )
    total = info.duration or 1.0
    words, segs = [], []
    for seg in segments:
        first = len(words)
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"w": text, "s": float(w.start), "e": float(w.end)})
        if len(words) > first:
            segs.append((first, len(words)))
        on_progress(min(seg.end / total, 0.99))
    return words, segs, info.language, float(total)


# ---------- indicatori ----------
def classify(words, lang):
    """Marchează fiecare cuvânt: 'w' normal, 'h' ezitare, 'f' umplutură. Întoarce și numărătorile."""
    hes = HESITATIONS.get(lang, set())
    fil = FILLER_WORDS.get(lang, set())
    phrases = sorted(FILLER_PHRASES.get(lang, []), key=len, reverse=True)
    toks = [norm(w["w"]) for w in words]
    kinds = ["w"] * len(words)
    hes_count, fil_count = Counter(), Counter()
    i = 0
    while i < len(words):
        t = toks[i]
        if t in hes:
            kinds[i] = "h"
            hes_count[t] += 1
            i += 1
            continue
        hit = next((p for p in phrases if tuple(toks[i:i + len(p)]) == p), None)
        if hit:
            for j in range(i, i + len(hit)):
                kinds[j] = "f"
            fil_count[" ".join(hit)] += 1
            i += len(hit)
            continue
        if t in fil:
            kinds[i] = "f"
            fil_count[t] += 1
        i += 1
    return kinds, hes_count, fil_count


def mmss(sec):
    sec = int(round(sec))
    return f"{sec // 60}:{sec % 60:02d}"


def compute(words, segs, language, duration):
    lang = language if language in HESITATIONS else "ro"
    result = {"language": language, "duration": round(duration, 1), "empty": not words}
    if not words:
        result["feedback"] = [{"level": "bad", "title": "Nu am găsit vorbire",
                               "text": "Înregistrarea nu conține voce clară. Verifică sunetul și încearcă din nou."}]
        result["transcript"] = []
        return result

    kinds, hes_count, fil_count = classify(words, lang)
    spoken = [w for w, k in zip(words, kinds) if k != "h"]
    n_words = len(spoken)
    start, end = words[0]["s"], words[-1]["e"]
    span = max(end - start, 1.0)
    minutes = span / 60
    wpm = n_words / minutes

    # pauze între cuvinte
    pauses, medium = [], 0
    for a, b in zip(words, words[1:]):
        gap = b["s"] - a["e"]
        if gap >= LONG_PAUSE:
            pauses.append({"at": round(a["e"], 1), "dur": round(gap, 1)})
        elif gap >= 1.0:
            medium += 1
    pause_total = sum(p["dur"] for p in pauses)

    # ritm pe ferestre de 30 s
    windows = []
    t = start
    while t < end:
        length = min(WINDOW, end - t)
        if length >= 10:
            c = sum(1 for w, k in zip(words, kinds) if k != "h" and t <= w["s"] < t + WINDOW)
            windows.append({"t": round(t, 1), "wpm": round(c * 60 / length)})
        t += WINDOW

    hes_total, fil_total = sum(hes_count.values()), sum(fil_count.values())
    result.update({
        "words": n_words, "span": round(span, 1), "wpm": round(wpm),
        "windows": windows,
        "long_pauses": pauses[:30], "long_pause_count": len(pauses),
        "long_pause_total": round(pause_total, 1), "medium_pause_count": medium,
        "hesitations": {"count": hes_total, "per_min": round(hes_total / minutes, 1),
                        "top": hes_count.most_common(5)},
        "fillers": {"count": fil_total, "per_min": round(fil_total / minutes, 1),
                    "top": fil_count.most_common(5)},
    })
    result["feedback"] = make_feedback(result)

    # transcriere cu marcaje
    pause_at = {round(p["at"], 1): p["dur"] for p in pauses}
    transcript = []
    for a, b in segs:
        tokens = []
        for i in range(a, b):
            tokens.append([words[i]["w"], kinds[i]])
            if i + 1 < len(words):
                gap = words[i + 1]["s"] - words[i]["e"]
                if gap >= LONG_PAUSE:
                    tokens.append([f"pauză {gap:.1f} s", "p"])
        transcript.append({"s": round(words[a]["s"], 1), "tokens": tokens})
    result["transcript"] = transcript
    return result


FEEDBACK_KEYS = {
    "Ritm prea lent": "wpm", "Ritm ușor lent": "wpm", "Ritm bun": "wpm", "Ritm ușor rapid": "wpm", "Ritm prea rapid": "wpm",
    "Ritmul variază mult": "pace_var",
    "Puține ezitări": "hes", "Câteva ezitări": "hes", "Multe ezitări": "hes",
    "Puține cuvinte de umplutură": "fil", "Cuvinte de umplutură": "fil", "Multe cuvinte de umplutură": "fil",
    "Fără pauze lungi": "pause", "Multe pauze lungi": "pause", "Pauze lungi": "pause",
}


def make_feedback(r):
    fb = []
    wpm = r["wpm"]
    if wpm < 100:
        fb.append({"level": "bad", "title": "Ritm prea lent",
                   "text": f"Vorbești cu {wpm} cuvinte pe minut. Pentru o prezentare, o țintă bună e între 120 și 160. Încearcă să scurtezi frazele și să nu te oprești între idei."})
    elif wpm < 120:
        fb.append({"level": "warn", "title": "Ritm ușor lent",
                   "text": f"{wpm} cuvinte pe minut. E acceptabil, dar poți crește puțin ritmul (ținta: 120–160) ca să păstrezi atenția publicului."})
    elif wpm <= 160:
        fb.append({"level": "good", "title": "Ritm bun",
                   "text": f"{wpm} cuvinte pe minut, în intervalul recomandat de 120–160."})
    elif wpm <= 180:
        fb.append({"level": "warn", "title": "Ritm ușor rapid",
                   "text": f"{wpm} cuvinte pe minut. Încetinește puțin la ideile importante, ca publicul să apuce să le urmărească."})
    else:
        fb.append({"level": "bad", "title": "Ritm prea rapid",
                   "text": f"{wpm} cuvinte pe minut. Vorbești foarte repede: fă pauze scurte după fiecare idee și respiră între fraze."})

    w = r["windows"]
    if len(w) >= 3:
        hi, lo = max(w, key=lambda x: x["wpm"]), min(w, key=lambda x: x["wpm"])
        if hi["wpm"] - lo["wpm"] >= 60:
            fb.append({"level": "warn", "title": "Ritmul variază mult",
                       "text": f"Cel mai rapid moment e în jurul minutului {mmss(hi['t'])} ({hi['wpm']} cuv/min), iar cel mai lent în jurul minutului {mmss(lo['t'])} ({lo['wpm']} cuv/min). Încearcă un ritm mai constant."})

    h, f = r["hesitations"], r["fillers"]
    if h["per_min"] < 2:
        fb.append({"level": "good", "title": "Puține ezitări",
                   "text": f"Am găsit {h['count']} sunete de ezitare („ăă”, „um”), adică {h['per_min']} pe minut."})
    elif h["per_min"] <= 5:
        fb.append({"level": "warn", "title": "Câteva ezitări",
                   "text": f"{h['count']} sunete de ezitare ({h['per_min']} pe minut). O scurtă pauză tăcută sună mai sigur decât „ăă”."})
    else:
        fb.append({"level": "bad", "title": "Multe ezitări",
                   "text": f"{h['count']} sunete de ezitare ({h['per_min']} pe minut). Înlocuiește-le cu pauze scurte și exersează începutul fiecărei idei."})

    top = ", ".join(f"„{w_}” ({c}×)" for w_, c in f["top"][:3])
    if f["per_min"] < 3:
        fb.append({"level": "good", "title": "Puține cuvinte de umplutură",
                   "text": f"{f['count']} în total ({f['per_min']} pe minut)." + (f" Cele mai frecvente: {top}." if top else "")})
    elif f["per_min"] <= 6:
        fb.append({"level": "warn", "title": "Cuvinte de umplutură",
                   "text": f"{f['count']} în total ({f['per_min']} pe minut). Cele mai frecvente: {top}. Încearcă să le înlocuiești cu o pauză."})
    else:
        fb.append({"level": "bad", "title": "Multe cuvinte de umplutură",
                   "text": f"{f['count']} în total ({f['per_min']} pe minut). Cele mai frecvente: {top}. Notează-le și exersează fără ele."})

    n, tot = r["long_pause_count"], r["long_pause_total"]
    pauze = "pauză" if n == 1 else "pauze"
    per_min = n / max(r["span"] / 60, 1 / 60)
    if n == 0:
        fb.append({"level": "good", "title": "Fără pauze lungi",
                   "text": "Nu ai făcut pauze de peste 2 secunde. Dacă vrei să subliniezi o idee, o pauză scurtă înainte de ea ajută."})
    elif per_min >= 1.5:
        fb.append({"level": "bad", "title": "Multe pauze lungi",
                   "text": f"{n} {pauze} de peste 2 secunde (în total {tot:.0f} s). Pot arăta că ți-ai pierdut șirul: pregătește tranzițiile dintre slide-uri."})
    else:
        fb.append({"level": "warn", "title": "Pauze lungi",
                   "text": f"{n} {pauze} de peste 2 secunde (în total {tot:.0f} s). Uită-te în transcriere unde apar și vezi dacă erau intenționate."})
    for item in fb:
        item["key"] = FEEDBACK_KEYS[item["title"]]
    return fb
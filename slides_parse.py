"""Citește textul din slide-uri (PowerPoint, Word, OpenDocument, text) fără biblioteci externe.

Întoarce o listă de slide-uri: [{"title": "...", "points": ["...", ...]}, ...]
"""
import io
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET

MAX_MEMBER = 30 * 1024 * 1024   # un fișier din arhivă nu poate depăși 30 MB după dezarhivare
MAX_SLIDES = 200
MAX_POINTS = 8

A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
DRAW = "{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}"
TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
PRES = "{urn:oasis:names:tc:opendocument:xmlns:presentation:1.0}"


def _clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


def _read(z, name):
    if z.getinfo(name).file_size > MAX_MEMBER:
        raise ValueError("Fișierul conține o parte prea mare.")
    return z.read(name)


def _open_zip(data):
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError("Fișierul nu pare un document valid (sau e vechi/protejat cu parolă).")


def _slide(title, lines):
    lines = [l for l in (_clean(x) for x in lines) if l]
    title = _clean(title)
    if not title and lines:
        title = lines.pop(0)
    return {"title": title[:300], "points": [l[:300] for l in lines[:MAX_POINTS]]}


def _split_long(text, size=220):
    """Paragrafele lungi devin mai multe puncte, pe propoziții."""
    text = _clean(text)
    if len(text) <= size:
        return [text] if text else []
    out, cur = [], ""
    for sent in re.split(r"(?<=[.!?;:])\s+", text):
        if cur and len(cur) + len(sent) + 1 > size:
            out.append(cur)
            cur = sent
        else:
            cur = (cur + " " + sent).strip()
    if cur:
        out.append(cur)
    return out


# ---------- PowerPoint ----------
def _para_text(p):
    parts = []
    for el in p.iter():
        if el.tag == A + "t":
            parts.append(el.text or "")
        elif el.tag == A + "br":
            parts.append(" ")
    return _clean("".join(parts))


def parse_pptx(data):
    z = _open_zip(data)
    names = set(z.namelist())
    order = []
    try:  # ordinea reală a slide-urilor, din presentation.xml
        pres = ET.fromstring(_read(z, "ppt/presentation.xml"))
        rels = ET.fromstring(_read(z, "ppt/_rels/presentation.xml.rels"))
        rmap = {r.get("Id"): r.get("Target") for r in rels}
        for sid in pres.iter(P + "sldId"):
            t = rmap.get(sid.get(R + "id"))
            if not t:
                continue
            path = t.lstrip("/") if t.startswith("/") else posixpath.normpath(posixpath.join("ppt", t))
            if path in names:
                order.append(path)
    except Exception:
        order = []
    if not order:
        order = sorted((n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                       key=lambda n: int(re.findall(r"\d+", n)[-1]))
    if not order:
        raise ValueError("Nu am găsit slide-uri în fișier.")
    slides = []
    for path in order[:MAX_SLIDES]:
        root = ET.fromstring(_read(z, path))
        state = {"title": None, "lines": []}

        def walk(el):
            for ch in el:
                if ch.tag == P + "sp":
                    ph = ch.find(".//" + P + "ph")
                    typ = ph.get("type") if ph is not None else None
                    paras = [t for t in (_para_text(p) for p in ch.iter(A + "p")) if t]
                    if typ in ("title", "ctrTitle") and state["title"] is None and paras:
                        state["title"] = " ".join(paras)
                    elif typ not in ("sldNum", "dt", "ftr"):
                        state["lines"].extend(paras)
                elif ch.tag == P + "graphicFrame":
                    state["lines"].extend(t for t in (_para_text(p) for p in ch.iter(A + "p")) if t)
                elif ch.tag == P + "grpSp":
                    walk(ch)

        tree = root.find(".//" + P + "spTree")
        if tree is not None:
            walk(tree)
        slides.append(_slide(state["title"] or "", state["lines"]))
    return slides


# ---------- Word ----------
def parse_docx(data):
    z = _open_zip(data)
    if "word/document.xml" not in z.namelist():
        raise ValueError("Nu am găsit textul documentului.")
    body = ET.fromstring(_read(z, "word/document.xml")).find(W + "body")
    if body is None:
        raise ValueError("Documentul pare gol.")
    paras = []   # (stil, text, are_salt_de_pagina)
    for p in body.iter(W + "p"):
        st = p.find(W + "pPr/" + W + "pStyle")
        style = st.get(W + "val") if st is not None else ""
        text = _clean("".join(t.text or "" for t in p.iter(W + "t")))
        pb = any(br.get(W + "type") == "page" for br in p.iter(W + "br"))
        paras.append((style or "", text, pb))
    heading = re.compile(r"(?i)^(title|heading ?[12])$")
    sections, cur = [], None
    for style, text, pb in paras:
        if heading.match(style) and text:
            cur = {"title": text, "lines": []}
            sections.append(cur)
            continue
        if cur is None:
            cur = {"title": "", "lines": []}
            sections.append(cur)
        if text:
            cur["lines"].extend(_split_long(text))
        if pb:
            cur = {"title": "", "lines": []}
            sections.append(cur)
    sections = [s for s in sections if s["title"] or s["lines"]]
    # fără titluri: grupăm câte ~6 puncte, ca să nu fie un singur „slide" uriaș
    if len(sections) == 1 and not sections[0]["title"] and len(sections[0]["lines"]) > 8:
        lines = sections[0]["lines"]
        sections = [{"title": "Partea %d" % (i // 6 + 1), "lines": lines[i:i + 6]} for i in range(0, len(lines), 6)]
    if not sections:
        raise ValueError("Documentul pare gol.")
    return [_slide(s["title"], s["lines"]) for s in sections[:MAX_SLIDES]]


# ---------- OpenDocument ----------
def parse_odp(data):
    z = _open_zip(data)
    if "content.xml" not in z.namelist():
        raise ValueError("Nu am găsit conținutul prezentării.")
    root = ET.fromstring(_read(z, "content.xml"))
    slides = []
    for page in root.iter(DRAW + "page"):
        title, lines = None, []
        for frame in page.iter(DRAW + "frame"):
            paras = [t for t in (_clean("".join(p.itertext())) for p in frame.iter(TEXT + "p")) if t]
            if frame.get(PRES + "class") == "title" and title is None and paras:
                title = " ".join(paras)
            else:
                lines.extend(paras)
        slides.append(_slide(title or "", lines))
    if not slides:
        raise ValueError("Nu am găsit slide-uri în fișier.")
    return slides[:MAX_SLIDES]


# ---------- text simplu ----------
def parse_txt(data):
    text = data.decode("utf-8", "replace").replace("\r\n", "\n")
    if re.search(r"(?m)^\s*---+\s*$", text):
        blocks = re.split(r"(?m)^\s*---+\s*$", text)
    else:
        blocks = re.split(r"\n\s*\n", text)
    slides = []
    for b in blocks:
        lines = [re.sub(r"^[#>*\-•\s]+", "", l).strip() for l in b.strip().split("\n")]
        lines = [l for l in lines if l]
        if lines:
            slides.append(_slide(lines[0], lines[1:]))
    if not slides:
        raise ValueError("Fișierul text este gol.")
    return slides[:MAX_SLIDES]


PARSERS = {".pptx": parse_pptx, ".docx": parse_docx, ".odp": parse_odp, ".txt": parse_txt, ".md": parse_txt}


def parse(ext, data):
    return PARSERS[ext](data)
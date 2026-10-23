"""Verifică analiza video pe un fișier, fără să porniți serverul.

Rulare:   python video_check.py "C:\\calea\\catre\\video.mp4"
La prima rulare descarcă (o singură dată) modelele MediaPipe pentru față și mâini.
Afișează și scorurile brute (cât de sus ajunge zâmbetul, privirea în jos etc.),
ca să putem regla pragurile pe înregistrările tale.
"""
import json
import os
import sys
import time
import traceback

import analysis_video

if len(sys.argv) < 2:
    sys.exit("Folosire: python video_check.py \"calea\\catre\\video.mp4\"")
if not os.path.exists(sys.argv[1]):
    sys.exit("Fișierul nu există: " + sys.argv[1] + "\nPune calea reală a videoului (poți trage fișierul în terminal).")

start = time.time()
last = [0.0]


def progress(p):
    if p - last[0] >= 0.1:
        last[0] = p
        print(f"  {int(p * 100)}% ({time.time() - start:.0f} s)")


def pctl(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))] if values else 0.0


try:
    print("Pornesc analiza (la prima rulare se descarcă modelele)...")
    feats = analysis_video.collect(sys.argv[1], progress)
    result = analysis_video.summarize(feats)
    print(f"Gata în {time.time() - start:.0f} secunde.\n")
    result.pop("eye_timeline", None)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    raws = [f["raw"] for f in feats if f["raw"]]
    print("\n--- Scoruri brute (valori între 0 și 1; grade pentru yaw) ---")
    print("                  p10    mediană   p90     maxim   prag")
    limits = {"smile": f"zâmbet dacă >= {analysis_video.SMILE_MIN}",
              "down": f"în jos dacă >= {analysis_video.GAZE_DOWN_MAX}",
              "side": f"ok dacă < {analysis_video.GAZE_SIDE_MAX}",
              "up": f"ok dacă < {analysis_video.GAZE_UP_MAX}",
              "yaw": f"ok dacă < {analysis_video.YAW_MAX}"}
    for k in ("smile", "down", "side", "up", "yaw"):
        v = [r[k] for r in raws]
        print(f"{k:<15} {pctl(v, .1):7.2f} {pctl(v, .5):8.2f} {pctl(v, .9):7.2f} {max(v) if v else 0:8.2f}   {limits[k]}")
    print(f"cadre cu mâini detectate: {sum(1 for f in feats if f['hands'])} din {len(feats)}")
except Exception:
    print("\nEROARE:")
    traceback.print_exc()
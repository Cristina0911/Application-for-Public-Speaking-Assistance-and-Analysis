"""Verifică dacă cheia Groq merge, fără să pornești serverul.

Rulare:  python llm_check.py
Cheia se citește din groq_key.txt (lângă acest fișier) sau din variabila GROQ_API_KEY.
"""
import os
import sys
from pathlib import Path

import requests

BASE = Path(__file__).parent
f = BASE / "groq_key.txt"
key = os.environ.get("GROQ_API_KEY") or (f.read_text(encoding="utf-8").strip() if f.exists() else "")
model = os.environ.get("GROQ_MODEL") or "openai/gpt-oss-120b"
if not key:
    sys.exit("Nu găsesc cheia. Creează fișierul groq_key.txt lângă acest script, cu cheia pe o singură linie.")
H = {"Authorization": "Bearer " + key}

print("1) Verific cheia și iau lista de modele...")
try:
    r = requests.get("https://api.groq.com/openai/v1/models", headers=H, timeout=15)
except requests.RequestException as e:
    sys.exit("Nu mă pot conecta la Groq: " + str(e) + "\nDacă ești pe rețeaua școlii/universității, încearcă altă rețea.")
if r.status_code == 401:
    sys.exit("Cheia nu e validă (401). Verifică dacă ai copiat-o întreagă, fără spații sau ghilimele.")
if r.status_code != 200:
    sys.exit(f"Eroare de la Groq: {r.status_code} {r.text[:200]}")
ids = sorted(m["id"] for m in r.json().get("data", []))
print("   Cheia e bună. Modele disponibile pentru tine:")
for i in ids:
    print("   -", i)
if model not in ids:
    print(f"\nATENȚIE: modelul „{model}” nu e în listă. Alege unul de mai sus (text, nu whisper/guard/tts) și setează-l:")
    print("   PowerShell:  $env:GROQ_MODEL=\"nume-model\"; python server.py")
    sys.exit(1)

print(f"\n2) Încerc o cerere cu modelul {model}...")
r = requests.post(
    "https://api.groq.com/openai/v1/chat/completions", headers=H, timeout=30,
    json={"model": model, "max_tokens": 600, **({"reasoning_effort": "low"} if "gpt-oss" in model else {}), "messages": [{"role": "user", "content": "Răspunde într-o propoziție: de ce e util să faci pauze când vorbești în public?"}]},
)
if r.status_code != 200:
    sys.exit(f"Eroare: {r.status_code} {r.text[:300]}")
print("   Răspuns:", (r.json()["choices"][0]["message"]["content"] or "(gol)").strip())
print("\nTotul funcționează. Repornește serverul: python server.py")
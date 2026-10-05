#!/usr/bin/env python3
"""tts-chatterbox.py — synthèse par lot avec Chatterbox Multilingual (Resemble AI, licence MIT).

Appelé par tools/build-audio.mjs quand story.json contient "engine": "chatterbox".
Le modèle n'est chargé qu'une fois pour toutes les phrases du lot.

    python tools/tts-chatterbox.py jobs.json

jobs.json : {"language": "fr", "exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.7,
             "voice_prompt": null | "chemin/vers/reference.wav", "verify": true, "attempts": 5,
             "jobs": [{"text": "...", "out": "chemin/sortie.wav"}, ...]}

Contrôle qualité ("verify": true) : un modèle génératif peut ajouter des mots inventés en fin de
phrase ou en écorcher un. Chaque prise est donc retranscrite par Whisper puis comparée au texte ;
si un mot important manque, ou si des mots sont en trop, on régénère avec une autre graine et on
garde la meilleure prise.
"""
import difflib
import json
import re
import sys
import unicodedata

import torch
import torchaudio as ta
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

cfg = json.load(open(sys.argv[1], encoding="utf-8"))
if cfg.get("threads"):
    torch.set_num_threads(cfg["threads"])  # plusieurs processus en parallèle : partager les cœurs
lang = cfg.get("language", "fr")
model = ChatterboxMultilingualTTS.from_pretrained(device="cpu")

asr = None
if cfg.get("verify"):
    from faster_whisper import WhisperModel
    from num2words import num2words

    asr = WhisperModel("small", device="cpu", compute_type="int8")


def words(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")  # sans accents
    s = re.sub(r"\d+", lambda m: " " + num2words(int(m.group()), lang=lang) + " ", s) if asr else s
    return re.findall(r"[a-z]+", s.replace("-", " "))


def score(expected, heard):
    """(mots importants retrouvés / total, nombre de mots en trop)."""
    exp, got = words(expected), words(heard)
    key = [w for w in exp if len(w) >= 4]
    found = sum(1 for w in key if any(difflib.SequenceMatcher(None, w, g).ratio() >= 0.75 for g in got))
    return (found / len(key) if key else 1.0), max(0, len(got) - len(exp))


for i, job in enumerate(cfg["jobs"], 1):
    best = None
    for attempt in range(cfg.get("attempts", 8) if asr else 1):
        torch.manual_seed(cfg.get("seed", 1912) + 1000 * attempt + i)  # reproductible
        kwargs = dict(
            language_id=lang,
            exaggeration=cfg.get("exaggeration", 0.5),
            cfg_weight=cfg.get("cfg_weight", 0.5),
            temperature=cfg.get("temperature", 0.8),
        )
        if cfg.get("voice_prompt"):
            kwargs["audio_prompt_path"] = cfg["voice_prompt"]
        wav = model.generate(job["text"], **kwargs)
        if not asr:
            best = (None, wav, "")
            break
        ta.save(job["out"], wav, model.sr)
        segs, _ = asr.transcribe(job["out"], language=lang)
        heard = " ".join(s.text.strip() for s in segs)
        found, extra = score(job["text"], heard)
        rank = found - 0.25 * extra
        if best is None or rank > best[0]:
            best = (rank, wav, heard)
        # phrase courte : aucun mot en trop toléré (c'est là que le modèle « babille »)
        ok = found == 1.0 and (extra == 0 or (extra == 1 and len(words(job["text"])) >= 8))
        print(f"  [{i}/{len(cfg['jobs'])}] essai {attempt + 1} {'OK ' if ok else 'NON'} « {heard[:70]} »", file=sys.stderr, flush=True)
        if ok:
            break
    ta.save(job["out"], best[1], model.sr)
    if asr and best[0] < 1.0:
        print(f"  ! meilleure prise imparfaite pour : {job['text']}", file=sys.stderr, flush=True)

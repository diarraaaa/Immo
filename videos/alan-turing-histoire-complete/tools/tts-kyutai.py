#!/usr/bin/env python3
"""tts-kyutai.py — synthèse par lot avec Kyutai TTS 1.6B en/fr (Kyutai, Paris — licence CC-BY 4.0).

Modèle et voix téléchargés depuis Hugging Face (kyutai/tts-1.6b-en_fr, kyutai/tts-voices), puis
exécutés localement : ni clé, ni compte. Appelé par tools/build-audio.mjs quand story.json
contient "engine": "kyutai".

    python tools/tts-kyutai.py jobs.json

jobs.json : {"voice": "voice-donations/…wav", "n_q": 32, "cfg_coef": 2.0, "temp": 0.6,
             "batch": 10, "verify": true, "attempts": 4, "jobs": [{"text", "out"}, ...]}

Sans GPU, une phrase seule est ~7× plus lente que le temps réel ; en lot de 10 phrases générées
en parallèle on descend à ~3×. Comme pour Chatterbox, chaque prise est retranscrite par Whisper
et les phrases ratées sont régénérées avec une autre graine.
"""
import difflib
import json
import os
import re
import sys
import unicodedata

os.environ.setdefault("NO_TORCH_COMPILE", "1")  # torch.compile échoue sur CPU avec ce modèle

import soundfile as sf
import torch
from moshi.models.loaders import CheckpointInfo
from moshi.models.tts import DEFAULT_DSM_TTS_REPO, TTSModel

cfg = json.load(open(sys.argv[1], encoding="utf-8"))
torch.set_num_threads(cfg.get("threads") or os.cpu_count())
model = TTSModel.from_checkpoint_info(
    CheckpointInfo.from_hf_repo(DEFAULT_DSM_TTS_REPO),
    n_q=cfg.get("n_q", 32), temp=cfg.get("temp", 0.6), device="cpu", dtype=torch.float32,
)
SR = model.mimi.sample_rate

asr = None
if cfg.get("verify"):
    from faster_whisper import WhisperModel
    from num2words import num2words

    asr = WhisperModel("small", device="cpu", compute_type="int8")


def words(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"\d+", lambda m: " " + num2words(int(m.group()), lang="fr") + " ", s)
    return re.findall(r"[a-z]+", s.replace("-", " "))


def ok(expected, out):
    """Toutes les mots importants entendus, et au plus un mot en trop (phrases longues)."""
    segs, _ = asr.transcribe(out, language="fr")
    heard = " ".join(s.text.strip() for s in segs)
    exp, got = words(expected), words(heard)
    key = [w for w in exp if len(w) >= 4]
    found = all(any(difflib.SequenceMatcher(None, w, g).ratio() >= 0.75 for g in got) for w in key)
    extra = max(0, len(got) - len(exp))
    return found and (extra == 0 or (extra == 1 and len(exp) >= 8)), heard


todo = list(cfg["jobs"])
batch = cfg.get("batch", 10)
for attempt in range(cfg.get("attempts", 4) if asr else 1):
    if not todo:
        break
    failed = []
    for b in range(0, len(todo), batch):
        chunk = todo[b:b + batch]
        torch.manual_seed(cfg.get("seed", 1912) + 1000 * attempt + b)  # reproductible
        pcms = model.simple_generate([j["text"] for j in chunk], cfg["voice"],
                                     cfg_coef=cfg.get("cfg_coef", 2.0), show_progress=False)
        for job, pcm in zip(chunk, pcms):
            take = job["out"] + ".try.wav"
            sf.write(take, pcm.numpy(), SR)
            good, heard = ok(job["text"], take) if asr else (True, "")
            print(f"  essai {attempt + 1} {'OK ' if good else 'NON'} « {heard[:70]} »", file=sys.stderr, flush=True)
            if good or not os.path.exists(job["out"]):
                os.replace(take, job["out"])  # une prise ratée ne remplace pas une précédente
            else:
                os.remove(take)
            if not good:
                failed.append(job)
        print(f"  lot {b // batch + 1}/{(len(todo) + batch - 1) // batch} terminé", file=sys.stderr, flush=True)
    todo = failed
for job in todo:
    print(f"  ! prise imparfaite gardée pour : {job['text']}", file=sys.stderr, flush=True)

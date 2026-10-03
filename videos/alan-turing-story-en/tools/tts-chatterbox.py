#!/usr/bin/env python3
"""tts-chatterbox.py — synthèse par lot avec Chatterbox Multilingual (Resemble AI, licence MIT).

Appelé par tools/build-audio.mjs quand story.json contient "engine": "chatterbox".
Le modèle n'est chargé qu'une fois pour toutes les phrases du lot.

    python tools/tts-chatterbox.py jobs.json

jobs.json : {"language": "fr", "exaggeration": 0.5, "cfg_weight": 0.5,
             "voice_prompt": null | "chemin/vers/reference.wav",
             "jobs": [{"text": "...", "out": "chemin/sortie.wav"}, ...]}
"""
import json
import sys

import torch
import torchaudio as ta
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

cfg = json.load(open(sys.argv[1], encoding="utf-8"))
torch.manual_seed(cfg.get("seed", 1912))  # rendu reproductible d'une exécution à l'autre
model = ChatterboxMultilingualTTS.from_pretrained(device="cpu")

for i, job in enumerate(cfg["jobs"], 1):
    kwargs = dict(
        language_id=cfg.get("language", "fr"),
        exaggeration=cfg.get("exaggeration", 0.5),
        cfg_weight=cfg.get("cfg_weight", 0.5),
    )
    if cfg.get("voice_prompt"):
        kwargs["audio_prompt_path"] = cfg["voice_prompt"]
    wav = model.generate(job["text"], **kwargs)
    ta.save(job["out"], wav, model.sr)
    print(f"  [{i}/{len(cfg['jobs'])}] {job['text'][:60]}", file=sys.stderr, flush=True)

#!/usr/bin/env python3
"""tts-kyutai.py — voix off avec Kyutai TTS 1.6B en/fr (Kyutai, Paris — licence CC-BY 4.0).

Modèle et voix téléchargés depuis Hugging Face (kyutai/tts-1.6b-en_fr, kyutai/tts-voices), puis
exécutés localement : ni clé, ni compte. Appelé par tools/build-audio.mjs quand story.json
contient "engine": "kyutai".

    python tools/tts-kyutai.py jobs.json

jobs.json : {"voice", "n_q", "cfg_coef", "temp", "initial_padding", "padding_bonus", "batch",
             "verify", "attempts", "chunks": [{"lines": [texte, ...], "outs": [chemin | null, ...]}]}

Pourquoi des « morceaux » de plusieurs phrases plutôt qu'une phrase à la fois :
  - un narrateur ne lit pas des phrases isolées ; en lisant un paragraphe d'un seul tenant, le
    modèle enchaîne l'intonation d'une phrase à l'autre (c'est ce qui évite l'effet robotique) ;
  - sur une phrase isolée, le modèle « avale » souvent le premier mot. On fait précéder chaque
    morceau d'un mot d'échauffement (« Bon. » + courte pause) qu'on coupe ensuite.
Le modèle indique à quel pas (1 pas = 1/12,5 s) il prononce chaque mot : on redécoupe le morceau
en une piste par phrase, en coupant au point le plus silencieux entre deux phrases. Chaque phrase
est ensuite retranscrite par Whisper ; les morceaux contenant une phrase ratée sont régénérés avec
une autre graine, et seule la phrase ratée est remplacée.
"""
import difflib
import json
import os
import re
import sys
import unicodedata

os.environ.setdefault("NO_TORCH_COMPILE", "1")  # torch.compile échoue sur CPU avec ce modèle

import numpy as np
import soundfile as sf
import torch
from moshi.models.loaders import CheckpointInfo
from moshi.models.tts import DEFAULT_DSM_TTS_REPO, TTSModel

WARMUP = 'Bon. <break time="0.3s"/> '

cfg = json.load(open(sys.argv[1], encoding="utf-8"))
torch.set_num_threads(cfg.get("threads") or os.cpu_count())
model = TTSModel.from_checkpoint_info(
    CheckpointInfo.from_hf_repo(DEFAULT_DSM_TTS_REPO),
    initial_padding=cfg.get("initial_padding", 6), padding_bonus=cfg.get("padding_bonus", 0.0),
    n_q=cfg.get("n_q", 32), temp=cfg.get("temp", 0.6), device="cpu", dtype=torch.float32,
)
SR, FPS = model.mimi.sample_rate, model.mimi.frame_rate
attrs = model.make_condition_attributes([model.get_voice_path(cfg["voice"])], cfg_coef=float(cfg.get("cfg_coef", 2)))

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


def check(expected, path):
    """(phrase correcte ?, texte entendu) : tous les mots importants présents, pas de mot inventé."""
    if not asr:
        return True, ""
    segs, _ = asr.transcribe(path, language="fr")
    heard = " ".join(s.text.strip() for s in segs)
    exp, got = words(expected), words(heard)
    key = [w for w in exp if len(w) >= 4]
    found = all(any(difflib.SequenceMatcher(None, w, g).ratio() >= 0.75 for g in got) for w in key)
    extra = max(0, len(got) - len(exp))
    return found and (extra == 0 or (extra == 1 and len(exp) >= 8)), heard


def n_words(text):
    return sum(1 for e in model.prepare_script([text]) if e.text)


def quietest(pcm, a, b):
    """Instant (s) le plus silencieux entre a et b : là où l'on coupe entre deux phrases."""
    win = int(0.02 * SR)
    i0, i1 = int(a * SR), max(int(a * SR) + win, int(b * SR))
    seg = pcm[i0:i1]
    if len(seg) < 2 * win:
        return a
    rms = np.sqrt(np.convolve(seg ** 2, np.ones(win) / win, mode="valid"))
    return (i0 + int(np.argmin(rms)) + win // 2) / SR


def render(chunks, seed):
    """Génère un lot de morceaux en parallèle ; renvoie, par morceau, les pistes audio par phrase."""
    torch.manual_seed(seed)
    entries = [model.prepare_script([WARMUP + " ".join(c["lines"])], padding_between=1) for c in chunks]
    res = model.generate(entries, [attrs] * len(chunks))
    with model.mimi.streaming(len(chunks)), torch.no_grad():
        pcm = torch.cat([torch.clip(model.mimi.decode(f[:, 1:, :]), -1, 1)[:, 0] for f in res.frames[model.delay_steps:]], dim=-1)
    out = []
    for i, c in enumerate(chunks):
        end = (res.end_steps[i] or len(res.frames)) / FPS
        audio = pcm[i, : int(end * SR)].numpy()
        starts = [s / FPS for _, s in res.all_transcripts[i]]
        counts = [1] + [n_words(t) for t in c["lines"]]  # 1 = le mot d'échauffement
        if len(starts) != sum(counts):  # le modèle n'a pas lu tout le texte : morceau raté
            out.append([None] * len(c["lines"]))
            continue
        firsts = np.cumsum([0] + counts[:-1])  # index du premier mot de chaque phrase
        cuts = [quietest(audio, starts[f - 1] + 0.25, starts[f]) for f in firsts[1:]] + [end]
        out.append([audio[int(a * SR): int(b * SR)] for a, b in zip(cuts, cuts[1:])])
    return out


todo = [c for c in cfg["chunks"] if any(cfg_out for cfg_out in c["outs"])]
batch, attempts = cfg.get("batch", 11), cfg.get("attempts", 3) if asr else 1
for attempt in range(attempts):
    if not todo:
        break
    todo.sort(key=lambda c: len(" ".join(c["lines"])))  # morceaux de longueur voisine ensemble
    retry = []
    for b in range(0, len(todo), batch):
        group = todo[b:b + batch]
        for c, pieces in zip(group, render(group, cfg.get("seed", 1912) + 1000 * attempt + b)):
            bad = False
            for k, (text, path, pcm) in enumerate(zip(c["lines"], c["outs"], pieces)):
                if not path or c.get("done", [False] * len(c["lines"]))[k]:
                    continue
                good = False
                if pcm is not None and len(pcm):
                    take = path + ".try.wav"
                    sf.write(take, pcm, SR)
                    good, heard = check(text, take)
                    print(f"  essai {attempt + 1} {'OK ' if good else 'NON'} « {heard[:70]} »", file=sys.stderr, flush=True)
                    if good or not os.path.exists(path):
                        os.replace(take, path)  # une prise ratée ne remplace pas une précédente
                    else:
                        os.remove(take)
                if good:
                    c.setdefault("done", [False] * len(c["lines"]))[k] = True
                else:
                    bad = True
            if bad:
                retry.append(c)
        print(f"  lot {b // batch + 1}/{(len(todo) + batch - 1) // batch} (essai {attempt + 1}) terminé", file=sys.stderr, flush=True)
    todo = retry
for c in todo:
    for text, path, ok in zip(c["lines"], c["outs"], c.get("done", [False] * len(c["lines"]))):
        if path and not ok:
            print(f"  ! prise imparfaite gardée pour : {text}", file=sys.stderr, flush=True)

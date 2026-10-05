#!/usr/bin/env python3
"""sfx.py — bruitages synthétisés (aucune banque de sons accessible) + musique « duckée ».

    python tools/sfx.py        (après build-video.mjs, qui écrit sfx.json)

sfx.json : {"total": s, "events": [{"type": "type|rotor|whoosh|impact", "t": s, "dur": s?}]}
Sorties :
  assets/audio/sfx.wav          les bruitages placés à l'instant exact des plans
  assets/audio/music-duck.wav   la musique, baissée automatiquement quand la voix parle
"""
import json
import subprocess

import numpy as np
import soundfile as sf

SR = 48000
cfg = json.load(open("sfx.json"))
out = np.zeros(int((cfg["total"] + 1) * SR), dtype=np.float32)
rng = np.random.default_rng(1912)  # déterministe : même entrée → même son


def add(sig, t, gain):
    i = int(t * SR)
    j = min(len(out), i + len(sig))
    if i < len(out):
        out[i:j] += gain * sig[: j - i]


def lowpass(x, a):
    y = np.empty_like(x)
    acc = 0.0
    for k in range(len(x)):  # filtre RC simple
        acc += a * (x[k] - acc)
        y[k] = acc
    return y


def click(length=0.012, bright=0.6):
    n = int(length * SR)
    env = np.exp(-np.linspace(0, 9, n))
    noise = rng.standard_normal(n).astype(np.float32)
    hp = noise - lowpass(noise, 0.25) * (1 - bright)  # plus clair = touche de machine à écrire
    return (hp * env).astype(np.float32)


def whoosh(length=0.55):
    n = int(length * SR)
    t = np.linspace(0, 1, n)
    env = np.sin(np.pi * t) ** 2
    noise = rng.standard_normal(n).astype(np.float32)
    sweep = np.empty(n, dtype=np.float32)  # filtre dont la coupure monte puis redescend
    acc = 0.0
    for k in range(n):
        a = 0.02 + 0.25 * env[k]
        acc += a * (noise[k] - acc)
        sweep[k] = acc
    return sweep * env


def impact(length=0.9):
    n = int(length * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * (55 + 30 * np.exp(-t * 18)) * t) * np.exp(-t * 6)  # coup sourd
    thump = lowpass(rng.standard_normal(n).astype(np.float32), 0.05) * np.exp(-t * 25) * 3
    return (body + thump).astype(np.float32)


for ev in cfg["events"]:
    if ev["type"] == "type":
        add(click(0.012, 0.9), ev["t"], 0.22 + 0.06 * rng.random())
    elif ev["type"] == "rotor":  # cliquetis mécanique régulier pendant la durée du plan
        k = 0.0
        while k < ev["dur"]:
            add(click(0.02, 0.2), ev["t"] + k, 0.16)
            k += 0.11 + 0.03 * rng.random()
    elif ev["type"] == "whoosh":
        add(whoosh(), ev["t"] - 0.25, 0.5)
    elif ev["type"] == "impact":
        add(impact(), ev["t"], 0.55)

peak = np.max(np.abs(out)) or 1
out = out / max(peak, 1.0) * 0.9
sf.write("assets/audio/sfx.wav", out, SR)

# Musique : nappe grave sans tic-tac, compressée par la voix (ducking via sidechaincompress)
subprocess.run([
    "ffmpeg", "-y", "-v", "error",
    "-i", "assets/audio/music.wav", "-i", "assets/audio/narration.wav",
    "-filter_complex",
    "[0:a]aformat=channel_layouts=stereo[m];[1:a]aformat=channel_layouts=stereo,asplit=2[sc][v];"
    "[m][sc]sidechaincompress=threshold=0.02:ratio=8:attack=40:release=500[d];[v]anullsink",
    "-map", "[d]", "assets/audio/music-duck.wav",
], check=True)
print(f"✓ sfx.wav ({len(cfg['events'])} évènements) + music-duck.wav")

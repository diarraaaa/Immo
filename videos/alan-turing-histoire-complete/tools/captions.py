#!/usr/bin/env python3
"""captions.py — sous-titres mot à mot (1 à 3 mots) à partir des timings Whisper.

    python tools/captions.py            (depuis la racine du projet, après build-audio.mjs)

Pour chaque phrase, Whisper (faster-whisper) donne l'instant de chaque mot prononcé.
Le texte affiché (« cap » : chiffres, guillemets) diffère du texte prononcé (« say » :
nombres en lettres) et de ce que Whisper écrit. On ramène tout à une suite de mots
normalisés (nombres → lettres avec num2words, sans accents), on aligne avec difflib,
et chaque mot affiché hérite du temps des mots prononcés correspondants.

Sortie : captions.json = [{start, end, words: [{text, accent}]}], temps absolus (s).
"""
import difflib
import hashlib
import json
import re
import sys
import unicodedata

from faster_whisper import WhisperModel
from num2words import num2words

story = json.load(open("story.json", encoding="utf-8"))
timing = json.load(open("timing.json", encoding="utf-8"))
opts = {k: v for k, v in story.get("engineOptions", {}).items() if k not in ("verify", "attempts", "tempo")}
TEMPO = story.get("engineOptions", {}).get("tempo", 1)

# Noms propres et termes mis en jaune (en plus des nombres et dates)
NAMES = set("""turing alan mathison christopher morcom sherborne cambridge king's princeton alonzo church
bletchley park enigma rejewski marian varsovie welchman gordon bombe hut churchill winston manchester ace obe
royal society arnold murray copeland jack brown élisabeth londres inde angleterre atlantique
janvier février mars juin juillet septembre octobre décembre""".split())

def key(text):
    sig = f"chatterbox|{json.dumps(opts, separators=(',', ':'), ensure_ascii=False)}|{text}"
    return hashlib.sha1(sig.encode()).hexdigest()[:12]

def norm_tokens(s):
    """Texte → mots normalisés ; renvoie aussi, pour chaque mot normalisé, l'index du mot source."""
    out = []
    for i, w in enumerate(s.split()):
        w2 = unicodedata.normalize("NFD", w.lower())
        w2 = "".join(c for c in w2 if unicodedata.category(c) != "Mn")
        w2 = re.sub(r"\d+", lambda m: " " + num2words(int(m.group()), lang="fr") + " ", w2)
        for t in re.findall(r"[a-z]+", w2.replace("-", " ")):
            out.append((t, i))
    return out

asr = WhisperModel("small", device="cpu", compute_type="int8")
groups = []
for scene, story_scene in zip(timing["scenes"], story["scenes"]):
    for line, sline in zip(scene["lines"], story_scene["lines"]):
        wav = f"assets/audio/vo/{key(sline['say'])}.wav"
        segs, _ = asr.transcribe(wav, language="fr", word_timestamps=True)
        heard = [(w.word.strip(), w.start / TEMPO, w.end / TEMPO) for s in segs for w in s.words]
        # mots Whisper normalisés, chacun avec son intervalle de temps (subdivisé si « 1952 » → 4 mots)
        h_tok = []
        for text, a, b in heard:
            toks = [t for t, _ in norm_tokens(text)] or ["_"]
            for k, t in enumerate(toks):
                h_tok.append((t, a + (b - a) * k / len(toks), a + (b - a) * (k + 1) / len(toks)))
        cap_words = sline["cap"].split()
        c_tok = norm_tokens(sline["cap"])
        sm = difflib.SequenceMatcher(None, [t for t, _ in c_tok], [t for t, _, _ in h_tok], autojunk=False)
        word_time = {}
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                ci = c_tok[blk.a + k][1]
                _, a, b = h_tok[blk.b + k]
                s0, e0 = word_time.get(ci, (a, b))
                word_time[ci] = (min(s0, a), max(e0, b))
        # mots non alignés : interpolation entre voisins, bornée à la durée de la phrase
        dur = line["end"] - line["start"]
        known = sorted(word_time)
        for i in range(len(cap_words)):
            if i in word_time:
                continue
            prev = max([k for k in known if k < i], default=None)
            nxt = min([k for k in known if k > i], default=None)
            a = word_time[prev][1] if prev is not None else 0.0
            b = word_time[nxt][0] if nxt is not None else dur
            word_time[i] = (a, max(a, b))
        # groupes de 1 à 3 mots, coupés après la ponctuation
        cur = []
        def flush():
            if cur:
                groups.append({
                    "start": round(line["start"] + word_time[cur[0]][0], 3),
                    "end": round(line["start"] + word_time[cur[-1]][1], 3),
                    "words": [{"text": cap_words[i], "accent": bool(re.search(r"\d", cap_words[i])) or
                               re.sub(r"[^\w']", "", cap_words[i].lower()).replace("l'", "").replace("d'", "") in NAMES}
                              for i in cur],
                })
                cur.clear()
        for i, w in enumerate(cap_words):
            cur.append(i)
            if len(cur) == 3 or re.search(r"[.,:;?!»…]$", w) or len(w) > 11:
                flush()
        flush()
    print(f"  {scene['id']}: ok", file=sys.stderr, flush=True)

# chaque groupe reste affiché jusqu'au suivant (sans trou), sauf pendant les vrais silences
for g, nxt in zip(groups, groups[1:]):
    g["end"] = round(nxt["start"] if nxt["start"] - g["end"] < 0.6 else g["end"] + 0.25, 3)
json.dump(groups, open("captions.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print(f"✓ captions.json — {len(groups)} groupes", file=sys.stderr)

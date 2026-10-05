#!/usr/bin/env python3
"""elevenlabs.py — voix off ElevenLabs (voix humaines de la Voice Library), via l'API HTTPS.

La clé est lue dans la variable d'environnement ELEVENLABS_API_KEY (jamais dans le dépôt).

Deux commandes :

    python tools/elevenlabs.py choose [--gender male|female]
        Cherche dans la Voice Library les voix francophones de narration les plus utilisées,
        télécharge un extrait de chacune dans assets/audio/voix-candidates/ (pour écouter),
        ajoute la meilleure au compte et écrit son identifiant dans story.json.

    python tools/elevenlabs.py synth jobs.json
        Appelé par tools/build-audio.mjs quand story.json contient "engine": "elevenlabs".
        jobs.json : {...engineOptions, "jobs": [{"text", "out", "previous_text", "next_text"}]}
        previous_text / next_text : les phrases voisines. Le modèle s'en sert pour garder
        l'intonation d'un récit continu au lieu de « réciter » chaque phrase isolément —
        c'est la principale différence avec une voix qui sonne robotique.

Refaire toute la vidéo avec la nouvelle voix (depuis la racine du projet) :

    python tools/elevenlabs.py choose        # une fois
    node tools/build-audio.mjs               # voix + timing.json (~8 200 caractères)
    python tools/captions.py                 # sous-titres mot à mot (Whisper)
    node tools/build-video.mjs               # plans calés sur le nouveau timing + bruitages
    npx -y hyperframes@0.8.115 render --quality high --fps 30 --workers 4 \
        --output renders/alan-turing-histoire-complete.mp4
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.elevenlabs.io/v1"


def call(method, path, body=None, raw=False):
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("ELEVENLABS_API_KEY absente : ajoute-la dans les variables d'environnement.")
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
                return data if raw else json.loads(data)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 4:  # trop de requêtes / panne passagère
                time.sleep(2 ** attempt * 2)
                continue
            sys.exit(f"ElevenLabs {e.code} sur {path} : {e.read().decode(errors='replace')[:400]}")


def choose(gender):
    tier = call("GET", "/user/subscription").get("tier", "free")
    q = urllib.parse.urlencode({
        "page_size": 30, "language": "fr", "use_cases": "narrative_story",
        "gender": gender, "sort": "usage_character_count_1y",
    })
    voices = call("GET", f"/shared-voices?{q}")["voices"]
    if tier == "free":  # certaines voix de la bibliothèque sont réservées aux offres payantes
        voices = [v for v in voices if v.get("free_users_allowed", True)]
    if not voices:
        sys.exit("Aucune voix trouvée avec ces filtres.")
    os.makedirs("assets/audio/voix-candidates", exist_ok=True)
    print(f"Offre ElevenLabs : {tier}. Voix francophones de narration les plus utilisées :")
    for i, v in enumerate(voices[:5], 1):
        print(f"  {i}. {v['name']} — {v.get('accent')}, {v.get('age')}, "
              f"{(v.get('usage_character_count_1y') or 0) / 1e6:.0f} M caractères/an · {v['voice_id']}")
        if v.get("preview_url"):
            name = "".join(c if c.isalnum() else "-" for c in v["name"].lower())[:40]
            urllib.request.urlretrieve(v["preview_url"], f"assets/audio/voix-candidates/{i}-{name}.mp3")
    best = voices[0]  # la plus utilisée = celle que le public a le plus validée
    added = call("POST", f"/voices/add/{best['public_owner_id']}/{best['voice_id']}", {"new_name": best["name"]})
    # remplacement ciblé (garde la mise en forme « une ligne par phrase » du fichier)
    src = open("story.json", encoding="utf-8").read()
    src, n = re.subn(r'"voice_id": (null|"[^"]*")', f'"voice_id": "{added["voice_id"]}"', src, count=1)
    if not n:
        sys.exit('Ajoute "voice_id": null dans engineOptions de story.json.')
    src = re.sub(r'"voice_name": (null|"[^"]*")', lambda m: f'"voice_name": {json.dumps(best["name"], ensure_ascii=False)}', src, count=1)
    open("story.json", "w", encoding="utf-8").write(src)
    print(f"✓ Voix choisie : {best['name']} ({added['voice_id']}) → story.json")


def synth(jobs_path):
    cfg = json.load(open(jobs_path, encoding="utf-8"))
    if not cfg.get("voice_id"):
        sys.exit("Pas de voice_id dans story.json : lance d'abord « python tools/elevenlabs.py choose ».")
    settings = {k: cfg[k] for k in ("stability", "similarity_boost", "style", "use_speaker_boost", "speed") if k in cfg}
    for i, job in enumerate(cfg["jobs"], 1):
        body = {
            "text": job["text"], "model_id": cfg.get("model_id", "eleven_multilingual_v2"),
            "voice_settings": settings, "seed": cfg.get("seed", 1912),
        }
        for k in ("previous_text", "next_text"):
            if job.get(k):
                body[k] = job[k]
        mp3 = call("POST", f"/text-to-speech/{cfg['voice_id']}?output_format=mp3_44100_128", body, raw=True)
        tmp = job["out"] + ".mp3"
        open(tmp, "wb").write(mp3)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", tmp, job["out"]], check=True)
        os.remove(tmp)
        print(f"  [{i}/{len(cfg['jobs'])}] {job['text'][:70]}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "choose":
        choose(sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--gender" else "male")
    elif len(sys.argv) == 3 and sys.argv[1] == "synth":
        synth(sys.argv[2])
    else:
        sys.exit(__doc__)

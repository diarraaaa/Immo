# Alan Turing — l'histoire (TikTok, 9:16)

Vidéo verticale 1080×1920 de ~78 s, en français, réalisée avec
[HyperFrames](https://hyperframes.heygen.com) (HTML → vidéo).

- **Rendu final :** `renders/alan-turing-tiktok.mp4`
- **Style :** preset *Broadside* (fond encre, un seul accent orange, Barlow 900 + IBM Plex Mono)
- **Voix :** Chatterbox Multilingual + voix de référence SIWIS (local, gratuit), sous-titres synchronisés phrase par phrase
- **Musique :** nappe sombre + tic-tac synthétisés par FFmpeg (aucune banque de sons n'était accessible)

## Comment c'est construit

```
story.json                 ← LE texte : scènes, phrases (say = prononcé, cap = affiché, hl = mot surligné)
tools/build-audio.mjs      → voix off proposition par proposition + timing.json
tools/build-index.mjs      → index.html + compositions/{captions,chrome,transitions}.html
compositions/scenes/*.html ← les 10 scènes animées (GSAP), écrites à la main
assets/photos/             ← 13 photos d'archives réelles (crédits et licences : CREDITS.md)
```

Chaque scène reçoit, via la variable HyperFrames `beats`, l'instant (en secondes) où
commence chacune de ses phrases : les animations restent calées sur la voix même si
on change le texte.

## La voix

`story.json` choisit le moteur de voix :

- `"engine": "chatterbox"` (actuel) — **Chatterbox Multilingual** (Resemble AI, MIT), bien
  plus naturel que Kokoro. On lui donne une **voix de référence française**
  (`assets/audio/voix-reference-siwis.wav`, corpus SIWIS, CC BY 4.0) : sans elle, sa voix par
  défaut est anglophone et garde l'accent (Whisper entendait « millions de J's » au lieu de
  « millions de vies »). Environ 6× plus lent que le temps réel sur CPU (~10 min pour la vidéo).
  Installation : `python3 -m venv cbx && cbx/bin/pip install chatterbox-tts`, puis
  `CHATTERBOX_PYTHON=cbx/bin/python node tools/build-audio.mjs`.
- `"engine": "kokoro"` (ou absent) — Kokoro `ff_siwis` via `hyperframes tts` : instantané mais
  robotique. Kokoro passe les noms anglais en phonèmes anglais ; il faut alors les écrire « pour
  l'oreille » dans `say` (`Tiourinng` → `tjuʁiŋ`, `Blètchelie Parc`, `Énigma`).

Dans les deux cas, `say` écrit les nombres en toutes lettres.

## Modifier puis régénérer

```bash
cd videos/alan-turing-histoire
# 1. éditer story.json (texte), puis :
node tools/build-audio.mjs      # voix + timing (le cache évite de régénérer les phrases inchangées)
node tools/build-index.mjs      # index + sous-titres
npx hyperframes check           # lint + rendu + mise en page + contraste
npx hyperframes render --quality high --output renders/alan-turing-tiktok.mp4
```

En session cloud, Chrome est déjà installé : `export HYPERFRAMES_BROWSER_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`.

## Photos

Les 13 photos (`assets/photos/`) sont de vraies images d'archives, du domaine public ou sous
licence Creative Commons. **Les crédits sont obligatoires** pour les licences CC BY / CC BY-SA :
ils sont affichés sous chaque photo, résumés sur la carte finale, et détaillés dans
[`CREDITS.md`](CREDITS.md) avec un texte prêt à coller dans la description TikTok.

## Sources des faits

Naissance 23/06/1912 (Londres) · « On Computable Numbers » 1936 · Bletchley Park dès 1939 ·
première Bombe britannique 1940, dérivée de la *bomba* polonaise · Enigma armée (3 rotors +
tableau de connexions) : 158 962 555 217 826 360 000 réglages · 26³ = 17 576 positions de
rotors · plans de l'ACE 1946 · « Computing Machinery and Intelligence » 1950 · procès du
31/03/1952 · mort le 07/06/1954 (41 ans) · grâce royale 24/12/2013 · billet de 50 £ émis en 2021.
L'estimation « 2 ans de guerre en moins » (F. H. Hinsley) est présentée comme telle.

# Alan Turing — l'histoire (TikTok, 9:16)

Vidéo verticale 1080×1920 de ~80 s, en français, réalisée avec
[HyperFrames](https://hyperframes.heygen.com) (HTML → vidéo).

- **Rendu final :** `renders/alan-turing-tiktok.mp4`
- **Style :** preset *Broadside* (fond encre, un seul accent orange, Barlow 900 + IBM Plex Mono)
- **Voix :** Kokoro `ff_siwis` (TTS locale, gratuite), sous-titres synchronisés phrase par phrase
- **Musique :** nappe sombre + tic-tac synthétisés par FFmpeg (aucune banque de sons n'était accessible)

## Comment c'est construit

```
story.json                 ← LE texte : scènes, phrases (say = prononcé, cap = affiché, hl = mot surligné)
tools/build-audio.mjs      → voix off proposition par proposition + timing.json
tools/build-index.mjs      → index.html + compositions/{captions,chrome,transitions}.html
compositions/scenes/*.html ← les 10 scènes animées (GSAP), écrites à la main
assets/illustrations/      ← illustrations SVG (portrait stylisé, Bletchley Park)
```

Chaque scène reçoit, via la variable HyperFrames `beats`, l'instant (en secondes) où
commence chacune de ses phrases : les animations restent calées sur la voix même si
on change le texte.

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

## Remplacer les illustrations par de vraies photos

Le réseau de la session de création bloquait les banques d'images (Wikimedia Commons,
Unsplash…). Les cartes « photo » utilisent donc des illustrations SVG, marquées
« ILLUSTRATION » à l'écran. Pour mettre de vraies photos d'archives :

1. Déposer les fichiers dans `assets/photos/` (par ex. le portrait d'Alan Turing à 16 ans,
   domaine public sur Wikimedia Commons ; une photo du manoir de Bletchley Park).
2. Changer le `src` de l'image :
   - `compositions/scenes/01-hook.html` → `#s01-img`
   - `compositions/scenes/05-bombe.html` → `#s05-card img`
3. Remplacer la légende « Illustration » par la source/crédit de la photo.
4. `npx hyperframes check` puis `render`.

## Sources des faits

Naissance 23/06/1912 (Londres) · « On Computable Numbers » 1936 · Bletchley Park dès 1939 ·
première Bombe britannique 1940, dérivée de la *bomba* polonaise · Enigma armée (3 rotors +
tableau de connexions) : 158 962 555 217 826 360 000 réglages · 26³ = 17 576 positions de
rotors · plans de l'ACE 1946 · « Computing Machinery and Intelligence » 1950 · procès du
31/03/1952 · mort le 07/06/1954 (41 ans) · grâce royale 24/12/2013 · billet de 50 £ émis en 2021.
L'estimation « 2 ans de guerre en moins » (F. H. Hinsley) est présentée comme telle.

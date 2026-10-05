#!/usr/bin/env node
// build-index.mjs — timing.json → index.html
//
// index.html est la composition racine : elle héberge les 10 scènes
// (sous-compositions dans compositions/scenes/), la voix off, la musique,
// l'habillage commun (barre de progression, compteur) et les sous-titres.
// Tout est placé en temps absolu à partir de timing.json : changer le texte de
// story.json puis relancer build-audio + build-index suffit à tout resynchroniser.
//
//   node tools/build-index.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const timing = JSON.parse(readFileSync(join(ROOT, "timing.json"), "utf8"));
const W = 1080;
const H = 1920;
const r3 = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ── Sous-titres : découpe d'une ligne en groupes de ≤ 4 mots / ≤ 26 caractères.
// Le mot-clé (hl) reste toujours dans un seul groupe. Kokoro ne donne pas de
// timestamps par mot : à l'intérieur d'une ligne, le temps est réparti au
// prorata du nombre de caractères (les bornes de ligne, elles, sont exactes).
function chunkLine(line) {
  const { cap, hl } = line;
  const hlAt = hl ? cap.toLowerCase().indexOf(hl.toLowerCase()) : -1;
  const tokens = []; // { text, hl }
  const pushWords = (s, isHl) => {
    if (isHl) tokens.push({ text: s.trim(), hl: true });
    else s.split(/\s+/).filter(Boolean).forEach((w) => tokens.push({ text: w, hl: false }));
  };
  if (hlAt >= 0) {
    // Préfixe élidé collé au mot-clé (« d'Alan Turing ») → rattaché au token surligné
    const before = cap.slice(0, hlAt);
    const head = before.match(/[^\s]*$/)[0];
    pushWords(before.slice(0, before.length - head.length), false);
    pushWords(cap.slice(hlAt, hlAt + hl.length), true);
    if (head) tokens[tokens.length - 1].head = head;
    // ponctuation collée au mot-clé (« condamné. ») → rattachée au token surligné
    const rest = cap.slice(hlAt + hl.length);
    const glued = rest.match(/^[^\s]*/)[0];
    if (glued) tokens[tokens.length - 1].tail = glued;
    pushWords(rest.slice(glued.length), false);
  } else pushWords(cap, false);

  const groups = [];
  let cur = [];
  const len = (g) => g.reduce((n, t) => n + (t.head?.length ?? 0) + t.text.length + (t.tail?.length ?? 0) + 1, 0);
  for (const tok of tokens) {
    const words = cur.reduce((n, t) => n + t.text.split(" ").length, 0);
    if (cur.length && (words >= 4 || len(cur) + tok.text.length > 26)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(tok);
  }
  if (cur.length) groups.push(cur);
  // Évite un dernier groupe orphelin d'un seul petit mot.
  if (groups.length > 1 && groups.at(-1).length === 1 && len(groups.at(-1)) < 6 && !groups.at(-1)[0].hl) {
    groups.at(-2).push(...groups.pop());
  }

  const total = groups.reduce((n, g) => n + len(g), 0);
  let t = line.start;
  const span = line.end - line.start;
  return groups.map((g) => {
    const d = (len(g) / total) * span;
    const out = { start: r3(t), end: r3(t + d), tokens: g };
    t += d;
    return out;
  });
}

const captions = [];
for (const s of timing.scenes) {
  const sceneCaps = s.lines.flatMap(chunkLine);
  sceneCaps.forEach((c, i) => {
    // Chaque groupe reste affiché jusqu'au suivant (pas de trou noir entre deux
    // propositions), sauf le dernier de la scène qui s'éteint à la fin de la scène.
    const next = sceneCaps[i + 1];
    c.until = next ? next.start : Math.min(s.end, c.end + 0.6);
    captions.push(c);
  });
}

const capHtml = captions
  .map((c, i) => {
    const words = c.tokens
      .map((t) =>
        t.hl
          ? `${t.head ? esc(t.head) : ""}<span class="cap-hl">${esc(t.text)}</span>${t.tail ? esc(t.tail) : ""}`
          : `<span class="cap-w">${esc(t.text)}</span>`,
      )
      .join(" ");
    return `        <div id="cap-${i}" class="cap-group"><div class="cap-plate" id="cap-plate-${i}"><p class="cap-line">${words}</p></div></div>`;
  })
  .join("\n");

const sceneHtml = timing.scenes
  .map(
    (s) =>
      `      <div id="scene-${s.id}" data-composition-id="${s.id}" data-composition-src="compositions/scenes/${s.id}.html" data-start="${s.start}" data-duration="${s.duration}" data-track-index="${1 + (s.index % 2)}" data-width="${W}" data-height="${H}" data-variable-values='${attr(JSON.stringify({ beats: s.beats.join(",") }))}'></div>`,
  )
  .join("\n");

const counterHtml = timing.scenes
  .map(
    (s, i) =>
      `        <div id="count-${i}" class="chrome-count">${String(i + 1).padStart(2, "0")} / ${String(timing.scenes.length).padStart(2, "0")}</div>`,
  )
  .join("\n");

// Volets orange (transition « wipe ») sur les grandes bascules du récit.
const WIPE_AT = ["02-enfance", "04-enigma", "08-tragedie", "10-fin"];
const wipes = timing.scenes.filter((s) => WIPE_AT.includes(s.id));
const wipeHtml = wipes
  .map(
    (s, i) =>
      `        <div class="wipe-panel" id="wipe-panel-${i}"></div>`,
  )
  .join("\n");

// ── Timelines des sous-compositions (temps local = temps global : elles démarrent à 0)
const capTweens = captions
  .map(
    (c, i) =>
      `          tl.set("#cap-${i}", { opacity: 1 }, ${c.start});\n` +
      `          tl.fromTo("#cap-plate-${i}", { y: 26, scale: 0.94 }, { y: 0, scale: 1, duration: 0.22, ease: "back.out(2)" }, ${c.start});\n` +
      `          tl.set("#cap-${i}", { opacity: 0 }, ${r3(c.until)});`,
  )
  .join("\n");
const countTweens = timing.scenes
  .map((s, i) => `          tl.set("#count-${i}", { opacity: 1 }, ${s.start});\n          tl.set("#count-${i}", { opacity: 0 }, ${s.end});`)
  .join("\n");
// Moments où une scène passe en registre orange (volet plein cadre) : l'habillage
// bascule alors en encre (« ink-on-fire » : jamais de crème sur orange).
const ORANGE = { "01-hook": [2, -0.2], "10-fin": [1, -0.25] }; // [index de phrase, décalage]
const chromeInk = timing.scenes
  .filter((s) => ORANGE[s.id])
  .map((s) => {
    const [bi, off] = ORANGE[s.id];
    const from = r3(s.start + s.beats[bi] + off + 0.2);
    return (
      `          tl.to(".chrome-label, .chrome-count", { color: "#111111", duration: 0.2 }, ${from});\n` +
      `          tl.to("#chrome-fill", { backgroundColor: "#111111", duration: 0.2 }, ${from});\n` +
      `          tl.set(".chrome-label, .chrome-count", { color: "#f0ece5" }, ${s.end});\n` +
      `          tl.set("#chrome-fill", { backgroundColor: "#e85d26" }, ${s.end});`
    );
  })
  .join("\n");
const wipeTweens = wipes
  .map(
    (s, i) =>
      `          tl.set("#wipe-panel-${i}", { visibility: "visible" }, ${r3(s.start - 0.3)});\n` +
      `          tl.fromTo("#wipe-panel-${i}", { yPercent: 100 }, { yPercent: 0, duration: 0.28, ease: "power3.in" }, ${r3(s.start - 0.3)});\n` +
      `          tl.to("#wipe-panel-${i}", { yPercent: -100, duration: 0.3, ease: "power3.out" }, ${s.start});\n` +
      `          tl.set("#wipe-panel-${i}", { visibility: "hidden" }, ${r3(s.start + 0.3)});`,
  )
  .join("\n");

const subcomp = (id, css, body, tweens) => `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <!-- GÉNÉRÉ par tools/build-index.mjs à partir de timing.json — ne pas éditer à la main -->
  </head>
  <body>
    <template>
      <style>
${css}
      </style>
      <div id="${id}-root" data-composition-id="${id}" data-width="${W}" data-height="${H}">
${body}
      </div>
      <script>
        (() => {
          const tl = gsap.timeline({ paused: true });
${tweens}
          window.__timelines["${id}"] = tl;
        })();
      </script>
    </template>
  </body>
</html>
`;

writeFileSync(
  join(ROOT, "compositions/captions.html"),
  subcomp(
    "captions",
    `        #captions-root { position: absolute; inset: 0; pointer-events: none; }
        /* bande 1190–1430 px : au-dessus de l'interface TikTok du bas */
        .cap-group { position: absolute; left: 0; right: 0; top: 1190px; height: 240px; display: flex; align-items: center; justify-content: center; opacity: 0; }
        .cap-plate { max-width: 900px; padding: 18px 38px 24px; background: var(--ink); border: 1px solid var(--fire); }
        .cap-line { font-family: var(--sans); font-weight: 900; font-size: 66px; line-height: 1.04; letter-spacing: -0.03em; text-transform: lowercase; color: var(--cream); text-align: center; }
        .cap-hl { color: var(--ink); background: var(--fire); box-shadow: 0 0 0 0.07em var(--fire); }`,
    capHtml,
    capTweens,
  ),
);

writeFileSync(
  join(ROOT, "compositions/chrome.html"),
  subcomp(
    "chrome",
    `        #chrome-root { position: absolute; inset: 0; pointer-events: none; }
        /* zone sûre TikTok : rien d'important dans les 160 px du haut */
        .chrome-bar { position: absolute; left: 72px; right: 72px; top: 168px; height: 4px; background: rgba(240, 236, 229, 0.16); }
        .chrome-fill { position: absolute; left: 0; top: 0; width: 100%; height: 100%; background: var(--fire); transform-origin: left center; }
        .chrome-label { position: absolute; left: 72px; top: 192px; font-family: var(--mono); font-weight: 500; font-size: 22px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cream); opacity: 0.85; }
        .chrome-count { position: absolute; right: 72px; top: 192px; font-family: var(--mono); font-weight: 500; font-size: 22px; letter-spacing: 0.14em; color: var(--cream); opacity: 0; }`,
    `        <div class="chrome-bar"><div class="chrome-fill" id="chrome-fill"></div></div>
        <div class="chrome-label">Alan Turing · 1912–1954</div>
${counterHtml}`,
    `          tl.fromTo("#chrome-fill", { scaleX: 0 }, { scaleX: 1, duration: ${timing.total}, ease: "none" }, 0);\n${countTweens}\n${chromeInk}`,
  ),
);

writeFileSync(
  join(ROOT, "compositions/transitions.html"),
  subcomp(
    "transitions",
    `        #transitions-root { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
        .wipe-panel { position: absolute; inset: 0; background: var(--fire); visibility: hidden; }`,
    wipeHtml,
    wipeTweens,
  ),
);

const host = (id, track, extra = "") =>
  `      <div id="layer-${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="0" data-duration="${timing.total}" data-track-index="${track}" data-width="${W}" data-height="${H}"${extra}></div>`;

const html = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>Alan Turing — l'histoire</title>
    <!-- GÉNÉRÉ par tools/build-index.mjs à partir de timing.json — ne pas éditer à la main -->
    <script src="vendor/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Barlow"; font-weight: 400; src: url("assets/fonts/barlow-latin-400-normal.woff2") format("woff2"); }
      @font-face { font-family: "Barlow"; font-weight: 500; src: url("assets/fonts/barlow-latin-500-normal.woff2") format("woff2"); }
      @font-face { font-family: "Barlow"; font-weight: 600; src: url("assets/fonts/barlow-latin-600-normal.woff2") format("woff2"); }
      @font-face { font-family: "Barlow"; font-weight: 700; src: url("assets/fonts/barlow-latin-700-normal.woff2") format("woff2"); }
      @font-face { font-family: "Barlow"; font-weight: 800; src: url("assets/fonts/barlow-latin-800-normal.woff2") format("woff2"); }
      @font-face { font-family: "Barlow"; font-weight: 900; src: url("assets/fonts/barlow-latin-900-normal.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Mono"; font-weight: 400; src: url("assets/fonts/ibm-plex-mono-latin-400-normal.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Mono"; font-weight: 500; src: url("assets/fonts/ibm-plex-mono-latin-500-normal.woff2") format("woff2"); }
      @font-face { font-family: "IBM Plex Mono"; font-weight: 600; src: url("assets/fonts/ibm-plex-mono-latin-600-normal.woff2") format("woff2"); }

      /* ── Jetons Broadside (frame.md) ── */
      :root {
        --ink: #111111;
        --ink-alt: #1a1a18;
        --fire: #e85d26;
        --cream: #f0ece5;
        --cream-muted: #888880;
        --cream-hint: #505048;
        --border: #282826;
        --mono: "IBM Plex Mono", ui-monospace, monospace;
        --sans: "Barlow", system-ui, sans-serif;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: var(--ink); }
      body { font-family: var(--sans); color: var(--cream); -webkit-font-smoothing: antialiased; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--ink); }
      .clip { position: absolute; inset: 0; }

      /* ── Atomes partagés par toutes les scènes (le DOM des scènes est cloné ici) ── */
      .kicker { font-family: var(--mono); font-weight: 500; font-size: 24px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--fire); }
      .kicker.muted { color: var(--cream-muted); }
      .rule { display: block; width: 64px; height: 4px; background: var(--fire); }
      .display { font-family: var(--sans); font-weight: 900; text-transform: lowercase; letter-spacing: -0.045em; line-height: 0.86; }
      .h1 { font-family: var(--sans); font-weight: 800; text-transform: lowercase; letter-spacing: -0.03em; line-height: 0.92; }
      .h2 { font-family: var(--sans); font-weight: 700; text-transform: lowercase; letter-spacing: -0.02em; line-height: 1.05; }
      .lead { font-family: var(--sans); font-weight: 500; font-size: 34px; line-height: 1.35; color: var(--cream-muted); }
      .accent { color: var(--fire); }
      /* carte « photo » : cadre net, filet 1px, légende mono — remplaçable par une vraie photo */
      .photo-card { position: absolute; background: var(--ink-alt); border: 1px solid var(--border); padding: 18px 18px 0; }
      .photo-card img { display: block; width: 100%; height: auto; }
      /* cadre à hauteur fixe : la photo est recadrée (cover) — fixer la hauteur par carte */
      .photo-card .frame { overflow: hidden; background: #000; }
      .photo-card .frame img { width: 100%; height: 100%; object-fit: cover; }
      .photo-card .photo-cap { display: flex; flex-wrap: wrap; gap: 4px 16px; justify-content: space-between; font-family: var(--mono); font-size: 20px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cream-muted); padding: 16px 2px 18px; }
      .stamp { position: absolute; font-family: var(--mono); font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--fire); border: 6px solid var(--fire); padding: 10px 26px; }
      .scene-ground { position: absolute; inset: 0; background: var(--ink); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${timing.total}" data-width="${W}" data-height="${H}">
      <div id="ground" class="clip scene-ground" data-start="0" data-duration="${timing.total}" data-track-index="0"></div>

      <!-- Scènes -->
${sceneHtml}

      <!-- Calques communs : habillage, sous-titres, transitions -->
${host("chrome", 10)}
${host("captions", 20, ' data-track-kind="captions"')}
${host("transitions", 30)}

      <!-- Audio : voix off + nappe synthétisée -->
      <audio id="vo" src="assets/audio/narration.wav" data-start="0" data-duration="${timing.total}" data-track-index="90" data-volume="1"></audio>
      <audio id="bgm" src="assets/audio/music.wav" data-start="0" data-duration="${timing.total}" data-track-index="91" data-volume="0.22" data-fade-in="1.5" data-fade-out="2.5"></audio>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;

writeFileSync(join(ROOT, "index.html"), html);
process.stderr.write(`✓ index.html + captions/chrome/transitions — ${timing.scenes.length} scènes, ${captions.length} sous-titres, ${timing.total}s\n`);

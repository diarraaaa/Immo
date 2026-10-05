#!/usr/bin/env node
// build-video.mjs — story.json + timing.json + shots.mjs (+ captions.json) → compositions HyperFrames 16:9
//
// Version longue YouTube (1920×1080). Chaque phrase de story.json reçoit un ou plusieurs
// « plans » décrits dans shots.mjs ; ce script en fabrique le HTML et la timeline GSAP :
//   compositions/scenes/<id>.html   un chapitre = une sous-composition
//   compositions/captions.html      sous-titres mot à mot (captions.json, sinon phrase par phrase)
//   compositions/chrome.html        barre de progression + chapitre en cours
//   index.html                      composition racine + voix off + musique
//
//   node tools/build-video.mjs [--estimate]   (--estimate : timing provisoire si la voix n'est pas prête)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHOTS, CREDITS } from "../shots.mjs";

const ROOT = process.cwd();
const W = 1920;
const H = 1080;
const story = JSON.parse(readFileSync(join(ROOT, "story.json"), "utf8"));
const GRADES = JSON.parse(readFileSync(join(ROOT, "tools/grades.json"), "utf8"));
const r3 = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => esc(s).replace(/"/g, "&quot;");

// ── Timing : réel (timing.json de build-audio) ou estimé (≈ 15,5 caractères/s)
let timing;
if (process.argv.includes("--estimate") || !existsSync(join(ROOT, "timing.json"))) {
  let t = story.leadIn;
  const scenes = story.scenes.map((s, si) => {
    const lines = s.lines.map((l, li) => {
      const d = Math.max(0.7, l.say.length / 15.5);
      const line = { cap: l.cap, start: r3(t), end: r3(t + d) };
      t += d + (l.pause ?? (li === s.lines.length - 1 ? story.gapAfterScene : story.gapAfterLine));
      return line;
    });
    return { id: s.id, index: si, lines };
  });
  const total = r3(t + story.tail);
  scenes.forEach((s, i) => {
    s.start = i === 0 ? 0 : r3(s.lines[0].start - 0.25);
  });
  scenes.forEach((s, i) => {
    s.end = i === scenes.length - 1 ? total : scenes[i + 1].start;
    s.duration = r3(s.end - s.start);
  });
  timing = { total, scenes, estimated: true };
} else {
  timing = JSON.parse(readFileSync(join(ROOT, "timing.json"), "utf8"));
}

// ── Plans : une entrée par phrase (un plan ou un tableau de plans qui se partagent la phrase)
//    Les instants sont relatifs à la scène. Un plan dure jusqu'au début du suivant.
function planScene(scene, specs) {
  const plans = [];
  scene.lines.forEach((line, li) => {
    const spec = specs[li];
    if (spec === undefined) throw new Error(`${scene.id} : pas de plan pour la phrase ${li + 1} « ${line.cap} »`);
    if (spec === null) return; // la phrase garde le plan précédent
    const list = Array.isArray(spec) ? spec : [spec];
    const a = (li === 0 ? scene.start : line.start) - scene.start;
    const nextLine = scene.lines[li + 1];
    const b = (nextLine ? nextLine.start : scene.end) - scene.start;
    // découpe pondérée (w) de [a, b] entre les plans de la phrase
    const weights = list.map((p) => p.w ?? 1);
    const sum = weights.reduce((x, y) => x + y, 0);
    let t = a;
    list.forEach((p, k) => {
      plans.push({ ...p, start: r3(li === 0 && k === 0 ? 0 : t) });
      t += ((b - a) * weights[k]) / sum;
    });
  });
  plans.forEach((p, i) => {
    p.end = i < plans.length - 1 ? plans[i + 1].start : r3(scene.duration);
    p.dur = r3(p.end - p.start);
  });
  // Règle du script : jamais une photo plus de ~4 s. Une photo trop longue est recoupée en
  // plusieurs plans de la même archive, chacun avec un autre cadrage (plus serré, décalé).
  const out = [];
  for (const p of plans) {
    if (p.t !== "photo" || p.hold || p.dur <= 4.2) { out.push(p); continue; }
    const n = Math.ceil(p.dur / 3.4);
    const [fx, fy] = p.focus ?? [50, 40];
    const z1 = p.zoom?.[1] ?? 1.16;
    for (let k = 0; k < n; k++) {
      const start = r3(p.start + (p.dur * k) / n);
      const end = r3(p.start + (p.dur * (k + 1)) / n);
      const shift = [[0, 0], [-12, -6], [12, 4], [-6, 8]][k % 4];
      out.push({
        ...p,
        start, end, dur: r3(end - start),
        label: k === 0 ? p.label : undefined,
        focus: [Math.min(85, Math.max(15, fx + shift[0])), Math.min(85, Math.max(15, fy + shift[1]))],
        zoom: k === 0 ? p.zoom : [z1 + 0.12 * k, z1 + 0.12 * k + 0.1],
        fade: k === 0 ? p.fade : undefined,
      });
    }
  }
  return out;
}

// ── Rendu HTML + tweens de chaque type de plan. Chaque fonction reçoit (plan, id) et renvoie
//    { html, js } ; js est du code de timeline avec les temps déjà relatifs à la scène.
const ERA = { sepia: GRADES.sepia, guerre: GRADES.guerre, froid: GRADES.froid };
// Étalonnage « cuit » d'avance par tools/bake-grades.mjs (sinon shader à chaque image : très lent sans GPU)
const bakedPath = (p) => `assets/photos/graded/${p.src.replace(/\.jpe?g$/i, "")}__${p.era}.jpg`;
const baked = (p) => p.era && existsSync(join(ROOT, bakedPath(p)));
const photoSrc = (p) => (baked(p) ? bakedPath(p) : `assets/photos/${p.src}`);
const gradeAttr = (era) => (ERA[era] ? ` data-color-grading="${attr(JSON.stringify(ERA[era]))}"` : "");

function labelHtml(p, id) {
  if (!p.label) return { html: "", js: "" };
  const lid = `${id}-label`;
  const n = p.label.length;
  // « instant » : libellé complet dès la première image (miniature YouTube = premier frame)
  if (p.instant) return { html: `<div class="chip" id="${lid}"><span class="chip-bar"></span><span class="chip-t">${esc(p.label)}</span></div>`, js: "" };
  // effet machine à écrire : le texte s'écrit lettre par lettre (états posés sur la timeline)
  const steps = Array.from({ length: n }, (_, k) => `tl.set("#${lid}-t", { textContent: ${JSON.stringify(p.label.slice(0, k + 1))} }, ${r3(p.start + 0.15 + (k * 0.5) / n)});`).join("\n");
  return {
    html: `<div class="chip" id="${lid}"><span class="chip-bar"></span><span class="chip-t" id="${lid}-t"></span></div>`,
    js: `tl.fromTo("#${lid}", { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.25, ease: "power3.out" }, ${r3(p.start + 0.05)});\n${steps}`,
  };
}

const RENDER = {
  // Photo d'archive : image entière sur fond sombre, Ken Burns vers « focus » (x%, y%)
  photo(p, id) {
    const credit = CREDITS[p.src] ?? "";
    const fit = p.fit ?? "cover";
    const [fx, fy] = p.focus ?? [50, 40];
    const z0 = p.zoom?.[0] ?? 1.04;
    const z1 = p.zoom?.[1] ?? 1.16;
    return {
      html: `<div class="shot photo ${fit}" id="${id}"><div class="pframe" id="${id}-f"><img class="clip pimg" id="${id}-i" src="${photoSrc(p)}" alt="" data-start="${p.start}" data-duration="${p.dur}"${baked(p) ? "" : gradeAttr(p.era)} /></div>${credit ? `<div class="credit">${esc(credit)}</div>` : ""}</div>`,
      js: `tl.fromTo("#${id}-i", { scale: ${z0}, transformOrigin: "${fx}% ${fy}%" }, { scale: ${z1}, duration: ${p.dur}, ease: "none" }, ${p.start});` +
        (p.punch ? `\ntl.fromTo("#${id}-f", { scale: 1 }, { scale: 1.12, duration: 0.35, ease: "power3.out", transformOrigin: "${fx}% ${fy}%", immediateRender: false }, ${r3(p.start + p.punch)});` : ""),
    };
  },
  // Grande phrase sur fond encre, mots entre [crochets] en jaune
  card(p, id) {
    const text = esc(p.text).replace(/\[([^\]]+)\]/g, '<span class="y">$1</span>');
    return {
      html: `<div class="shot card${p.dark ? " dark" : ""}" id="${id}">${p.kicker ? `<div class="kick">${esc(p.kicker)}</div>` : ""}<div class="ctext" id="${id}-t">${text}</div>${p.note ? `<div class="cnote">${esc(p.note)}</div>` : ""}</div>`,
      js: `tl.fromTo("#${id}-t", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, ${r3(p.start + 0.05)});` +
        (p.punch ? `\ntl.fromTo("#${id}-t", { scale: 1 }, { scale: 1.1, duration: 0.35, ease: "power3.out", immediateRender: false }, ${r3(p.start + p.punch)});` : ""),
    };
  },
  chapter(p, id) {
    return {
      html: `<div class="shot chapter" id="${id}"><div class="chnum" id="${id}-n">Chapitre ${p.n}</div><div class="chtitle" id="${id}-t">${esc(p.title)}</div><div class="chrule" id="${id}-r"></div></div>`,
      js: `tl.fromTo("#${id}-n", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.35 }, ${r3(p.start + 0.05)});
tl.fromTo("#${id}-t", { opacity: 0, y: 50 }, { opacity: 1, y: 0, duration: 0.5, ease: "power4.out" }, ${r3(p.start + 0.15)});
tl.fromTo("#${id}-r", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.inOut" }, ${r3(p.start + 0.3)});`,
    };
  },
  // Date (ou mot) énorme, tapée à la machine
  date(p, id) {
    const n = p.text.length;
    const steps = Array.from({ length: n }, (_, k) => `tl.set("#${id}-t", { textContent: ${JSON.stringify(p.text.slice(0, k + 1))} }, ${r3(p.start + 0.1 + (k * 0.6) / n)});`).join("\n");
    return {
      html: `<div class="shot date" id="${id}">${p.kicker ? `<div class="kick">${esc(p.kicker)}</div>` : ""}<div class="dtext" id="${id}-t"></div>${p.sub ? `<div class="dsub" id="${id}-s">${esc(p.sub)}</div>` : ""}</div>`,
      js: steps + (p.sub ? `\ntl.fromTo("#${id}-s", { opacity: 0 }, { opacity: 1, duration: 0.4 }, ${r3(p.start + 0.8)});` : "") +
        (p.punch ? `\ntl.fromTo("#${id}-t", { scale: 1 }, { scale: 1.12, duration: 0.35, ease: "power3.out", transformOrigin: "0% 50%" }, ${r3(p.start + 0.7 + p.punch)});` : ""),
    };
  },
  // Carte schématique : points nommés reliés par un tracé qui avance
  map(p, id) {
    const pts = p.points; // [nom, x, y] en px
    const d = pts.map(([, x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
    const dots = pts.map(([name, x, y], i) => `<g class="mdot" id="${id}-p${i}"><circle cx="${x}" cy="${y}" r="14" fill="#ffd23f"/><text x="${x}" y="${y - 30}" text-anchor="middle" class="mlabel">${esc(name)}</text></g>`).join("");
    const step = (p.dur - 0.6) / Math.max(1, pts.length - 1);
    const js = pts.map((_, i) => `tl.fromTo("#${id}-p${i}", { opacity: 0, scale: 0.4, svgOrigin: "${pts[i][1]} ${pts[i][2]}" }, { opacity: 1, scale: 1, svgOrigin: "${pts[i][1]} ${pts[i][2]}", duration: 0.3, ease: "back.out(2)" }, ${r3(p.start + 0.2 + i * step)});`).join("\n");
    return {
      html: `<div class="shot map" id="${id}"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#grid)"/><path id="${id}-path" d="${d}" fill="none" stroke="#ffd23f" stroke-width="6" stroke-dasharray="18 14"/>${dots}</svg>${p.title ? `<div class="mtitle">${esc(p.title)}</div>` : ""}<div class="schema">Schéma · positions approximatives</div></div>`,
      js: `tl.fromTo("#${id}-path", { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: ${r3(Math.max(0.6, p.dur - 0.6))}, ease: "power1.inOut" }, ${r3(p.start + 0.2)});\n${js}`,
    };
  },
  // Machine de Turing : ruban + tête qui calcule 1011 + 1 = 1100
  tape(p, id) {
    const init = ["", "1", "0", "1", "1", "", "", "", "", ""];
    const cells = init.map((v, i) => `<div class="tcell" id="${id}-c${i}">${v || "·"}</div>`).join("");
    const trace = [[1], [2], [3], [4], [5], [4, "0"], [3, "0"], [2, "1"]];
    const step = Math.min(0.5, (p.dur - 0.8) / trace.length);
    let js = `tl.fromTo("#${id}-tape", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" }, ${r3(p.start)});`;
    let prev = null;
    trace.forEach(([pos, write], k) => {
      const t = r3(p.start + 0.5 + k * step);
      js += `\ntl.to("#${id}-head", { x: ${pos * 136}, duration: ${r3(step * 0.6)}, ease: "power2.inOut" }, ${t});`;
      if (prev !== null) js += `\ntl.set("#${id}-c${prev}", { className: "tcell" }, ${r3(t + step * 0.6)});`;
      js += `\ntl.set("#${id}-c${pos}", { className: "tcell hot" }, ${r3(t + step * 0.6)});`;
      if (write) js += `\ntl.set("#${id}-c${pos}", { textContent: "${write}" }, ${r3(t + step * 0.7)});`;
      prev = pos;
    });
    return {
      html: `<div class="shot tapeshot" id="${id}">${p.title ? `<div class="kick">${esc(p.title)}</div>` : ""}<div class="tapewrap" id="${id}-tape"><div class="tape">${cells}</div><div class="thead" id="${id}-head"><div class="ttri"></div><div class="tbox"></div></div></div><div class="tcap">Ruban infini · tête de lecture · règles</div></div>`,
      js,
    };
  },
  // Tableau lumineux d'Enigma qui épelle un mot
  enigma(p, id) {
    const rows = ["QWERTZUIO", "ASDFGHJK", "PYXCVBNML"];
    const lamps = rows.map((r) => `<div class="erow">${[...r].map((c) => `<div class="lamp" id="${id}-${c}">${c}</div>`).join("")}</div>`).join("");
    const word = p.word ?? "WETTER";
    const step = Math.min(0.45, (p.dur - 0.6) / word.length);
    let js = "";
    [...word].forEach((c, k) => {
      const t = r3(p.start + 0.4 + k * step);
      js += `tl.set("#${id}-${c}", { className: "lamp lit" }, ${t});\ntl.set("#${id}-${c}", { className: "lamp" }, ${r3(t + step * 0.8)});\ntl.set("#${id}-out", { textContent: ${JSON.stringify("Clair : " + word.slice(0, k + 1))} }, ${t});\n`;
    });
    return {
      html: `<div class="shot enigma" id="${id}"><div class="ebox"><div class="kick">Enigma · tableau lumineux</div><div class="elamps">${lamps}</div><div class="eout" id="${id}-out">Clair : —</div></div></div>`,
      js,
    };
  },
  // Compteur qui s'emballe puis se fige
  counter(p, id) {
    const final = p.to;
    let seed = 1939;
    const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const n = 14;
    let js = `tl.fromTo("#${id}-n", { opacity: 0, scale: 1.1 }, { opacity: 1, scale: 1, duration: 0.3 }, ${p.start});`;
    for (let k = 0; k < n; k++) js += `\ntl.set("#${id}-n", { textContent: ${JSON.stringify(final.replace(/\d/g, () => String(Math.floor(rnd() * 10))))} }, ${r3(p.start + k * 0.07)});`;
    js += `\ntl.set("#${id}-n", { textContent: ${JSON.stringify(final)} }, ${r3(p.start + n * 0.07)});`;
    js += `\ntl.fromTo("#${id}-n", { scale: 1.06 }, { scale: 1, duration: 0.3, ease: "back.out(3)", immediateRender: false }, ${r3(p.start + n * 0.07)});`;
    return { html: `<div class="shot counter" id="${id}"><div class="kick">${esc(p.kicker ?? "")}</div><div class="cnum" id="${id}-n">${esc(final)}</div><div class="cnote">${esc(p.label ?? "")}</div></div>`, js };
  },
  // Bombe : tambours qui tournent de plus en plus vite
  bombe(p, id) {
    const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const drum = (i) => `<svg class="drum" viewBox="0 0 180 180"><g id="${id}-d${i}"><circle cx="90" cy="90" r="82" fill="#151515" stroke="${i % 5 === 2 ? "#ffd23f" : "#555"}" stroke-width="4"/>${[...ABC].map((c, k) => { const a = (k / 26) * Math.PI * 2; return `<text x="${r3(90 + Math.sin(a) * 62)}" y="${r3(96 - Math.cos(a) * 62)}" text-anchor="middle" font-size="15" font-weight="600" fill="${k ? "#999" : "#ffd23f"}" font-family="IBM Plex Mono, monospace">${c}</text>`; }).join("")}<circle cx="90" cy="90" r="22" fill="#2a2a2a"/></g></svg>`;
    const drums = Array.from({ length: 18 }, (_, i) => drum(i)).join("");
    const js = Array.from({ length: 18 }, (_, i) => { const dir = i % 2 ? -1 : 1; const sp = 120 + (Math.floor(i / 6) * 160); return `tl.fromTo("#${id}-d${i}", { rotation: 0, svgOrigin: "90 90" }, { rotation: ${dir * sp * p.dur}, svgOrigin: "90 90", duration: ${p.dur}, ease: "power1.in" }, ${p.start});`; }).join("\n");
    return { html: `<div class="shot bombe" id="${id}"><div class="kick">${esc(p.kicker ?? "La Bombe · schéma")}</div><div class="cab">${drums}</div></div>`, js };
  },
  // Jeu de l'imitation : conversation écrite
  chat(p, id) {
    return {
      html: `<div class="shot chat" id="${id}"><div class="kick">Le jeu de l'imitation · 1950</div><div class="msgs"><div class="msg q" id="${id}-a"><small>Juge</small>Es-tu un humain&nbsp;?</div><div class="msg r" id="${id}-b"><small>Interlocuteur caché</small>Bien sûr. Et toi&nbsp;?</div></div><div class="who" id="${id}-w">HUMAIN ? MACHINE ?</div></div>`,
      js: `tl.fromTo("#${id}-a", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.3 }, ${r3(p.start + 0.2)});
tl.fromTo("#${id}-b", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.3 }, ${r3(p.start + Math.min(1.4, p.dur * 0.4))});
tl.fromTo("#${id}-w", { opacity: 0 }, { opacity: 1, duration: 0.3 }, ${r3(p.start + Math.min(2.2, p.dur * 0.65))});`,
    };
  },
  // Frise chronologique qui se remplit
  timeline(p, id) {
    const items = p.items.map(([y, t], i) => `<div class="tl-item" id="${id}-i${i}"><div class="tl-y">${esc(y)}</div><div class="tl-t">${esc(t)}</div></div>`).join("");
    const js = p.items.map((_, i) => `tl.fromTo("#${id}-i${i}", { opacity: 0.12 }, { opacity: 1, duration: 0.3 }, ${r3(p.start + (p.at?.[i] ?? 0.3 + i * 0.6))});`).join("\n");
    return { html: `<div class="shot tline" id="${id}"><div class="tl-rail"></div><div class="tl-items">${items}</div></div>`, js: `tl.fromTo("#${id} .tl-rail", { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: "power2.inOut" }, ${p.start});\n${js}` };
  },
  // Document recomposé (pas une archive) : lignes tapées + tampon
  doc(p, id) {
    const lines = p.lines.map((l, i) => `<div class="dl" id="${id}-l${i}">${esc(l)}</div>`).join("");
    let js = `tl.fromTo("#${id}-p", { opacity: 0, y: 60, rotation: 2 }, { opacity: 1, y: 0, rotation: -1, duration: 0.5, ease: "power3.out" }, ${p.start});`;
    p.lines.forEach((_, i) => { js += `\ntl.fromTo("#${id}-l${i}", { opacity: 0 }, { opacity: 1, duration: 0.2 }, ${r3(p.start + 0.4 + i * 0.35)});`; });
    if (p.stamp) js += `\ntl.fromTo("#${id}-s", { opacity: 0, scale: 2.4 }, { opacity: 1, scale: 1, rotation: -10, duration: 0.2, ease: "power4.in" }, ${r3(p.start + (p.stampAt ?? 1.2))});`;
    return {
      html: `<div class="shot doc" id="${id}"><div class="paper" id="${id}-p">${lines}<div class="dtag">Illustration · document recomposé</div></div>${p.stamp ? `<div class="dstamp" id="${id}-s">${esc(p.stamp)}</div>` : ""}</div>`,
      js,
    };
  },
  // Billet de 50 £ stylisé avec le vrai portrait de 1951
  note50(p, id) {
    return {
      html: `<div class="shot note50" id="${id}"><div class="nwrap" id="${id}-n"><svg viewBox="0 0 900 480" width="1100" height="587"><rect width="900" height="480" fill="#f0ece5"/><rect x="20" y="20" width="860" height="440" fill="none" stroke="#111" stroke-width="3"/><text x="44" y="160" font-family="Barlow, sans-serif" font-weight="900" font-size="160" fill="#c0392b" letter-spacing="-6">£50</text><text x="52" y="232" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="26" letter-spacing="4" fill="#111">FIFTY POUNDS</text><text x="52" y="312" font-family="Barlow, sans-serif" font-weight="800" font-size="50" fill="#111">alan turing</text><text x="52" y="356" font-family="IBM Plex Mono, monospace" font-size="22" letter-spacing="3" fill="#111">1912 – 1954</text><text x="48" y="430" font-family="IBM Plex Mono, monospace" font-size="22" fill="#111" opacity="0.55">01000001 01001100 01000001 01001110</text><clipPath id="${id}-m"><circle cx="670" cy="240" r="150"/></clipPath><circle cx="670" cy="240" r="156" fill="#111"/><g clip-path="url(#${id}-m)"><image href="assets/photos/turing-1951.jpg" x="514" y="84" width="312" height="312" preserveAspectRatio="xMidYMin slice"/></g><circle cx="670" cy="240" r="156" fill="none" stroke="#111" stroke-width="3"/></svg><div class="ncap">Billet de 50 £ · 2021 · stylisé — portrait : Elliott &amp; Fry, 1951</div></div></div>`,
      js: `tl.fromTo("#${id}-n", { opacity: 0, y: 160, rotation: -8 }, { opacity: 1, y: 0, rotation: -2, duration: 0.7, ease: "back.out(1.3)" }, ${p.start});\ntl.to("#${id}-n", { rotation: 0, scale: 1.04, duration: ${r3(Math.max(0.5, p.dur - 0.7))}, ease: "sine.inOut" }, ${r3(p.start + 0.7)});`,
    };
  },
};

// ── Bruitages : évènements en temps absolu, synthétisés par tools/sfx.py (aucun au chapitre 6)
const SFX = [];
function sfxFor(scene, p) {
  if (scene.id === "08-pomme") return;
  const T = (t) => r3(scene.start + t);
  if (p.label && !p.instant) [...p.label].forEach((_, k) => SFX.push({ type: "type", t: T(p.start + 0.15 + (k * 0.5) / p.label.length) }));
  if (p.t === "date") [...p.text].forEach((_, k) => SFX.push({ type: "type", t: T(p.start + 0.1 + (k * 0.6) / p.text.length) }));
  if (p.t === "bombe" || p.t === "enigma") SFX.push({ type: "rotor", t: T(p.start + 0.3), dur: r3(Math.max(0.5, p.dur - 0.5)) });
  if (p.t === "tape") for (let k = 0; k < 8; k++) SFX.push({ type: "type", t: T(p.start + 0.5 + k * Math.min(0.5, (p.dur - 0.8) / 8)) });
  if (p.t === "chapter") SFX.push({ type: "whoosh", t: T(p.start) });
  if (p.t === "doc" && p.stamp) SFX.push({ type: "impact", t: T(p.start + (p.stampAt ?? 1.2) + 0.18) });
  if (scene.id === "01-enjeux") SFX.push({ type: "whoosh", t: T(p.start) }); // whoosh à chaque changement d'image
}

// ── Une scène = une sous-composition
function sceneHtml(scene, plans) {
  plans.forEach((p) => sfxFor(scene, p));
  const parts = plans.map((p, i) => {
    const id = `s${scene.index}-p${i}`;
    const r = RENDER[p.t];
    if (!r) throw new Error(`type de plan inconnu : ${p.t}`);
    const body = r(p, id);
    const lab = labelHtml(p, id);
    // visibilité du plan : coupe franche (option « fade » : fondu lent)
    const vis = p.fade
      ? `tl.fromTo("#${id}-w", { opacity: 0 }, { opacity: 1, duration: ${p.fade} }, ${p.start});\ntl.set("#${id}-w", { opacity: 0 }, ${p.end});`
      : `tl.set("#${id}-w", { opacity: 1 }, ${p.start});\ntl.set("#${id}-w", { opacity: 0 }, ${p.end});`;
    return { html: `<div class="shotwrap" id="${id}-w">${body.html}${lab.html}</div>`, js: `${vis}\n${body.js}\n${lab.js}` };
  });
  const cid = scene.id;
  return `<!doctype html>
<html lang="fr">
  <head><meta charset="UTF-8" /><!-- GÉNÉRÉ par tools/build-video.mjs — ne pas éditer à la main --></head>
  <body>
    <template>
      <style>#sc${scene.index}-root { position: absolute; inset: 0; overflow: hidden; background: #0e0e0e; }</style>
      <div id="sc${scene.index}-root" data-composition-id="${cid}" data-width="${W}" data-height="${H}">
${parts.map((p) => "        " + p.html).join("\n")}
      </div>
      <script>
        (() => {
          const tl = gsap.timeline({ paused: true });
${parts.map((p) => p.js.split("\n").filter(Boolean).map((l) => "          " + l).join("\n")).join("\n")}
          window.__timelines["${cid}"] = tl;
        })();
      </script>
    </template>
  </body>
</html>
`;
}

mkdirSync(join(ROOT, "compositions/scenes"), { recursive: true });
let nPlans = 0;
for (const scene of timing.scenes) {
  const specs = SHOTS[scene.id];
  if (!specs) throw new Error(`shots.mjs : scène ${scene.id} manquante`);
  const plans = planScene(scene, specs);
  nPlans += plans.length;
  const long = plans.filter((p) => p.dur > 4.5 && p.t === "photo" && !p.hold);
  if (long.length) process.stderr.write(`  ⚠ ${scene.id} : ${long.length} photo(s) > 4,5 s (${long.map((p) => p.src + " " + p.dur + "s").join(", ")})\n`);
  writeFileSync(join(ROOT, `compositions/scenes/${scene.id}.html`), sceneHtml(scene, plans));
}

// ── Sous-titres : mot à mot si captions.json existe, sinon phrase par phrase (provisoire)
let groups;
if (existsSync(join(ROOT, "captions.json")) && !timing.estimated) {
  groups = JSON.parse(readFileSync(join(ROOT, "captions.json"), "utf8")).filter((g) => g.end > g.start);
  // Lisibilité : un groupe ne finit pas sur un petit mot (« à gagner la / guerre ») — fusion avec le suivant
  const SMALL = new Set("la le les l' de du des d' un une à au aux en et qui que son sa ses leur ce cette par pour sur dans avec".split(" "));
  for (let i = 0; i < groups.length - 1; i++) {
    const g = groups[i], n = groups[i + 1];
    const last = g.words.at(-1).text.toLowerCase();
    if (SMALL.has(last) && n.start - g.end < 0.2 && g.words.length + n.words.length <= 4) {
      groups.splice(i, 2, { start: g.start, end: n.end, words: [...g.words, ...n.words] });
    }
  }
} else {
  groups = timing.scenes.flatMap((s) => s.lines.map((l) => ({ start: l.start, end: l.end, words: l.cap.split(" ").map((w) => ({ text: w, accent: /\d/.test(w) })) })));
}
// Question d'engagement (script : 3 dernières secondes, dans la zone sûre)
groups.push({ start: r3(timing.total - 3.2), end: timing.total, q: true, words: [{ text: "Tu connaissais cette partie de son histoire ?", accent: false }] });
const capHtml = groups.map((g, i) => `<div class="cg${g.q ? " cq" : ""}" id="cg${i}"><span class="cl">${g.words.map((w) => (w.accent ? `<span class="ca">${esc(w.text)}</span>` : esc(w.text))).join(" ")}</span></div>`).join("\n        ");
const capJs = groups.map((g, i) => `tl.set("#cg${i}", { opacity: 1 }, ${g.start});\ntl.set("#cg${i}", { opacity: 0 }, ${g.end});`).join("\n          ");
writeFileSync(
  join(ROOT, "compositions/captions.html"),
  `<!doctype html>
<html lang="fr">
  <head><meta charset="UTF-8" /><!-- GÉNÉRÉ par tools/build-video.mjs --></head>
  <body>
    <template>
      <style>
        #captions-root { position: absolute; inset: 0; pointer-events: none; }
        /* sans-serif gras, blanc, contour noir épais ; jaune pour dates, nombres et noms */
        .cg { position: absolute; left: 0; right: 0; top: 870px; height: 140px; display: flex; align-items: center; justify-content: center; opacity: 0; }
        .cl { font-family: var(--sans); font-weight: 900; font-size: 74px; line-height: 1; letter-spacing: -0.01em; color: #ffffff; -webkit-text-stroke: 14px #000; paint-order: stroke fill; text-align: center; }
        .ca { color: var(--yellow); }
        .cq .cl { font-size: 58px; -webkit-text-stroke: 0; color: #111; background: var(--yellow); padding: 18px 34px 22px; }
      </style>
      <div id="captions-root" data-composition-id="captions" data-width="${W}" data-height="${H}">
        ${capHtml}
      </div>
      <script>
        (() => {
          const tl = gsap.timeline({ paused: true });
          ${capJs}
          window.__timelines["captions"] = tl;
        })();
      </script>
    </template>
  </body>
</html>
`,
);

// impact sonore sur « condamne » dans la toute première phrase
const hookWord = groups.find((g) => g.words.some((w) => /^condamne/i.test(w.text)));
if (hookWord) SFX.push({ type: "impact", t: hookWord.start });
writeFileSync(join(ROOT, "sfx.json"), JSON.stringify({ total: timing.total, events: SFX }));
if (!timing.estimated && existsSync(join(ROOT, "assets/audio/narration.wav"))) {
  execFileSync(process.env.CHATTERBOX_PYTHON || "python3", [join(ROOT, "tools/sfx.py")], { stdio: ["ignore", "inherit", "inherit"] });
}

// Chapitres YouTube (description) : début de chaque scène titrée, au format m:ss
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
writeFileSync(join(ROOT, "chapters.txt"), story.scenes.map((s, i) => (s.title ? `${mmss(timing.scenes[i].start)} ${s.title}` : null)).filter(Boolean).join("\n") + "\n");

// ── Index racine
const sceneHosts = timing.scenes
  .map((s) => `      <div id="host-${s.id}" data-composition-id="${s.id}" data-composition-src="compositions/scenes/${s.id}.html" data-start="${s.start}" data-duration="${s.duration}" data-track-index="${1 + (s.index % 2)}" data-width="${W}" data-height="${H}"></div>`)
  .join("\n");
const fonts = [400, 500, 600, 700, 800, 900].map((w) => `@font-face { font-family: "Barlow"; font-weight: ${w}; src: url("assets/fonts/barlow-latin-${w}-normal.woff2") format("woff2"); }`).join("\n      ") +
  "\n      " + [400, 500, 600].map((w) => `@font-face { font-family: "IBM Plex Mono"; font-weight: ${w}; src: url("assets/fonts/ibm-plex-mono-latin-${w}-normal.woff2") format("woff2"); }`).join("\n      ");
const audio = existsSync(join(ROOT, "assets/audio/narration.wav")) && !timing.estimated
  ? `      <audio id="vo" src="assets/audio/narration.wav" data-start="0" data-duration="${timing.total}" data-track-index="90" data-volume="1"></audio>
      <audio id="bgm" src="assets/audio/music-duck.wav" data-start="0" data-duration="${timing.total}" data-track-index="91" data-volume="0.2" data-fade-in="2" data-fade-out="3"></audio>
      <audio id="sfx" src="assets/audio/sfx.wav" data-start="0" data-duration="${timing.total}" data-track-index="92" data-volume="0.7"></audio>`
  : "      <!-- voix off pas encore générée (timing estimé) -->";
writeFileSync(
  join(ROOT, "index.html"),
  `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>Alan Turing — l'histoire complète</title>
    <!-- GÉNÉRÉ par tools/build-video.mjs à partir de story.json, timing.json et shots.mjs -->
    <script src="vendor/gsap.min.js"></script>
    <style>
      ${fonts}
      :root { --ink: #0e0e0e; --paper: #f2efe8; --yellow: #ffd23f; --red: #c0392b; --muted: #9a9a92; --mono: "IBM Plex Mono", ui-monospace, monospace; --sans: "Barlow", system-ui, sans-serif; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: var(--ink); }
      body { font-family: var(--sans); color: var(--paper); -webkit-font-smoothing: antialiased; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--ink); }
      .clip { position: absolute; inset: 0; }

      /* ── plans (le DOM des scènes est cloné dans ce document) ── */
      .shotwrap { position: absolute; inset: 0; opacity: 0; overflow: hidden; }
      .shot { position: absolute; inset: 0; background: var(--ink); }
      .kick { font-family: var(--mono); font-weight: 500; font-size: 30px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--yellow); }
      .photo .pframe { position: absolute; inset: 0; overflow: hidden; }
      .photo .pimg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .photo.contain .pframe { inset: 40px auto 150px 50%; width: 920px; margin-left: -460px; border: 2px solid #2a2a2a; }
      .photo.contain { background: var(--ink) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60'><path d='M60 0H0V60' fill='none' stroke='%231c1c1c' stroke-width='2'/></svg>"); }
      .photo.contain .pimg { object-fit: cover; }
      .credit { position: absolute; right: 36px; top: 30px; font-family: var(--mono); font-size: 18px; letter-spacing: 0.08em; color: #d8d8d0; background: rgba(0, 0, 0, 0.55); padding: 6px 12px; }
      .chip { position: absolute; left: 80px; top: 70px; display: flex; align-items: center; gap: 18px; background: rgba(14, 14, 14, 0.82); padding: 14px 26px 16px 18px; }
      .chip-bar { display: block; width: 10px; height: 54px; background: var(--yellow); }
      .chip-t { font-family: var(--sans); font-weight: 900; font-size: 54px; line-height: 1; color: #fff; }
      .card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; padding: 0 160px 170px; text-align: center; }
      .card .ctext { font-family: var(--sans); font-weight: 900; font-size: 112px; line-height: 1.02; letter-spacing: -0.02em; color: #fff; }
      .card .y, .y { color: var(--yellow); }
      .card .cnote { font-family: var(--mono); font-size: 26px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
      .chapter { display: flex; flex-direction: column; justify-content: center; padding: 0 160px 120px; }
      .chnum { font-family: var(--mono); font-weight: 600; font-size: 34px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--yellow); }
      .chtitle { margin-top: 18px; font-family: var(--sans); font-weight: 900; font-size: 150px; line-height: 0.95; letter-spacing: -0.03em; color: #fff; }
      .chrule { margin-top: 34px; width: 420px; height: 8px; background: var(--yellow); transform-origin: left center; }
      .date { display: flex; flex-direction: column; justify-content: center; padding: 0 160px 150px; }
      .dtext { font-family: var(--sans); font-weight: 900; font-size: 190px; line-height: 1; letter-spacing: -0.03em; color: var(--yellow); min-height: 190px; }
      .dsub { margin-top: 20px; font-family: var(--mono); font-size: 34px; letter-spacing: 0.12em; text-transform: uppercase; color: #ddd; }
      .date .kick { margin-bottom: 20px; }
      .map svg { position: absolute; inset: 0; }
      .mlabel { font-family: var(--sans); font-weight: 800; font-size: 40px; fill: #fff; paint-order: stroke; stroke: #0e0e0e; stroke-width: 8px; }
      .mtitle { position: absolute; left: 80px; top: 70px; font-family: var(--mono); font-size: 30px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--yellow); }
      .schema, .dtag { position: absolute; right: 36px; top: 30px; font-family: var(--mono); font-size: 18px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
      .tapeshot { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 110px; padding-bottom: 120px; }
      .tapewrap { position: relative; }
      .tape { display: flex; gap: 12px; }
      .tcell { width: 124px; height: 140px; border: 2px solid #555; display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-weight: 600; font-size: 72px; color: #fff; background: #171717; }
      .tcell.hot { background: var(--yellow); color: #111; border-color: var(--yellow); }
      .thead { position: absolute; left: 0; top: -70px; width: 124px; height: 230px; }
      .ttri { position: absolute; left: 40px; top: 0; width: 0; height: 0; border-left: 22px solid transparent; border-right: 22px solid transparent; border-top: 38px solid var(--yellow); }
      .tbox { position: absolute; left: -10px; top: 58px; width: 144px; height: 162px; border: 6px solid var(--yellow); }
      .tcap { font-family: var(--mono); font-size: 26px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
      .enigma { display: flex; align-items: center; justify-content: center; padding-bottom: 150px; }
      .ebox { padding: 40px 60px; background: #161616; border: 2px solid #2a2a2a; display: flex; flex-direction: column; align-items: center; gap: 26px; }
      .elamps { display: flex; flex-direction: column; align-items: center; gap: 20px; }
      .erow { display: flex; gap: 18px; }
      .lamp { width: 84px; height: 84px; border-radius: 50%; border: 2px solid #555; display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-weight: 600; font-size: 34px; color: #999; background: #0e0e0e; }
      .lamp.lit { background: var(--yellow); border-color: var(--yellow); color: #111; box-shadow: 0 0 46px rgba(255, 210, 63, 0.75); }
      .eout { font-family: var(--mono); font-size: 32px; letter-spacing: 0.3em; color: var(--yellow); }
      .counter { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; padding-bottom: 170px; }
      .cnum { font-family: var(--sans); font-weight: 900; font-size: 120px; letter-spacing: -0.02em; color: var(--yellow); font-variant-numeric: tabular-nums; }
      .counter .cnote { font-family: var(--mono); font-size: 30px; letter-spacing: 0.12em; text-transform: uppercase; color: #ddd; }
      .bombe { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; padding-bottom: 150px; }
      .cab { display: grid; grid-template-columns: repeat(6, 150px); gap: 22px; padding: 30px 40px; background: #161616; border: 2px solid #2a2a2a; }
      .drum { width: 150px; height: 150px; }
      .chat { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 40px; padding-bottom: 170px; }
      .msgs { width: 1100px; display: flex; flex-direction: column; gap: 30px; }
      .msg { max-width: 760px; padding: 28px 40px; font-family: var(--sans); font-weight: 700; font-size: 56px; line-height: 1.1; }
      .msg small { display: block; margin-bottom: 10px; font-family: var(--mono); font-weight: 500; font-size: 22px; letter-spacing: 0.14em; text-transform: uppercase; }
      .msg.q { align-self: flex-start; background: #1b1b1b; border: 2px solid #444; color: #fff; }
      .msg.q small { color: var(--muted); }
      .msg.r { align-self: flex-end; background: var(--yellow); color: #111; }
      .who { font-family: var(--mono); font-weight: 600; font-size: 40px; letter-spacing: 0.2em; color: #fff; }
      .tline { display: flex; align-items: center; justify-content: center; padding-bottom: 170px; }
      .tl-rail { position: absolute; left: 140px; right: 140px; top: 470px; height: 6px; background: var(--yellow); transform-origin: left center; }
      .tl-items { position: relative; width: 1640px; display: flex; justify-content: space-between; }
      .tl-item { width: 360px; padding-top: 70px; }
      .tl-y { font-family: var(--sans); font-weight: 900; font-size: 92px; color: var(--yellow); line-height: 1; }
      .tl-t { margin-top: 14px; font-family: var(--sans); font-weight: 600; font-size: 36px; line-height: 1.2; color: #fff; }
      .doc { display: flex; align-items: center; justify-content: center; padding-bottom: 160px; }
      .paper { position: relative; width: 1100px; padding: 60px 70px 80px; background: var(--paper); color: #161616; font-family: var(--mono); }
      .paper .dl { font-size: 36px; line-height: 1.6; letter-spacing: 0.04em; }
      .paper .dl:first-child { font-family: var(--sans); font-weight: 800; font-size: 54px; margin-bottom: 16px; letter-spacing: 0; }
      .paper .dtag { top: auto; bottom: 20px; right: 30px; color: #6b6b63; }
      .dstamp { position: absolute; left: 1060px; top: 560px; font-family: var(--mono); font-weight: 600; font-size: 72px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--red); border: 8px solid var(--red); padding: 10px 34px; }
      .note50 { display: flex; align-items: center; justify-content: center; padding-bottom: 150px; }
      .nwrap { display: flex; flex-direction: column; align-items: center; gap: 18px; }
      .ncap { font-family: var(--mono); font-size: 22px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
    </style>
  </head>
  <body>
    <svg width="0" height="0" style="position: absolute"><defs><pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M60 0H0V60" fill="none" stroke="#1d1d1d" stroke-width="2"/></pattern></defs></svg>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${timing.total}" data-width="${W}" data-height="${H}">
      <div id="ground" class="clip" data-start="0" data-duration="${timing.total}" data-track-index="0"></div>
${sceneHosts}
      <div id="layer-captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${timing.total}" data-track-index="20" data-track-kind="captions" data-width="${W}" data-height="${H}"></div>
${audio}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`,
);
process.stderr.write(`✓ ${timing.scenes.length} scènes, ${nPlans} plans, ${groups.length} sous-titres, ${timing.total}s${timing.estimated ? " (timing ESTIMÉ)" : ""}\n`);

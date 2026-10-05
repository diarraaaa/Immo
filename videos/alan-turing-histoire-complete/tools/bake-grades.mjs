#!/usr/bin/env node
// bake-grades.mjs — « cuit » l'étalonnage par époque dans des copies des photos.
//
// Sans GPU (WebGL logiciel), les shaders data-color-grading rendent la vidéo ~25× plus lente
// (mesuré : 300 images en 51 s sans étalonnage, > 20 min avec). On calcule donc une seule fois,
// avec le moteur HyperFrames lui-même, chaque couple (photo, époque) utilisé dans shots.mjs :
// une mini-composition contenant uniquement l'image étalonnée est capturée par `hyperframes
// snapshot`, et le résultat est enregistré dans assets/photos/graded/<photo>__<époque>.jpg.
// build-video.mjs utilise ensuite ces copies au lieu d'appliquer le shader à chaque image.
//
//   node tools/bake-grades.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHOTS } from "../shots.mjs";

const ROOT = process.cwd();
const GRADES = JSON.parse(execFileSync("cat", [join(ROOT, "tools/grades.json")]).toString());
const OUT = join(ROOT, "assets/photos/graded");
mkdirSync(OUT, { recursive: true });
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const pairs = new Set();
for (const specs of Object.values(SHOTS))
  for (const spec of specs.flat()) if (spec && spec.t === "photo" && spec.era) pairs.add(`${spec.src}|${spec.era}`);

const tmp = join(ROOT, ".bake");
for (const pair of [...pairs].sort()) {
  const [src, era] = pair.split("|");
  const dest = join(OUT, `${src.replace(/\.jpe?g$/i, "")}__${era}.jpg`);
  if (existsSync(dest)) continue;
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(ROOT, "assets/photos", src)])
    .toString().trim().split(",").map(Number);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  symlinkSync(join(ROOT, "assets"), join(tmp, "assets"));
  symlinkSync(join(ROOT, "vendor"), join(tmp, "vendor"));
  writeFileSync(join(tmp, "index.html"), `<!doctype html><html><head><meta charset="UTF-8"><script src="vendor/gsap.min.js"></script>
<style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#000}#root{position:relative;width:100%;height:100%}.clip{position:absolute;inset:0}img{width:100%;height:100%;object-fit:fill}</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="${w}" data-height="${h}">
<img id="ph" class="clip" data-start="0" data-duration="1" src="assets/photos/${src}" alt="" data-color-grading="${attr(JSON.stringify(GRADES[era]))}" /></div>
<script>window.__timelines["main"] = gsap.timeline({ paused: true });</script></body></html>`);
  execFileSync("npx", ["-y", "hyperframes@0.8.115", "snapshot", tmp, "--at", "0.5", "--describe", "false"], { stdio: ["ignore", "ignore", "inherit"] });
  const png = readdirSync(join(tmp, "snapshots")).find((f) => f.endsWith(".png"));
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", join(tmp, "snapshots", png), "-q:v", "3", dest]);
  process.stderr.write(`  ✓ ${src} · ${era} (${w}×${h})\n`);
}
rmSync(tmp, { recursive: true, force: true });
process.stderr.write(`✓ ${pairs.size} photos étalonnées dans assets/photos/graded/\n`);

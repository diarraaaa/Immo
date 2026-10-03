#!/usr/bin/env node
// build-audio.mjs — story.json → voix off + timing.json
//
// Kokoro (TTS locale) ne fournit pas de timestamps par mot. On synthétise donc
// la narration proposition par proposition : la durée exacte de chaque fichier
// donne le début et la fin de chaque sous-titre, sans transcription Whisper.
//
//   node tools/build-audio.mjs           (depuis la racine du projet)
//
// Sorties :
//   assets/audio/vo/<hash>.wav   cache, une proposition par fichier
//   assets/audio/narration.wav   voix off complète, silences inclus
//   assets/audio/music.wav       nappe sombre + tic-tac, synthétisée par FFmpeg
//   timing.json                  scènes et lignes avec temps absolus (secondes)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const story = JSON.parse(readFileSync(join(ROOT, "story.json"), "utf8"));
const VO_DIR = join(ROOT, "assets/audio/vo");
mkdirSync(VO_DIR, { recursive: true });

const r3 = (n) => Math.round(n * 1000) / 1000;
const probe = (file) =>
  Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
      .toString()
      .trim(),
  );

function synth(text) {
  const key = createHash("sha1").update(`${story.voice}|${story.speed}|${text}`).digest("hex").slice(0, 12);
  const raw = join(VO_DIR, `${key}.raw.wav`);
  const out = join(VO_DIR, `${key}.wav`);
  if (!existsSync(out)) {
    execFileSync(
      "npx",
      ["hyperframes", "tts", text, "-v", story.voice, "-s", String(story.speed), "-o", raw, "--json"],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    // Coupe le silence de tête/queue de Kokoro pour que les durées soient « utiles »
    // et normalise en 24 kHz mono.
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-i", raw,
      "-af",
      "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02," +
        "areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06,areverse",
      "-ar", "24000", "-ac", "1", out,
    ]);
    execFileSync("rm", ["-f", raw]);
  }
  return { file: out, duration: probe(out) };
}

// 1) Synthèse + placement temporel
let t = story.leadIn;
const pieces = []; // { file?, silence?, duration }
pieces.push({ silence: true, duration: story.leadIn });
const scenes = [];
for (const [si, scene] of story.scenes.entries()) {
  const lines = [];
  for (const [li, line] of scene.lines.entries()) {
    const { file, duration } = synth(line.say);
    lines.push({ cap: line.cap, hl: line.hl, start: r3(t), end: r3(t + duration) });
    pieces.push({ file, duration });
    t += duration;
    const gap = li === scene.lines.length - 1 ? story.gapAfterScene : story.gapAfterLine;
    pieces.push({ silence: true, duration: gap });
    t += gap;
  }
  scenes.push({ id: scene.id, index: si, lines });
  process.stderr.write(`  ${scene.id}: ${lines.length} lignes, fin ${r3(t)}s\n`);
}

// 2) Bornes de scène : chaque scène démarre 0,25 s avant sa première phrase
//    (la coupe visuelle précède la voix, comme au montage).
const total = r3(t - story.gapAfterScene + story.tail);
for (const [i, s] of scenes.entries()) {
  s.start = i === 0 ? 0 : r3(s.lines[0].start - 0.25);
}
for (const [i, s] of scenes.entries()) {
  s.end = i === scenes.length - 1 ? total : scenes[i + 1].start;
  s.duration = r3(s.end - s.start);
  // Temps relatifs à la scène : c'est ce que lisent les sous-compositions.
  s.beats = s.lines.map((l) => r3(l.start - s.start));
  s.beatEnds = s.lines.map((l) => r3(l.end - s.start));
}

// 3) Concaténation de la voix off (filtre concat avec silences générés)
const inputs = [];
const filters = [];
pieces.forEach((p, i) => {
  if (p.silence) {
    inputs.push("-f", "lavfi", "-t", String(p.duration), "-i", "anullsrc=r=24000:cl=mono");
  } else {
    inputs.push("-i", p.file);
  }
  filters.push(`[${i}:a]`);
});
const narration = join(ROOT, "assets/audio/narration.wav");
execFileSync("ffmpeg", [
  "-y", "-v", "error", ...inputs,
  "-filter_complex", `${filters.join("")}concat=n=${pieces.length}:v=0:a=1,apad=whole_dur=${total}[out]`,
  "-map", "[out]", "-ar", "48000", "-ac", "1", narration,
]);

// 4) Musique d'ambiance synthétisée (aucune banque de sons accessible ici) :
//    nappe grave en ré mineur + tic-tac d'horloge, fondu d'entrée/sortie.
const music = join(ROOT, "assets/audio/music.wav");
const drone =
  "0.30*sin(2*PI*73.42*t)*(0.75+0.25*sin(2*PI*0.11*t))" + // ré2
  "+0.20*sin(2*PI*110*t)*(0.7+0.3*sin(2*PI*0.07*t+1))" + // la2
  "+0.12*sin(2*PI*174.61*t)*(0.6+0.4*sin(2*PI*0.05*t+2))" + // fa3
  "+0.05*sin(2*PI*293.66*t)*(0.5+0.5*sin(2*PI*0.13*t))"; // ré4
// tic toutes les 0,5 s : salve sinusoïdale à 2,2 kHz très brève, décroissance exponentielle
const tick = "0.35*sin(2*PI*2200*t)*exp(-90*mod(t,0.5))*lt(mod(t,0.5),0.06)";
execFileSync("ffmpeg", [
  "-y", "-v", "error",
  "-f", "lavfi", "-t", String(total), "-i", `aevalsrc='${drone}':s=48000:c=mono`,
  "-f", "lavfi", "-t", String(total), "-i", `aevalsrc='${tick}':s=48000:c=mono`,
  "-filter_complex",
  `[0:a]lowpass=f=900,volume=0.9[d];[1:a]highpass=f=1200,volume=0.35[k];` +
    `[d][k]amix=inputs=2:normalize=0,afade=t=in:d=2,afade=t=out:st=${r3(total - 2.5)}:d=2.5[out]`,
  "-map", "[out]", "-ac", "2", music,
]);

writeFileSync(join(ROOT, "timing.json"), JSON.stringify({ total, scenes }, null, 2) + "\n");
process.stderr.write(`✓ timing.json — durée totale ${total}s, ${scenes.length} scènes\n`);

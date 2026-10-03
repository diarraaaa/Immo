# Alan Turing — the story (TikTok, 9:16)

English version of `../alan-turing-histoire` (same scenes, photos and animations).
Vertical 1080×1920 video made with [HyperFrames](https://hyperframes.heygen.com).

- **Final render:** `renders/alan-turing-tiktok-en.mp4`
- **Voice:** Kokoro `bf_emma` (local British English TTS), captions synced phrase by phrase
- **Photos:** 13 real archive photos — licences and credits in [`CREDITS.md`](CREDITS.md)

## Rebuild

```bash
cd videos/alan-turing-story-en
node tools/build-audio.mjs   # voice + timing.json (cached per sentence)
node tools/build-index.mjs   # index + captions
npx hyperframes check
npx hyperframes render --quality high --output renders/alan-turing-tiktok-en.mp4
```

`story.json` holds the script: `say` is what the voice reads (numbers spelled out,
"Bombe" written "Bomb" so it is pronounced correctly), `cap` is the on-screen caption,
`hl` the highlighted keyword. English numbers use the short scale:
158,962,555,217,826,360,000 ≈ **159 quintillion** (French: 159 *trillions*).

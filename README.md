# ChipForge — 8-bit SFX & Music Studio

A tiny browser DAW for GBA-style chiptune music and game sound effects.
No build step, no install: **double-click `index.html`** (Chrome or Edge recommended).

If your browser ever refuses MIDI access on a `file://` page, run it from
localhost instead: `node serve.js` then open <http://localhost:8474>.

## What's inside

| File | Purpose |
|---|---|
| `index.html` | page structure, all the controls |
| `style.css` | dark GB-green theme |
| `synth.js` | the sound engine — 2 pulse channels, wavetable channel, LFSR noise (the GBA's PSG hardware), plus offline song rendering for export |
| `pianoroll.js` | canvas piano roll editor (draw/move/resize/erase/select/copy-paste) |
| `sfx.js` | sfxr-style sound-effect designer (generators, mutate, render) |
| `input.js` | FL-style QWERTY piano + Web MIDI (with sustain pedal) |
| `io.js` | WAV/MP3 encoding, file downloads, project save/load |
| `import.js` | MP3/WAV → channels transcription (FFT salience analysis, BPM detection, drum-onset clustering) + reference-track panel |
| `app.js` | state, transport/scheduler, recording, undo, channel rack UI, demo song |
| `help.js` | the built-in manual (HELP tab) |
| `lame.min.js` | vendored lamejs 1.2.0 MP3 encoder (from cdnjs) |
| `serve.js` | optional zero-dependency local server, dev convenience only |

## Quick facts

- **IMPORT** (top bar) transcribes an existing MP3/WAV onto the four channels —
  melody, harmony, bass, drums — and loads the original as a synced **reference
  track** (bottom of the left rack) for A/B-ing while you clean up the draft.

- Songs export as **MP3 (192 kbps)** or **WAV**; SFX export the same way from their tab.
- For *looping* music in a game engine, prefer the WAV (MP3 adds encoder padding at the loop point).
- Projects save as `.chipforge.json` (includes the SFX library); work is also autosaved to localStorage.
- The full manual lives in the app's **HELP** tab.

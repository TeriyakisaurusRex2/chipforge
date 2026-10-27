/* ============================================================
   ChipForge built-in manual. Injected into the HELP tab.
   ============================================================ */
(function () {
  const CF = window.CF = window.CF || {};

  // typing-keyboard diagram data: [keycap label, note, isBlack] (null = unused key)
  const ROW_NUM = [['1'], ['2', 'C#5', 1], ['3', 'D#5', 1], ['4'], ['5', 'F#5', 1], ['6', 'G#5', 1], ['7', 'A#5', 1], ['8'], ['9', 'C#6', 1], ['0', 'D#6', 1], ['-'], ['=']];
  const ROW_Q = [['Q', 'C5'], ['W', 'D5'], ['E', 'E5'], ['R', 'F5'], ['T', 'G5'], ['Y', 'A5'], ['U', 'B5'], ['I', 'C6'], ['O', 'D6'], ['P', 'E6'], ['[', 'F6'], [']', 'G6']];
  const ROW_A = [['A'], ['S', 'C#4', 1], ['D', 'D#4', 1], ['F'], ['G', 'F#4', 1], ['H', 'G#4', 1], ['J', 'A#4', 1], ['K'], ['L', 'C#5', 1], [';', 'D#5', 1], ["'"]];
  const ROW_Z = [['Z', 'C4'], ['X', 'D4'], ['C', 'E4'], ['V', 'F4'], ['B', 'G4'], ['N', 'A4'], ['M', 'B4'], [',', 'C5'], ['.', 'D5'], ['/', 'E5']];

  function kbRow(keys, indent) {
    const caps = keys.map(([k, note, black]) =>
      `<div class="keycap ${note ? (black ? 'black' : 'white') : 'off'}"><span class="kn">${k}</span><span class="nt">${note || ''}</span></div>`
    ).join('');
    return `<div class="kbRow ${indent}">${caps}</div>`;
  }

  CF.helpHTML = `
<h1>CHIPFORGE MANUAL</h1>
<div class="toc">
  <a href="#h-quick">Quick start</a>
  <a href="#h-channels">The 4 channels</a>
  <a href="#h-roll">Piano roll</a>
  <a href="#h-keys">Typing keyboard</a>
  <a href="#h-midi">MIDI keyboard</a>
  <a href="#h-inst">Instruments</a>
  <a href="#h-rec">Recording</a>
  <a href="#h-sfx">SFX designer</a>
  <a href="#h-import">Importing MP3s</a>
  <a href="#h-ref">Reference track</a>
  <a href="#h-export">Exporting</a>
  <a href="#h-short">Shortcut list</a>
</div>

<h2 id="h-quick">Quick start — your first loop in 60 seconds</h2>
<ol>
  <li>Click <code>DEMO</code> in the top bar and press <kbd>Space</kbd> to hear what a full track sounds like. Press <kbd>Space</kbd> again to stop.</li>
  <li>Click <code>NEW</code> to get an empty project.</li>
  <li>In the left rack, <b>PULSE 1</b> is already selected. Drag in the grid to draw a few notes — left-drag draws, right-click deletes. Each cell is one grid step; drag right while drawing to make longer notes.</li>
  <li>Press <kbd>Space</kbd>. Your notes loop. Draw while it plays — changes are live.</li>
  <li>Click <b>NOISE</b> in the rack and draw short notes on the beats for drums. Low notes = kick-ish, high notes = hats.</li>
  <li>Happy? Hit <code>EXPORT MP3</code>. Done — drop the file in your game.</li>
</ol>
<p class="tip">Hover <b>anything</b> in the app for a tooltip explaining what it does.</p>

<h2 id="h-channels">The four channels — why only four?</h2>
<p>The Game Boy Advance inherited the original Game Boy's sound chip, and most classic GBA music leans on its four mono channels. ChipForge recreates exactly those, which is why everything you make automatically sounds "GBA":</p>
<table>
<tr><th>Channel</th><th>What it is</th><th>Typical jobs</th></tr>
<tr><td><b>PULSE 1</b></td><td>Square wave with selectable <i>duty cycle</i> (how wide the "on" part of the wave is: 12.5% sounds thin and reedy, 50% full and hollow)</td><td>Lead melody</td></tr>
<tr><td><b>PULSE 2</b></td><td>Identical second pulse</td><td>Harmony, echoes, chord arpeggios</td></tr>
<tr><td><b>WAVE</b></td><td>A tiny looping 32-sample waveform (4-bit) — the GB's "anything goes" channel</td><td>Bass lines, soft flutes</td></tr>
<tr><td><b>NOISE</b></td><td>White-ish noise from a hardware random generator (LFSR). "Short" mode loops so fast it sounds metallic and tonal</td><td>Drums, hi-hats, explosions, wind</td></tr>
</table>
<p><b>Each channel plays one note at a time</b> — that's the hardware limit, and it's also the secret to the style. Chords are faked with fast arpeggios (see <a href="#h-inst">Instruments</a>), drums live on the noise channel, and melodies stay clean and single-voiced.</p>

<h2 id="h-roll">The piano roll</h2>
<p>The big grid is where the song lives. Pitch runs up the left edge (click the piano keys to preview), time runs left to right. Bar numbers are in the ruler at the top — click or drag the ruler to move the playhead.</p>
<table>
<tr><th>Action</th><th>How</th></tr>
<tr><td>Draw a note</td><td>Left-click empty space; keep dragging right to set its length. New notes reuse the last length you drew.</td></tr>
<tr><td>Move a note</td><td>Drag it. Vertical = pitch, horizontal = time.</td></tr>
<tr><td>Resize</td><td>Drag a note's right edge.</td></tr>
<tr><td>Delete</td><td>Right-click (hold and sweep to erase many).</td></tr>
<tr><td>Select several</td><td><kbd>Ctrl</kbd>+drag a box, or <kbd>Shift</kbd>+click to add. Selected notes move/resize/delete together.</td></tr>
<tr><td>Copy / paste</td><td><kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> — pastes at the playhead, so click the ruler where you want it first. Great for repeating bars.</td></tr>
<tr><td>Nudge selection</td><td>Arrow keys (◄► = time, ▲▼ = semitone, <kbd>Shift</kbd>+▲▼ = octave).</td></tr>
<tr><td>Note velocity</td><td><kbd>Alt</kbd>+wheel over a note (or a selection) — 1 to 15, brighter notes are louder. MIDI recording and song import set velocities automatically.</td></tr>
<tr><td>Fine placement</td><td>Hold <kbd>Alt</kbd> to ignore the snap grid.</td></tr>
<tr><td>Scroll / zoom</td><td>Wheel = up/down · <kbd>Shift</kbd>+wheel = sideways · <kbd>Ctrl</kbd>+wheel = zoom.</td></tr>
<tr><td>Undo / redo</td><td><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd>.</td></tr>
</table>
<p>The faint notes in the background are the <b>other channels</b> (so you can line things up) — toggle them with the <code>GHOSTS</code> button. <code>SNAP</code> in the top bar sets the grid: 1/16 is a good default; 1/32 for fast runs.</p>

<h2 id="h-keys">Playing with your computer keyboard</h2>
<p>Your QWERTY keyboard is always a piano for the <b>currently selected channel</b> — same layout as FL Studio. The bottom row is the base octave, the top row is one octave higher (so they overlap: <kbd>,</kbd> and <kbd>Q</kbd> are the same C).</p>
${kbRow(ROW_NUM, 'indent1')}
${kbRow(ROW_Q, 'indent1')}
${kbRow(ROW_A, 'indent2')}
${kbRow(ROW_Z, '')}
<p>Change the base octave with <kbd>PageUp</kbd> / <kbd>PageDown</kbd> — the current octave shows in the status bar. Keys light up on the piano-roll keyboard as you play.</p>

<h2 id="h-midi">Using a MIDI keyboard</h2>
<ol>
  <li>Plug your controller in (before or after opening ChipForge — both work, devices are detected when connected).</li>
  <li>Your browser will ask for MIDI permission the first time — click <b>Allow</b>.</li>
  <li>The status bar (bottom right) shows the connected device name. Play — it drives the selected channel, with velocity, and the sustain pedal works.</li>
</ol>
<p class="tip">MIDI needs Chrome, Edge or Firefox. If the status bar says "not supported", switch browsers. If your device doesn't appear, unplug/replug it — hot-plug is detected automatically.</p>

<h2 id="h-inst">Instruments — shaping each channel's sound</h2>
<p>Select a channel and its instrument panel appears below the rack. Every control has a tooltip; here's the big picture:</p>
<h3>Duty cycle (pulse channels)</h3>
<p>The single most characterful knob in chiptune. <b>50%</b> = full, hollow, classic lead. <b>25%</b> = brighter, naselly — the classic "second pulse". <b>12.5%</b> = thin and buzzy. Try switching duty mid-song between sections for cheap variety.</p>
<h3>Envelope (ATT / DEC / SUS / REL)</h3>
<p>How the volume of every note evolves: <b>Attack</b> = fade-in time (keep near 0 for chip sounds), <b>Decay</b> = how fast it drops to the <b>Sustain</b> level (the volume held while the note lasts), <b>Release</b> = fade-out after the note ends. Plucky lead: low sustain, short decay. Flute/pad: high sustain.</p>
<h3>Vibrato</h3>
<p>Pitch wobble. A little (depth ~15 ct, speed ~5–6 Hz) makes long lead notes sing instead of beeping.</p>
<h3>Arpeggio — fake chords, the chiptune way</h3>
<p>Enter semitone offsets like <code>0 4 7</code> (major) or <code>0 3 7</code> (minor) and the channel rattles through them super fast on every note — one voice <i>pretending</i> to be a chord. The iconic chiptune shimmer. <code>0 12</code> = octave bounce, works over anything. Leave the box empty for a normal note. RATE sets how fast it cycles.</p>
<h3>Wave / noise specifics</h3>
<p>The WAVE channel picks its 32-sample waveform from a preset list — <b>triangle</b> is the classic soft bass. The NOISE channel has <b>long</b> (white noise, drums) and <b>short</b> (metallic, robotic) modes; the note's <i>pitch</i> controls noise brightness, so kick = low note, hat = high note.</p>

<h2 id="h-rec">Recording your playing into the song</h2>
<ol>
  <li>Arm <code>●REC</code> in the top bar.</li>
  <li>Press <kbd>Space</kbd> to start playback (loop on is handy).</li>
  <li>Play your QWERTY or MIDI keyboard — notes are written into the selected channel, snapped to the current SNAP grid.</li>
  <li>Mistakes? <kbd>Ctrl</kbd>+<kbd>Z</kbd> removes them note by note, or right-click-erase in the roll.</li>
</ol>

<h2 id="h-sfx">The SFX designer</h2>
<p>Switch to the <b>SFX</b> tab. The workflow is: <b>generate → mutate → export</b>.</p>
<ol>
  <li>Click a generator (<code>PICKUP/COIN</code>, <code>LASER/SHOOT</code>, …). Each click rolls <i>new random parameters</i> tuned for that sound type — click until you hear something close.</li>
  <li>Click <code>MUTATE</code> to nudge all sliders slightly — keep clicking to evolve the sound, undoing with another generator click if it wanders off.</li>
  <li>Fine-tune sliders by hand (each has a tooltip). The sound replays whenever you release a slider; <kbd>Enter</kbd> or <code>▶ PLAY</code> replays it any time.</li>
  <li>Name it, then <code>EXPORT MP3</code>/<code>WAV</code> — or <code>SAVE TO LIBRARY</code> to keep it in the project file and come back later (click a library entry to reload its sliders).</li>
</ol>
<p>Cheat sheet: <b>slide down</b> = laser/fall · <b>slide up</b> = jump/powerup · <b>arp jump up</b> = coin · <b>noise + lowpass sweep down</b> = explosion · <b>short sustain+decay</b> = UI blip.</p>

<h2 id="h-import">Importing MP3s — turn an existing song into a chiptune</h2>
<p>Click <code>IMPORT</code> in the top bar, load an MP3/WAV, and ChipForge listens to it: notes are detected by <b>Basic Pitch</b>, Spotify's open-source machine-learning transcription model, running locally in your browser (nothing is uploaded; the model loads on first use). Detected notes are split into melody / harmony / bass by voice position, drum hits and tempo are found by spectral analysis, and everything lands on the four channels with <b>per-note velocity</b> taken from how loud each note was in the original. The source file is loaded as a <a href="#h-ref">reference track</a>, time-aligned, so you can hear it under your channels while you work.</p>
<p class="tip"><b>Set your expectations:</b> this is automatic transcription of a full mix down to four single-voice channels — it produces a <b>draft</b>, not a finished cover. Clean mixes with a clear lead come out surprisingly well; dense walls of sound come out messy. The workflow is import → loop playback with the reference on → fix and delete in the piano roll.</p>
<h3>The dials</h3>
<ul>
  <li><b>NOTE SENS / DRUM SENS</b> (before analyzing): how eagerly it accepts quiet notes/hits. If you get clutter, re-run lower; if it misses obvious parts, re-run higher.</li>
  <li><b>BPM</b> (after analyzing): the tempo guess can land on double or half the real feel. If the imported notes look squeezed onto half the grid (or stretched over twice of it), hit <code>÷2</code>/<code>×2</code> before writing — the notes re-snap.</li>
  <li><b>Channel checkboxes</b>: untick a stream to leave that channel alone — e.g. import only the bass and drums and play the melody in yourself with <code>●REC</code>.</li>
</ul>
<h3>Cleanup checklist (in rough order of payoff)</h3>
<ol>
  <li>Solo each channel and listen against the reference. Delete everything that isn't the part.</li>
  <li>Fix octave slips — transcription loves jumping an octave for a note or two. Select the notes and <kbd>Shift</kbd>+<kbd>▼</kbd>/<kbd>▲</kbd>.</li>
  <li>The HARMONY channel is the noisiest — often it's faster to keep its best moments and rewrite the rest as chord-root notes with an <a href="#h-inst">arp instrument</a>.</li>
  <li>Simplify! Great 8-bit covers <i>reinterpret</i>: fewer notes, tighter rhythms, chords become arps. The transcription gives you the skeleton; the style comes from pruning.</li>
</ol>

<h2 id="h-ref">The reference track</h2>
<p>Bottom of the left rack. Load any MP3/WAV and it plays <b>under</b> your channels during playback — synced to the grid, restarting when the song loops, never included in exports or in the project file. Use it to A/B a cover against the original, or to play/record along by ear.</p>
<ul>
  <li><b>VOLUME</b> — how loud the original sits under your channels.</li>
  <li><b>OFFSET</b> — where in the audio file your bar 1 begins (seconds). The importer sets this automatically; nudge it if the original drifts against your grid.</li>
  <li><b>ON</b> — toggle it without unloading (takes effect the next time you press play).</li>
</ul>

<h2 id="h-export">Exporting for your game</h2>
<ul>
  <li><b>EXPORT MP3</b> renders the whole song (all bars, exactly what loop playback covers) at 192 kbps. SFX export the same way from their tab.</li>
  <li><b>WAV</b> is lossless and — important — <b>gapless</b>. MP3 files always carry a few ms of encoder silence at the start, so a looping music track exported as MP3 can "hiccup" at the loop point in some engines. For seamless loops, ship the WAV (or convert it to OGG, which most engines loop cleanly); use MP3 where the format is required.</li>
  <li>Channels you've <b>muted</b> are left out of the render, and <b>solo</b> exports only that channel — handy for stems.</li>
  <li><code>SAVE</code> downloads the whole project (song + SFX library) as a <code>.chipforge.json</code> file; <code>OPEN</code> loads it back. Your work is also auto-saved in the browser between sessions.</li>
</ul>

<h2 id="h-short">Shortcut list</h2>
<table>
<tr><td><kbd>Space</kbd></td><td>Play / stop</td><td><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Y</kbd></td><td>Undo / redo</td></tr>
<tr><td><kbd>PageUp/Down</kbd></td><td>Keyboard octave</td><td><kbd>Ctrl</kbd>+<kbd>A</kbd></td><td>Select all notes</td></tr>
<tr><td><kbd>Delete</kbd></td><td>Delete selection</td><td><kbd>Ctrl</kbd>+<kbd>C/X/V</kbd></td><td>Copy / cut / paste</td></tr>
<tr><td>Arrows</td><td>Nudge selection</td><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>Save project</td></tr>
<tr><td><kbd>Esc</kbd></td><td>Deselect + silence stuck notes</td><td><kbd>Enter</kbd> (SFX tab)</td><td>Play current SFX</td></tr>
</table>
`;
})();

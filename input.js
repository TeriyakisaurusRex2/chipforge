/* ============================================================
   ChipForge input: FL Studio-style typing keyboard + Web MIDI.
   Uses e.code (physical key position) so it works on any layout.
   Bottom row = current octave, top row = one octave up.
   ============================================================ */
(function () {
  const CF = window.CF = window.CF || {};

  // physical key -> semitone offset from C of the base octave
  const KEYMAP = {
    KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7,
    KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
    Semicolon: 15, Slash: 16,
    KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
    KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25,
    KeyO: 26, Digit0: 27, KeyP: 28, BracketLeft: 29, BracketRight: 31,
  };
  CF.KEYMAP = KEYMAP;

  const downKeys = new Map();   // key id -> midi note (frozen at press time)

  function noteOn(key, midi, vel) {
    if (downKeys.has(key)) return;
    downKeys.set(key, midi);
    CF.audio.noteOn(key, midi, vel);
    CF.roll.setHeld(midi, true);
    CF.transport.recordOn(key, midi, vel);
  }
  function noteOff(key) {
    const midi = downKeys.get(key);
    if (midi == null) return;
    downKeys.delete(key);
    CF.roll.setHeld(midi, false);
    CF.transport.recordOff(key);
    if (sustainPedal) { sustained.add(key); return; }   // hold until pedal up
    CF.audio.noteOff(key);
  }
  function panic() {
    downKeys.forEach((midi, key) => { CF.roll.setHeld(midi, false); CF.transport.recordOff(key); });
    downKeys.clear();
    sustained.clear();
    CF.audio.allNotesOff();
  }

  /* ---------------- typing keyboard ---------------- */
  function isTyping(e) {
    const t = e.target.tagName;
    return t === 'INPUT' && e.target.type !== 'range' || t === 'SELECT' || t === 'TEXTAREA';
  }

  document.addEventListener('keydown', e => {
    if (isTyping(e)) {
      if (e.code === 'Enter' || e.code === 'Escape') e.target.blur();
      return;
    }

    // transport & global shortcuts
    if (e.code === 'Space') { e.preventDefault(); CF.transport.toggle(); return; }
    if (e.code === 'PageUp')   { e.preventDefault(); CF.setOctave(CF.state.octave + 1); return; }
    if (e.code === 'PageDown') { e.preventDefault(); CF.setOctave(CF.state.octave - 1); return; }
    if (e.code === 'Escape') { CF.roll.deselect(); panic(); return; }

    if (e.ctrlKey || e.metaKey) {
      const k = e.code;
      if (k === 'KeyZ' && !e.shiftKey) { e.preventDefault(); CF.undo(); }
      else if (k === 'KeyY' || (k === 'KeyZ' && e.shiftKey)) { e.preventDefault(); CF.redo(); }
      else if (k === 'KeyA') { e.preventDefault(); CF.roll.selectAll(); }
      else if (k === 'KeyC') { e.preventDefault(); CF.roll.copy(); }
      else if (k === 'KeyX') { e.preventDefault(); CF.roll.cut(); }
      else if (k === 'KeyV') { e.preventDefault(); CF.roll.paste(); }
      else if (k === 'KeyS') { e.preventDefault(); CF.io.saveProject(); }
      return;
    }

    if (CF.state.tab === 'music') {
      if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); CF.roll.deleteSelection(); return; }
      if (e.code === 'ArrowLeft')  { e.preventDefault(); CF.roll.nudge(-1, 0); return; }
      if (e.code === 'ArrowRight') { e.preventDefault(); CF.roll.nudge(1, 0); return; }
      if (e.code === 'ArrowUp')    { e.preventDefault(); CF.roll.nudge(0, e.shiftKey ? 12 : 1); return; }
      if (e.code === 'ArrowDown')  { e.preventDefault(); CF.roll.nudge(0, e.shiftKey ? -12 : -1); return; }
    }
    if (CF.state.tab === 'sfx' && e.code === 'Enter') { e.preventDefault(); CF.sfx.play(); return; }

    // musical keys
    if (e.repeat || e.altKey) return;
    const off = KEYMAP[e.code];
    if (off == null) return;
    e.preventDefault();
    noteOn('kb' + e.code, (CF.state.octave + 1) * 12 + off, 15);
  });

  document.addEventListener('keyup', e => {
    const off = KEYMAP[e.code];
    if (off != null) noteOff('kb' + e.code);
  });

  window.addEventListener('blur', panic);

  /* ---------------- Web MIDI ---------------- */
  let sustainPedal = false;
  const sustained = new Set();

  function onMidiMessage(e) {
    const [st, d1, d2] = e.data;
    const cmd = st & 0xF0;
    if (cmd === 0x90 && d2 > 0) {
      sustained.delete('midi' + d1);
      noteOn('midi' + d1, d1, Math.max(1, Math.round(d2 / 127 * 15)));
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      noteOff('midi' + d1);
    } else if (cmd === 0xB0 && d1 === 64) {          // sustain pedal
      sustainPedal = d2 >= 64;
      if (!sustainPedal) {
        sustained.forEach(key => CF.audio.noteOff(key));
        sustained.clear();
      }
    }
  }

  function initMidi() {
    const el = document.getElementById('statusMidi');
    if (!navigator.requestMIDIAccess) {
      el.textContent = 'MIDI: not supported in this browser';
      return;
    }
    navigator.requestMIDIAccess({ sysex: false }).then(acc => {
      const update = () => {
        const names = [];
        acc.inputs.forEach(inp => {
          inp.onmidimessage = onMidiMessage;
          names.push(inp.name);
        });
        el.textContent = names.length ? 'MIDI: ' + names.join(', ') : 'MIDI: no device — plug one in';
      };
      acc.onstatechange = update;
      update();
    }).catch(() => { el.textContent = 'MIDI: access denied'; });
  }

  CF.input = { initMidi, panic };
})();

/* ============================================================
   ChipForge app shell: state, transport scheduler, undo,
   channel rack / instrument UI, recording, demo song, autosave.
   ============================================================ */
(function () {
  const CF = window.CF = window.CF || {};
  const COLORS = ['#6ee76e', '#59d8e6', '#ffb347', '#c792ea'];
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const SPB = CF.STEPS_PER_BEAT;

  /* ---------------- state ---------------- */
  function mkCh(type, name) {
    return { type, name, inst: CF.defaultInst(type), notes: [], mute: false, solo: false, vol: 0.8, pan: 0 };
  }
  function defaultState() {
    return {
      title: 'untitled', bpm: 120, bars: 4, loop: true, snap: 2, octave: 4,
      master: 0.8, ghosts: true, follow: true, rec: false, tab: 'music', currentChannel: 0,
      channels: [mkCh('pulse', 'PULSE 1'), mkCh('pulse', 'PULSE 2'), mkCh('wave', 'WAVE'), mkCh('noise', 'NOISE')],
      sfxLib: [],
    };
  }
  CF.state = defaultState();
  CF.clipboard = null;

  CF.serialize = function () {
    const { tab, rec, ...rest } = CF.state;
    return JSON.parse(JSON.stringify(rest));
  };

  CF.loadState = function (json) {
    const st = defaultState();
    ['title', 'bpm', 'bars', 'loop', 'snap', 'octave', 'master', 'ghosts', 'follow', 'currentChannel']
      .forEach(k => { if (json[k] !== undefined) st[k] = json[k]; });
    if (Array.isArray(json.channels)) {
      json.channels.slice(0, 4).forEach((c, i) => {
        if (!c) return;
        const ch = st.channels[i];
        Object.assign(ch.inst, c.inst || {});
        ['mute', 'solo', 'vol', 'pan'].forEach(k => { if (c[k] !== undefined) ch[k] = c[k]; });
        if (Array.isArray(c.notes)) {
          ch.notes = c.notes.map(n => ({ s: n.s | 0, l: Math.max(1, n.l | 0), p: n.p | 0, v: n.v == null ? 15 : n.v | 0 }));
        }
      });
    }
    if (Array.isArray(json.sfxLib)) {
      st.sfxLib = json.sfxLib.map(e => ({ name: String(e.name || 'sfx'), params: Object.assign(CF.sfxDefaults(), e.params || {}) }));
    }
    st.bpm = clamp(st.bpm, 40, 300);
    st.bars = clamp(st.bars | 0, 1, 64);
    st.currentChannel = clamp(st.currentChannel | 0, 0, 3);
    st.tab = CF.state.tab;
    CF.state = st;
    refreshAllUI();
    CF.audio.refreshChannelGains();
    CF.audio.setMaster(st.master);
  };

  /* ---------------- undo / redo ---------------- */
  const undoStack = [], redoStack = [];
  CF.pushUndo = function () {
    undoStack.push(JSON.stringify(CF.serialize()));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };
  CF.undo = function () {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(CF.serialize()));
    CF.loadState(JSON.parse(undoStack.pop()));
    CF.markChanged();
  };
  CF.redo = function () {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(CF.serialize()));
    CF.loadState(JSON.parse(redoStack.pop()));
    CF.markChanged();
  };

  /* ---------------- autosave ---------------- */
  let saveTimer = null;
  CF.markChanged = function () {
    CF.roll.markDirty();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 700);
  };
  function persist() {
    try { localStorage.setItem('chipforge-autosave', JSON.stringify(CF.serialize())); } catch (e) {}
  }
  window.addEventListener('beforeunload', persist);

  /* ---------------- transport / scheduler ----------------
     Classic Web Audio lookahead pattern: a coarse JS interval
     wakes up every 25 ms and schedules, sample-accurately, every
     sequencer step that falls inside the next 150 ms. */
  const totalSteps = () => CF.state.bars * 4 * SPB;
  const stepDur = () => 60 / (CF.state.bpm * SPB);

  CF.transport = {
    playing: false,
    posStep: 0,
    _anchorStep: 0, _anchorTime: 0, _virt: 0, _timer: null,
    _pending: new Map(),

    getPlayStep() {
      if (!this.playing) return this.posStep;
      const s = this._unwrapped();
      const T = totalSteps();
      return CF.state.loop ? ((s % T) + T) % T : Math.min(s, T);
    },
    _unwrapped() {
      return this._anchorStep + (CF.audio.ctx.currentTime - this._anchorTime) / stepDur();
    },
    getPosStep() { return this.playing ? this.getPlayStep() : this.posStep; },

    start() {
      const ctx = CF.audio.init();
      CF.audio.resume();
      this.playing = true;
      this._anchorStep = this.posStep >= totalSteps() ? 0 : this.posStep;
      this._anchorTime = ctx.currentTime + 0.08;
      this._virt = Math.ceil(this._anchorStep);
      this._timer = setInterval(() => this._tick(), 25);
      CF.audio.refStart(this._anchorTime, this._anchorStep * stepDur());
      this._tick();
      $('btnPlay').classList.add('playing');
      $('btnPlay').textContent = '❚❚';
      CF.roll.markDirty();
    },

    stop() {
      if (!this.playing) return;
      this.playing = false;
      clearInterval(this._timer);
      this._pending.clear();
      CF.audio.refStop();
      $('btnPlay').classList.remove('playing');
      $('btnPlay').textContent = '▶';
      CF.roll.markDirty();
    },

    toggle() { this.playing ? this.stop() : this.start(); },

    setPos(step) {
      this.posStep = step;
      if (this.playing) {
        this._anchorStep = step;
        this._anchorTime = CF.audio.ctx.currentTime + 0.05;
        this._virt = Math.ceil(step);
        CF.audio.refStart(this._anchorTime, step * stepDur());
      }
      CF.roll.markDirty();
    },

    // re-anchor the clock after a live BPM change
    reanchor() {
      if (!this.playing) return;
      this._anchorStep = this.getPlayStep();
      this._anchorTime = CF.audio.ctx.currentTime;
      this._virt = Math.ceil(this._anchorStep);
    },

    _tick() {
      const ctx = CF.audio.ctx, T = totalSteps(), sd = stepDur();
      while (true) {
        const t = this._anchorTime + (this._virt - this._anchorStep) * sd;
        if (t > ctx.currentTime + 0.15) break;
        if (!CF.state.loop && this._virt >= T) {
          if (ctx.currentTime > t + 0.1) this.stop();
          break;
        }
        const idx = ((this._virt % T) + T) % T;
        if (idx === 0 && this._virt > 0) CF.audio.refStart(t, 0);   // loop wrap: restart reference
        this._scheduleStep(idx, Math.max(t, ctx.currentTime + 0.005), sd);
        this._virt++;
      }
    },

    _scheduleStep(idx, t, sd) {
      CF.state.channels.forEach((c, ci) => {
        c.notes.forEach(n => {
          if (n.s === idx) CF.audio.scheduleNote(ci, n.p, n.v, t, n.l * sd);
        });
      });
    },

    /* ----- live recording into the piano roll ----- */
    recordOn(key, midi, vel) {
      if (!this.playing || !CF.state.rec) return;
      const T = totalSteps(), sn = CF.state.snap;
      const startAbs = this._unwrapped();
      let s = Math.round(startAbs / sn) * sn;
      s = ((s % T) + T) % T;
      CF.pushUndo();
      const note = { s, l: Math.max(1, sn), p: midi, v: vel };
      CF.state.channels[CF.state.currentChannel].notes.push(note);
      this._pending.set(key, { note, startAbs });
      CF.markChanged();
    },
    recordOff(key) {
      const p = this._pending.get(key);
      if (!p) return;
      this._pending.delete(key);
      if (!this.playing) return;
      const len = Math.max(1, Math.round(this._unwrapped() - p.startAbs));
      p.note.l = Math.max(1, Math.min(len, totalSteps() - p.note.s));
      CF.markChanged();
    },
  };

  /* ---------------- channel rack ---------------- */
  function renderRack() {
    const root = $('channels');
    root.innerHTML = '';
    CF.state.channels.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'chCard' + (i === CF.state.currentChannel ? ' sel' : '');
      d.style.setProperty('--chcolor', COLORS[i]);
      d.title = 'Click to select this channel — the piano roll, your keyboard and MIDI all target the selected channel';
      d.innerHTML =
        `<div class="chHead"><span class="chName">${c.name}</span>
         <button class="chBtn mute${c.mute ? ' on' : ''}" title="Mute — silences this channel (also left out of exports)">M</button>
         <button class="chBtn solo${c.solo ? ' on' : ''}" title="Solo — hear only soloed channels">S</button></div>
         <div class="chVol"><input type="range" min="0" max="1" step="0.01" value="${c.vol}" title="Channel volume"><span class="val">${Math.round(c.vol * 100)}</span></div>`;
      d.addEventListener('click', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        if (CF.state.currentChannel !== i) {
          CF.state.currentChannel = i;
          CF.roll.deselect();
          renderRack(); renderInst();
        }
      });
      const [mB, sB] = d.querySelectorAll('button');
      mB.onclick = () => { c.mute = !c.mute; mB.classList.toggle('on', c.mute); CF.audio.refreshChannelGains(); CF.markChanged(); };
      sB.onclick = () => { c.solo = !c.solo; sB.classList.toggle('on', c.solo); CF.audio.refreshChannelGains(); CF.markChanged(); };
      const vol = d.querySelector('input');
      vol.oninput = () => {
        c.vol = +vol.value;
        d.querySelector('.chVol .val').textContent = Math.round(c.vol * 100);
        CF.audio.refreshChannelGains(); CF.markChanged();
      };
      root.appendChild(d);
    });
  }

  /* ---------------- instrument editor ---------------- */
  function instRow(parent, label, tip, min, max, step, get, set, fmt) {
    const div = document.createElement('div');
    div.className = 'instRow';
    div.innerHTML = `<span class="lbl" title="${tip}">${label}</span>`;
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = get();
    const val = document.createElement('span');
    val.className = 'val'; val.textContent = fmt(get());
    inp.oninput = () => { set(+inp.value); val.textContent = fmt(+inp.value); CF.markChanged(); };
    div.append(inp, val);
    parent.appendChild(div);
  }
  const ms = v => Math.round(v * 1000) + 'ms';
  const pct = v => Math.round(v * 100) + '%';

  function renderInst() {
    const i = CF.state.currentChannel, c = CF.state.channels[i], inst = c.inst;
    const root = $('instPanel');
    root.innerHTML = `<h3 style="color:${COLORS[i]}">INSTRUMENT — ${c.name}</h3>`;

    if (c.type === 'pulse') {
      const div = document.createElement('div');
      div.className = 'instRow';
      div.innerHTML = `<span class="lbl" title="Duty cycle — the width of the square wave's 'on' phase. 50% = full & hollow, 25% = bright & nasal, 12.5% = thin & buzzy. THE chiptune timbre knob.">DUTY</span>`;
      const btns = document.createElement('div');
      btns.className = 'dutyBtns';
      [[0.125, '12.5'], [0.25, '25'], [0.5, '50'], [0.75, '75']].forEach(([v, l]) => {
        const b = document.createElement('button');
        b.textContent = l + '%';
        b.classList.toggle('on', inst.duty === v);
        b.onclick = () => { inst.duty = v; renderInst(); CF.markChanged(); };
        btns.appendChild(b);
      });
      div.appendChild(btns);
      root.appendChild(div);
    }
    if (c.type === 'wave') {
      const div = document.createElement('div');
      div.className = 'instRow';
      div.innerHTML = `<span class="lbl" title="The 32-sample waveform this channel loops — triangle is the classic GB bass tone">TABLE</span>`;
      const sel = document.createElement('select');
      CF.WAVETABLE_NAMES.forEach(n => sel.add(new Option(n.toUpperCase(), n)));
      sel.value = inst.table;
      sel.onchange = () => { inst.table = sel.value; CF.markChanged(); };
      div.appendChild(sel);
      root.appendChild(div);
    }
    if (c.type === 'noise') {
      const div = document.createElement('div');
      div.className = 'instRow';
      div.innerHTML = `<span class="lbl" title="LFSR width — LONG is white noise (drums, wind), SHORT loops only 127 steps and sounds metallic/tonal">MODE</span>`;
      const btns = document.createElement('div');
      btns.className = 'dutyBtns';
      [['long', 'LONG'], ['short', 'SHORT']].forEach(([v, l]) => {
        const b = document.createElement('button');
        b.textContent = l;
        b.classList.toggle('on', inst.mode === v);
        b.onclick = () => { inst.mode = v; renderInst(); CF.markChanged(); };
        btns.appendChild(b);
      });
      div.appendChild(btns);
      root.appendChild(div);
    }

    root.insertAdjacentHTML('beforeend', '<h3>ENVELOPE</h3>');
    instRow(root, 'ATTACK', 'Fade-in time of each note. Keep near 0 for chip sounds.', 0, 0.3, 0.001, () => inst.attack, v => inst.attack = v, ms);
    instRow(root, 'DECAY', 'Time to fall from full volume to the sustain level.', 0, 0.6, 0.001, () => inst.decay, v => inst.decay = v, ms);
    instRow(root, 'SUSTAIN', 'Volume held for the rest of the note. Low = plucky, high = sustained.', 0, 1, 0.01, () => inst.sustain, v => inst.sustain = v, pct);
    instRow(root, 'RELEASE', 'Fade-out after the note ends.', 0, 0.6, 0.001, () => inst.release, v => inst.release = v, ms);

    if (c.type !== 'noise') {
      root.insertAdjacentHTML('beforeend', '<h3>VIBRATO</h3>');
      instRow(root, 'DEPTH', 'Pitch wobble depth in cents (100 = one semitone). ~15 makes long notes sing.', 0, 100, 1, () => inst.vibDepth, v => inst.vibDepth = v, v => v + 'ct');
      instRow(root, 'SPEED', 'Vibrato speed in Hz.', 0, 15, 0.1, () => inst.vibRate, v => inst.vibRate = v, v => v.toFixed(1) + 'Hz');

      root.insertAdjacentHTML('beforeend', '<h3 title="Fake chords! The channel cycles these semitone offsets super fast on every note.">ARPEGGIO</h3>');
      const div = document.createElement('div');
      div.className = 'instRow';
      div.innerHTML = `<span class="lbl" title="Semitone offsets, space separated. 0 4 7 = major chord, 0 3 7 = minor, 0 12 = octave bounce. Empty = off.">ARP</span>`;
      const inp = document.createElement('input');
      inp.type = 'text'; inp.placeholder = 'e.g. 0 4 7'; inp.value = inst.arp || ''; inp.spellcheck = false;
      inp.oninput = () => { inst.arp = inp.value; CF.markChanged(); };
      div.appendChild(inp);
      root.appendChild(div);
      instRow(root, 'RATE', 'How fast the arpeggio cycles through its offsets.', 4, 30, 0.5, () => inst.arpRate, v => inst.arpRate = v, v => v.toFixed(0) + 'Hz');
    }

    root.insertAdjacentHTML('beforeend', '<h3>OUTPUT</h3>');
    instRow(root, 'PAN', 'Stereo position. The GB panned channels hard left/right — subtle pans widen a mix nicely.', -1, 1, 0.01, () => c.pan, v => { c.pan = v; CF.audio.refreshChannelGains(); }, v => v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
  }

  /* ---------------- SFX library ---------------- */
  function renderSfxLib() {
    const root = $('sfxLib');
    root.innerHTML = '';
    if (!CF.state.sfxLib.length) {
      root.innerHTML = '<p style="color:var(--dim);font-size:11px">Saved sounds appear here and are stored inside the project file.</p>';
      return;
    }
    CF.state.sfxLib.forEach((e, i) => {
      const d = document.createElement('div');
      d.className = 'libItem';
      d.innerHTML = `<span class="libName" title="Click to load this sound's parameters and play it">${e.name}</span>
                     <button title="Delete from library">✕</button>`;
      d.querySelector('.libName').onclick = () => {
        CF.sfx.params = Object.assign(CF.sfxDefaults(), e.params);
        $('sfxName').value = e.name;
        CF.sfx.refreshUI();
        CF.sfx.play();
      };
      d.querySelector('button').onclick = () => {
        CF.state.sfxLib.splice(i, 1);
        renderSfxLib(); CF.markChanged();
      };
      root.appendChild(d);
    });
  }

  /* ---------------- tabs & hints ---------------- */
  const HINTS = {
    music: 'DRAW: left-drag · ERASE: right-click · SELECT: Ctrl+drag · COPY/PASTE: Ctrl+C/V (paste lands at the playhead) · PLAY KEYS: Z-row/Q-row · SPACE: play',
    sfx: 'Click a generator (each click = new random take) → MUTATE to evolve → EXPORT. Hover any slider for an explanation. ENTER replays.',
    help: 'Hover anything in the app for a tooltip. This manual lives here whenever you need it.',
  };
  CF.setHint = t => { $('statusHint').textContent = t; };

  function switchTab(tab) {
    CF.state.tab = tab;
    document.querySelectorAll('.tabBtn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('view-music').hidden = tab !== 'music';
    $('view-sfx').hidden = tab !== 'sfx';
    $('view-help').hidden = tab !== 'help';
    CF.setHint(HINTS[tab]);
    if (tab === 'music') CF.roll.markDirty();
  }

  CF.setOctave = function (o) {
    CF.state.octave = clamp(o, 1, 7);
    $('statusOct').textContent = 'OCT: C' + CF.state.octave + ' (PgUp/PgDn)';
  };

  /* ---------------- demo song ---------------- */
  function demoState() {
    const st = defaultState();
    st.title = 'demo'; st.bpm = 140; st.bars = 4;
    const [p1, p2, wv, nz] = st.channels;
    p1.inst.duty = 0.25; p1.inst.vibDepth = 10; p1.inst.vibRate = 6; p1.inst.sustain = 0.5; p1.inst.decay = 0.12;
    p2.inst.duty = 0.5; p2.vol = 0.45; p2.inst.sustain = 0.35; p2.inst.decay = 0.08; p2.pan = 0.3;
    wv.inst.table = 'triangle'; wv.vol = 0.95;
    nz.inst.sustain = 0; nz.inst.decay = 0.09; nz.vol = 0.6; nz.pan = -0.15;

    const melody = [
      [69, 72, 76, 72, 69, 72, 76, 79],
      [65, 69, 72, 69, 65, 69, 72, 74],
      [72, 76, 79, 76, 72, 76, 79, 81],
      [71, 74, 79, 74, 71, 74, 79, 76],
    ];
    melody.forEach((bar, b) => bar.forEach((p, k) => p1.notes.push({ s: b * 32 + k * 4, l: 3, p, v: 15 })));

    const harmony = [[57, 64], [53, 60], [60, 67], [55, 62]];
    harmony.forEach(([r, f], b) => {
      for (let k = 0; k < 8; k++) p2.notes.push({ s: b * 32 + k * 4, l: 3, p: k % 2 ? f : r, v: 11 });
    });

    const bass = [[33, 40], [29, 36], [36, 43], [31, 38]];
    bass.forEach(([r, f], b) => [r, r, f, r].forEach((p, k) => wv.notes.push({ s: b * 32 + k * 8, l: 7, p, v: 15 })));

    for (let b = 0; b < 4; b++) {
      [[0, 45, 15], [16, 45, 15], [8, 65, 13], [24, 65, 13]].forEach(([s, p, v]) =>
        nz.notes.push({ s: b * 32 + s, l: 2, p, v }));
      [4, 12, 20, 28].forEach(s => nz.notes.push({ s: b * 32 + s, l: 1, p: 85, v: 7 }));
    }
    return JSON.parse(JSON.stringify(st));
  }

  /* ---------------- refresh everything after a state swap ---------------- */
  function refreshAllUI() {
    $('inpTitle').value = CF.state.title;
    $('inpBpm').value = CF.state.bpm;
    $('inpBars').value = CF.state.bars;
    $('selSnap').value = String(CF.state.snap);
    $('inpMaster').value = CF.state.master;
    $('btnLoop').classList.toggle('on', CF.state.loop);
    $('btnRec').classList.toggle('on', CF.state.rec);
    $('btnGhost').classList.toggle('on', CF.state.ghosts);
    $('btnFollow').classList.toggle('on', CF.state.follow);
    CF.setOctave(CF.state.octave);
    renderRack();
    renderInst();
    renderSfxLib();
    CF.roll.markDirty();
  }

  /* ---------------- wire it all up ---------------- */
  function bind() {
    document.querySelectorAll('.tabBtn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

    $('btnPlay').onclick = () => CF.transport.toggle();
    $('btnStop').onclick = () => { CF.transport.stop(); CF.transport.setPos(0); };
    $('btnLoop').onclick = e => { CF.state.loop = !CF.state.loop; e.target.classList.toggle('on', CF.state.loop); CF.markChanged(); };
    $('btnRec').onclick = e => { CF.state.rec = !CF.state.rec; e.target.classList.toggle('on', CF.state.rec); };
    $('inpBpm').onchange = e => { CF.state.bpm = clamp(+e.target.value || 120, 40, 300); e.target.value = CF.state.bpm; CF.transport.reanchor(); CF.markChanged(); };
    $('inpBars').onchange = e => { CF.state.bars = clamp((+e.target.value | 0) || 4, 1, 64); e.target.value = CF.state.bars; CF.markChanged(); };
    $('selSnap').onchange = e => { CF.state.snap = +e.target.value; CF.markChanged(); };
    $('inpMaster').oninput = e => { CF.state.master = +e.target.value; CF.audio.setMaster(CF.state.master); CF.markChanged(); };
    $('inpTitle').oninput = e => { CF.state.title = e.target.value; CF.markChanged(); };

    $('btnNew').onclick = () => {
      if (!confirm('Start a new empty project? (Ctrl+Z can bring the current one back)')) return;
      CF.pushUndo();
      CF.transport.stop();
      CF.loadState(defaultState());
      CF.markChanged();
    };
    $('btnDemo').onclick = () => {
      CF.pushUndo();
      CF.transport.stop();
      CF.loadState(demoState());
      CF.markChanged();
      CF.setHint('Demo loaded — press SPACE. Pick it apart channel by channel with the M/S buttons.');
    };
    $('btnSave').onclick = () => CF.io.saveProject();
    $('btnLoad').onclick = () => CF.io.openProject();
    $('btnExportMp3').onclick = () => CF.io.exportSong('mp3');
    $('btnExportWav').onclick = () => CF.io.exportSong('wav');

    $('btnGhost').onclick = e => { CF.state.ghosts = !CF.state.ghosts; e.target.classList.toggle('on', CF.state.ghosts); CF.roll.markDirty(); };
    $('btnFollow').onclick = e => { CF.state.follow = !CF.state.follow; e.target.classList.toggle('on', CF.state.follow); };
    $('btnZoomIn').onclick = () => CF.roll.zoom(1);
    $('btnZoomOut').onclick = () => CF.roll.zoom(-1);

    // SFX tab
    document.querySelectorAll('#sfxPresets button[data-preset]').forEach(b => {
      b.onclick = () => {
        CF.sfx.params = CF.sfx.preset(b.dataset.preset);
        if ($('sfxName').value.match(/^(sfx|pickup|laser|explosion|powerup|hit|jump|blip|random)/)) {
          $('sfxName').value = b.dataset.preset;
        }
        CF.sfx.refreshUI();
        CF.sfx.play();
      };
    });
    $('btnMutate').onclick = () => { CF.sfx.mutate(); CF.sfx.refreshUI(); CF.sfx.play(); };
    $('sfxPlay').onclick = () => CF.sfx.play();
    $('btnSfxSave').onclick = () => {
      CF.state.sfxLib.push({ name: $('sfxName').value || 'sfx', params: { ...CF.sfx.params } });
      renderSfxLib(); CF.markChanged();
      CF.setHint('Saved to library — it travels with the project file.');
    };
    $('btnSfxMp3').onclick = () => CF.io.exportSfx('mp3');
    $('btnSfxWav').onclick = () => CF.io.exportSfx('wav');

    // wake the audio context on the first user gesture (browser autoplay policy)
    const wake = () => { CF.audio.init(); CF.audio.resume(); };
    document.addEventListener('pointerdown', wake, { once: true });
    document.addEventListener('keydown', wake, { once: true });

    // position readout
    (function posLoop() {
      const s = CF.transport.getPosStep();
      $('pos').textContent = (Math.floor(s / 32) + 1) + '.' + (Math.floor((s % 32) / 8) + 1);
      requestAnimationFrame(posLoop);
    })();
  }

  /* ---------------- boot ---------------- */
  $('helpContent').innerHTML = CF.helpHTML;
  CF.sfx.initUI();
  bind();
  CF.roll.init();

  let firstRun = true;
  try {
    const saved = localStorage.getItem('chipforge-autosave');
    if (saved) { CF.loadState(JSON.parse(saved)); firstRun = false; }
  } catch (e) {}
  if (firstRun) {
    CF.loadState(demoState());
    CF.setHint('Welcome! Press SPACE to hear the demo — the HELP tab has a 60-second tutorial.');
  } else {
    CF.setHint(HINTS.music);
  }

  CF.input.initMidi();
})();

/* ============================================================
   ChipForge SFX designer (sfxr-style).
   A sound is just a bag of parameters. We always render it in an
   OfflineAudioContext first — the preview you hear is the exact
   buffer that gets exported, guaranteed identical.
   ============================================================ */
(function () {
  const CF = window.CF = window.CF || {};
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const choice = arr => arr[Math.floor(Math.random() * arr.length)];

  CF.sfxDefaults = () => ({
    wave: 'pulse50',   // pulse125/pulse25/pulse50/pulse75/tri/saw/noise/noiseShort
    vol: 0.5,
    freq: 1000,        // Hz
    slide: 0,          // semitones per second
    vibDepth: 0,       // cents
    vibRate: 8,        // Hz
    arpJump: 0,        // semitones (single jump, like sfxr "change amount")
    arpTime: 0,        // seconds until the jump (0 = off)
    attack: 0,
    sustain: 0.05,
    punch: 0.3,        // extra volume at the start, decays over the sustain
    decay: 0.2,
    retrig: 0,         // Hz; restarts the pitch envelope (0 = off)
    lpCutoff: 12000,   // Hz; 12000 = filter off
    lpSweep: 0,        // octaves per second
    hpCutoff: 0,       // Hz; 0 = off
  });

  function duration(p) { return p.attack + p.sustain + p.decay + 0.08; }

  /* ---------- build the sound into any context ---------- */
  function buildSfx(ctx, dest, p, t0) {
    const dur = p.attack + p.sustain + p.decay;
    let src, freqParam, hzScale;   // param value = hzScale * frequencyHz

    if (p.wave.startsWith('pulse')) {
      src = ctx.createOscillator();
      const duty = { pulse125: 0.125, pulse25: 0.25, pulse50: 0.5, pulse75: 0.75 }[p.wave];
      src.setPeriodicWave(CF._waves.getPulseWave(ctx, duty));
      freqParam = src.frequency; hzScale = 1;
    } else if (p.wave === 'tri' || p.wave === 'saw') {
      src = ctx.createBufferSource();
      src.buffer = CF._waves.getWaveBuffer(ctx, p.wave === 'tri' ? 'triangle' : 'sawtooth');
      src.loop = true;
      freqParam = src.playbackRate; hzScale = 32 / ctx.sampleRate;
    } else { // noise / noiseShort
      src = ctx.createBufferSource();
      src.buffer = CF._waves.getNoise(ctx, p.wave === 'noiseShort');
      src.loop = true;
      freqParam = src.playbackRate; hzScale = 1 / 500;  // 500 Hz param = raw LFSR rate
    }

    // pitch curve sampled every 5 ms — handles slide + arp jump + retrigger
    // uniformly, and the slight stepping is period-correct chiptune flavour.
    const retrigPeriod = p.retrig > 0 ? 1 / p.retrig : Infinity;
    const freqAt = tt => {
      const seg = retrigPeriod === Infinity ? tt : tt % retrigPeriod;
      let f = p.freq * Math.pow(2, p.slide * seg / 12);
      if (p.arpTime > 0 && seg >= p.arpTime) f *= Math.pow(2, p.arpJump / 12);
      return clamp(f, 20, 12000);
    };
    for (let tt = 0; tt < dur; tt += 0.005) {
      freqParam.setValueAtTime(hzScale * freqAt(tt), t0 + tt);
    }

    if (p.vibDepth > 0 && src.detune) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.vibRate;
      const lg = ctx.createGain();
      lg.gain.value = p.vibDepth;
      lfo.connect(lg).connect(src.detune);
      lfo.start(t0); lfo.stop(t0 + dur + 0.1);
    }

    // filters
    let node = src;
    if (p.lpCutoff < 11500) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(p.lpCutoff, t0);
      if (p.lpSweep !== 0) {
        const fEnd = clamp(p.lpCutoff * Math.pow(2, p.lpSweep * dur), 40, 12000);
        lp.frequency.exponentialRampToValueAtTime(fEnd, t0 + dur);
      }
      node.connect(lp); node = lp;
    }
    if (p.hpCutoff > 25) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.hpCutoff;
      node.connect(hp); node = hp;
    }

    // envelope: attack -> vol*(1+punch), punch fades across sustain, then decay
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(p.vol * (1 + p.punch), t0 + Math.max(p.attack, 0.002));
    g.gain.linearRampToValueAtTime(p.vol, t0 + p.attack + p.sustain);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    node.connect(g).connect(dest);

    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /* ---------- render & play ---------- */
  CF.sfx = {
    params: CF.sfxDefaults(),

    async render(p) {
      p = p || CF.sfx.params;
      const sr = 44100;
      const ctx = new OfflineAudioContext(1, Math.ceil(duration(p) * sr), sr);
      buildSfx(ctx, ctx.destination, p, 0.01);
      return ctx.startRendering();
    },

    async play() {
      const buf = await CF.sfx.render();
      CF.sfx.drawWave(buf);
      const ctx = CF.audio.init();
      CF.audio.resume();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(CF.audio.masterNode());
      src.start();
      return buf;
    },

    drawWave(buf) {
      const cv = document.getElementById('sfxWave');
      const w = cv.width = cv.clientWidth, h = cv.height = cv.clientHeight;
      const g = cv.getContext('2d');
      g.clearRect(0, 0, w, h);
      g.strokeStyle = '#7fdb4f';
      g.beginPath();
      const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / w));
      for (let x = 0; x < w; x++) {
        let mn = 1, mx = -1;
        for (let i = x * step; i < (x + 1) * step && i < d.length; i++) {
          if (d[i] < mn) mn = d[i];
          if (d[i] > mx) mx = d[i];
        }
        g.moveTo(x, h / 2 + mn * h * 0.48);
        g.lineTo(x, h / 2 + mx * h * 0.48 + 1);
      }
      g.stroke();
    },

    /* ---------- preset generators ---------- */
    preset(name) {
      const p = CF.sfxDefaults();
      switch (name) {
        case 'pickup':
          p.wave = choice(['pulse50', 'pulse25']);
          p.freq = rnd(900, 1600);
          p.arpJump = choice([3, 4, 5, 7, 12]);
          p.arpTime = rnd(0.05, 0.12);
          p.sustain = rnd(0.02, 0.08); p.punch = rnd(0.3, 0.6); p.decay = rnd(0.15, 0.45);
          break;
        case 'laser':
          p.wave = choice(['pulse50', 'pulse25', 'pulse125', 'saw']);
          p.freq = rnd(500, 1300);
          p.slide = rnd(-80, -30);
          p.sustain = rnd(0.04, 0.15); p.decay = rnd(0.05, 0.2);
          if (Math.random() < 0.4) p.hpCutoff = rnd(100, 400);
          if (Math.random() < 0.3) { p.vibDepth = rnd(20, 80); p.vibRate = rnd(10, 25); }
          break;
        case 'explosion':
          p.wave = choice(['noise', 'noise', 'noiseShort']);
          p.freq = rnd(100, 400);
          p.slide = rnd(-40, -10);
          p.punch = rnd(0.4, 1); p.sustain = rnd(0.1, 0.3); p.decay = rnd(0.4, 1.2);
          p.lpCutoff = rnd(1500, 6000); p.lpSweep = rnd(-3, -1);
          p.vol = 0.6;
          break;
        case 'powerup':
          p.wave = choice(['pulse50', 'pulse25', 'tri']);
          p.freq = rnd(250, 600);
          if (Math.random() < 0.5) { p.slide = rnd(20, 60); }
          else { p.slide = rnd(30, 50); p.retrig = rnd(8, 16); }
          p.sustain = rnd(0.2, 0.4); p.decay = rnd(0.3, 0.6);
          if (Math.random() < 0.4) { p.vibDepth = rnd(30, 100); p.vibRate = rnd(8, 18); }
          break;
        case 'hit':
          p.wave = choice(['noise', 'noiseShort', 'pulse25']);
          p.freq = rnd(250, 700);
          p.slide = rnd(-90, -40);
          p.sustain = rnd(0.02, 0.08); p.punch = rnd(0.2, 0.5); p.decay = rnd(0.1, 0.25);
          break;
        case 'jump':
          p.wave = 'pulse50';
          p.freq = rnd(180, 420);
          p.slide = rnd(25, 65);
          p.sustain = rnd(0.1, 0.25); p.decay = rnd(0.1, 0.3);
          p.hpCutoff = rnd(80, 250);
          break;
        case 'blip':
          p.wave = choice(['pulse50', 'pulse25']);
          p.freq = rnd(700, 1800);
          p.sustain = rnd(0.015, 0.06); p.decay = rnd(0.02, 0.09); p.punch = 0;
          break;
        case 'random':
          p.wave = choice(['pulse125', 'pulse25', 'pulse50', 'pulse75', 'tri', 'saw', 'noise', 'noiseShort']);
          p.freq = rnd(80, 2500);
          p.slide = rnd(-90, 90);
          if (Math.random() < 0.4) { p.arpJump = Math.round(rnd(-12, 12)); p.arpTime = rnd(0.03, 0.3); }
          if (Math.random() < 0.3) { p.vibDepth = rnd(10, 150); p.vibRate = rnd(4, 25); }
          if (Math.random() < 0.3) p.retrig = rnd(4, 25);
          p.attack = Math.random() < 0.2 ? rnd(0, 0.2) : 0;
          p.sustain = rnd(0.02, 0.4); p.punch = rnd(0, 0.8); p.decay = rnd(0.05, 0.9);
          if (Math.random() < 0.4) { p.lpCutoff = rnd(500, 9000); p.lpSweep = rnd(-4, 4); }
          if (Math.random() < 0.3) p.hpCutoff = rnd(50, 1500);
          break;
      }
      return p;
    },

    mutate() {
      const p = CF.sfx.params;
      const def = CF.sfxDefaults();
      for (const k in def) {
        if (typeof def[k] !== 'number' || Math.random() < 0.4) continue;
        const ranges = { vol: [0.05, 1], freq: [40, 5000], slide: [-96, 96], vibDepth: [0, 200], vibRate: [0, 30],
          arpJump: [-24, 24], arpTime: [0, 0.5], attack: [0, 0.3], sustain: [0, 0.8], punch: [0, 1], decay: [0, 1.5],
          retrig: [0, 30], lpCutoff: [200, 12000], lpSweep: [-8, 8], hpCutoff: [0, 2000] };
        const r = ranges[k];
        const span = (r[1] - r[0]) * 0.08;
        p[k] = clamp(p[k] + rnd(-span, span), r[0], r[1]);
      }
    },
  };

  /* ---------- slider schema & UI ---------- */
  const log = { to: (v, a, b) => Math.log(v / a) / Math.log(b / a), from: (x, a, b) => a * Math.pow(b / a, x) };

  const GROUPS = [
    { title: 'WAVEFORM', rows: [
      { key: 'wave', kind: 'select', label: 'WAVE', tip: 'The raw tone. Pulses = classic GB leads (the % is the duty cycle), TRI/SAW = the wavetable channel, NOISE = the drum/explosion channel ("short" mode is metallic and buzzy).',
        opts: [['pulse125', 'PULSE 12.5%'], ['pulse25', 'PULSE 25%'], ['pulse50', 'PULSE 50%'], ['pulse75', 'PULSE 75%'], ['tri', 'TRIANGLE'], ['saw', 'SAWTOOTH'], ['noise', 'NOISE'], ['noiseShort', 'NOISE (SHORT)']] },
      { key: 'vol', label: 'VOLUME', min: 0, max: 1, fmt: v => Math.round(v * 100) + '%', tip: 'Output level of this sound.' },
    ]},
    { title: 'PITCH', rows: [
      { key: 'freq', label: 'FREQUENCY', min: 40, max: 5000, isLog: true, fmt: v => Math.round(v) + ' Hz', tip: 'Starting pitch. For noise this sets brightness instead of a musical pitch.' },
      { key: 'slide', label: 'SLIDE', min: -96, max: 96, fmt: v => v.toFixed(0) + ' st/s', tip: 'Pitch slide in semitones per second. Up = powerups/jumps, down = lasers/falls.' },
      { key: 'vibDepth', label: 'VIB DEPTH', min: 0, max: 200, fmt: v => v.toFixed(0) + ' ct', tip: 'Vibrato depth in cents (100 = one semitone of wobble).' },
      { key: 'vibRate', label: 'VIB SPEED', min: 0, max: 30, fmt: v => v.toFixed(1) + ' Hz', tip: 'How fast the vibrato wobbles.' },
    ]},
    { title: 'ARPEGGIO', rows: [
      { key: 'arpJump', label: 'JUMP', min: -24, max: 24, step: 1, fmt: v => v.toFixed(0) + ' st', tip: 'Pitch jump in semitones partway through the sound — the classic coin "bling" is a +5..+7 jump.' },
      { key: 'arpTime', label: 'JUMP AT', min: 0, max: 0.5, fmt: v => (v * 1000).toFixed(0) + ' ms', tip: 'When the jump happens. 0 disables it.' },
    ]},
    { title: 'ENVELOPE', rows: [
      { key: 'attack', label: 'ATTACK', min: 0, max: 0.3, fmt: v => (v * 1000).toFixed(0) + ' ms', tip: 'Fade-in time. 0 = instant (most retro SFX).' },
      { key: 'sustain', label: 'SUSTAIN', min: 0, max: 0.8, fmt: v => (v * 1000).toFixed(0) + ' ms', tip: 'How long the sound holds at full volume.' },
      { key: 'punch', label: 'PUNCH', min: 0, max: 1, fmt: v => Math.round(v * 100) + '%', tip: 'Extra volume spike at the start that fades over the sustain — adds impact.' },
      { key: 'decay', label: 'DECAY', min: 0, max: 1.5, fmt: v => (v * 1000).toFixed(0) + ' ms', tip: 'Fade-out time after the sustain.' },
    ]},
    { title: 'EFFECTS', rows: [
      { key: 'retrig', label: 'RETRIGGER', min: 0, max: 30, fmt: v => v <= 0 ? 'OFF' : v.toFixed(1) + ' Hz', tip: 'Restarts the pitch envelope N times per second — stuttery UFO/alarm sounds. 0 = off.' },
      { key: 'lpCutoff', label: 'LOWPASS', min: 200, max: 12000, isLog: true, fmt: v => v >= 11500 ? 'OFF' : Math.round(v) + ' Hz', tip: 'Cuts highs above this frequency — muffles the sound. Slide it to max to disable.' },
      { key: 'lpSweep', label: 'LP SWEEP', min: -8, max: 8, fmt: v => v.toFixed(1) + ' oct/s', tip: 'Moves the lowpass cutoff over time. Negative = the sound closes down (great for explosions).' },
      { key: 'hpCutoff', label: 'HIGHPASS', min: 0, max: 2000, fmt: v => v < 25 ? 'OFF' : Math.round(v) + ' Hz', tip: 'Cuts lows below this frequency — thins the sound out.' },
    ]},
  ];

  CF.sfx.initUI = function () {
    const root = document.getElementById('sfxParams');
    root.innerHTML = '';
    CF.sfx._updaters = [];
    GROUPS.forEach(grp => {
      const box = document.createElement('div');
      box.className = 'sfxGroup';
      box.innerHTML = `<h3>${grp.title}</h3>`;
      grp.rows.forEach(row => {
        const div = document.createElement('div');
        div.className = 'sfxRow';
        if (row.kind === 'select') {
          div.innerHTML = `<span class="lbl" title="${row.tip}">${row.label}</span>`;
          const sel = document.createElement('select');
          row.opts.forEach(([v, l]) => sel.add(new Option(l, v)));
          sel.value = CF.sfx.params[row.key];
          sel.onchange = () => { CF.sfx.params[row.key] = sel.value; CF.sfx.play(); };
          div.appendChild(sel);
          CF.sfx._updaters.push(() => { sel.value = CF.sfx.params[row.key]; });
        } else {
          div.innerHTML = `<span class="lbl" title="${row.tip}">${row.label}</span>`;
          const inp = document.createElement('input');
          inp.type = 'range';
          inp.min = 0; inp.max = 1000; inp.step = 1;
          const val = document.createElement('span');
          val.className = 'val';
          const toSlider = v => row.isLog ? 1000 * log.to(v, row.min, row.max) : 1000 * (v - row.min) / (row.max - row.min);
          const fromSlider = x => row.isLog ? log.from(x / 1000, row.min, row.max) : row.min + (x / 1000) * (row.max - row.min);
          const refresh = () => { inp.value = toSlider(CF.sfx.params[row.key]); val.textContent = row.fmt(CF.sfx.params[row.key]); };
          inp.oninput = () => {
            let v = fromSlider(+inp.value);
            if (row.step) v = Math.round(v / row.step) * row.step;
            CF.sfx.params[row.key] = v;
            val.textContent = row.fmt(v);
          };
          inp.onchange = () => CF.sfx.play();   // audition on release
          refresh();
          div.appendChild(inp); div.appendChild(val);
          CF.sfx._updaters.push(refresh);
        }
        box.appendChild(div);
      });
      root.appendChild(box);
    });
  };

  CF.sfx.refreshUI = function () { (CF.sfx._updaters || []).forEach(f => f()); };
})();

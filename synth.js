/* ============================================================
   ChipForge synth engine.
   Recreates the GBA's PSG side (the Game Boy sound hardware it
   inherited): 2 pulse channels with selectable duty cycle, a
   32-sample 4-bit wavetable channel, and an LFSR noise channel.
   Every function takes a ctx + destination so the exact same
   code drives live playback AND offline rendering for export.
   ============================================================ */
(function () {
  const CF = window.CF = window.CF || {};

  CF.STEPS_PER_BEAT = 8;        // 1 step = a 32nd note
  CF.midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

  /* ---------- per-context resource cache (waves, buffers) ---------- */
  // PeriodicWaves and AudioBuffers belong to one context, so we build
  // them lazily per context and cache them in a WeakMap.
  const resCache = new WeakMap();

  function pulseWave(ctx, duty) {
    // Fourier series of a pulse wave: harmonic n has magnitude
    // (2/nπ)·sin(πnd). 64 harmonics is plenty below ~8 kHz.
    const N = 64;
    const real = new Float32Array(N), imag = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      imag[n] = (2 / (n * Math.PI)) * Math.sin(Math.PI * n * duty);
    }
    return ctx.createPeriodicWave(real, imag);
  }

  // GB wave channel tables: 32 samples, 4-bit (0..15).
  const WAVETABLES = {
    triangle: Array.from({ length: 32 }, (_, i) => i < 16 ? i : 31 - i),
    sawtooth: Array.from({ length: 32 }, (_, i) => Math.floor(i / 2)),
    sine:     Array.from({ length: 32 }, (_, i) => Math.round(7.5 + 7.5 * Math.sin(2 * Math.PI * i / 32))),
    organ:    Array.from({ length: 32 }, (_, i) => Math.round(7.5 + 5 * Math.sin(2 * Math.PI * i / 32) + 2.5 * Math.sin(4 * Math.PI * i / 32))),
    bass:     Array.from({ length: 32 }, (_, i) => Math.round(7.5 + 7.5 * Math.tanh(2.5 * Math.sin(2 * Math.PI * i / 32)))),
  };
  CF.WAVETABLE_NAMES = Object.keys(WAVETABLES);

  function waveTableBuffer(ctx, name) {
    const tbl = WAVETABLES[name] || WAVETABLES.triangle;
    const buf = ctx.createBuffer(1, 32, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < 32; i++) d[i] = tbl[i] / 7.5 - 1;
    return buf;
  }

  // GB noise: 15-bit LFSR; "short" mode also feeds bit 6, giving the
  // 127-step metallic loop. One sample per LFSR step.
  function lfsrBuffer(ctx, short) {
    const len = short ? 32768 : 131072;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let r = 0x7FFF;
    for (let i = 0; i < len; i++) {
      const b = (r ^ (r >> 1)) & 1;
      r = (r >> 1) | (b << 14);
      if (short) r = (r & ~0x40) | (b << 6);
      d[i] = (r & 1) ? 0.5 : -0.5;
    }
    return buf;
  }

  function res(ctx) {
    let r = resCache.get(ctx);
    if (!r) {
      r = {
        pulse: {},   // duty -> PeriodicWave
        waves: {},   // table name -> AudioBuffer
        noiseLong: lfsrBuffer(ctx, false),
        noiseShort: lfsrBuffer(ctx, true),
      };
      resCache.set(ctx, r);
    }
    return r;
  }

  function getPulseWave(ctx, duty) {
    const r = res(ctx);
    if (!r.pulse[duty]) r.pulse[duty] = pulseWave(ctx, duty);
    return r.pulse[duty];
  }
  function getWaveBuffer(ctx, name) {
    const r = res(ctx);
    if (!r.waves[name]) r.waves[name] = waveTableBuffer(ctx, name);
    return r.waves[name];
  }

  /* ---------- default instruments ---------- */
  CF.defaultInst = function (type) {
    const env = { attack: 0.004, decay: 0.06, sustain: 0.65, release: 0.05 };
    if (type === 'pulse') return { ...env, duty: 0.5, vibDepth: 0, vibRate: 5, arp: '', arpRate: 14 };
    if (type === 'wave')  return { ...env, table: 'triangle', vibDepth: 0, vibRate: 5, arp: '', arpRate: 14 };
    return { attack: 0.001, decay: 0.05, sustain: 0.4, release: 0.04, mode: 'long' }; // noise
  };

  /* ---------- voice ----------
     Builds source -> envelope gain -> dest and schedules everything.
     If dur is given (sequencer / offline render) the whole lifetime is
     scheduled up front. If dur is null (live keyboard/MIDI) the caller
     keeps the handle and calls .release() on key-up. */
  function startVoice(ctx, dest, type, inst, midi, vel, t, dur) {
    const freq = CF.midiToFreq(midi);
    const nodes = [];
    let src, freqParam, baseVal;

    if (type === 'pulse') {
      src = ctx.createOscillator();
      src.setPeriodicWave(getPulseWave(ctx, inst.duty || 0.5));
      src.frequency.value = freq;
      freqParam = src.frequency; baseVal = freq;
    } else if (type === 'wave') {
      src = ctx.createBufferSource();
      src.buffer = getWaveBuffer(ctx, inst.table);
      src.loop = true;
      // looped 32-sample buffer: output freq = rate * sampleRate / 32
      baseVal = freq * 32 / ctx.sampleRate;
      src.playbackRate.value = baseVal;
      freqParam = src.playbackRate;
    } else { // noise
      src = ctx.createBufferSource();
      src.buffer = inst.mode === 'short' ? res(ctx).noiseShort : res(ctx).noiseLong;
      src.loop = true;
      baseVal = Math.pow(2, (midi - 60) / 12);   // C4 = raw LFSR rate
      src.playbackRate.value = baseVal;
      freqParam = src.playbackRate;
    }
    nodes.push(src);

    // vibrato: sine LFO into the source's detune (cents)
    if (inst.vibDepth > 0 && src.detune) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = inst.vibRate || 5;
      const lg = ctx.createGain();
      lg.gain.value = inst.vibDepth;
      lfo.connect(lg).connect(src.detune);
      lfo.start(t);
      nodes.push(lfo);
    }

    // arpeggio: step through semitone offsets at arpRate Hz
    const arpOffs = String(inst.arp || '').trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
    if (arpOffs.length > 1 && type !== 'noise') {
      const dt = 1 / (inst.arpRate || 14);
      const horizon = dur != null ? dur : 12;   // live notes: schedule 12 s ahead
      for (let k = 0, tt = 0; tt < horizon; k++, tt += dt) {
        freqParam.setValueAtTime(baseVal * Math.pow(2, arpOffs[k % arpOffs.length] / 12), t + tt);
      }
    }

    // volume envelope (A/D/S, release on note end)
    const vol = (vel == null ? 1 : vel / 15);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + inst.attack);
    g.gain.linearRampToValueAtTime(vol * inst.sustain, t + inst.attack + inst.decay);
    src.connect(g).connect(dest);

    src.start(t);

    const handle = {
      release(when) {
        const w = Math.max(when, ctx.currentTime);
        g.gain.cancelScheduledValues(w);
        g.gain.setValueAtTime(g.gain.value, w);
        g.gain.linearRampToValueAtTime(0, w + inst.release);
        nodes.forEach(n => { try { n.stop(w + inst.release + 0.02); } catch (e) {} });
      },
    };

    if (dur != null) {
      const end = t + dur;
      g.gain.setValueAtTime(vol * inst.sustain, Math.max(end, t + inst.attack + inst.decay));
      g.gain.linearRampToValueAtTime(0, end + inst.release);
      nodes.forEach(n => n.stop(end + inst.release + 0.02));
    }
    return handle;
  }

  /* ---------- live engine ---------- */
  const live = {
    ctx: null,
    master: null,
    chains: [],      // per channel: {gain, pan}
    held: new Map(), // key -> voice handle (typing keyboard + MIDI)
    // reference track: the original song playing under your channels.
    // Never serialized, never rendered into exports.
    ref: { buffer: null, name: '', vol: 0.5, offset: 0, on: true, _gain: null, _srcs: [] },
  };

  CF.audio = {
    get ctx() { return live.ctx; },

    init() {
      if (live.ctx) return live.ctx;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ctx.createDynamicsCompressor();   // soft safety limiter
      comp.threshold.value = -10;
      comp.ratio.value = 8;
      const master = ctx.createGain();
      master.gain.value = CF.state ? CF.state.master : 0.8;
      master.connect(comp).connect(ctx.destination);
      live.ctx = ctx;
      live.master = master;
      live.chains = CF.state.channels.map(() => {
        const pan = ctx.createStereoPanner();
        const gain = ctx.createGain();
        gain.connect(pan).connect(master);
        return { gain, pan };
      });
      // reference bypasses the chip master/limiter — it's already mixed audio
      live.ref._gain = ctx.createGain();
      live.ref._gain.gain.value = live.ref.vol;
      live.ref._gain.connect(ctx.destination);
      CF.audio.refreshChannelGains();
      return ctx;
    },

    resume() {
      if (live.ctx && live.ctx.state === 'suspended') live.ctx.resume();
    },

    setMaster(v) { if (live.master) live.master.gain.value = v; },

    masterNode() { CF.audio.init(); return live.master; },

    /* ----- reference track ----- */
    refInfo() { return live.ref; },
    refLoad(buffer, name) { live.ref.buffer = buffer; live.ref.name = name; },
    refClear() { CF.audio.refStop(); live.ref.buffer = null; live.ref.name = ''; },
    refSetVol(v) { live.ref.vol = v; if (live.ref._gain) live.ref._gain.gain.value = v; },
    refSetOn(on) { live.ref.on = on; if (!on) CF.audio.refStop(); },
    refSetOffset(s) { live.ref.offset = s; },

    // start the reference so that song position `posSec` plays at ctx time `when`;
    // any previously scheduled reference source is stopped at that moment.
    refStart(when, posSec) {
      const r = live.ref;
      if (!r.buffer || !r.on || !live.ctx) return;
      const off = r.offset + posSec;
      if (off >= r.buffer.duration) return;
      r._srcs.forEach(s => { try { s.stop(when); } catch (e) {} });
      const src = live.ctx.createBufferSource();
      src.buffer = r.buffer;
      src.connect(r._gain);
      if (off < 0) src.start(when - off, 0);
      else src.start(when, off);
      r._srcs.push(src);
      if (r._srcs.length > 4) r._srcs.shift();
    },
    refStop() {
      live.ref._srcs.forEach(s => { try { s.stop(); } catch (e) {} });
      live.ref._srcs.length = 0;
    },

    // apply vol/pan/mute/solo to the live chains
    refreshChannelGains() {
      if (!live.ctx) return;
      const anySolo = CF.state.channels.some(c => c.solo);
      CF.state.channels.forEach((c, i) => {
        const audible = anySolo ? c.solo : !c.mute;
        live.chains[i].gain.gain.value = audible ? c.vol : 0;
        live.chains[i].pan.pan.value = c.pan;
      });
    },

    // schedule one sequenced note (used by the transport scheduler)
    scheduleNote(chIdx, midi, vel, t, dur) {
      const ch = CF.state.channels[chIdx];
      startVoice(live.ctx, live.chains[chIdx].gain, ch.type, ch.inst, midi, vel, t, dur);
    },

    // live input: key/MIDI down & up
    noteOn(key, midi, vel) {
      const ctx = CF.audio.init();
      CF.audio.resume();
      if (live.held.has(key)) return;
      const ch = CF.state.channels[CF.state.currentChannel];
      const h = startVoice(ctx, live.chains[CF.state.currentChannel].gain, ch.type, ch.inst, midi, vel, ctx.currentTime, null);
      live.held.set(key, h);
    },
    noteOff(key) {
      const h = live.held.get(key);
      if (h) { h.release(live.ctx.currentTime); live.held.delete(key); }
    },
    allNotesOff() {
      live.held.forEach(h => h.release(live.ctx ? live.ctx.currentTime : 0));
      live.held.clear();
    },

    // short audition blip when drawing/moving notes in the piano roll
    blip(midi) {
      const ctx = CF.audio.init();
      CF.audio.resume();
      const ch = CF.state.channels[CF.state.currentChannel];
      startVoice(ctx, live.chains[CF.state.currentChannel].gain, ch.type, ch.inst, midi, 12, ctx.currentTime, 0.12);
    },
  };

  /* ---------- offline render of the whole song ---------- */
  CF.renderSong = async function () {
    const st = CF.state;
    const stepDur = 60 / (st.bpm * CF.STEPS_PER_BEAT);
    const totalSteps = st.bars * 4 * CF.STEPS_PER_BEAT;
    const len = totalSteps * stepDur + 1.0;   // 1 s tail for releases
    const sr = 44100;
    const ctx = new OfflineAudioContext(2, Math.ceil(len * sr), sr);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 8;
    const master = ctx.createGain();
    master.gain.value = st.master;
    master.connect(comp).connect(ctx.destination);

    const anySolo = st.channels.some(c => c.solo);
    st.channels.forEach(c => {
      const audible = anySolo ? c.solo : !c.mute;
      if (!audible) return;
      const pan = ctx.createStereoPanner();
      pan.pan.value = c.pan;
      const gain = ctx.createGain();
      gain.gain.value = c.vol;
      gain.connect(pan).connect(master);
      c.notes.forEach(n => {
        if (n.s >= totalSteps) return;
        startVoice(ctx, gain, c.type, c.inst, n.p, n.v, 0.02 + n.s * stepDur, n.l * stepDur);
      });
    });
    return ctx.startRendering();
  };

  CF._startVoice = startVoice;   // shared with sfx.js
  CF._waves = {
    getPulseWave,
    getWaveBuffer,
    getNoise: (ctx, short) => short ? res(ctx).noiseShort : res(ctx).noiseLong,
  };
})();

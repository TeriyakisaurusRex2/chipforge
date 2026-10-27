/* ============================================================
   ChipForge song importer: MP3/WAV -> notes on the 4 channels.

   Pipeline (all plain DSP, runs in the page):
     1. decode + downmix + resample to 22050 Hz
     2. STFT (2048-pt FFT, 512 hop) frame by frame
     3. per frame: harmonic-summation salience over a semitone
        grid -> best melody / harmony / bass pitch candidates;
        spectral flux (per band + "spread") for drum onsets
     4. tempo from autocorrelation of the flux envelope,
        beat phase from comb alignment
     5. threshold + segment candidates into note events,
        quantize onto the sequencer grid, enforce 1 voice/channel

   The output is a DRAFT — octave slips and clutter are expected,
   the piano roll is where it gets cleaned up. The source file is
   loaded as the reference track, time-aligned, for A/B-ing.

   Also wires the reference-track panel UI.
   ============================================================ */
(function () {
  const CF = window.CF = window.CF || {};
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------------- FFT (iterative radix-2) ---------------- */
  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let j = 0; j < levels; j++) r = (r << 1) | ((i >>> j) & 1);
      rev[i] = r;
    }
    return function (re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = -re[l] * sin[k] + im[l] * cos[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }

  /* ---------------- analysis constants ---------------- */
  const SR = 22050, N = 2048, HOP = 512, NBINS = N / 2;
  const HOP_SEC = HOP / SR;
  const FRAME_OFF = (N / 2) / SR;   // an event at audio time T peaks in the frame centred on T
  const BIN_HZ = SR / N;
  const M_LO = 28, M_HI = 96;                  // E1..C7 salience grid
  const HW = [1, 0.7, 0.5, 0.33, 0.22];        // harmonic weights (melody/harmony)
  // bass weights: at 40-100 Hz the FFT bins are wider than a semitone, so the
  // fundamental is smeared — pitch precision comes from harmonics 2-5 instead
  const BW = [0.25, 0.9, 1.0, 0.7, 0.5];
  const MAX_SEC = 360;                          // analysis cap

  /* ---------------- shared: downmix + linear resample to 22050 ---------------- */
  function toMono22050(buf) {
    const ratio = buf.sampleRate / SR;
    const n = Math.min(Math.floor(buf.length / ratio), MAX_SEC * SR);
    const c0 = buf.getChannelData(0);
    const c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i * ratio, j = t | 0, fr = t - j;
      const jn = Math.min(j + 1, buf.length - 1);
      const a = c1 ? (c0[j] + c1[j]) * 0.5 : c0[j];
      const b = c1 ? (c0[jn] + c1[jn]) * 0.5 : c0[jn];
      x[i] = a + (b - a) * fr;
    }
    return x;
  }

  /* ---------------- ML note engine: Spotify Basic Pitch ----------------
     ~2.3 MB (tfjs bundle + embedded model), injected lazily the first
     time an import runs. Script-tag injection works on file:// where
     fetch() would not — that's why the model ships embedded as base64. */
  let mlPromise = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function ensureML() {
    if (!mlPromise) {
      mlPromise = (async () => {
        if (typeof window.BP === 'undefined') await loadScript('basicpitch.js');
        if (typeof window.BP_MODEL === 'undefined') await loadScript('basicpitch-model.js');
        const m = window.BP_MODEL;
        const model = BP.tf.loadGraphModel({
          load: async () => ({
            modelTopology: m.topology.modelTopology,
            format: m.topology.format,
            generatedBy: m.topology.generatedBy,
            convertedBy: m.topology.convertedBy,
            weightSpecs: m.topology.weightsManifest.flatMap(g => g.weights),
            weightData: Uint8Array.from(atob(m.weightsB64), c => c.charCodeAt(0)).buffer,
          }),
        });
        return new BP.BasicPitch(model);
      })().catch(err => { mlPromise = null; throw err; });
    }
    return mlPromise;
  }

  async function analyzeML(buf, noteSens, onProg) {
    const bp = await ensureML();
    const x = toMono22050(buf);
    let frames = [], onsets = [], contours = [];
    await bp.evaluateModel(
      x,
      (f, o, c) => { frames = f; onsets = o; contours = c; },   // called once, complete result
      p => onProg(p),
    );
    // sensitivity maps onto the model's onset/frame confidence thresholds
    const onsetThresh = clamp(0.6 - 0.18 * (noteSens - 1), 0.2, 0.85);
    const frameThresh = clamp(0.35 - 0.12 * (noteSens - 1), 0.12, 0.6);
    const poly = BP.outputToNotesPoly(frames, onsets, onsetThresh, frameThresh, 5, true, null, null, true);
    return BP.noteFramesToTime(BP.addPitchBendsToNoteEvents(contours, poly));
  }

  // Polyphonic note list -> three mono streams. Bass = below C3; of the rest,
  // a note is melody if it's the TOP sounding voice for most of its duration.
  function reduceNotes(notes) {
    const evs = notes
      .map(n => ({ t0: n.startTimeSeconds, t1: n.startTimeSeconds + n.durationSeconds, p: Math.round(n.pitchMidi), str: n.amplitude }))
      .filter(e => e.t1 - e.t0 > 0.02 && e.p >= 24 && e.p <= 107);
    const bass = [], upper = [];
    evs.forEach(e => (e.p < 48 ? bass : upper).push(e));
    const melody = [], harmony = [];
    upper.forEach(e => {
      const dur = e.t1 - e.t0;
      const iv = upper
        .filter(o => o !== e && o.p > e.p && o.t0 < e.t1 && o.t1 > e.t0)
        .map(o => [Math.max(o.t0, e.t0), Math.min(o.t1, e.t1)])
        .sort((a, b) => a[0] - b[0]);
      let covered = 0, end = -1;
      iv.forEach(([a, b]) => {
        if (a > end) { covered += b - a; end = b; }
        else if (b > end) { covered += b - end; end = b; }
      });
      (covered / dur < 0.5 ? melody : harmony).push(e);
    });
    return { melody, harmony, bass };
  }

  /* ---------------- heavy pass: STFT + per-frame features ---------------- */
  async function analyzeBuffer(buf, onProg) {
    onProg = onProg || (() => {});
    const x = toMono22050(buf);
    const n = x.length;

    const fft = makeFFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);

    // precompute spectrogram positions of 5 harmonics per semitone
    const nM = M_HI - M_LO + 1;
    const pos = new Float32Array(nM * 5);
    for (let mi = 0; mi < nM; mi++) {
      const f = CF.midiToFreq(M_LO + mi);
      for (let h = 1; h <= 5; h++) {
        const p = f * h / BIN_HZ;
        pos[mi * 5 + h - 1] = p < NBINS - 1 ? p : 0;
      }
    }

    const nF = Math.max(1, Math.floor((n - N) / HOP) + 1);
    const re = new Float32Array(N), im = new Float32Array(N);
    const mag = new Float32Array(NBINS), prev = new Float32Array(NBINS);
    const sal = new Float32Array(nM);

    const mel1 = [], mel2 = [], bassA = [];
    const env = new Float32Array(nF);
    const fl = new Float32Array(nF), fm = new Float32Array(nF), fh = new Float32Array(nF);
    const spread = new Float32Array(nF);
    const bLow = Math.round(160 / BIN_HZ), bMid = Math.round(2000 / BIN_HZ), bHi = Math.round(5000 / BIN_HZ);

    for (let k = 0; k < nF; k++) {
      const off = k * HOP;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < NBINS; b++) mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);

      // spectral flux: total, banded, and bin-spread (broadband = percussive)
      let s = 0, l = 0, m = 0, h = 0, cnt = 0;
      for (let b = 1; b < NBINS; b++) {
        const d = mag[b] - prev[b];
        if (d > 0) {
          s += d;
          if (b < bLow) l += d;
          else if (b < bMid) m += d;
          if (b > bHi) h += d;
          if (d > 0.003) cnt++;
        }
      }
      env[k] = s; fl[k] = l; fm[k] = m; fh[k] = h; spread[k] = cnt;
      prev.set(mag);

      // harmonic-summation salience over the semitone grid
      for (let mi = 0; mi < nM; mi++) {
        let v = 0;
        for (let j = 0; j < 5; j++) {
          const p = pos[mi * 5 + j];
          if (p <= 0) continue;
          const bi = p | 0;
          v += HW[j] * (mag[bi] + (mag[bi + 1] - mag[bi]) * (p - bi));
        }
        sal[mi] = v;
      }

      // raw spectrum lookup — used as direct "is the fundamental really there" evidence
      const imAt = hz => {
        const p = hz / BIN_HZ;
        if (p <= 0 || p >= NBINS - 1) return 0;
        const bi = p | 0;
        return mag[bi] + (mag[bi + 1] - mag[bi]) * (p - bi);
      };

      // melody: strongest pitch in C3..E6; drop an octave only if the lower
      // octave's own fundamental actually carries energy
      let bm = -1, bs = 0;
      for (let mm = 55; mm <= 88; mm++) {
        if (sal[mm - M_LO] > bs) { bs = sal[mm - M_LO]; bm = mm; }
      }
      if (bm >= 67) {
        const f = CF.midiToFreq(bm);
        if (imAt(f / 2) > 0.5 * imAt(f)) { bm -= 12; bs = sal[bm - M_LO]; }
      }
      mel1.push({ m: bm, s: bs });

      // harmony: a second voice. Skip pitches that are just the melody's own
      // harmonics (unisons, octaves above); anything else needs fundamental evidence.
      let hm = -1, hs = 0;
      const melF = bm > 0 ? imAt(CF.midiToFreq(bm)) : 0;
      for (let mm = 48; mm <= 84; mm++) {
        if (Math.abs(mm - bm) < 3 || mm === bm + 12 || mm === bm + 24) continue;
        const sv = sal[mm - M_LO];
        if (sv > hs && imAt(CF.midiToFreq(mm)) > 0.3 * melF) { hs = sv; hm = mm; }
      }
      mel2.push({ m: hm, s: hs });

      // bass: harmonic-weighted argmax, then evidence-based octave-down check
      let xm = -1, xs = 0;
      for (let mm = M_LO; mm <= 52; mm++) {
        const mi = mm - M_LO;
        let v = 0;
        for (let j = 0; j < 5; j++) {
          const p = pos[mi * 5 + j];
          if (p <= 0) continue;
          const bi = p | 0;
          v += BW[j] * (mag[bi] + (mag[bi + 1] - mag[bi]) * (p - bi));
        }
        if (v > xs) { xs = v; xm = mm; }
      }
      if (xm - 12 >= M_LO) {
        const f = CF.midiToFreq(xm);
        if (imAt(f / 2) > 0.55 * imAt(f)) xm -= 12;
      }
      bassA.push({ m: xm, s: xs });

      if (k % 300 === 0) {
        onProg(k / nF);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    onProg(1);

    env[0] = env[1] = 0;   // first frames see flux against silence — a fake giant onset

    // median-smooth the bass pitch track: low-end estimates jitter between
    // neighbouring semitones, which would shred long notes into fragments
    for (let k = 2; k < bassA.length - 2; k++) {
      const w = [];
      for (let j = k - 2; j <= k + 2; j++) if (bassA[j].m > 0 && bassA[j].s > 0) w.push(bassA[j].m);
      if (w.length >= 3 && bassA[k].m > 0) {
        w.sort((a, b) => a - b);
        bassA[k] = { m: w[w.length >> 1], s: bassA[k].s };
      }
    }

    const bpm = detectBPM(env);
    return { mel1, mel2, bassA, env, fl, fm, fh, spread, nF, bpm, dur: n / SR };
  }

  /* ---------------- tempo & beat phase ---------------- */
  function onsetCurve(env) {
    const n = Math.min(env.length, Math.round(120 / HOP_SEC));
    const e = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 8), b = Math.min(n - 1, k + 8);
      let mn = 0;
      for (let j = a; j <= b; j++) mn += env[j];
      e[k] = Math.max(0, env[k] - mn / (b - a + 1));
    }
    return e;
  }

  function detectBPM(env) {
    const e = onsetCurve(env), n = e.length, fps = 1 / HOP_SEC;
    const corr = lag => {
      let s = 0, c = 0;
      for (let k = 0; k + lag + 1 < n; k++) {
        const t = k + lag, j = t | 0, fr = t - j;
        s += e[k] * (e[j] + (e[j + 1] - e[j]) * fr);
        c++;
      }
      return c > 0 ? s / c : 0;
    };
    let best = 120, bs = -1;
    for (let bpm = 60; bpm <= 200; bpm += 0.5) {
      const lag = 60 / bpm * fps;
      const sc = corr(lag) + 0.5 * corr(2 * lag);
      if (sc > bs) { bs = sc; best = bpm; }
    }
    if (best < 80) best *= 2;
    if (best > 180) best /= 2;
    return best;
  }

  function detectPhase(env, bpm) {
    const e = onsetCurve(env), n = e.length;
    const beat = 60 / bpm / HOP_SEC;
    let bestPh = 0, bs = -1;
    for (let ph = 0; ph < beat; ph += 0.25) {
      let s = 0, c = 0;
      for (let i = 0; ; i++) {
        const t = ph + i * beat;
        if (t + 1 >= n) break;
        const j = t | 0;
        s += e[j] + (e[j + 1] - e[j]) * (t - j);
        c++;
      }
      if (c && s / c > bs) { bs = s / c; bestPh = ph; }
    }
    return (bestPh * HOP_SEC + FRAME_OFF) % (60 / bpm);
  }

  /* ---------------- candidates -> note events (seconds) ---------------- */
  function percentile(arr, q) {
    const v = [];
    for (const c of arr) if (c.s > 0) v.push(c.s);
    if (!v.length) return Infinity;
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length * q)];
  }

  function runs(cands, thr, minDur, maxGap) {
    const out = [];
    let cur = null, gap = 0;
    const close = k => {
      if (cur) {
        const t0 = cur.k0 * HOP_SEC + FRAME_OFF, t1 = (cur.k1 + 1) * HOP_SEC + FRAME_OFF;
        if (t1 - t0 >= minDur) out.push({ t0, t1, p: cur.p, str: cur.sum / cur.n });
        cur = null;
      }
    };
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k];
      const ok = c.m > 0 && c.s >= thr;
      if (cur) {
        if (ok && c.m === cur.p) { cur.k1 = k; cur.sum += c.s; cur.n++; gap = 0; }
        else if (ok) { close(k); cur = { p: c.m, k0: k, k1: k, sum: c.s, n: 1 }; gap = 0; }
        else { gap++; if (gap > maxGap) close(k); }
      } else if (ok) {
        cur = { p: c.m, k0: k, k1: k, sum: c.s, n: 1 };
        gap = 0;
      }
    }
    close();
    return out;
  }

  function drumEvents(raw, drumSens) {
    const { env, fl, fm, fh, spread, nF } = raw;
    // adaptive gates: local-mean ratio for "is this a hit", spread for "is it percussive"
    const sp = Array.from(spread).sort((a, b) => a - b);
    const spreadThr = sp[Math.floor(sp.length * 0.55)] || 0;
    const ons = [];
    let lastT = -1;
    for (let k = 2; k < nF - 3; k++) {
      const v = env[k];
      if (v < env[k - 1] || v < env[k - 2] || v < env[k + 1] || v < env[k + 2]) continue;
      const a = Math.max(0, k - 21), b = Math.min(nF - 1, k + 21);
      let mn = 0;
      for (let j = a; j <= b; j++) mn += env[j];
      mn /= (b - a + 1);
      if (v < mn * (1.8 / drumSens) || spread[k] < spreadThr) continue;
      const t = k * HOP_SEC + FRAME_OFF;
      if (t - lastT < 0.07) continue;
      lastT = t;
      const L = fl[k] + fl[k + 1], M = fm[k] + fm[k + 1], H = fh[k] + fh[k + 1];
      ons.push({ t, str: v, B: (H - L) / (L + M + H + 1e-9) });   // B = brightness
    }
    const lanes = classifyDrums(ons);
    return ons.map((o, i) => ({ t0: o.t, t1: o.t + 0.05, p: lanes[i], str: o.str }));
  }

  // Kick/snare/hat from brightness. Absolute thresholds fail across kits
  // (a chip "kick" is far brighter than a real one), so cluster this song's
  // own brightness values and order the clusters dark -> bright.
  function classifyDrums(ons) {
    const ANCHORS = [[-0.2, 45], [0.25, 65], [0.55, 85]];
    const nearestLane = b => {
      let lane = 65, d = Infinity;
      ANCHORS.forEach(([c, l]) => { const dd = Math.abs(b - c); if (dd < d) { d = dd; lane = l; } });
      return lane;
    };
    if (ons.length < 6) return ons.map(o => nearestLane(o.B));

    const bs = ons.map(o => o.B);
    let cent = [Math.min(...bs), (Math.min(...bs) + Math.max(...bs)) / 2, Math.max(...bs)];
    for (let it = 0; it < 12; it++) {
      const sum = [0, 0, 0], cnt = [0, 0, 0];
      bs.forEach(b => {
        let ci = 0, d = Infinity;
        cent.forEach((c, i) => { const dd = Math.abs(b - c); if (dd < d) { d = dd; ci = i; } });
        sum[ci] += b; cnt[ci]++;
      });
      for (let i = 0; i < 3; i++) if (cnt[i]) cent[i] = sum[i] / cnt[i];
    }
    cent.sort((a, b) => a - b);
    const groups = [cent[0]];
    for (let i = 1; i < 3; i++) {
      if (cent[i] - groups[groups.length - 1] > 0.08) groups.push(cent[i]);
    }
    let lanesFor;
    if (groups.length === 3) lanesFor = [45, 65, 85];
    else if (groups.length === 1) lanesFor = [nearestLane(groups[0])];
    else {
      lanesFor = groups.map(nearestLane);
      if (lanesFor[0] === lanesFor[1]) lanesFor = lanesFor[1] === 45 ? [45, 65] : [65, 85];
    }
    return ons.map(o => {
      let gi = 0, d = Infinity;
      groups.forEach((g, i) => { const dd = Math.abs(o.B - g); if (dd < d) { d = dd; gi = i; } });
      return lanesFor[gi];
    });
  }

  function buildEvents(raw, noteSens, drumSens) {
    return {
      melody: runs(raw.mel1, percentile(raw.mel1, 0.6) * 0.55 / noteSens, 0.07, 2),
      harmony: runs(raw.mel2, percentile(raw.mel2, 0.6) * 0.85 / noteSens, 0.10, 2),
      bass: runs(raw.bassA, percentile(raw.bassA, 0.6) * 0.50 / noteSens, 0.09, 3),
      drums: drumEvents(raw, drumSens),
    };
  }

  /* ---------------- events -> quantized channel notes ---------------- */
  function quantizeStream(events, bpm, phase, grid, T, isDrum) {
    const stepSec = 60 / (bpm * CF.STEPS_PER_BEAT);
    let vmax = 0;
    events.forEach(e => vmax = Math.max(vmax, e.str));
    const raw = [];
    events.forEach(e => {
      let s = Math.round((e.t0 - phase) / stepSec / grid) * grid;
      if (s < 0) s = 0;
      if (s >= T) return;
      let l = isDrum ? (e.p === 85 ? 1 : 2)
                     : Math.max(grid, Math.round((e.t1 - e.t0) / stepSec / grid) * grid);
      if (s + l > T) l = T - s;
      if (l < 1) return;
      raw.push({ s, l, p: clamp(e.p, 24, 107), v: clamp(Math.round(4 + 11 * e.str / vmax), 3, 15) });
    });
    raw.sort((a, b) => a.s - b.s || b.v - a.v);
    const out = [];
    raw.forEach(nn => {                    // enforce one voice: trim/drop overlaps
      const last = out[out.length - 1];
      if (last && nn.s === last.s) return;
      if (last && last.s + last.l > nn.s) last.l = nn.s - last.s;
      out.push(nn);
    });
    return out;
  }

  function buildNotes(raw, events, bpm, grid) {
    // beat phase tells us where beats are, but not which beat is "bar 1, beat 1" —
    // anchor step 0 on the beat closest to the first detected event.
    const beatSec = 60 / bpm;
    let phase = detectPhase(raw.env, bpm);
    let tFirst = Infinity, lastT = 0;
    for (const k in events) events[k].forEach(e => { tFirst = Math.min(tFirst, e.t0); lastT = Math.max(lastT, e.t1); });
    if (tFirst < Infinity) phase += beatSec * Math.round((tFirst - phase) / beatSec);
    const beats = Math.max(1, (lastT - phase) / beatSec);
    // 0.12-bar tolerance: a final note's decay tail shouldn't add a whole bar
    // (a 4-bar piece imported as 5 bars would loop wrong in-game)
    const bars = clamp(Math.ceil(beats / 4 - 0.12), 1, 64);
    const T = bars * 4 * CF.STEPS_PER_BEAT;
    return {
      phase, bars,
      melody: quantizeStream(events.melody, bpm, phase, grid, T, false),
      harmony: quantizeStream(events.harmony, bpm, phase, grid, T, false),
      bass: quantizeStream(events.bass, bpm, phase, grid, T, false),
      drums: quantizeStream(events.drums, bpm, phase, grid, T, true),
    };
  }

  /* ---------------- apply to the project ---------------- */
  const STREAMS = [
    ['melody', 0, 'MELODY → PULSE 1'],
    ['harmony', 1, 'HARMONY → PULSE 2'],
    ['bass', 2, 'BASS → WAVE'],
    ['drums', 3, 'DRUMS → NOISE'],
  ];

  function applyResult(raw, events, opts) {
    const built = buildNotes(raw, events, opts.bpm, opts.grid);
    CF.pushUndo();
    CF.transport.stop();
    CF.state.bpm = clamp(Math.round(opts.bpm), 40, 300);
    CF.state.bars = built.bars;
    STREAMS.forEach(([key, ch]) => {
      if (opts.use[key]) CF.state.channels[ch].notes = built[key];
    });
    if (opts.use.drums) {
      Object.assign(CF.state.channels[3].inst, { sustain: 0, decay: 0.09, release: 0.04 });
    }
    if (opts.refBuffer) {
      CF.audio.refLoad(opts.refBuffer, opts.refName);
      CF.audio.refSetOffset(+built.phase.toFixed(3));
      updateRefPanel();
    }
    CF.loadState(CF.serialize());          // re-sync every UI input to the new state
    CF.markChanged();
    CF.transport.setPos(0);
    document.querySelector('.tabBtn[data-tab="music"]').click();
    CF.setHint('Imported! It\'s a draft — play it against the REFERENCE (left rack, bottom), fix octaves, delete clutter. Ctrl+Z reverts everything.');
    return built;
  }

  /* ---------------- audio file helpers ---------------- */
  function pickAudioFile(cb) {
    const inp = $('audioInput');
    inp.onchange = async () => {
      const f = inp.files[0];
      inp.value = '';
      if (!f) return;
      try {
        const ab = await f.arrayBuffer();
        const buffer = await CF.audio.init().decodeAudioData(ab);
        cb(buffer, f.name);
      } catch (err) {
        CF.setHint('Could not decode that file: ' + err.message);
      }
    };
    inp.click();
  }

  /* ---------------- reference panel UI ---------------- */
  function updateRefPanel() {
    const r = CF.audio.refInfo();
    $('refName').textContent = r.buffer ? r.name + ' (' + Math.round(r.buffer.duration) + 's)' : '— none —';
    $('refVol').value = r.vol;
    $('refVolVal').textContent = Math.round(r.vol * 100);
    $('refOffset').value = r.offset;
    $('btnRefOn').classList.toggle('on', r.on);
  }

  $('btnRefLoad').onclick = () => pickAudioFile((buf, name) => {
    CF.audio.refLoad(buf, name);
    updateRefPanel();
    CF.setHint('Reference loaded — it plays under your channels, synced to the grid. It is never part of exports.');
  });
  $('btnRefOn').onclick = e => {
    CF.audio.refSetOn(!CF.audio.refInfo().on);
    e.target.classList.toggle('on', CF.audio.refInfo().on);
  };
  $('refVol').oninput = e => {
    CF.audio.refSetVol(+e.target.value);
    $('refVolVal').textContent = Math.round(+e.target.value * 100);
  };
  $('refOffset').onchange = e => CF.audio.refSetOffset(+e.target.value || 0);

  /* ---------------- import wizard UI ---------------- */
  const wiz = { buffer: null, name: '', raw: null, events: null };

  function stage(name) {
    ['impPick', 'impConf', 'impProg', 'impRes'].forEach(id => $(id).hidden = id !== name);
  }

  function openWizard() {
    $('importModal').hidden = false;
    stage(wiz.buffer ? 'impConf' : 'impPick');
  }
  function closeWizard() { $('importModal').hidden = true; }

  $('btnImport').onclick = openWizard;
  $('impClose').onclick = closeWizard;
  $('importModal').addEventListener('pointerdown', e => { if (e.target === $('importModal')) closeWizard(); });

  const acceptFile = (buf, name) => {
    wiz.buffer = buf;
    wiz.name = name;
    wiz.raw = null;
    $('impFileInfo').innerHTML = `<b>${name}</b> — ${buf.duration.toFixed(1)}s, ${buf.sampleRate} Hz` +
      (buf.duration > MAX_SEC ? ` (only the first ${MAX_SEC / 60} minutes will be analyzed)` : '');
    stage('impConf');
  };
  $('impLoad').onclick = () => pickAudioFile(acceptFile);
  $('impOther').onclick = () => pickAudioFile(acceptFile);

  $('impNoteSens').oninput = e => $('impNoteSensVal').textContent = (+e.target.value).toFixed(2);
  $('impDrumSens').oninput = e => $('impDrumSensVal').textContent = (+e.target.value).toFixed(2);
  $('impBpmHalf').onclick = () => $('impBpm').value = clamp((+$('impBpm').value || 120) / 2, 40, 300);
  $('impBpmDouble').onclick = () => $('impBpm').value = clamp((+$('impBpm').value || 120) * 2, 40, 300);

  $('impRun').onclick = async () => {
    stage('impProg');
    const bar = f => { $('impBar').style.width = Math.round(f * 100) + '%'; };
    const noteSens = +$('impNoteSens').value, drumSens = +$('impDrumSens').value;

    // tonal notes: Basic Pitch ML model, falling back to the DSP tracker
    let mlNotes = null;
    try {
      $('impStage').textContent = 'running the note-detection model (Basic Pitch)…';
      mlNotes = await analyzeML(wiz.buffer, noteSens, f => bar(f * 0.7));
    } catch (err) {
      console.warn('ML engine unavailable, falling back to DSP:', err);
    }

    try {
      $('impStage').textContent = 'tempo, drums' + (mlNotes ? '' : ' and notes (DSP fallback)') + '…';
      wiz.raw = await analyzeBuffer(wiz.buffer, f => bar(0.7 + f * 0.3));
      wiz.events = buildEvents(wiz.raw, noteSens, drumSens);
    } catch (err) {
      $('impStage').textContent = 'Analysis failed: ' + err.message;
      console.error(err);
      return;
    }
    wiz.usedML = !!mlNotes;
    if (mlNotes) {
      const red = reduceNotes(mlNotes);
      wiz.events.melody = red.melody;
      wiz.events.harmony = red.harmony;
      wiz.events.bass = red.bass;
    }
    const ev = wiz.events;
    $('impBpm').value = wiz.raw.bpm;
    $('impSummary').innerHTML =
      `<b>${wiz.usedML ? 'ML engine (Basic Pitch)' : 'DSP engine (fallback)'}</b> heard ` +
      `<b>${ev.melody.length}</b> melody, <b>${ev.harmony.length}</b> harmony, ` +
      `<b>${ev.bass.length}</b> bass notes and <b>${ev.drums.length}</b> drum hits, with per-note velocity. ` +
      `Tempo guess: <b>${wiz.raw.bpm} BPM</b> — if that's double/half the real feel, fix it below before writing.`;
    const box = $('impStreams');
    box.innerHTML = '';
    STREAMS.forEach(([key, ch, label]) => {
      const lab = document.createElement('label');
      lab.innerHTML = `<input type="checkbox" data-stream="${key}" ${ev[key].length ? 'checked' : ''}> ${label}`;
      lab.title = 'Untick to leave that channel untouched';
      box.appendChild(lab);
    });
    stage('impRes');
  };

  $('impApply').onclick = () => {
    if (!wiz.raw) return;
    const use = {};
    document.querySelectorAll('#impStreams input').forEach(cb => use[cb.dataset.stream] = cb.checked);
    applyResult(wiz.raw, wiz.events, {
      bpm: clamp(+$('impBpm').value || wiz.raw.bpm, 40, 300),
      grid: +$('impGrid').value,
      use,
      refBuffer: wiz.buffer,
      refName: wiz.name,
    });
    closeWizard();
  };

  /* exposed for testing + power use */
  CF.importer = {
    open: openWizard,
    updateRefPanel,
    _analyze: analyzeBuffer,
    _events: buildEvents,
    _notes: buildNotes,
    _apply: applyResult,
    _setFile(buf, name) { wiz.buffer = buf; wiz.name = name; $('impFileInfo').textContent = name; stage('impConf'); },
  };
})();

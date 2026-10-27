/* ============================================================
   ChipForge I/O: WAV + MP3 encoding (lamejs), file downloads,
   project save/load as JSON.
   ============================================================ */
(function () {
  const CF = window.CF = window.CF || {};

  /* ---------------- encoding ---------------- */
  function floatTo16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  function encodeWav(buf) {
    const nCh = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
    const bytes = 44 + len * nCh * 2;
    const ab = new ArrayBuffer(bytes);
    const dv = new DataView(ab);
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * nCh * 2, true);
    dv.setUint16(32, nCh * 2, true); dv.setUint16(34, 16, true);
    wstr(36, 'data'); dv.setUint32(40, len * nCh * 2, true);
    const chans = [];
    for (let c = 0; c < nCh; c++) chans.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nCh; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  function encodeMp3(buf, kbps = 192) {
    if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) {
      throw new Error('lame.min.js missing — MP3 export unavailable (WAV still works)');
    }
    const nCh = Math.min(2, buf.numberOfChannels);
    const enc = new lamejs.Mp3Encoder(nCh, buf.sampleRate, kbps);
    const L = floatTo16(buf.getChannelData(0));
    const R = nCh === 2 ? floatTo16(buf.getChannelData(1)) : null;
    const chunks = [];
    const BLOCK = 1152;
    for (let i = 0; i < L.length; i += BLOCK) {
      const l = L.subarray(i, i + BLOCK);
      const m = nCh === 2 ? enc.encodeBuffer(l, R.subarray(i, i + BLOCK)) : enc.encodeBuffer(l);
      if (m.length) chunks.push(m);
    }
    const end = enc.flush();
    if (end.length) chunks.push(end);
    return new Blob(chunks, { type: 'audio/mpeg' });
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const safeName = s => (s || 'untitled').replace(/[^\w\- ]+/g, '').trim().replace(/ +/g, '_') || 'untitled';

  /* ---------------- public API ---------------- */
  CF.io = {
    async exportSong(fmt) {
      CF.setHint('Rendering song…');
      try {
        const buf = await CF.renderSong();
        const name = safeName(CF.state.title);
        if (fmt === 'mp3') download(encodeMp3(buf), name + '.mp3');
        else download(encodeWav(buf), name + '.wav');
        CF.setHint('Exported ' + name + '.' + fmt);
      } catch (err) {
        CF.setHint('Export failed: ' + err.message);
        console.error(err);
      }
    },

    async exportSfx(fmt) {
      try {
        const buf = await CF.sfx.render();
        const name = safeName(document.getElementById('sfxName').value);
        if (fmt === 'mp3') download(encodeMp3(buf), name + '.mp3');
        else download(encodeWav(buf), name + '.wav');
        CF.setHint('Exported ' + name + '.' + fmt);
      } catch (err) {
        CF.setHint('Export failed: ' + err.message);
        console.error(err);
      }
    },

    saveProject() {
      const blob = new Blob([JSON.stringify(CF.serialize(), null, 1)], { type: 'application/json' });
      download(blob, safeName(CF.state.title) + '.chipforge.json');
      CF.setHint('Project saved.');
    },

    openProject() {
      const inp = document.getElementById('fileInput');
      inp.onchange = () => {
        const f = inp.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          try {
            CF.loadState(JSON.parse(r.result));
            CF.setHint('Loaded ' + f.name);
          } catch (err) {
            CF.setHint('Could not load file: ' + err.message);
          }
        };
        r.readAsText(f);
        inp.value = '';
      };
      inp.click();
    },
  };
})();

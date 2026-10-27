/* ============================================================
   ChipForge piano roll — canvas note editor.
   Virtual-scrolled: the canvas is only viewport-sized and we
   draw offset by scrollX/scrollY, so long songs stay cheap.
   Mouse model (FL-style):
     left drag on empty   = draw a note (drag right = length)
     left drag on a note  = move it (and everything selected)
     drag a note's right edge = resize
     right click / drag   = delete (eraser)
     Ctrl + drag on empty = box select       Shift+click = add to selection
     Alt while dragging   = ignore snap
     wheel = scroll · Shift+wheel = sideways · Ctrl+wheel = zoom
     click the ruler      = move the playhead
   ============================================================ */
(function () {
  const CF = window.CF = window.CF || {};

  const KEYS_W = 56, RULER_H = 22, ROW_H = 14;
  const PITCH_MIN = 24, PITCH_MAX = 107;          // C1 .. B7
  const ROWS = PITCH_MAX - PITCH_MIN + 1;
  const CH_COLORS = ['#6ee76e', '#59d8e6', '#ffb347', '#c792ea'];
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK = [1, 3, 6, 8, 10];

  let cv, g, wrap, W = 0, H = 0;
  let pps = 8;                  // px per step (1 step = 1/32 note)
  let scrollX = 0, scrollY = (PITCH_MAX - 81) * ROW_H;  // start view around C5
  let dirty = true;
  let drag = null;
  let lastLen = null;
  let lastVelTweak = 0;
  const sel = new Set();
  const heldKeys = new Set();   // midi notes lit up on the keys strip

  const totalSteps = () => CF.state.bars * 4 * CF.STEPS_PER_BEAT;
  const snap = () => CF.state.snap;
  const curCh = () => CF.state.channels[CF.state.currentChannel];

  const xOf = s => KEYS_W + s * pps - scrollX;
  const yOf = p => RULER_H + (PITCH_MAX - p) * ROW_H - scrollY;
  const stepAt = x => (x - KEYS_W + scrollX) / pps;
  const pitchAt = y => PITCH_MAX - Math.floor((y - RULER_H + scrollY) / ROW_H);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function clampScroll() {
    scrollX = clamp(scrollX, 0, Math.max(0, totalSteps() * pps - (W - KEYS_W) + 160));
    scrollY = clamp(scrollY, 0, Math.max(0, ROWS * ROW_H - (H - RULER_H)));
  }

  function noteAt(x, y) {
    const p = pitchAt(y), s = stepAt(x);
    const notes = curCh().notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.p === p && s >= n.s && s <= n.s + n.l) return n;
    }
    return null;
  }

  /* ---------------- drawing ---------------- */
  function render() {
    const st = CF.state;
    g.clearRect(0, 0, W, H);

    // row stripes
    const pTop = pitchAt(RULER_H), pBot = pitchAt(H);
    for (let p = clamp(pTop, PITCH_MIN, PITCH_MAX); p >= clamp(pBot, PITCH_MIN, PITCH_MAX); p--) {
      const y = yOf(p);
      g.fillStyle = BLACK.includes(p % 12) ? '#0c120c' : '#111911';
      g.fillRect(KEYS_W, y, W - KEYS_W, ROW_H);
      if (p % 12 === 0) {                       // line above each C
        g.fillStyle = '#2a3d2a';
        g.fillRect(KEYS_W, y + ROW_H - 1, W - KEYS_W, 1);
      }
    }

    // vertical grid
    const spb = CF.STEPS_PER_BEAT;
    const s0 = Math.floor(stepAt(KEYS_W)), s1 = Math.ceil(stepAt(W));
    for (let s = Math.max(0, s0 - (s0 % snap())); s <= s1; s += snap()) {
      const x = xOf(s);
      if (s % (spb * 4) === 0)       g.fillStyle = '#3f5d3f';
      else if (s % spb === 0)        g.fillStyle = '#243424';
      else                           g.fillStyle = '#1a241a';
      g.fillRect(x, RULER_H, 1, H - RULER_H);
    }

    // shade past the end of the song
    const endX = xOf(totalSteps());
    if (endX < W) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(Math.max(endX, KEYS_W), RULER_H, W - endX, H - RULER_H);
    }

    // ghost notes from other channels
    if (st.ghosts) {
      st.channels.forEach((c, i) => {
        if (i === st.currentChannel) return;
        g.fillStyle = CH_COLORS[i] + '38';
        c.notes.forEach(n => {
          const x = xOf(n.s), y = yOf(n.p);
          if (x > W || x + n.l * pps < KEYS_W || y > H || y < RULER_H - ROW_H) return;
          g.fillRect(x, y + 4, Math.max(2, n.l * pps - 1), ROW_H - 8);
        });
      });
    }

    // current channel notes
    const col = CH_COLORS[st.currentChannel];
    curCh().notes.forEach(n => {
      const x = xOf(n.s), y = yOf(n.p), w = Math.max(3, n.l * pps - 1);
      if (x > W || x + w < KEYS_W || y > H || y < RULER_H - ROW_H) return;
      g.globalAlpha = 0.55 + 0.45 * (n.v / 15);
      g.fillStyle = col;
      g.fillRect(x, y + 1, w, ROW_H - 3);
      g.globalAlpha = 1;
      g.fillStyle = '#0a0e0a';
      g.fillRect(x + 1, y + 2, 2, ROW_H - 5);           // left accent notch
      if (sel.has(n)) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 1.5;
        g.strokeRect(x - 0.5, y + 0.5, w + 1, ROW_H - 2);
      }
    });

    // box selection rectangle
    if (drag && drag.mode === 'box') {
      g.strokeStyle = '#7fdb4f';
      g.setLineDash([4, 3]);
      g.strokeRect(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1),
                   Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      g.setLineDash([]);
    }

    // ruler
    g.fillStyle = '#131a13';
    g.fillRect(KEYS_W, 0, W - KEYS_W, RULER_H);
    g.fillStyle = '#3f5d3f';
    g.fillRect(KEYS_W, RULER_H - 2, W - KEYS_W, 2);
    g.font = '10px Consolas, monospace';
    const barPx = spb * 4 * pps;
    const labelEvery = barPx < 36 ? Math.ceil(36 / barPx) : 1;
    for (let b = 0; b * barPx <= totalSteps() * pps; b++) {
      const x = xOf(b * spb * 4);
      if (x < KEYS_W - 2 || x > W) continue;
      g.fillStyle = '#3f5d3f';
      g.fillRect(x, 0, 1, RULER_H);
      if (b % labelEvery === 0) {
        g.fillStyle = '#7da37d';
        g.fillText(String(b + 1), x + 4, 14);
      }
    }

    // playhead
    const ps = CF.transport ? CF.transport.getPlayStep() : 0;
    const px = xOf(ps);
    if (px >= KEYS_W && px <= W) {
      g.fillStyle = CF.transport && CF.transport.playing ? '#e85d5d' : '#7fdb4f';
      g.fillRect(px, 0, 2, H);
      g.beginPath();
      g.moveTo(px - 4, 0); g.lineTo(px + 6, 0); g.lineTo(px + 1, 8);
      g.fill();
    }

    // piano keys strip
    for (let p = clamp(pTop, PITCH_MIN, PITCH_MAX); p >= clamp(pBot, PITCH_MIN, PITCH_MAX); p--) {
      const y = yOf(p);
      const black = BLACK.includes(p % 12);
      g.fillStyle = heldKeys.has(p) ? '#7fdb4f' : (black ? '#0d130d' : '#cfe8cf');
      g.fillRect(0, y, KEYS_W - 4, ROW_H - 1);
      if (p % 12 === 0) {
        g.fillStyle = black ? '#cfe8cf' : '#0a0e0a';
        g.font = '10px Consolas, monospace';
        g.fillText('C' + (p / 12 - 1), 4, y + 11);
      }
    }
    g.fillStyle = '#3f5d3f';
    g.fillRect(KEYS_W - 4, 0, 2, H);
    g.fillStyle = '#131a13';
    g.fillRect(0, 0, KEYS_W, RULER_H);
  }

  /* ---------------- interaction ---------------- */
  function onPointerDown(e) {
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    CF.audio.init(); CF.audio.resume();
    const x = e.offsetX, y = e.offsetY;

    if (y < RULER_H && x > KEYS_W) {                       // ruler: move playhead
      drag = { mode: 'ruler' };
      CF.transport.setPos(clamp(Math.round(stepAt(x) / snap()) * snap(), 0, totalSteps()));
      dirty = true;
      return;
    }
    if (x < KEYS_W) {                                      // keys strip: audition
      const p = pitchAt(y);
      if (p >= PITCH_MIN && p <= PITCH_MAX) CF.audio.blip(p);
      return;
    }

    if (e.button === 2) {                                  // eraser
      drag = { mode: 'erase', pushed: false };
      eraseAt(x, y);
      return;
    }
    if (e.button !== 0) return;

    const hit = noteAt(x, y);
    if (e.ctrlKey && !hit) {                               // box select
      drag = { mode: 'box', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? new Set(sel) : new Set() };
      dirty = true;
      return;
    }

    if (hit) {
      if (e.ctrlKey) {                                     // toggle selection
        sel.has(hit) ? sel.delete(hit) : sel.add(hit);
        dirty = true;
        return;
      }
      if (!sel.has(hit)) {
        if (!e.shiftKey) sel.clear();
        sel.add(hit);
      }
      const nearEdge = x > xOf(hit.s + hit.l) - 6;
      CF.pushUndo();
      const targets = [...sel];
      drag = nearEdge
        ? { mode: 'resize', notes: targets, orig: targets.map(n => n.l), s0: stepAt(x) }
        : { mode: 'move', notes: targets, orig: targets.map(n => ({ s: n.s, p: n.p })), s0: stepAt(x), p0: pitchAt(y), lastBlip: hit.p };
      CF.audio.blip(hit.p);
      dirty = true;
    } else {                                               // draw a new note
      const sn = e.altKey ? 1 : snap();
      const s = clamp(Math.floor(stepAt(x) / sn) * sn, 0, totalSteps() - 1);
      const p = clamp(pitchAt(y), PITCH_MIN, PITCH_MAX);
      CF.pushUndo();
      const note = { s, l: lastLen || snap(), p, v: 15 };
      curCh().notes.push(note);
      sel.clear(); sel.add(note);
      drag = { mode: 'create', note, s0: stepAt(x), lastBlip: p };
      CF.audio.blip(p);
      CF.markChanged();
      dirty = true;
    }
  }

  function eraseAt(x, y) {
    const n = noteAt(x, y);
    if (n) {
      if (!drag.pushed) { CF.pushUndo(); drag.pushed = true; }
      const notes = curCh().notes;
      notes.splice(notes.indexOf(n), 1);
      sel.delete(n);
      CF.markChanged();
      dirty = true;
    }
  }

  function onPointerMove(e) {
    const x = e.offsetX, y = e.offsetY;

    if (!drag) {                                           // hover cursor
      if (y < RULER_H || x < KEYS_W) { cv.style.cursor = 'pointer'; return; }
      const hit = noteAt(x, y);
      cv.style.cursor = hit ? (x > xOf(hit.s + hit.l) - 6 ? 'ew-resize' : 'move') : 'crosshair';
      return;
    }

    const sn = e.altKey ? 1 : snap();
    if (drag.mode === 'ruler') {
      CF.transport.setPos(clamp(Math.round(stepAt(x) / sn) * sn, 0, totalSteps()));
    } else if (drag.mode === 'erase') {
      eraseAt(x, y);
    } else if (drag.mode === 'box') {
      drag.x1 = x; drag.y1 = y;
      const sA = stepAt(Math.min(drag.x0, x)), sB = stepAt(Math.max(drag.x0, x));
      const pA = pitchAt(Math.max(drag.y0, y)), pB = pitchAt(Math.min(drag.y0, y));
      sel.clear();
      drag.base.forEach(n => sel.add(n));
      curCh().notes.forEach(n => {
        if (n.s + n.l >= sA && n.s <= sB && n.p >= pA && n.p <= pB) sel.add(n);
      });
    } else if (drag.mode === 'create') {
      const n = drag.note;
      n.l = Math.max(sn, Math.ceil((stepAt(x) - n.s) / sn) * sn);
      const p = clamp(pitchAt(y), PITCH_MIN, PITCH_MAX);
      if (p !== n.p) { n.p = p; CF.audio.blip(p); }
      CF.markChanged();
    } else if (drag.mode === 'move') {
      const ds = Math.round((stepAt(x) - drag.s0) / sn) * sn;
      const dp = pitchAt(y) - drag.p0;
      drag.notes.forEach((n, i) => {
        n.s = clamp(drag.orig[i].s + ds, 0, totalSteps() - 1);
        n.p = clamp(drag.orig[i].p + dp, PITCH_MIN, PITCH_MAX);
      });
      const lead = drag.notes[0];
      if (lead.p !== drag.lastBlip) { drag.lastBlip = lead.p; CF.audio.blip(lead.p); }
      CF.markChanged();
    } else if (drag.mode === 'resize') {
      const ds = stepAt(x) - drag.s0;
      drag.notes.forEach((n, i) => {
        n.l = Math.max(sn === 1 ? 1 : sn, Math.round((drag.orig[i] + ds) / sn) * sn);
      });
      CF.markChanged();
    }
    dirty = true;
  }

  function onPointerUp(e) {
    if (drag && drag.mode === 'create') lastLen = drag.note.l;
    drag = null;
    dirty = true;
  }

  function onWheel(e) {
    e.preventDefault();
    if (e.altKey) {                       // velocity edit: hovered note, or the selection
      const hit = noteAt(e.offsetX, e.offsetY);
      const targets = hit ? (sel.has(hit) ? [...sel] : [hit]) : [...sel];
      if (targets.length) {
        const now = performance.now();
        if (now - lastVelTweak > 800) CF.pushUndo();   // one undo step per wheel gesture
        lastVelTweak = now;
        const d = e.deltaY < 0 ? 1 : -1;
        targets.forEach(n => n.v = clamp(n.v + d, 1, 15));
        CF.setHint('Velocity ' + targets[0].v + '/15' + (targets.length > 1 ? ' (' + targets.length + ' notes)' : '') + ' — brightness shows velocity');
        CF.markChanged();
        dirty = true;
      }
      return;
    }
    if (e.ctrlKey) {
      const sBefore = stepAt(e.offsetX);
      pps = clamp(pps * (e.deltaY < 0 ? 1.25 : 0.8), 1.5, 40);
      scrollX = sBefore * pps - (e.offsetX - KEYS_W);
    } else if (e.shiftKey) {
      scrollX += (e.deltaY || e.deltaX);
    } else {
      scrollY += e.deltaY;
      scrollX += e.deltaX;
    }
    clampScroll();
    dirty = true;
  }

  /* ---------------- public API ---------------- */
  CF.roll = {
    markDirty() { dirty = true; },

    setHeld(midi, on) { on ? heldKeys.add(midi) : heldKeys.delete(midi); dirty = true; },

    deselect() { sel.clear(); dirty = true; },
    selectAll() { sel.clear(); curCh().notes.forEach(n => sel.add(n)); dirty = true; },

    deleteSelection() {
      if (!sel.size) return;
      CF.pushUndo();
      const ch = curCh();
      ch.notes = ch.notes.filter(n => !sel.has(n));
      sel.clear();
      CF.markChanged(); dirty = true;
    },

    copy() {
      if (!sel.size) return;
      const s0 = Math.min(...[...sel].map(n => n.s));
      CF.clipboard = [...sel].map(n => ({ ds: n.s - s0, l: n.l, p: n.p, v: n.v }));
    },
    cut() { CF.roll.copy(); CF.roll.deleteSelection(); },
    paste() {
      if (!CF.clipboard || !CF.clipboard.length) return;
      CF.pushUndo();
      const at = Math.round(CF.transport.getPosStep() / snap()) * snap();
      sel.clear();
      CF.clipboard.forEach(c => {
        const n = { s: clamp(at + c.ds, 0, totalSteps() - 1), l: c.l, p: c.p, v: c.v };
        curCh().notes.push(n);
        sel.add(n);
      });
      CF.markChanged(); dirty = true;
    },

    nudge(ds, dp) {
      if (!sel.size) return;
      CF.pushUndo();
      sel.forEach(n => {
        n.s = clamp(n.s + ds * snap(), 0, totalSteps() - 1);
        n.p = clamp(n.p + dp, PITCH_MIN, PITCH_MAX);
      });
      CF.markChanged(); dirty = true;
    },

    zoom(dir) {
      pps = clamp(pps * (dir > 0 ? 1.25 : 0.8), 1.5, 40);
      clampScroll(); dirty = true;
    },

    // keep playhead in view during playback
    follow() {
      if (!CF.state.follow) return;
      const px = xOf(CF.transport.getPlayStep());
      if (px > W - 80 || px < KEYS_W) {
        scrollX = CF.transport.getPlayStep() * pps - 80;
        clampScroll();
      }
      dirty = true;
    },

    init() {
      cv = document.getElementById('roll');
      wrap = document.getElementById('rollWrap');
      g = cv.getContext('2d');

      const resize = () => {
        const dpr = window.devicePixelRatio || 1;
        W = wrap.clientWidth; H = wrap.clientHeight;
        cv.width = W * dpr; cv.height = H * dpr;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        clampScroll(); dirty = true;
      };
      new ResizeObserver(resize).observe(wrap);
      resize();

      cv.addEventListener('pointerdown', onPointerDown);
      cv.addEventListener('pointermove', onPointerMove);
      cv.addEventListener('pointerup', onPointerUp);
      cv.addEventListener('wheel', onWheel, { passive: false });
      cv.addEventListener('contextmenu', e => e.preventDefault());

      (function frame() {
        if (dirty || (CF.transport && CF.transport.playing)) {
          if (CF.transport && CF.transport.playing) CF.roll.follow();
          render();
          dirty = false;
        }
        requestAnimationFrame(frame);
      })();
    },
  };
})();

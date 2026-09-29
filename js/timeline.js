// Tempo-driven playback. Positions are measured in beats from the start of the song, so a song
// synced at a slow tempo plays back correctly at any tempo.
//   Clock          — count-in, beat position, optional metronome (Web Audio clicks)
//   TimelinePlayer — lights up bars / lyric lines ("units") as the clock passes through them

export class Clock {
  constructor() {
    this.running = false;
    this.audio = null;
    this.bpm = 100;
    this.bpb = 4;
  }

  // Starts counting in so that beat `startBeat` lands exactly one bar from now.
  start(startBeat, bpm, bpb, { metronome = false } = {}) {
    this.bpm = bpm;
    this.bpb = bpb;
    this.startBeat = startBeat;
    this.metronome = metronome;
    const beatMs = 60000 / bpm;
    this.t0 = performance.now() + 120 + bpb * beatMs; // time at which startBeat is reached
    this.running = true;
    this._audioInit();
    this.nextClick = startBeat - bpb;                 // count-in always clicks
    this.schedule(performance.now());
  }

  stop() { this.running = false; }

  beat(now = performance.now()) { return this.startBeat + (now - this.t0) / (60000 / this.bpm); }

  // Count-in number (1..bpb) while counting in, else 0.
  countIn(now = performance.now()) {
    const b = this.beat(now);
    return b < this.startBeat ? Math.max(1, Math.floor(b - (this.startBeat - this.bpb)) + 1) : 0;
  }

  setBpm(bpm) {
    if (this.running) {
      const now = performance.now(), b = this.beat(now);
      this.bpm = bpm;
      if (b < this.startBeat) {
        this.t0 = now + (this.startBeat - b) * (60000 / bpm); // mid count-in: keep counting
      } else {
        this.startBeat = b;
        this.t0 = now;
      }
      this.nextClick = Math.ceil(b);
    } else this.bpm = bpm;
  }

  // Schedule clicks a little ahead on the audio clock. Call every frame.
  schedule(now) {
    if (!this.running || !this.audio) return;
    const beatMs = 60000 / this.bpm;
    const horizon = this.beat(now + 200);
    while (this.nextClick <= horizon) {
      const b = this.nextClick++;
      if (b >= this.startBeat && !this.metronome) continue;
      const whenMs = this.t0 + (b - this.startBeat) * beatMs;
      const accent = ((b % this.bpb) + this.bpb) % this.bpb === 0;
      this._click(this.audio.currentTime + Math.max(0, whenMs - now) / 1000, accent);
    }
  }

  _audioInit() {
    try {
      this.audio ||= new (window.AudioContext || window.webkitAudioContext)();
      this.audio.resume?.();
    } catch { this.audio = null; } // no audio: the visual count-in still works
  }

  _click(t, accent) {
    const ctx = this.audio;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1100;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.35, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  dispose() {
    this.stop();
    this.audio?.close?.().catch(() => {});
    this.audio = null;
  }
}

// A unit is { el, kind: 'cell' | 'line', start, end } in beats. Lines may carry `words`
// (arrays of word elements) for karaoke-style fill.
export class TimelinePlayer {
  constructor({ onUnit = () => {}, onCount = () => {}, onEnd = () => {} } = {}) {
    Object.assign(this, { onUnit, onCount, onEnd });
    this.clock = new Clock();
    this.units = [];
    this.cur = -1;
    this.count = 0;
  }

  get running() { return this.clock.running; }

  setUnits(units, bpb) {
    this.units = units;
    this.bpb = bpb;
    for (const u of units) {
      if (u.kind !== 'line' || !u.words) continue;
      const total = u.words.reduce((n, w) => n + w.len, 0) || 1;
      let acc = 0;
      for (const w of u.words) { w.from = acc / total; acc += w.len; }
    }
    if (this.cur >= units.length) this.cur = -1;
    this._paint();
  }

  reset() { this.stop(); this.cur = -1; this._paint(); }

  start(fromUnit, bpm) {
    if (!this.units.length) return;
    const i = Math.max(0, Math.min(fromUnit, this.units.length - 1));
    this.cur = -1;
    this._paint();
    this.clock.start(this.units[i].start, bpm, this.bpb);
    this.count = 0;
  }

  // Where to resume after a stop.
  resumeIndex() { return this.cur >= 0 && this.cur < this.units.length - 1 ? this.cur : 0; }

  stop() {
    if (!this.clock.running) return;
    this.clock.stop();
    if (this.count) { this.count = 0; this.onCount(0); }
    this.units.forEach(u => u.el.style.removeProperty('--p'));
  }

  setBpm(bpm) { this.clock.setBpm(bpm); }

  frame(now) {
    if (!this.clock.running) return;
    this.clock.schedule(now);
    const n = this.clock.countIn(now);
    if (n !== this.count) { this.count = n; this.onCount(n); }
    if (n) return;
    const beat = this.clock.beat(now);
    const last = this.units[this.units.length - 1];
    if (beat >= last.end) { this.stop(); this.cur = this.units.length; this._paint(); this.onEnd(); return; }
    let i = Math.max(0, this.cur);
    while (i + 1 < this.units.length && this.units[i + 1].start <= beat) i++;
    while (i > 0 && this.units[i].start > beat) i--;
    if (i !== this.cur) { this.cur = i; this._paint(); this.onUnit(this.units[i], beat); }
    const u = this.units[i];
    const p = Math.max(0, Math.min(1, (beat - u.start) / (u.end - u.start)));
    if (u.kind === 'cell') {
      u.el.style.setProperty('--p', p.toFixed(3));
      const chords = u.el.querySelectorAll('.ch-in');   // split bar: share the beats evenly
      const k = Math.min(chords.length - 1, Math.floor(p * chords.length));
      chords.forEach((c, j) => c.classList.toggle('on', j === k));
    } else if (u.words) {
      // Lines are usually sung in the first part of their span; fill a little ahead.
      const fill = Math.min(1, p * 1.25);
      for (const w of u.words) { const on = w.from <= fill; w.els.forEach(el => el.classList.toggle('hit', on)); }
    }
  }

  _paint() {
    this.units.forEach((u, i) => {
      const past = this.cur >= 0 && i < this.cur, now = i === this.cur;
      u.el.classList.toggle(u.kind === 'cell' ? 'past' : 'done', past);
      u.el.classList.toggle(u.kind === 'cell' ? 'now' : 'active', now);
      if (!now) {
        u.el.querySelectorAll('.ch-in.on').forEach(c => c.classList.remove('on'));
        u.words?.forEach(w => w.els.forEach(el => el.classList.toggle('hit', past)));
      }
    });
  }

  dispose() { this.clock.dispose(); }
}

// "12:3.5" → beats from the song start (bar 12, beat 3½). "12" means beat 1 of bar 12.
export function parseAt(val, bpb) {
  const m = String(val).trim().match(/^(\d+)(?::(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  return (+m[1] - 1) * bpb + (m[2] ? +m[2] - 1 : 0);
}

export function formatAt(beat, bpb) {
  const bar = Math.floor(beat / bpb + 1e-6) + 1;
  const b = +(beat - (bar - 1) * bpb + 1).toFixed(2);
  return b === 1 ? String(bar) : `${bar}:${b}`;
}

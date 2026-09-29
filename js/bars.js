// Bar-by-bar playback for chord charts: a one-bar count-in (with clicks), then the current bar
// is highlighted in time with the tempo. Driven from the perform view's animation loop.

export class BarPlayer {
  constructor({ onBar = () => {}, onCount = () => {}, onEnd = () => {} } = {}) {
    Object.assign(this, { onBar, onCount, onEnd });
    this.cells = [];
    this.beatsPerBar = 4;
    this.bpm = 100;
    this.running = false;
    this.bar = -1;       // current (or last stopped-at) bar
    this.count = 0;      // count-in number currently shown
    this.audio = null;
  }

  setCells(cells, beatsPerBar = 4) {
    this.cells = cells;
    this.beatsPerBar = beatsPerBar;
    this._paint();
  }

  reset() {
    this.stop();
    this.bar = -1;
    this._paint();
  }

  start(fromBar, bpm) {
    if (!this.cells.length) return;
    this.bpm = bpm;
    this.startBar = Math.max(0, Math.min(fromBar, this.cells.length - 1));
    this.bar = this.startBar - 1;
    this.t0 = performance.now() + 120; // tiny lead so the first click isn't clipped
    this.running = true;
    this.count = 0;
    this._clicks(this.t0);
    this._paint();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.count = 0;
    this.onCount(0);
    this.cells.forEach(c => c.style.removeProperty('--p'));
  }

  setBpm(bpm) {
    if (this.running) {
      const now = performance.now();
      const beats = (now - this.t0) / (60000 / this.bpm);
      this.t0 = now - beats * (60000 / bpm); // keep our place in the song
    }
    this.bpm = bpm;
  }

  frame(now) {
    if (!this.running) return;
    const beatMs = 60000 / this.bpm, bpb = this.beatsPerBar;
    const b = (now - this.t0) / beatMs;
    if (b < 0) return;
    if (b < bpb) { // count-in
      const n = Math.floor(b) + 1;
      if (n !== this.count) { this.count = n; this.onCount(n); }
      return;
    }
    if (this.count) { this.count = 0; this.onCount(0); }
    const beats = b - bpb;
    const bar = this.startBar + Math.floor(beats / bpb);
    if (bar >= this.cells.length) {
      this.stop();
      this.bar = this.cells.length - 1;
      this.onEnd();
      return;
    }
    if (bar !== this.bar) {
      this.bar = bar;
      this._paint();
      this.onBar(bar, this.cells[bar]);
    }
    const cell = this.cells[bar];
    const p = (beats % bpb) / bpb;
    cell.style.setProperty('--p', p.toFixed(3));
    // A split bar ("Am Gm") shares its beats evenly between its chords.
    const chords = cell.querySelectorAll('.ch-in');
    const k = Math.min(chords.length - 1, Math.floor(p * chords.length));
    chords.forEach((c, i) => c.classList.toggle('on', i === k));
  }

  _paint() {
    this.cells.forEach((c, i) => {
      c.classList.toggle('past', this.bar >= 0 && i < this.bar);
      c.classList.toggle('now', i === this.bar);
      if (i !== this.bar) c.querySelectorAll('.ch-in.on').forEach(ch => ch.classList.remove('on'));
    });
  }

  // Count-in clicks (accent on beat 1) on the Web Audio clock.
  _clicks(t0) {
    try {
      this.audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.audio;
      ctx.resume?.();
      const start = ctx.currentTime + (t0 - performance.now()) / 1000;
      const beat = 60 / this.bpm;
      for (let i = 0; i < this.beatsPerBar; i++) {
        const t = start + i * beat;
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.frequency.value = i === 0 ? 1600 : 1100;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.5, t + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.06);
      }
    } catch { /* no audio: the visual count-in still runs */ }
  }

  dispose() {
    this.stop();
    this.audio?.close?.().catch(() => {});
    this.audio = null;
  }
}

// Voice follow: listens with the browser's speech recognizer and works out where in the
// known lyrics the singer is. It never needs a perfect transcript — it fuzzy-aligns the
// last few heard words against a window of lyrics just around the current position.

const STOP = new Set('a an and the i to of in on my me you your it is was be oh so but for at with we they he she that this as by do no'.split(' '));

export const normWord = w => String(w).toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]/g, '');
const tokens = s => s.split(/\s+/).map(normWord).filter(Boolean);
const weight = w => (STOP.has(w) ? 0.4 : 1);

function lev(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function sim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 3) return 0;
  if (a.startsWith(b) || b.startsWith(a)) return 0.75;
  const r = 1 - lev(a, b) / Math.max(a.length, b.length);
  return r >= 0.6 ? r : 0;
}

const HEARD_WINDOW = 8;   // how many recent words to align
const LOOK_BACK = 6;      // words behind the cursor to consider
const LOOK_AHEAD = 60;    // words ahead of the cursor to consider

export class VoiceFollower {
  constructor({ onMatch, onHeard, onState } = {}) {
    this.onMatch = onMatch || (() => {});
    this.onHeard = onHeard || (() => {});
    this.onState = onState || (() => {});
    this.words = [];
    this.cursor = 0;
    this.active = false;
    this.rec = null;
    this.finalWords = [];
    this.misses = 0;
    this.restartDelay = 200;
    this.mode = 'cloud';
  }

  static get supported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }

  setWords(list) {
    this.words = list.map(normWord);
    this.cursor = Math.min(this.cursor, Math.max(0, this.words.length - 1));
    this.finalWords = [];
  }

  setCursor(i) {
    this.cursor = Math.max(0, Math.min(i, this.words.length - 1));
    this.finalWords = [];
    this.misses = 0;
  }

  async start(lang = 'en-US') {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.onState('error', 'Speech recognition is not available in this browser. Use Chrome or Edge.'); return false; }
    this.active = true;
    this.onState('starting');
    const rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.mode = 'cloud';
    // Newer Chrome can recognise on-device (works offline, lower latency). Use it when available.
    try {
      if ('processLocally' in rec && SR.available) {
        const st = await SR.available({ langs: [lang], processLocally: true });
        if (st === 'available') { rec.processLocally = true; this.mode = 'on-device'; }
      }
    } catch { /* fall back to cloud recognition */ }
    if (!this.active) return false;

    rec.onstart = () => this.onState('listening', this.mode);
    rec.onresult = e => { this.restartDelay = 200; this._onResult(e); };
    rec.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false;
        this.onState('error', 'Microphone permission was denied.');
        return;
      }
      if (e.error === 'network') this.restartDelay = 3000;
      this.onState('error', 'Speech recognition error: ' + e.error);
    };
    rec.onend = () => {
      if (!this.active) { this.onState('off'); return; }
      setTimeout(() => { if (this.active && this.rec === rec) { try { rec.start(); } catch { /* already running */ } } }, this.restartDelay);
    };
    this.rec = rec;
    try { rec.start(); } catch (e) { this.active = false; this.onState('error', e.message); return false; }
    return true;
  }

  stop() {
    this.active = false;
    const rec = this.rec;
    this.rec = null;
    try { rec?.abort(); } catch { /* ignore */ }
    this.onState('off');
  }

  // Feed text as if it had been heard (used for testing without a mic).
  feed(text) {
    this.finalWords.push(...tokens(text));
    this._process([]);
  }

  _onResult(e) {
    const interim = [];
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) this.finalWords.push(...tokens(r[0].transcript));
      else interim.push(...tokens(r[0].transcript));
    }
    this._process(interim);
  }

  _process(interim) {
    this.finalWords = this.finalWords.slice(-16);
    const heard = [...this.finalWords, ...interim].slice(-HEARD_WINDOW);
    this.onHeard(heard.join(' '));
    const r = this.match(heard);
    if (r) { this.cursor = r.j; this.onMatch(r.j, r); }
  }

  match(heard) {
    const n = this.words.length, m = heard.length;
    if (!n || m < 2) return null;
    const local = this._align(heard, Math.max(0, this.cursor - LOOK_BACK), Math.min(n, this.cursor + LOOK_AHEAD));
    if (local && local.score >= 3 && local.count >= 2) { this.misses = 0; return local; }
    // Lost? After several misses, search the whole song but demand a much stronger match.
    if (++this.misses >= 4 && m >= 4) {
      const g = this._align(heard, 0, n);
      if (g && g.score >= 5.5 && g.count >= 4) { this.misses = 0; return g; }
    }
    return null;
  }

  // Local (Smith-Waterman style) alignment of heard words vs lyrics[from, to).
  // Returns the lyric index aligned with the most recent heard word.
  _align(h, from, to) {
    const m = h.length;
    let prev = new Float64Array(m + 1), prevC = new Int16Array(m + 1);
    let best = null;
    for (let j = from; j < to; j++) {
      const cur = new Float64Array(m + 1), curC = new Int16Array(m + 1);
      const lw = this.words[j], wt = weight(lw);
      for (let i = 1; i <= m; i++) {
        const s = sim(h[i - 1], lw);
        let v = 0, c = 0, matched = false;
        const d = s > 0 ? prev[i - 1] + 2 * s * wt : prev[i - 1] - 1;
        if (d > v) { v = d; c = prevC[i - 1] + (s > 0 ? 1 : 0); matched = s > 0; }
        const up = cur[i - 1] - 0.6;   // extra heard word (misrecognition)
        if (up > v) { v = up; c = curC[i - 1]; matched = false; }
        const left = prev[i] - 0.6;    // lyric word the recognizer missed
        if (left > v) { v = left; c = prevC[i]; matched = false; }
        cur[i] = v; curC[i] = c;
        if (matched && i >= m - 1) {
          const dist = j - this.cursor;
          const adj = v - (dist < 0 ? -dist * 0.15 : dist * 0.02);
          if (!best || adj > best.adj) best = { j, score: v, count: c, adj };
        }
      }
      prev = cur; prevC = curC;
    }
    return best;
  }
}

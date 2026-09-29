// Capo helper: how hard a song's chords are to play with the capo on each fret, and which
// fret gives the easiest shapes. The song keeps sounding in the same key; only the shapes change.
import { isChord, transposeChord } from './chordpro.js';

const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11, 'B#': 0, Fb: 4, 'E#': 5 };

// Difficulty of common shapes by root pitch class: 1 = easy open chord … 4 = barre chord.
const MAJ = { 0: 1, 2: 1, 4: 1, 7: 1, 9: 1, 5: 3, 11: 3.5 };
const MIN = { 9: 1, 4: 1, 2: 1, 11: 3, 6: 3, 0: 3.5, 7: 3.5, 5: 3.5 };
const DOM7 = { 4: 1, 9: 1, 2: 1, 7: 1.5, 0: 1.5, 11: 2, 5: 3 };
const MIN7 = { 9: 1, 4: 1, 2: 1.5, 11: 2.5, 6: 3 };
const MAJ7 = { 0: 1, 5: 1.5, 9: 1.5, 2: 1.5, 4: 2, 7: 2 };
// Slash chords that are standard open voicings.
const EASY_SLASH = new Set(['C/G', 'G/B', 'D/F#', 'C/E', 'Am/E', 'F/C', 'Am/G', 'C/B', 'G/D', 'D/A', 'Em/B', 'Em/D', 'G/F#', 'Am/C']);

export function chordDifficulty(name) {
  const m = String(name).match(/^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/);
  if (!m || PC[m[1]] === undefined) return 2;
  const pc = PC[m[1]], q = m[2];
  let d;
  if (q === '5') d = 1.5;                                         // power chord: movable, easy
  else if (/^(dim|°|aug|\+|m7b5|ø|mmaj|mMaj)/.test(q)) d = 3.5;
  else if (/^m(?!aj)/.test(q)) {
    if (/^m7$/.test(q)) d = MIN7[pc] ?? 4;
    else d = (MIN[pc] ?? 4) + (q === 'm' ? 0 : 0.5);
  } else if (/^(maj7|maj9|M7)$/.test(q)) d = MAJ7[pc] ?? 3.5;
  else if (/^(7|9|13|7sus4)$/.test(q)) d = (DOM7[pc] ?? 4) + (q === '7' ? 0 : 0.3);
  else if (q === '' || q === 'M') d = MAJ[pc] ?? 4;
  else d = (MAJ[pc] ?? 4) + 0.3;                                  // sus2/sus4/add9/6 …
  if (m[3] && !EASY_SLASH.has(name)) d += 0.5;
  return d;
}

// All chords in a parsed song, with how often each is played.
export function songChords(parsed) {
  const counts = new Map();
  for (const it of parsed.items) {
    if (it.type !== 'line') continue;
    for (const s of it.segs) if (s.chord && isChord(s.chord)) counts.set(s.chord, (counts.get(s.chord) || 0) + 1);
  }
  return counts;
}

// soundShift: semitones from the written chords to what should sound (transpose + the sheet's own capo).
// Returns one option per capo fret, and the index of the recommended one.
export function capoOptions(counts, soundShift, { maxFret = 9 } = {}) {
  const options = [];
  if (!counts.size) return { options, best: 0 };
  for (let capo = 0; capo <= maxFret; capo++) {
    const shift = soundShift - capo;
    const shapes = [], seen = new Set();
    let total = 0, n = 0, worst = 0, barre = 0;
    for (const [ch, count] of counts) {
      const shape = friendly(transposeChord(ch, ((shift % 12) + 12) % 12, false));
      const d = chordDifficulty(shape);
      total += d * count; n += count;
      worst = Math.max(worst, d);
      if (!seen.has(shape)) { seen.add(shape); shapes.push(shape); if (d >= 3) barre++; }
    }
    const penalty = capo >= 7 ? 0.25 * (capo - 6) : 0;             // cramped frets, thin sound
    options.push({ capo, shapes, barre, score: total / n + 0.35 * worst + penalty });
  }
  let best = 0;
  options.forEach((o, i) => { if (o.score < options[best].score - 0.15) best = i; }); // prefer no capo on near-ties
  return { options, best };
}

// Guitarists say B♭, E♭, A♭ rather than A♯, D♯, G♯.
export const friendly = c => c.replace(/(^|\/)(A#|D#|G#)/g, (m, p, n) => p + { 'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab' }[n]);

export const difficultyLabel = score => (score < 2 ? 'Easy' : score < 3 ? 'OK' : score < 4 ? 'Hard' : 'Very hard');

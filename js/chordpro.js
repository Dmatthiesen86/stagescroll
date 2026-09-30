// ChordPro parsing, "chords over lyrics" conversion, and transposition.

const CHORD_RE = /^[A-G][#b]?(?:m(?!aj)|maj|min|dim|aug|sus|add|M|\+|°|ø)?\d*(?:(?:sus|add|maj|b|#|\+|-)\d*)*(?:\/[A-G][#b]?)?$/;
const FILLER_RE = /^(\||x\d+|\d+x|N\.?C\.?|-+|\/|\.{2,}|%)$/i;
const HEADER_RE = /^\[([^\]]+)\]\s*(\([^)]*\))?\s*$/;   // "[Chorus]", also "[Chorus] (play loud)"
const TAB_LINE_RE = /^[A-Ga-g]?\s*\|[-\d|hpbrsx~\/\\()^. ]+\|?\s*$/;

export const isChord = t => CHORD_RE.test(String(t).replace(/^\(|\)$/g, ''));

// Notes UG writes on chord lines: "(Hold)", "(x2)", "[Riff]" — not chords, but worth keeping.
// A chord in parentheses — "(D)", a held/optional chord — is still a chord, not a note.
const lineNotes = line => [
  ...(line.match(/\([^)]*\)/g) || []).filter(m => !isChord(m.slice(1, -1))),
  ...[...line.matchAll(/\[([^\]]+)\]/g)].filter(m => !isChord(m[1])).map(m => `(${m[1]})`),
];
const withoutNotes = line => line.replace(/\*/g, ' ')              // footnote marks: "G* C**"
  .replace(/\(([^)]*)\)/g, (m, x) => (isChord(x) ? m : ' '.repeat(m.length)))
  .replace(/\[([^\]]+)\]/g, (m, x) => (isChord(x) ? x.padEnd(m.length) : ' '.repeat(m.length)));

// Chord names printed so close together they ran into one word: "ABmG" → "A Bm G". Only when the
// whole run splits into chords and has 2+ capitals, so a word like "Cab" is left alone.
const splitGlued = t => {
  if ((t.match(/[A-G]/g) || []).length < 2 || /[H-Z]/.test(t)) return null;
  const parts = t.split(/(?=[A-G])/).filter(Boolean); // a bass note after "/" is re-joined below
  const merged = [];
  for (const p of parts) (merged.length && merged[merged.length - 1].endsWith('/') ? merged.push(merged.pop() + p) : merged.push(p));
  return merged.length > 1 && merged.every(isChord) ? merged : null;
};
export const unglueChords = line => line.replace(/\S+/g, t => (isChord(t) ? t : splitGlued(t)?.join(' ') ?? t));

// A speck of OCR noise on a chord line ("[5", "+4", "(o-") — short and mostly symbols.
export const isNoiseToken = t => t.length <= 3 && /[^A-Za-z0-9#/]/.test(t) && !/[a-z]{2}/i.test(t);

export function isChordLine(line) {
  const tokens = withoutNotes(line).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let chords = 0, noise = 0;
  for (const t of tokens) {
    if (isChord(t)) chords++;
    else if (FILLER_RE.test(t)) continue;          // bar lines, x2, N.C. … (before the noise check)
    else if (isNoiseToken(t)) noise++;
    else return false;
  }
  return chords > 0 && noise * 2 <= chords;   // tolerate a little noise, never a line of it
}

const isTabLine = line => TAB_LINE_RE.test(line);

// True if the text already looks like ChordPro. Inline [Chord] markers win; otherwise any
// chords-above-lyrics lines mean it still needs converting, even if it has {title:} etc.
export function isChordPro(text) {
  const inline = text.match(/\[([^\]\s]{1,10})\]/g) || [];
  if (inline.some(m => isChord(m.slice(1, -1)))) return true;
  const lines = text.split(/\r?\n/);
  if (lines.some((l, i) => isChordLine(l) && lines[i + 1]?.trim() && !isChordLine(lines[i + 1]))) return false;
  return /^\s*\{\s*(title|t|subtitle|st|artist|start_of_\w+|so[cvbt]|comment|c)\s*[:}]/im.test(text);
}

// Convert Ultimate-Guitar style "chords above lyrics" text into ChordPro.
// Lines already in ChordPro directive form ({...}) pass through untouched.
export function plainToChordPro(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
    .map(l => { const u = unglueChords(l); return u !== l && isChordLine(u) ? u : l; }); // "D ABmG" → "D A Bm G"
  const out = [];
  let open = null;
  const close = () => {
    if (!open) return;
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out.push(`{end_of_${open}}`, '');
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^\{.*\}$/.test(trimmed)) {
      out.push(trimmed);
      // Existing tab blocks pass through verbatim.
      if (/^\{\s*(start_of_tab|sot)\b/i.test(trimmed)) {
        while (++i < lines.length && !/^\s*\{\s*(end_of_tab|eot)\b/i.test(lines[i])) out.push(lines[i].replace(/\s+$/, ''));
        if (i < lines.length) out.push(lines[i].trim());
      }
      continue;
    }

    const hdr = trimmed.match(HEADER_RE);
    if (hdr && !isChord(hdr[1])) {
      close();
      const label = hdr[1].trim() + (hdr[2] ? ' ' + hdr[2] : '');
      open = /chorus/i.test(label) ? 'chorus' : /bridge/i.test(label) ? 'bridge' : 'verse';
      out.push(`{start_of_${open}: ${label}}`);
      continue;
    }

    if (isTabLine(line)) {
      const block = [];
      while (i < lines.length && (isTabLine(lines[i]) || (block.length && !lines[i].trim() && isTabLine(lines[i + 1] || '')))) {
        block.push(lines[i]); i++;
      }
      i--;
      out.push('{start_of_tab}', ...block, '{end_of_tab}');
      continue;
    }

    if (isChordLine(line)) {
      const next = lines[i + 1];
      const notes = lineNotes(line).join(' ');
      const chordsOnly = withoutNotes(line);
      if (next !== undefined && next.trim() && !isChordLine(next) && !HEADER_RE.test(next.trim()) && !isTabLine(next) && !/^\{.*\}$/.test(next.trim())) {
        out.push(mergeChords(chordsOnly, plainBrackets(next)) + (notes ? '  ' + notes : ''));
        i++;
      } else if (chordsOnly.includes('|')) {
        // "| Bm7 | G Gadd9 D | Dsus2 |" keeps its bars, so it shows as a bar chart
        out.push(chordsOnly.trim().split(/\s+/).map(t => (isChord(t) ? `[${t.replace(/^\(|\)$/g, '')}]` : t === '|' ? '|' : '')).filter(Boolean).join(' ') + (notes ? '  ' + notes : ''));
      } else {
        out.push(chordsOnly.trim().split(/\s+/).filter(isChord).map(c => `[${c.replace(/^\(|\)$/g, '')}]`).join(' ') + (notes ? '  ' + notes : ''));
      }
      continue;
    }

    out.push(plainBrackets(line).replace(/\s+$/, ''));
  }
  close();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// In a lyric line, a bracketed word that isn't a chord ("[Riff]") would be read as a chord in
// ChordPro — show it as a note instead.
const plainBrackets = line => line.replace(/\[([^\]]+)\]/g, (m, x) => (isChord(x) ? m : `(${x})`));

function mergeChords(chordLine, lyric) {
  const marks = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(chordLine))) {
    if (isChord(m[0])) marks.push({ pos: m.index, chord: m[0].replace(/^\(|\)$/g, '') });
  }
  let result = lyric.replace(/\s+$/, '');
  const maxPos = marks.length ? marks[marks.length - 1].pos : 0;
  if (result.length < maxPos) result = result.padEnd(maxPos, ' ');
  for (let k = marks.length - 1; k >= 0; k--) {
    const { pos, chord } = marks[k];
    result = result.slice(0, pos) + `[${chord}]` + result.slice(pos);
  }
  // Chords hanging past the end of the lyric: keep them, but drop the padding.
  return result.replace(/\s{2,}((?:\[[^\]]+\]\s*)+)$/, ' $1').replace(/\s+$/, '');
}

function parseDuration(v) {
  const m = String(v).trim().match(/^(\d+)(?::(\d{1,2}))?$/);
  if (!m) return null;
  return m[2] !== undefined ? +m[1] * 60 + +m[2] : +m[1];
}

function parseSegs(line) {
  const segs = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0, chord = null, m;
  while ((m = re.exec(line))) {
    const text = line.slice(last, m.index);
    if (text || chord !== null) segs.push({ chord, text });
    chord = m[1].trim();
    last = re.lastIndex;
  }
  segs.push({ chord, text: line.slice(last) });
  return segs.filter(s => s.chord || s.text);
}

const SECTION_LABELS = { chorus: 'Chorus', verse: 'Verse', bridge: 'Bridge', tab: 'Tab', grid: 'Grid' };
const SHORT = { soc: 'start_of_chorus', eoc: 'end_of_chorus', sov: 'start_of_verse', eov: 'end_of_verse',
  sob: 'start_of_bridge', eob: 'end_of_bridge', sot: 'start_of_tab', eot: 'end_of_tab' };

export function parseChordPro(text) {
  const meta = {};
  const items = [];
  let section = null, inTab = false, at = null;

  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const d = line.trim().match(/^\{\s*([a-zA-Z_]+)\s*(?::\s*(.*?))?\s*\}$/);
    if (d) {
      let name = d[1].toLowerCase();
      name = SHORT[name] || name;
      const val = (d[2] || '').trim();
      if (name.startsWith('start_of_')) {
        const kind = name.slice(9);
        section = kind;
        if (kind === 'tab') inTab = true;
        items.push({ type: 'section', kind, label: val || SECTION_LABELS[kind] || kind });
        continue;
      }
      if (name.startsWith('end_of_')) { section = null; inTab = false; continue; }
      switch (name) {
        case 'title': case 't': meta.title = val; break;
        case 'subtitle': case 'st': case 'artist': meta.artist = val; break;
        case 'key': meta.key = val; break;
        case 'tempo': meta.tempo = val; break;
        case 'time': meta.time = val; break;
        case 'x_at': at = val; break; // timing for the next line (bar:beat), set by tap-along sync
        case 'capo': meta.capo = val; break;
        case 'duration': meta.duration = parseDuration(val); break;
        case 'comment': case 'c': case 'ci': case 'cb': case 'comment_italic': case 'comment_box':
          items.push({ type: 'comment', text: val }); break;
        case 'chorus': items.push({ type: 'comment', text: val || 'Chorus' }); break;
        default: break; // unknown directives are ignored
      }
      continue;
    }
    if (inTab) { items.push({ type: 'tab', text: line }); continue; }
    if (line.trim().startsWith('#')) continue;
    if (!line.trim()) { items.push({ type: 'blank' }); continue; }
    items.push({ type: 'line', section, segs: parseSegs(line), at });
    at = null;
  }
  return { meta, items };
}

// --- transposition ---
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const IDX = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };

const shiftNote = (note, n, flats) => IDX[note] === undefined ? note : (flats ? FLATS : SHARPS)[(IDX[note] + n + 120) % 12];

export function transposeChord(ch, n, flats) {
  if (!n || !isChord(ch)) return ch;
  return ch
    .replace(/^(\(?)([A-G][#b]?)/, (_, p, r) => p + shiftNote(r, n, flats))
    .replace(/\/([A-G][#b]?)/, (_, r) => '/' + shiftNote(r, n, flats));
}

export function keyPrefersFlats(key, n = 0) {
  const m = String(key || '').match(/^([A-G][#b]?)(m(?!aj))?/);
  if (!m || IDX[m[1]] === undefined) return false;
  const i = (IDX[m[1]] + n + 120) % 12;
  return m[2] ? [2, 7, 0, 5, 10, 3].includes(i) : [5, 10, 3, 8, 1, 6].includes(i);
}

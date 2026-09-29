// Merge pasted lyrics into a bar chart using tap-along timings.
// Input: the chart's bars (chords per bar), the lyric lines, and the beat at which each line
// starts. Output: ChordPro where lyric lines carry the chords from the bars they span, bars with
// no singing stay as chart rows, and every line has {x_at: bar:beat} so playback can follow it.
import { isChord } from './chordpro.js';
import { formatAt } from './timeline.js';

const BARS_PER_ROW = 4;

// Chart rows ("| [Am] | % | [G] [D] |") → [{ raw: '%' | '[Am]' | '[G] [D]', chords: ['G','D'] }]
// with '%' resolved to the previous bar's last chord.
export function chartBars(parsed) {
  const bars = [];
  let prev = null;
  for (const it of parsed.items) {
    if (it.type !== 'line' || !it.segs.some(s => s.text.includes('|')) || !it.segs.every(s => /^[\s|%]*$/.test(s.text))) continue;
    let cell = null;
    const close = () => {
      if (!cell) return;
      const chords = cell.filter(t => t !== '%');
      if (!chords.length && !cell.length) { cell = null; return; }
      const resolved = chords.length ? chords : prev ? [prev] : [];
      bars.push({ raw: chords.length ? chords.map(c => `[${c}]`).join(' ') : '%', chords: resolved });
      if (resolved.length) prev = resolved[resolved.length - 1];
      cell = null;
    };
    for (const s of it.segs) {
      if (s.chord) (cell ||= []).push(s.chord);
      for (const ch of s.text) {
        if (ch === '|') { close(); cell = []; }
        else if (ch === '%') (cell ||= []).push('%');
      }
    }
    close();
  }
  return bars;
}

// Pasted lyrics → [{ label, kind, lines: [text] }]. Blank lines split sections; "[Chorus]" labels them.
export function parseLyrics(text) {
  const sections = [];
  let cur = null;
  const open = label => { cur = { label, lines: [] }; sections.push(cur); };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\[([^\]]*)\]/g, (m, c) => (isChord(c.trim()) ? '' : m)).replace(/\s+/g, ' ').trim();
    const hdr = line.match(/^\[([^\]]+)\]$/) || line.match(/^\{(?:c|comment):\s*(.+)\}$/i);
    if (hdr) { open(hdr[1].trim()); continue; }
    if (!line || /^\{.*\}$/.test(line)) { if (cur && cur.lines.length) cur = null; continue; }
    if (!cur) open('');
    cur.lines.push(line);
  }
  let verse = 0;
  for (const s of sections) {
    if (!s.label) s.label = `Verse ${++verse}`;
    s.kind = /chorus/i.test(s.label) ? 'chorus' : /bridge/i.test(s.label) ? 'bridge' : 'verse';
  }
  return sections.filter(s => s.lines.length);
}

// sections: from parseLyrics; taps: beat position for each lyric line, in order (may be shorter).
export function buildMerged({ meta, bars, bpb, sections, taps }) {
  const lines = sections.flatMap((s, si) => s.lines.map((text, k) => ({ text, section: si, first: k === 0 })));
  const n = Math.min(lines.length, taps.length);
  const totalBeats = bars.length * bpb;

  // Chord change events, in beats.
  const events = [];
  bars.forEach((b, i) => b.chords.forEach((c, k) => {
    const beat = i * bpb + (k * bpb) / b.chords.length;
    if (!events.length || events[events.length - 1].chord !== c) events.push({ beat, chord: c });
  }));
  const chordAt = beat => { let c = null; for (const e of events) { if (e.beat <= beat + 1e-6) c = e.chord; else break; } return c; };

  // How long a line usually lasts: used to spot instrumental gaps after the last line of a section.
  const gaps = [];
  for (let j = 0; j + 1 < n; j++) if (lines[j + 1].section === lines[j].section) gaps.push(taps[j + 1] - taps[j]);
  gaps.sort((a, b) => a - b);
  const typical = gaps.length ? gaps[gaps.length >> 1] : bpb * 2;
  const cap = Math.max(bpb * 2, typical * 1.5);

  const out = [];
  const head = [];
  if (meta.title) head.push(`{title: ${meta.title}}`);
  if (meta.artist) head.push(`{artist: ${meta.artist}}`);
  if (meta.key) head.push(`{key: ${meta.key}}`);
  if (meta.tempo) head.push(`{tempo: ${meta.tempo}}`);
  head.push(`{time: ${bpb}/4}`);
  if (meta.duration) head.push(`{duration: ${Math.floor(meta.duration / 60)}:${String(meta.duration % 60).padStart(2, '0')}}`);
  head.push('# Lyrics synced by tap-along. {x_at: bar:beat} marks where each line starts.');

  const chartRows = (fromBar, toBar, label) => {
    if (toBar <= fromBar) return;
    out.push('', `{start_of_verse: ${label}}`);
    for (let b = fromBar; b < toBar; b += BARS_PER_ROW) {
      const row = bars.slice(b, Math.min(toBar, b + BARS_PER_ROW));
      // A row's first bar always names its chord, so the chart reads correctly on its own.
      const cells = row.map((bar, k) => (k === 0 && bar.raw === '%' ? `[${bar.chords[0]}]` : bar.raw));
      out.push(`{x_at: ${formatAt(b * bpb, bpb)}}`, '| ' + cells.join(' | ') + ' |');
    }
    out.push('{end_of_verse}');
  };

  // Intro: whole bars before the first sung line.
  const firstBar = n ? Math.floor(taps[0] / bpb) : bars.length;
  chartRows(0, firstBar, 'Intro');

  let openSection = -1;
  let sectionKind = 'verse';
  for (let j = 0; j < n; j++) {
    const L = lines[j], s = taps[j];
    const next = j + 1 < n ? taps[j + 1] : totalBeats;
    const lastOfSection = j + 1 >= n || lines[j + 1].section !== L.section;
    // The line runs to the next line, unless there's a long instrumental gap after it.
    let e = next;
    let gapFrom = null, gapTo = null;
    if (lastOfSection && next - s > cap) {
      e = Math.min(next, Math.ceil((s + cap) / bpb) * bpb);
      gapFrom = Math.round(e / bpb);
      gapTo = j + 1 < n ? Math.floor(next / bpb) : bars.length;
      if (gapTo <= gapFrom) { e = next; gapFrom = gapTo = null; }
    }

    if (L.section !== openSection) {
      if (openSection >= 0) out.push(`{end_of_${sectionKind}}`);
      const sec = sections[L.section];
      sectionKind = sec.kind;
      out.push('', `{start_of_${sec.kind}: ${sec.label}}`);
      openSection = L.section;
    }
    out.push(`{x_at: ${formatAt(s, bpb)}}`, placeChords(L.text, s, e, chordAt(s), events));

    if (gapFrom !== null) {
      out.push(`{end_of_${sectionKind}}`);
      openSection = -1;
      chartRows(gapFrom, gapTo, j + 1 < n ? 'Instrumental' : 'Outro');
    }
  }
  if (openSection >= 0) out.push(`{end_of_${sectionKind}}`);

  return head.join('\n') + '\n' + out.join('\n') + '\n';
}

// Put the chord that's playing when the line starts on its first word, and later chord changes
// on the word sung at about that point (spread across the line's span).
function placeChords(text, s, e, startChord, events) {
  const toks = text.split(/(\s+)/);
  const wordIdx = toks.map((t, i) => (t.trim() ? i : -1)).filter(i => i >= 0);
  const at = new Map();
  const put = (w, c) => { const i = wordIdx[Math.min(w, wordIdx.length - 1)]; at.set(i, (at.get(i) || '') + `[${c}]`); };
  if (startChord) put(0, startChord);
  const span = Math.max(1e-6, e - s);
  for (const ev of events) {
    if (ev.beat <= s + 1e-6 || ev.beat >= e - 1e-6) continue;
    put(Math.floor(((ev.beat - s) / span) * wordIdx.length), ev.chord);
  }
  return toks.map((t, i) => (at.get(i) || '') + t).join('');
}

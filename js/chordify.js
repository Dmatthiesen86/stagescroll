// Chordify PDF → ChordPro chord chart.
// Chordify exports a lead sheet: chord names (real text) above a staff, bar numbers at the start
// of each system, a tempo mark, and no lyrics. Bar lines and the "△" in F△ (maj7) are drawn
// shapes, not text, so the page is rendered and scanned for staff lines and bar lines. Each
// chord name is then dropped into the bar it sits over.
import { isChord } from './chordpro.js';

const SCALE = 2;
const BARS_PER_LINE = 4;

export const isChordifyPdf = texts => texts.some(t => /chordify\.net|tune into chords/i.test(t));

// makeCanvas(w, h) lets tests supply a canvas outside the browser.
export async function chordifyToChordPro(doc, fallbackTitle, makeCanvas = defaultCanvas) {
  let title = '', tempo = 0;
  const measures = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: SCALE });
    const canvas = makeCanvas(Math.floor(vp.width), Math.floor(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Keep blank items too: Chordify's noteheads come through as blank music-font glyphs.
    const items = (await page.getTextContent()).items.filter(i => typeof i.str === 'string').map(i => {
      const [x, y] = vp.convertToViewportPoint(i.transform[4], i.transform[5]);
      return { str: i.str.trim(), x, y, w: i.width * SCALE, h: Math.abs(i.transform[3]) * SCALE, font: i.fontName };
    });
    if (p === 1) {
      const top = items.filter(i => !/chordify/i.test(i.str) && i.str.length > 3 && !/=/.test(i.str)).sort((a, b) => a.y - b.y)[0];
      title = top?.str || '';
      const t = items.find(i => /=\s*\d{2,3}/.test(i.str));
      if (t) tempo = +t.str.match(/(\d{2,3})/)[1];
    }
    measures.push(...pageMeasures(img, items));
    canvas.width = canvas.height = 0;
  }
  return buildChart(measures, title || fallbackTitle, tempo);
}

function defaultCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ---- page analysis
function pageMeasures(img, items) {
  const { width: W, height: H, data } = img;
  const dark = (x, y) => {
    const k = (y * W + x) * 4;
    return data[k] + data[k + 1] + data[k + 2] < 384;
  };

  // Staff lines: rows that are dark across a large part of the page width.
  const lineRows = [];
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x += 2) if (dark(x, y)) n++;
    if (n * 2 > W * 0.45) lineRows.push(y);
  }
  const lines = [];
  for (const y of lineRows) {
    const last = lines[lines.length - 1];
    if (last && y - last.y1 <= 1) last.y1 = y; else lines.push({ y0: y, y1: y });
  }
  const centers = lines.map(l => (l.y0 + l.y1) / 2);
  const staves = [];
  for (let i = 0; i + 4 < centers.length; i++) {
    const gaps = [1, 2, 3, 4].map(k => centers[i + k] - centers[i + k - 1]);
    const g = gaps[0];
    if (g > 4 && g < 40 && gaps.every(d => Math.abs(d - g) <= 2)) {
      const top = Math.round(centers[i]), bottom = Math.round(centers[i + 4]);
      let left = 0, right = W - 1;
      const midY = Math.round(lines[i].y0);
      while (left < W && !dark(left, midY)) left++;
      while (right > 0 && !dark(right, midY)) right--;
      staves.push({ top, bottom, left, right, space: g });
      i += 4;
    }
  }

  const chordItems = items.filter(i => isChord(i.str) || /^N\.?C\.?$/i.test(i.str));
  const out = [];
  for (const st of staves) {
    // Noteheads/rests (music-font glyphs in the staff): they mark each bar's first beat, and the
    // edges of a stack of hollow whole notes must not be mistaken for bar lines.
    const chordFont = chordItems[0]?.font;
    const glyphs = items.filter(i => i.font !== chordFont && i.w > 0 && i.w <= st.space * 2 && i.str !== ' ' &&
      i.y >= st.top - st.space && i.y <= st.bottom + st.space * 2); // pdf.js also merges runs of spaces into wide blank items
    const inGlyph = x => glyphs.some(g => x >= g.x - 1 && x <= g.x + g.w + 1);

    // Bar lines: columns dark from the top staff line to the bottom one, but not beyond
    // (note stems poke out above or below the staff).
    const xs = [];
    for (let x = st.left + 2; x <= st.right; x++) {
      let n = 0;
      for (let y = st.top; y <= st.bottom; y++) if (dark(x, y)) n++;
      if (n < (st.bottom - st.top + 1) * 0.95) continue;
      const pad = Math.round(st.space * 0.6);
      if (st.top - pad >= 0 && dark(x, st.top - pad)) continue;
      if (st.bottom + pad < H && dark(x, st.bottom + pad)) continue;
      if (inGlyph(x)) continue;
      xs.push(x);
    }
    // Group dark columns into runs. Bar lines are thin; a stacked chord of noteheads can also
    // fill the staff top-to-bottom, but it's much wider.
    const runs = [];
    for (const x of xs) {
      const r = runs[runs.length - 1];
      if (r && x - r.x1 <= 1) r.x1 = x; else runs.push({ x0: x, x1: x });
    }
    const bars = [];
    for (const r of runs) {
      if (r.x1 - r.x0 + 1 > st.space * 0.5) continue;
      const x = Math.round((r.x0 + r.x1) / 2);
      const last = bars[bars.length - 1];
      if (last !== undefined && x - last <= st.space * 0.8) continue; // double / final bar line
      bars.push(x);
    }
    const bounds = [st.left, ...bars];
    if (st.right - bounds[bounds.length - 1] > st.space * 1.5) bounds.push(st.right);

    // Chord names sit just above this staff.
    const above = chordItems.filter(c => c.y < st.top && c.y > st.top - st.space * 5);

    for (let m = 0; m + 1 < bounds.length; m++) {
      const [x0, x1] = [bounds[m], bounds[m + 1]];
      const firstBeat = Math.min(x1, ...glyphs.filter(g => g.x > x0 && g.x < x1).map(g => g.x));
      const chords = above.filter(c => c.x >= x0 - 2 && c.x < x1 - 2).sort((a, b) => a.x - b.x).map((c, k) => ({
        name: withSuperscript(c, items, dark, W, H),
        // The clef/time signature sit at the start of a system's first bar, so its first chord is on beat 1.
        late: !(m === 0 && k === 0) && c.x - firstBeat > (x1 - firstBeat) * 0.25,
      }));
      out.push(chords);
    }
  }
  return out;
}

// A small drawn triangle just after the chord name means maj7 (Chordify writes F△ for Fmaj7).
function withSuperscript(c, items, dark, W, H) {
  if (!isChord(c.str)) return c.str.toUpperCase().replace(/^N\.?C\.?$/, 'N.C.');
  const x0 = Math.round(c.x + c.w + 1), x1 = Math.min(W - 1, x0 + Math.round(c.h * 0.5));
  const y0 = Math.max(0, Math.round(c.y - c.h * 1.0)), y1 = Math.round(c.y - c.h * 0.4);
  // Don't mistake neighbouring text (the next chord, the tempo mark) for a superscript.
  const clash = items.some(o => o !== c && /[A-Za-z0-9=]/.test(o.str) && o.x < x1 && o.x + o.w > x0 && o.y - o.h < y1 && o.y > y0);
  if (clash) return c.str;
  let n = 0;
  for (let y = y0; y <= y1 && y < H; y++) for (let x = x0; x <= x1; x++) if (dark(x, y)) n++;
  return n >= 6 ? c.str + 'maj7' : c.str;
}

// ---- output
function buildChart(measures, rawTitle, tempo) {
  let artist = '', title = rawTitle;
  const split = rawTitle.match(/^(.+?)\s+-\s+(.+)$/);
  if (split) { artist = split[1]; title = split[2]; }

  const bars = [];
  let current = null;
  for (const chords of measures) {
    const names = chords.map(c => c.name);
    if (chords.length && chords[0].late && current) names.unshift(current); // chord changes mid-bar
    if (!names.length) bars.push('%');
    else bars.push(names.map(n => `[${n}]`).join(' '));
    if (names.length) current = names[names.length - 1];
  }

  const head = [`{title: ${title}}`];
  if (artist) head.push(`{artist: ${artist}}`);
  if (tempo) {
    head.push(`{tempo: ${tempo}}`);
    const secs = Math.round(bars.length * 4 * 60 / tempo); // Chordify charts are in 4/4
    head.push(`{duration: ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}}`);
  }
  head.push(`# Imported from Chordify — ${bars.length} bars${tempo ? `, ${tempo} bpm` : ''}. % = same chord as the bar before.`);

  const rows = [];
  for (let i = 0; i < bars.length; i += BARS_PER_LINE) {
    if (i && i % (BARS_PER_LINE * 4) === 0) rows.push('');
    rows.push('| ' + bars.slice(i, i + BARS_PER_LINE).join(' | ') + ' |');
  }
  return head.join('\n') + '\n\n{start_of_verse: Chords}\n' + rows.join('\n') + '\n{end_of_verse}\n';
}

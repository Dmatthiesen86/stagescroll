// PDF import. Ultimate Guitar's PDF downloads are *pictures* of the page, so pages without a
// text layer are rendered and run through OCR (Tesseract, bundled so it works offline).
// Either way, words are placed back on a character grid from their positions on the page,
// which recreates the chords-above-lyrics layout for plainToChordPro().
import { plainToChordPro, isChord, isNoiseToken } from './chordpro.js';
import { isChordifyPdf, chordifyToChordPro } from './chordify.js';

const VENDOR = new URL('./vendor/', import.meta.url).href;
const OCR_SCALE = 3;
export let lastRawLines = null; // ~30px text height on a letter/A4 page — Tesseract's sweet spot

export async function pdfToChordPro(file, onProgress = () => {}) {
  onProgress('Opening PDF…');
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const lines = [];
  let ocr = null;
  try {
    const firstTexts = (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str || '');
    if (isChordifyPdf(firstTexts)) {
      onProgress('Reading Chordify chart…');
      return await chordifyToChordPro(doc, file.name.replace(/\.pdf$/i, '').replace(/^Chordify_/i, ''));
    }
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const items = (await page.getTextContent()).items.filter(i => i.str && i.str.trim());
      if (items.length > 5) {
        lines.push(...textLayerLines(items));
      } else {
        if (!ocr) { onProgress('Loading text recognition…'); ocr = await createOcr(); }
        onProgress(`Reading page ${p} of ${doc.numPages}…`);
        lines.push(...await ocrLines(ocr, page));
      }
      lines.push('');
    }
  } finally {
    await ocr?.terminate();
    task.destroy();
  }
  lastRawLines = lines; // kept for troubleshooting imports
  return ugTextToChordPro(lines, file.name.replace(/\.pdf$/i, ''));
}

// ---- text-layer PDFs (exported from a word processor, "print to PDF" of a web page, etc.)
function textLayerLines(items) {
  const words = items.map(i => ({
    text: i.str.replace(/\s+$/, ''),
    x0: i.transform[4],
    x1: i.transform[4] + i.width,
    y: -i.transform[5], // PDF y grows upward
    h: Math.abs(i.transform[3]) || i.height || 10,
  }));
  const rows = [];
  for (const w of words.sort((a, b) => a.y - b.y)) {
    const row = rows.find(r => Math.abs(r.y - w.y) < w.h * 0.4);
    if (row) row.words.push(w); else rows.push({ y: w.y, h: w.h, words: [w] });
  }
  return gridLines(rows);
}

// ---- image PDFs: render the page and OCR it
async function createOcr() {
  const { default: Tesseract } = await import('./vendor/ocr/tesseract.esm.min.js');
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: VENDOR + 'ocr/worker.min.js',
    corePath: VENDOR + 'ocr/',
    langPath: VENDOR + 'ocr/',
    workerBlobURL: false,
    cacheMethod: 'none', // the service worker already keeps these files offline
  });
  // PSM 6 = one uniform block of text: keeps chord lines and lyric lines as separate rows.
  await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
  return worker;
}

async function ocrLines(worker, page) {
  const vp = page.getViewport({ scale: OCR_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 'print' intent renders without waiting on animation frames, so it can't stall if the screen is backgrounded.
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  canvas.width = canvas.height = 0; // free memory promptly on phones

  const rows = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const words = line.words.filter(w => w.text.trim()).map(w => ({
          text: w.text, x0: w.bbox.x0, x1: w.bbox.x1, y: line.bbox.y0, h: line.bbox.y1 - line.bbox.y0,
        }));
        if (words.length) rows.push({ y: line.bbox.y0, h: line.bbox.y1 - line.bbox.y0, words });
      }
    }
  }
  return gridLines(rows.sort((a, b) => a.y - b.y));
}

// Place words on a monospace grid using their x positions, and turn big vertical gaps into
// blank lines. Chord sheets are laid out in fixed-width fonts, so this recovers alignment.
function gridLines(rows) {
  const all = rows.flatMap(r => r.words);
  if (!all.length) return [];
  const widths = all.filter(w => w.text.length >= 2).map(w => (w.x1 - w.x0) / w.text.length).sort((a, b) => a - b);
  const cw = widths[widths.length >> 1] || 10;
  const left = Math.min(...all.map(w => w.x0));
  const heights = rows.map(r => r.h).sort((a, b) => a - b);
  const lineH = heights[heights.length >> 1] || 20;

  const out = [];
  let prevY = null;
  for (const r of rows) {
    if (prevY !== null && r.y - prevY > lineH * 2.3) out.push('');
    prevY = r.y;
    let s = '';
    for (const w of r.words.sort((a, b) => a.x0 - b.x0)) {
      let col = Math.max(0, Math.round((w.x0 - left) / cw));
      if (s.length && col <= s.length) col = s.length + 1;
      s = s.padEnd(col) + w.text;
    }
    out.push(s);
  }
  return out;
}

// ---- OCR chord repair
// Bold chord names are OCR's weak spot ("C" → "Cc" / "€", "Dm7" → "bm7"). Chord names that
// OCR'd cleanly elsewhere in the document (UG lists every chord up top) are used to repair
// near-misses on lines that are already mostly chords.
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

const FILLER = /^(\||x\d+|\d+x|N\.?C\.?|-+|%)$/i;

// Bar-chart rows ("| C  | C  | G  |") OCR badly: the bar glues onto the bold chord ("lc", "Jc", "[6",
// "/I6") and C/G come out as "¢c" / "6". Returns the repaired row, or null if it isn't one.
function repairBarLine(l) {
  if (!/[|]/.test(l) && !/^\s*[lJ]c\b/.test(l)) return null;
  if (l.trim().split(/\s+/).every(t => isChord(t) || FILLER.test(t))) return null; // already fine; keep its spacing
  const out = [];
  for (const t of l.trim().split(/\s+/)) {
    const m = t.match(/^([|lJI[\/]*)(.*?)(\|?)$/);
    let [, bar, name, end] = m;
    if (/^(¢c?|Cc|c|€)$/.test(name)) name = 'C';
    else if (name === '6') name = 'G';
    if (name && !isChord(name) && !FILLER.test(name)) return null;
    if (bar) out.push('|');
    if (name) out.push(name);
    if (end) out.push('|');
  }
  const chords = out.filter(t => t !== '|').length;
  return chords >= 2 && out.filter(t => t === '|').length >= 2 ? out.join('  ') : null;
}

function repairChordLines(lines) {
  const known = new Map(); // chord -> count
  for (const l of lines) {
    const toks = l.trim().split(/\s+/).filter(Boolean);
    const chords = toks.filter(isChord);
    if (chords.length && chords.length >= toks.length / 2) chords.forEach(c => known.set(c, (known.get(c) || 0) + 1));
  }
  const fix = t => {
    if (isChord(t) || FILLER.test(t)) return t;
    if (isNoiseToken(t)) return '';                                  // OCR speck on a chord line
    if (t === '€') return 'C';
    if (isChord(t.replace(/é/g, '6'))) return t.replace(/é/g, '6');   // "Amé/C" → "Am6/C"
    const dbl = t.match(/^([A-G])([a-g])$/);
    if (dbl && dbl[2].toUpperCase() === dbl[1]) return dbl[1];      // "Cc" → "C"
    let best = null, bestScore = Infinity;
    for (const [c, n] of known) {
      const d = c.toLowerCase() === t.toLowerCase() ? 0 : lev(c, t);
      const score = d - Math.min(n, 20) / 100;                      // ties go to the commoner chord
      if (d <= 1 && score < bestScore) { best = c; bestScore = score; }
    }
    return best;
  };
  return lines.map(l => {
    const toks = [...l.matchAll(/\S+/g)];
    if (!toks.length) return l;
    const bars = repairBarLine(l);
    if (bars) return bars;
    // Footnote stars ride along: "D*  Cc  D*" → "D*  C  D*".
    const valid = toks.filter(m => isChord(m[0].replace(/\*+$/, '')) || FILLER.test(m[0])).length;
    // "Cc" (a bold C misread) counts toward the line being mostly chords — "Cc  F  Cc" in O Holy Night —
    // but not toward it needing no repair.
    const likely = valid + toks.filter(m => /^([A-G])\1\**$/i.test(m[0])).length;
    if (valid === toks.length || likely < toks.length / 2) return l;
    const fixed = toks.map(m => {
      const [, t, star] = m[0].match(/^(.*?)(\**)$/);
      const x = fix(t || m[0]);
      return x === null ? null : x + (t ? star : '');
    });
    if (fixed.some(f => f === null)) return l;
    let out = '';
    toks.forEach((m, i) => { out = out.padEnd(m.index) + (out.length > m.index ? ' ' : '') + fixed[i]; });
    return out;
  });
}

// ---- Tab blocks
// OCR mangles guitar tab (long dash runs), so tab areas are boxed as {start_of_tab} blocks:
// shown monospaced for reference, and kept out of the lyrics that voice follow listens for.
const isChordBars = l => l.trim().split(/\s+/).every(t => isChord(t.replace(/\*+$/, '')) || t === '|'); // "| C  Cmaj7 | F |", "E*  B"
// A line that's mostly words is lyrics, even with dashes in it — UG writes held syllables as
// "so----orry" (The Scientist).
const wordy = l => (l.match(/[A-Za-z]/g) || []).length > 0.4 * l.replace(/\s/g, '').length && /[a-z]{3}/.test(l);
// A tab string label, with the bar often OCR'd as "]" or "l": "e|", "Eb|", "B]", "Al ===" (but not "All").
const STRING_LABEL = /^\s*[A-Ga-g€8][b#]?\s?[|\]lI](?![A-Za-z])/;
const isTabby = l => !isChordBars(l) && ((l.match(/\|/g) || []).length >= 2 || (/-{3,}/.test(l) && !wordy(l)) ||
  /\d\s*&\s*\d/.test(l) || STRING_LABEL.test(l));
// A tab line with letters tab doesn't use (h p b s r t v x are techniques) is OCR soup.
const soupy = l => (l.replace(STRING_LABEL, '').replace(/[xX]\d+|\d+[xX]/g, '').match(/[ac-gi-oquwyzA-Z]/g) || []).length >= 4;
function isJunk(l) {
  const toks = l.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  const odd = toks.filter(t => !/^[A-Za-z][a-z']*[,.!?]?$/.test(t) || !/[aeiouy]/i.test(t)).length;
  return odd / toks.length >= 0.4 && !isChord(toks[0].replace(/\*+$/, '')) && !/^\s*\[[^\]]+\]\s*$/.test(l); // never a [Section]
}

function groupTabs(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTabby(lines[i])) { out.push(lines[i]); continue; }
    let j = i;
    const block = [];
    while (j < lines.length && lines[j].trim() && (isTabby(lines[j]) || isJunk(lines[j]))) block.push(lines[j++]);
    // Pull in junk lines just above, and the chord line that sits over the first bar.
    while (out.length && out[out.length - 1].trim() && isJunk(out[out.length - 1])) block.unshift(out.pop());
    const prev = out[out.length - 1];
    if (prev && prev.trim() && isChordBars(prev)) block.unshift(out.pop());
    // Tab printed as a picture often OCRs into letter soup ("G| =m=rmmmmnne=872"). That's no use on
    // stage, so keep just its chord rows and point to the PDF.
    const staff = block.filter(l => !isChordBars(l)).join('');
    const letters = (staff.match(/[A-Za-z]/g) || []).length, marks = (staff.match(/[-0-9]/g) || []).length;
    const staffLines = block.some(l => STRING_LABEL.test(l) || /-{2,}\d|\d-{2,}/.test(l));
    const garbled = (letters > 20 && letters > marks * 0.6) || block.some(l => !isChordBars(l) && soupy(l));
    if (staffLines && garbled) out.push(...block.filter(isChordBars), '{comment: Tab riff - see the original PDF}');
    else out.push('{start_of_tab}', ...block, '{end_of_tab}');
    i = j - 1;
  }
  return out;
}

// ---- Ultimate Guitar specific clean-up
export function ugTextToChordPro(rawLines, fallbackTitle) {
  const lines = repairChordLines(rawLines
    .map(l => l.replace(/^\s*\]([A-Z][A-Za-z0-9 -]*\])\s*$/, '[$1')                     // "]Verse 1]"
      .replace(/(?<![\w-])0(?=[a-z]+\b)/g, m => (/--|\||\d-\d|00/.test(l) ? m : 'O'))           // "0f a phone call" (not tab "0h|" or "0-0h")
      .replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+$/, ''))
    .filter(l => !/^\s*Page \d+(\s*\/\s*|\s+)\d+\s*$/i.test(l))                     // "Page 1/2", "Page 1 2"
    .filter(l => !/^\s*\S{12,}\s*$/.test(l) || new Set(l.trim()).size > 4)          // "*******" rules OCR'd as "khkkhk…"
    .filter(l => !/^\s*(\d{1,4}\s+){2,}\d{1,4}\s*$/.test(l))                          // chord-diagram finger numbers
    .filter(l => !l.trim() || (l.match(/[A-Za-z0-9]/g) || []).length > 2 ||           // ". - . <7"
      l.trim().split(/\s+/).some(t => isChord(t) || /^N\.?C\.?$/i.test(t) || /^([A-G])\1$/i.test(t))));        // but keep a lone bold C read as "Cc"

  let title = '', artist = '', key = '', capo = '';
  const top = lines.slice(0, 40);
  top.forEach((raw, i) => {
    const l = raw.trim().replace(/\s+/g, ' ');
    const t = l.match(/^(.+?)\s+(?:Chords|Tabs?|Ukulele Chords|Bass Tabs?|Chords & Lyrics)\s+by\s+(.+)$/i);
    if (t && !title) {
      // A leading "I" OCRs as "|" or "l": "| Will Follow You…", "lll Be" (I'll Be).
      title = t[1].trim().replace(/^[|l](?=\s)/, 'I').replace(/^lll\b/, "I'll");
      // Trailing 1–2 character tokens are OCR noise from the UG logo at the right edge.
      artist = t[2].replace(/(\s+\S{1,2})+$/, '').trim();
      // A long title+artist wraps onto the next line: "…by Garth" / "Brooks".
      const next = (top.slice(i + 1, i + 3).find(x => x.trim()) || '').trim().replace(/\s+/g, ' '); // may follow a blank line
      const continues = /^[A-Za-z][A-Za-z&'.\- ]{1,40}$/.test(next) && next.split(' ').length <= 4 &&
        !/^(description|difficulty|tuning|key|capo|author|chords|strumming|intro)\b/i.test(next);
      if (artist.length <= 2) artist = continues ? next : artist;
      else if (continues) artist += ' ' + next;
    }
    const k = l.trim().match(/^Key:\s*([A-G][#b]?m?)\b/i);
    if (k && !key) key = k[1];
    const c = l.trim().match(/^Capo:\s*(.+)$/i);
    if (c && !capo) capo = c[1].replace(/\s*fret.*$/i, '');
  });

  // UG puts chord diagrams / strumming patterns before the song; the song starts at the first [Section].
  let start = lines.findIndex(l => /^\s*\[[^\]]+\]\s*$/.test(l));
  if (start < 0) start = 0;
  const body = groupTabs(lines.slice(start)).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const head = [`{title: ${title || fallbackTitle || 'Untitled'}}`];
  if (artist) head.push(`{artist: ${artist}}`);
  if (key) head.push(`{key: ${key}}`);
  if (capo) head.push(`{capo: ${capo}}`);
  head.push('# Imported from PDF — check chords against the original.');
  return head.join('\n') + '\n\n' + tidySpacing(plainToChordPro(body));
}

// Once chords are inline, runs of spaces in lyric lines are just OCR/layout noise.
function tidySpacing(cp) {
  let inTab = false;
  return cp.split('\n').map(l => {
    if (/^\{\s*(start_of_tab|sot)\b/i.test(l)) inTab = true;
    if (/^\{\s*(end_of_tab|eot)\b/i.test(l)) inTab = false;
    if (inTab || /^\s*[{#]/.test(l) || !/\[[^\]]+\]/.test(l)) return l;
    return l.trim().replace(/ {2,}/g, ' ');
  }).join('\n');
}

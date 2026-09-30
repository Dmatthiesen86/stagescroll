import * as store from './store.js';
import { parseChordPro, plainToChordPro, transposeChord, keyPrefersFlats, isChord } from './chordpro.js';
import { VoiceFollower } from './follow.js';
import { TimelinePlayer, Clock, parseAt, formatAt } from './timeline.js';
import { chartBars, parseLyrics, buildMerged } from './lyricsync.js';
import { songChords, capoOptions, difficultyLabel, friendly } from './capo.js';

const app = document.getElementById('app');
const S = store.settings;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const go = hash => { location.hash = hash; };
let cleanup = null;

function toast(msg, ms = 2200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- routing
function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [a, b, c, d] = parts;
  if (a === 'song' && b) return viewEditor(b === 'new' ? null : b);
  if (a === 'sync' && b) return viewSync(b);
  if (a === 'sets' && b) return viewSetlist(b);
  if (a === 'sets') return viewSetlists();
  if (a === 'play' && b === 'song' && c) return viewPerform([c], 0, null);
  if (a === 'play' && b === 'set' && c) {
    const set = store.getSetlist(c);
    if (!set) return go('#/sets');
    return viewPerform(set.songIds, +(d || 0), set);
  }
  return viewLibrary();
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- sheet rendering
export function renderSheet(parsed, { transpose = 0, flats = false } = {}) {
  const out = [];
  let w = 0, li = 0;
  // Untransposed chords keep the sheet's own spelling (D♯ stays D♯); transposed ones with no key
  // to go by get guitar-friendly names (B♭ rather than A♯).
  const tc = ch => (!isChord(ch) || !transpose ? ch : flats === null ? friendly(transposeChord(ch, transpose, false)) : transposeChord(ch, transpose, flats));

  for (const it of parsed.items) {
    if (it.type === 'section') { out.push(`<div class="sec sec-${esc(it.kind)}">${esc(it.label)}</div>`); continue; }
    if (it.type === 'comment') { out.push(`<div class="cmt">${esc(it.text)}</div>`); continue; }
    if (it.type === 'tab') { out.push(`<pre class="tab">${esc(it.text) || ' '}</pre>`); continue; }
    if (it.type === 'blank') { out.push('<div class="gap"></div>'); continue; }

    const hasCh = it.segs.some(s => s.chord);
    const cls = `${it.section ? ` in-${esc(it.section)}` : ''}`;
    // Chord-only lines ("| [Am] | % | [G] |" or "[C] [Cmaj7] [F]") render as a chart, not over empty lyrics.
    // (A row can be just "| % |" — the previous chord carried on — with no chord name in it.)
    if ((hasCh || it.segs.some(s => s.text.includes('|'))) && it.segs.every(s => /^[\s|%]*$/.test(s.text))) {
      out.push(renderChart(it.segs, tc, cls, li++));
      continue;
    }
    let html = '', prevSpace = true;
    for (const seg of it.segs) {
      const toks = seg.text.match(/\S+\s*|\s+/g) || [''];
      toks.forEach((tok, k) => {
        const chord = k === 0 && seg.chord ? tc(seg.chord) : '';
        const [, word, sp] = tok.match(/^(\S*)(\s*)$/);
        let inner = '';
        if (word) {
          if (prevSpace) w++;
          inner += `<span class="w" data-w="${w - 1}">${esc(word)}</span>`;
        }
        if (sp) inner += sp;
        if (word || sp) prevSpace = !!sp;
        html += `<span class="seg">${hasCh ? `<span class="ch">${esc(chord)}</span>` : ''}<span class="ly">${inner || '&nbsp;'}</span></span>`;
      });
    }
    out.push(`<div class="line${hasCh ? ' has-ch' : ''}${cls}" data-l="${li++}">${html}</div>`);
  }
  return out.join('');
}

function renderChart(segs, tc, cls, li) {
  const chordHtml = c => `<span class="ch-in">${esc(tc(c))}</span>`;
  if (!segs.some(s => s.text.includes('|'))) {
    return `<div class="line chart${cls}" data-l="${li}">${segs.map(s => s.chord ? chordHtml(s.chord) : '').join('')}</div>`;
  }
  // Bar chart: one equal-width cell per bar so columns line up from row to row.
  const cells = [];
  let cell = null;
  const add = html => { (cell ||= []).push(html); };
  for (const s of segs) {
    if (s.chord) add(chordHtml(s.chord));
    for (const ch of s.text) {
      if (ch === '|') { if (cell) cells.push(cell); cell = []; }
      else if (ch === '%') add('<span class="rep" title="Same chord as the bar before">%</span>');
    }
  }
  if (cell && cell.length) cells.push(cell);
  const cols = Math.max(4, cells.length);
  return `<div class="line chart bars${cls}" data-l="${li}" style="--cols:${cols}">${
    cells.map(c => `<span class="cell">${c.join('')}</span>`).join('')}</div>`;
}

// ---------------------------------------------------------------- shell / backup
function shell(active, inner) {
  app.innerHTML = `
    <header class="top">
      <a class="brand" href="#/">Stage<span>Scroll</span></a>
      <nav>
        <a href="#/" class="${active === 'songs' ? 'on' : ''}">Songs</a>
        <a href="#/sets" class="${active === 'sets' ? 'on' : ''}">Setlists</a>
      </nav>
      <div class="spacer"></div>
      <button class="btn ghost" id="exportBtn" title="Download a backup of all songs and setlists">Export</button>
      <label class="btn ghost" title="Import Ultimate Guitar PDFs, song files (.cho, .chordpro, .txt) or a backup (.json)">Import
        <input type="file" id="importFile" multiple accept=".pdf,application/pdf,.json,.cho,.chopro,.chordpro,.crd,.pro,.txt" hidden>
      </label>
    </header>
    <main class="page">${inner}</main>`;
  app.querySelector('#exportBtn').onclick = exportBackup;
  app.querySelector('#importFile').onchange = e => importFiles(e.target.files);
}

function exportBackup() {
  const blob = new Blob([store.exportData()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `stagescroll-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importFiles(files) {
  let songs = 0, sets = 0, lastSong = null, pdfs = 0;
  const errors = [];
  const status = busy('Importing…');
  try {
    for (const f of files) {
      try {
        if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
          const { pdfToChordPro } = await import('./pdfimport.js');
          const cp = await pdfToChordPro(f, msg => status(`${f.name}: ${msg}`));
          lastSong = store.upsertSong({ chordpro: cp });
          songs++; pdfs++;
          continue;
        }
        const text = await f.text();
        if (/\.json$/i.test(f.name)) {
          const r = store.importData(text);
          songs += r.songs; sets += r.setlists;
        } else {
          lastSong = store.upsertSong({ chordpro: store.toChordPro(text, f.name.replace(/\.[^.]+$/, '')) });
          songs++;
        }
      } catch (e) { errors.push(`${f.name}: ${e.message}`); }
    }
  } finally { status.done(); }
  toast(`Imported ${songs} song${songs === 1 ? '' : 's'}${sets ? ` and ${sets} setlist${sets === 1 ? '' : 's'}` : ''}`);
  if (errors.length) alert('Some files failed:\n' + errors.join('\n'));
  // A single PDF goes straight to the editor so OCR mistakes can be fixed before a gig.
  if (pdfs === 1 && files.length === 1 && lastSong) go(`#/song/${lastSong.id}`);
  else route();
}

// Blocking progress overlay for slow work (PDF text recognition).
function busy(msg) {
  const el = document.createElement('div');
  el.className = 'busy';
  el.innerHTML = '<div class="busy-card"><div class="spinner"></div><div class="busy-msg"></div></div>';
  const text = el.querySelector('.busy-msg');
  text.textContent = msg;
  document.body.appendChild(el);
  const update = m => { text.textContent = m; };
  update.done = () => el.remove();
  return update;
}

// ---------------------------------------------------------------- library
function viewLibrary() {
  shell('songs', `
    <div class="toolbar">
      <input id="q" class="input" type="search" placeholder="Search songs or artists…" autocomplete="off">
      <a class="btn primary" href="#/song/new">+ New song</a>
    </div>
    <ul class="list" id="songList"></ul>`);
  const q = app.querySelector('#q'), ul = app.querySelector('#songList');
  const sets = store.setlists();

  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const list = store.songs().filter(s => `${s.title} ${s.artist}`.toLowerCase().includes(term));
    ul.innerHTML = list.length ? list.map(s => `
      <li class="row">
        <a class="grow" href="#/play/song/${s.id}">
          <div class="t">${esc(s.title)}</div>
          <div class="sub">${esc(s.artist) || '&nbsp;'}${s.key ? ` · Key ${esc(s.key)}` : ''}</div>
        </a>
        ${sets.length ? `<select class="input sm" data-add="${s.id}" aria-label="Add to setlist">
          <option value="">+ Setlist</option>${sets.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}
        </select>` : ''}
        <a class="btn" href="#/song/${s.id}">Edit</a>
        <a class="btn primary" href="#/play/song/${s.id}">Play</a>
      </li>`).join('')
      : `<li class="empty">${term ? 'No matches.' : 'No songs yet. Add one, or import ChordPro / text files.'}</li>`;
  };

  ul.addEventListener('change', e => {
    const songId = e.target.dataset.add, setId = e.target.value;
    if (!songId || !setId) return;
    const set = store.getSetlist(setId);
    if (set.songIds.includes(songId)) toast(`Already in ${set.name}`);
    else { store.upsertSetlist({ id: set.id, songIds: [...set.songIds, songId] }); toast(`Added to ${set.name}`); }
    e.target.value = '';
  });
  q.oninput = draw;
  draw();
}

// ---------------------------------------------------------------- setlists
function viewSetlists() {
  const sets = store.setlists();
  shell('sets', `
    <div class="toolbar"><h2 class="grow">Setlists</h2><button class="btn primary" id="newSet">+ New setlist</button></div>
    <ul class="list">${sets.length ? sets.map(s => `
      <li class="row">
        <a class="grow" href="#/sets/${s.id}"><div class="t">${esc(s.name)}</div>
          <div class="sub">${s.songIds.length} song${s.songIds.length === 1 ? '' : 's'}</div></a>
        <a class="btn" href="#/sets/${s.id}">Edit</a>
        <a class="btn primary" href="#/play/set/${s.id}/0">Play</a>
      </li>`).join('') : '<li class="empty">No setlists yet.</li>'}
    </ul>`);
  app.querySelector('#newSet').onclick = () => {
    const name = prompt('Setlist name', 'Gig ' + new Date().toLocaleDateString());
    if (name) go(`#/sets/${store.upsertSetlist({ name: name.trim() || 'New Setlist' }).id}`);
  };
}

function viewSetlist(id) {
  let set = store.getSetlist(id);
  if (!set) return go('#/sets');
  shell('sets', `
    <div class="toolbar">
      <input id="name" class="input" value="${esc(set.name)}" aria-label="Setlist name">
      <a class="btn primary" id="playSet">▶ Play set</a>
      <button class="btn danger" id="delSet">Delete</button>
    </div>
    <div class="cols">
      <section><h3 id="setHead"></h3><ol class="list" id="setSongs"></ol></section>
      <section><h3>Add songs</h3>
        <input id="q" class="input full" type="search" placeholder="Search library…" autocomplete="off">
        <ul class="list" id="pool"></ul></section>
    </div>`);
  const $ = sel => app.querySelector(sel);

  const draw = () => {
    set = store.getSetlist(id);
    const songs = set.songIds.map(store.getSong).filter(Boolean);
    $('#setHead').textContent = `In this set (${songs.length})`;
    $('#playSet').href = `#/play/set/${id}/0`;
    $('#setSongs').innerHTML = songs.length ? songs.map((s, i) => `
      <li class="row" data-id="${s.id}">
        <span class="grip" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>
        <span class="num">${i + 1}</span>
        <a class="grow" href="#/play/set/${id}/${i}"><div class="t">${esc(s.title)}</div><div class="sub">${esc(s.artist)}</div></a>
        <button class="btn icon danger" data-act="rm" data-i="${i}" aria-label="Remove">✕</button>
      </li>`).join('') : '<li class="empty">Add songs from the right.</li>';
    const term = $('#q').value.trim().toLowerCase();
    const pool = store.songs().filter(s => `${s.title} ${s.artist}`.toLowerCase().includes(term));
    $('#pool').innerHTML = pool.map(s => `
      <li class="row"><div class="grow"><div class="t">${esc(s.title)}</div><div class="sub">${esc(s.artist)}</div></div>
        <button class="btn" data-act="add" data-id="${s.id}">${set.songIds.includes(s.id) ? '✓ Added' : '+ Add'}</button></li>`).join('')
      || '<li class="empty">No songs match.</li>';
  };

  app.querySelector('.cols').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const ids = [...set.songIds], i = +b.dataset.i;
    if (b.dataset.act === 'rm') ids.splice(i, 1);
    if (b.dataset.act === 'add') {
      if (ids.includes(b.dataset.id)) return;
      ids.push(b.dataset.id);
    }
    store.upsertSetlist({ id, songIds: ids });
    draw();
  });
  // Drag a song by its grip to reorder the set (mouse, finger or pen). The row follows the pointer and
  // the others make room; the page scrolls when you drag near the top or bottom edge.
  const list = $('#setSongs');
  let drag = null;
  const edgeScroll = () => {
    if (!drag) return;
    const y = drag.y, band = 70;
    const speed = y < band ? -(band - y) / 4 : y > innerHeight - band ? (y - (innerHeight - band)) / 4 : 0;
    if (speed) { scrollBy(0, speed); move(drag.y); }
    drag.raf = requestAnimationFrame(edgeScroll);
  };
  // All positions in page coordinates, so auto-scrolling doesn't pull the row away from the finger.
  const move = y => {
    drag.y = y;
    const { row } = drag;
    const py = y + scrollY;
    const naturalTop = () => row.getBoundingClientRect().top + scrollY - (parseFloat(row.style.getPropertyValue('--dy')) || 0);
    const centre = py - drag.grab + row.offsetHeight / 2;   // where the dragged row's centre is now
    const others = [...list.children].filter(el => el !== row);
    const before = others.find(el => { const r = el.getBoundingClientRect(); return centre < r.top + scrollY + r.height / 2; });
    const oldTop = naturalTop();
    if (before ? row.nextElementSibling !== before : list.lastElementChild !== row) list.insertBefore(row, before || null);
    drag.startY += naturalTop() - oldTop;                   // keep the row under the finger after it moves
    row.style.setProperty('--dy', `${py - drag.startY}px`);
  };
  list.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.grip');
    if (!grip || drag) return;
    e.preventDefault();
    const row = grip.closest('.row');
    grip.setPointerCapture(e.pointerId);
    drag = { row, grip, pointer: e.pointerId, startY: e.clientY + scrollY, y: e.clientY, grab: e.clientY - row.getBoundingClientRect().top };
    row.classList.add('dragging');
    list.classList.add('reordering');
    drag.raf = requestAnimationFrame(edgeScroll);
  });
  list.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.pointer) move(e.clientY); });
  const drop = e => {
    if (!drag || e.pointerId !== drag.pointer) return;
    cancelAnimationFrame(drag.raf);
    drag.row.classList.remove('dragging');
    drag.row.style.removeProperty('--dy');
    list.classList.remove('reordering');
    drag = null;
    const order = [...list.querySelectorAll('.row[data-id]')].map(el => el.dataset.id);
    if (order.join() !== set.songIds.filter(x => order.includes(x)).join()) {
      store.upsertSetlist({ id, songIds: [...order, ...set.songIds.filter(x => !order.includes(x))] });
    }
    draw();
  };
  list.addEventListener('pointerup', drop);
  list.addEventListener('pointercancel', drop);

  $('#name').onchange = e => store.upsertSetlist({ id, name: e.target.value.trim() || 'Untitled set' });
  $('#q').oninput = draw;
  $('#delSet').onclick = () => { if (confirm(`Delete setlist "${set.name}"? Songs stay in your library.`)) { store.deleteSetlist(id); go('#/sets'); } };
  draw();
}

// ---------------------------------------------------------------- editor
const NEW_SONG = `{title: New Song}
{artist: }
{key: G}
{duration: 3:00}

{start_of_verse: Verse 1}
[G]Put chords in [C]square brackets [D]right before the [G]syllable
{end_of_verse}

{start_of_chorus}
[C]Or paste a song with chords [G]above the lyrics
and press "Convert chords-over-lyrics"
{end_of_chorus}
`;

function viewEditor(id) {
  const song = id ? store.getSong(id) : null;
  if (id && !song) return go('#/');
  shell('songs', `
    <div class="toolbar">
      <h2 class="grow">${song ? 'Edit song' : 'New song'}</h2>
      <button class="btn" id="convert" title="Turn Ultimate-Guitar style chords-above-lyrics into ChordPro">Convert chords-over-lyrics</button>
      ${song && (song.sourceChart || /\|\s*\[/.test(song.chordpro)) ? `<a class="btn" href="#/sync/${song.id}" title="Paste lyrics and tap along to line them up with the bars">Add lyrics (tap along)</a>` : ''}
      ${song ? '<button class="btn danger" id="del">Delete</button>' : ''}
      <button class="btn" id="savePlay">Save &amp; play</button>
      <button class="btn primary" id="save">Save</button>
    </div>
    <div class="editor">
      <textarea id="src" spellcheck="false" aria-label="Song in ChordPro format">${esc(song ? song.chordpro : NEW_SONG)}</textarea>
      <div class="preview sheet" id="preview"></div>
    </div>
    <details class="help"><summary>ChordPro cheat sheet</summary>
      <pre>{title: Song name}        {artist: Who}       {key: G}    {capo: 2}
{duration: 3:30}          ← sets the default auto-scroll speed
{start_of_verse: Verse 1} … {end_of_verse}
{start_of_chorus} … {end_of_chorus}      {chorus}  ← "repeat chorus" marker
{start_of_bridge} … {end_of_bridge}
{start_of_tab} … {end_of_tab}            ← monospace tab block
{comment: Let ring}       # a line starting with # is hidden
A[G]mazing [G7]grace      ← chord goes right before the syllable</pre>
    </details>`);
  const src = app.querySelector('#src'), preview = app.querySelector('#preview');
  let dirty = false, timer;
  const draw = () => { preview.innerHTML = renderSheet(parseChordPro(src.value)); };
  src.oninput = () => { dirty = true; clearTimeout(timer); timer = setTimeout(draw, 150); };
  draw();

  const save = () => {
    const s = store.upsertSong({ id: song?.id, chordpro: src.value });
    dirty = false;
    toast('Saved');
    return s;
  };
  app.querySelector('#convert').onclick = () => { src.value = plainToChordPro(src.value); dirty = true; draw(); };
  app.querySelector('#save').onclick = () => { const s = save(); if (!song) history.replaceState(null, '', `#/song/${s.id}`), route(); };
  app.querySelector('#savePlay').onclick = () => { const s = save(); go(`#/play/song/${s.id}`); };
  app.querySelector('#del')?.addEventListener('click', () => {
    if (confirm(`Delete "${song.title}"? This also removes it from setlists.`)) { store.deleteSong(song.id); dirty = false; go('#/'); }
  });
  const beforeUnload = e => { if (dirty) e.preventDefault(); };
  window.addEventListener('beforeunload', beforeUnload);
  cleanup = () => window.removeEventListener('beforeunload', beforeUnload);
}

// ---------------------------------------------------------------- lyrics tap-along sync
function viewSync(id) {
  const song = store.getSong(id);
  if (!song) return go('#/');
  const chartText = song.sourceChart || song.chordpro;
  const chart = parseChordPro(chartText);
  const bars = chartBars(chart);
  if (!bars.length) { toast('This song has no bar chart to sync lyrics to.'); return go(`#/song/${id}`); }
  const bpb = +(String(chart.meta.time || '').match(/^(\d+)\s*\//) || [])[1] || 4;
  let bpm = song.bpm || +chart.meta.tempo || 100;
  let sections = [], taps = [];
  // Word timing from an auto-sync (karaoke file), kept in step with taps when the timing is shifted.
  let words = null, wordsAt = 0;
  let lyricsText = song.lyricsText || '';
  const clock = new Clock();
  let raf = 0;
  let onKey = () => {};
  const offKey = () => document.removeEventListener('keydown', onKey);
  cleanup = () => { cancelAnimationFrame(raf); clock.dispose(); offKey(); delete window.__stagescroll; };

  // Step 1: paste lyrics
  function paste() {
    cancelAnimationFrame(raf); clock.stop(); offKey();
    shell('songs', `
      <div class="toolbar"><h2 class="grow">Add lyrics — ${esc(song.title)}</h2>
        <a class="btn" href="#/play/song/${id}">Cancel</a></div>
      <p class="sub wrap">Paste the lyrics the way you sing them: one sung line per line, and a blank line between
        sections. Labels like <b>[Chorus]</b> are optional. If a chorus is sung three times, paste it three times.
        Next you'll tap along as each line starts. ${bars.length} bars at ${bpm} bpm.</p>
      <textarea id="lyr" class="lyrics-input" spellcheck="false" placeholder="[Verse 1]&#10;First line you sing&#10;Second line&#10;&#10;[Chorus]&#10;…">${esc(lyricsText)}</textarea>
      <div class="toolbar"><span class="sub grow" id="lcount"></span>
        <button class="btn primary" id="go">Start tap-along →</button></div>`);
    const ta = app.querySelector('#lyr'), countEl = app.querySelector('#lcount');
    const upd = () => {
      const s = parseLyrics(ta.value);
      const n = s.reduce((k, x) => k + x.lines.length, 0);
      countEl.textContent = n ? `${n} lines in ${s.length} section${s.length === 1 ? '' : 's'}: ${s.map(x => x.label).join(', ')}` : '';
    };
    ta.oninput = upd;
    upd();
    app.querySelector('#go').onclick = () => {
      lyricsText = ta.value;
      sections = parseLyrics(lyricsText);
      if (!sections.length) { toast('Paste some lyrics first'); return; }
      store.upsertSong({ id, lyricsText });
      taps = [];
      words = null; // the lyrics may have changed, so stored word timing no longer applies
      tapAlong();
    };
  }

  // Step 2: tap along
  function tapAlong() {
    const lines = sections.flatMap(s => s.lines.map((text, k) => ({ text, label: k === 0 ? s.label : '' })));
    app.innerHTML = `
      <div class="perform sync">
        <header class="pbar">
          <button class="btn ghost icon" id="sBack" title="Back to lyrics (Esc)">←</button>
          <div class="ptitle grow"><div class="t">Tap along — ${esc(song.title)}</div>
            <div class="sub">Tap the screen, Space or your pedal the moment you start singing each line</div></div>
          <div class="grp" title="Tempo while syncing — slow it down if you like; the timing still fits the real tempo">
            <button class="btn icon" id="sSlower">−</button><span class="val" id="sBpm"></span><button class="btn icon" id="sFaster">+</button>
          </div>
          <button class="btn ghost" id="sClick" title="Metronome click while tapping">Click</button>
        </header>
        <div class="sync-body" id="sBody">
          <div class="sync-status"><span class="sub" id="sBar"></span><span class="sync-chord" id="sChord"></span>
            <span class="beats" id="sBeats">${'<i></i>'.repeat(bpb)}</span></div>
          <div class="sync-lines">
            <div class="s-prev" id="sPrev"></div>
            <div class="s-label" id="sLabel"></div>
            <div class="s-next" id="sNext"></div>
            <div class="s-after" id="sAfter"></div>
          </div>
          <div class="sub" id="sProg"></div>
        </div>
        <div class="countin" id="countin" hidden></div>
        <footer class="pctl">
          <button class="btn" id="sUndo" title="Undo last tap and rewind (← / Backspace)">↶ Undo</button>
          <button class="btn primary big tapbtn" id="sTap">▶ Count in</button>
          <button class="btn" id="sDone" title="Build the song from your taps">Finish</button>
        </footer>
      </div>`;
    const $ = sel => app.querySelector(sel);
    const countEl = $('#countin');
    let shownCount = 0;

    const draw = () => {
      const i = taps.length;
      $('#sPrev').textContent = lines[i - 1]?.text || '';
      $('#sLabel').textContent = lines[i]?.label || '';
      $('#sNext').textContent = lines[i]?.text || 'All lines tapped — press Finish';
      $('#sAfter').textContent = lines[i + 1]?.text || '';
      $('#sProg').textContent = `Line ${Math.min(i + 1, lines.length)} of ${lines.length}`;
      $('#sBpm').textContent = `${bpm} bpm`;
      $('#sClick').classList.toggle('on', S.syncClick !== false);
      $('#sTap').textContent = clock.running ? 'TAP' : taps.length ? '▶ Continue' : '▶ Count in';
      $('#sDone').classList.toggle('primary', i >= lines.length);
    };

    const startFrom = beat => {
      clock.start(beat, bpm, bpb, { metronome: S.syncClick !== false });
      draw();
    };
    const tap = () => {
      if (!clock.running) { startFrom(taps.length ? Math.floor(taps[taps.length - 1] / bpb) * bpb : 0); return; }
      if (clock.countIn() || taps.length >= lines.length) return;
      const b = Math.max(0, Math.round(clock.beat() * 2) / 2); // nearest half beat
      if (taps.length && b <= taps[taps.length - 1]) return;
      taps.push(b);
      draw();
    };
    const undo = () => {
      if (!taps.length) return;
      taps.pop();
      // Rewind to the bar of the previous line so the next one can be tapped again.
      startFrom(taps.length ? Math.floor(taps[taps.length - 1] / bpb) * bpb : 0);
    };
    const finish = () => {
      clock.stop();
      if (!taps.length) { toast('Tap at least one line first'); draw(); return; }
      review();
    };

    $('#sBody').addEventListener('pointerdown', e => { e.preventDefault(); tap(); });
    $('#sTap').addEventListener('pointerdown', e => { e.preventDefault(); tap(); });
    $('#sUndo').onclick = undo;
    $('#sDone').onclick = finish;
    $('#sBack').onclick = paste;
    $('#sSlower').onclick = () => { bpm = clamp(bpm - 4, 30, 300); clock.setBpm(bpm); draw(); };
    $('#sFaster').onclick = () => { bpm = clamp(bpm + 4, 30, 300); clock.setBpm(bpm); draw(); };
    $('#sClick').onclick = () => { S.syncClick = S.syncClick === false; store.save(); clock.metronome = S.syncClick !== false; draw(); };

    offKey();
    onKey = e => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if ([' ', 'Enter', 'ArrowDown', 'ArrowRight', 'PageDown'].includes(e.key)) { e.preventDefault(); e.target.blur?.(); tap(); }
      else if (['Backspace', 'ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); undo(); }
      else if (e.key === 'Escape') paste();
    };
    document.addEventListener('keydown', onKey);

    const frame = now => {
      if (!clock.running) return;
      clock.schedule(now);
      const n = clock.countIn(now);
      if (n !== shownCount) {
        shownCount = n;
        countEl.hidden = !n;
        if (n) { countEl.textContent = n; countEl.classList.remove('pop'); void countEl.offsetWidth; countEl.classList.add('pop'); }
        draw();
      }
      const beat = clock.beat(now);
      if (beat >= bars.length * bpb) { clock.stop(); draw(); toast('End of the song — press Finish'); return; }
      if (n) return;
      const bar = Math.floor(beat / bpb);
      const chords = bars[bar].chords;
      const within = (beat - bar * bpb) / bpb;
      $('#sBar').textContent = `Bar ${bar + 1} / ${bars.length}`;
      $('#sChord').textContent = chords[Math.min(chords.length - 1, Math.floor(within * chords.length))] || '';
      const bi = Math.floor(beat - bar * bpb);
      $('#sBeats').querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k === bi));
    };
    const loop = now => { frame(now); raf = requestAnimationFrame(loop); };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    window.__stagescroll = { clock, tap, undo, finish, frame }; // testing hook
    draw();
  }

  // Stored word timing moved by however far the lines have been shifted since it was saved.
  const shiftedWords = () => {
    if (!words || !taps.length) return null;
    const d = taps[0] - wordsAt;
    return d ? words.map(ws => ws && ws.map(w => w && [w[0] + d, w[1] + d])) : words;
  };

  // Step 3: review, shift the timing if needed, and save
  function review(adjusting = false) {
    cancelAnimationFrame(raf); offKey();
    const total = sections.reduce((k, x) => k + x.lines.length, 0);
    const build = () => buildMerged({
      meta: { ...chart.meta, title: song.title, artist: song.artist, tempo: +chart.meta.tempo || bpm },
      bars, bpb, sections, taps,
      notes: chart.items.filter(i => i.type === 'comment').map(i => i.text), // e.g. Chordify's transposition note
      wordBeats: shiftedWords(),
    });
    let merged = build();
    shell('songs', `
      <div class="toolbar"><h2 class="grow">${adjusting ? 'Adjust timing' : 'Review'} — ${esc(song.title)}</h2>
        ${adjusting ? '<button class="btn" id="edit">Edit lyrics</button>' : ''}
        <button class="btn" id="again">↶ ${adjusting ? 'Tap along instead' : 'Tap again'}</button>
        <button class="btn primary" id="save">Save</button></div>
      ${taps.length < total ? `<p class="warn">Only ${taps.length} of ${total} lines have timing — the rest are left out. Tap again to include them.</p>` : ''}
      <div class="shift">
        <span class="sub">If the chords sit on the wrong words, move all the lyrics:</span>
        <button class="btn" data-shift="${-bpb}">−1 bar</button>
        <button class="btn" data-shift="-0.5">−½ beat</button>
        <button class="btn" data-shift="0.5">+½ beat</button>
        <button class="btn" data-shift="${bpb}">+1 bar</button>
        <span class="sub" id="firstAt"></span>
      </div>
      <div class="preview sheet review" id="prev"></div>`);
    const draw = () => {
      merged = build();
      app.querySelector('#prev').innerHTML = renderSheet(parseChordPro(merged));
      app.querySelector('#firstAt').textContent = `First line: bar ${formatAt(taps[0], bpb).replace(':', ', beat ')}`;
      app.querySelectorAll('[data-shift]').forEach(b => { b.disabled = taps[0] + +b.dataset.shift < 0; });
    };
    draw();
    app.querySelector('.shift').addEventListener('click', e => {
      const b = e.target.closest('[data-shift]');
      if (!b) return;
      taps = taps.map(t => t + +b.dataset.shift);
      draw();
    });
    app.querySelector('#again').onclick = () => { taps = []; words = null; tapAlong(); };
    app.querySelector('#edit')?.addEventListener('click', paste);
    app.querySelector('#save').onclick = () => {
      store.upsertSong({ id, chordpro: merged, sourceChart: song.sourceChart || song.chordpro, lyricsText, syncTaps: taps, syncWords: shiftedWords() });
      toast('Saved — press Count in to play along');
      go(`#/play/song/${id}`);
    };
  }

  // A song that's already synced opens on the timing adjuster; otherwise start by pasting lyrics.
  if (song.syncTaps?.length && song.sourceChart && lyricsText) {
    sections = parseLyrics(lyricsText);
    taps = song.syncTaps.slice();
    if (song.syncWords) { words = song.syncWords; wordsAt = taps[0]; }
    review(true);
  } else paste();
}

// ---------------------------------------------------------------- perform
function viewPerform(songIds, startIdx, set) {
  const ids = songIds.filter(id => store.getSong(id));
  if (!ids.length) { toast('Nothing to play'); return go(set ? `#/sets/${set.id}` : '#/'); }

  app.innerHTML = `
    <div class="perform">
      <header class="pbar">
        <button class="btn ghost icon" data-a="exit" title="Back (Esc)">←</button>
        <div class="ptitle grow"><div class="t" id="pTitle"></div><div class="sub" id="pSub"></div></div>
        <span class="pos" id="pPos"></span>
        <button class="btn ghost" id="syncBtn" data-a="sync" title="Add or re-sync lyrics by tapping along" hidden>Lyrics</button>
        <button class="btn ghost icon" data-a="fs" title="Fullscreen">⛶</button>
      </header>
      <div class="stage" id="stage"><div class="sheet" id="sheet"></div></div>
      <div class="countin" id="countin" hidden></div>
      <div class="capo-panel" id="capoPanel" hidden></div>
      <div class="heard" id="heard" hidden></div>
      <footer class="pctl">
        <div class="grp">
          <button class="btn icon" data-a="prev" title="Previous song (P)">⏮</button>
          <button class="btn primary play" data-a="play" id="playBtn" title="Start / stop scrolling (Space)">▶ Scroll</button>
          <button class="btn icon" data-a="next" title="Next song (N)">⏭</button>
        </div>
        <div class="grp" id="speedGrp" title="Scroll speed (− / +)">
          <button class="btn icon" data-a="slower">−</button>
          <span class="val" id="speedVal"></span>
          <button class="btn icon" data-a="faster">+</button>
        </div>
        <div class="grp">
          <button class="btn" data-a="voice" id="voiceBtn" title="Follow my voice (V)"><span class="dot" id="voiceDot"></span> Voice follow</button>
          <button class="btn icon ghost" data-a="heard" id="heardBtn" title="Show what the mic hears">👂</button>
        </div>
        <div class="grp">
          <button class="btn icon" data-a="smaller" title="Smaller text">A−</button>
          <button class="btn icon" data-a="bigger" title="Bigger text">A+</button>
          <button class="btn" data-a="chords" id="chordsBtn" title="Show / hide chords">Chords</button>
          <button class="btn icon" data-a="down" title="Transpose down">♭</button>
          <span class="val" id="trVal" title="Transpose"></span>
          <button class="btn icon" data-a="up" title="Transpose up">♯</button>
          <button class="btn" data-a="capo" id="capoBtn" title="Capo: pick a fret and see the shapes to play there">Capo</button>
        </div>
      </footer>
    </div>`;

  const $ = sel => app.querySelector(sel);
  const stage = $('#stage'), sheet = $('#sheet'), heardEl = $('#heard');
  let idx = clamp(startIdx, 0, ids.length - 1);
  let song, parsed, lineEls = [], words = [], activeLine = -1;
  let playing = false, voiceOn = false, voiceRate = 1;
  let timed = false, units = [];
  let pos = null, target = null, syncAfterTarget = false, raf = 0, last = 0, manualTimer = 0;

  const follower = new VoiceFollower({
    onMatch: j => onMatch(j),
    onHeard: text => { heardEl.textContent = text ? `🎤 ${text}` : ''; },
    onState: (state, info) => {
      $('#voiceDot').className = `dot ${state}`;
      $('#voiceBtn').title = state === 'listening' ? `Listening (${info} recognition)` : 'Follow my voice (V)';
      if (state === 'error') { toast(info, 4000); if (!follower.active) setVoice(false); }
    },
  });
  window.__stagescroll = { hear: text => follower.feed(text) }; // testing hook: simulate singing

  // Timed playback: chord charts (e.g. Chordify imports) and songs synced by tap-along.
  // Count in, then bars and lyric lines light up in tempo.
  const countEl = $('#countin');
  const player = new TimelinePlayer({
    onCount: n => {
      countEl.hidden = !n;
      if (n) { countEl.textContent = n; countEl.classList.remove('pop'); void countEl.offsetWidth; countEl.classList.add('pop'); }
    },
    onUnit: (unit, beat) => {
      const bars = Math.ceil(units[units.length - 1].end / beatsPerBar());
      $('#pPos').textContent = `Bar ${Math.floor(beat / beatsPerBar()) + 1} / ${bars}`;
      const row = unit.el.closest('.line');
      const desired = clamp(row.offsetTop - stage.clientHeight * 0.3, 0, stage.scrollHeight - stage.clientHeight);
      if (Math.abs(desired - stage.scrollTop) > row.offsetHeight * 0.5) { target = desired; syncAfterTarget = false; }
    },
    onEnd: () => { updateControls(); showPos(); },
  });
  window.__stagescroll.player = player; // testing hook
  const bpm = () => song.bpm || +parsed.meta.tempo || 100;
  const beatsPerBar = () => +(String(parsed.meta.time || '').match(/^(\d+)\s*\//) || [])[1] || 4;
  const showPos = () => { $('#pPos').textContent = ids.length > 1 ? `${idx + 1} / ${ids.length}` : ''; };
  function toggleTimed(fromUnit) {
    if (player.running && fromUnit === undefined) { player.stop(); showPos(); }
    else player.start(fromUnit ?? player.resumeIndex(), bpm());
    updateControls();
  }

  // Units in beat order. Songs with {x_at} markers use them; a plain chart plays bar after bar.
  function buildUnits() {
    const bpb = beatsPerBar();
    const lineItems = parsed.items.filter(i => i.type === 'line');
    const list = [];
    if (lineItems.some(i => i.at)) {
      lineItems.forEach((it, li) => {
        const start = it.at ? parseAt(it.at, bpb) : null;
        if (start === null) return;
        const el = lineEls[li];
        const cs = [...el.querySelectorAll('.cell')];
        if (cs.length) cs.forEach((c, k) => list.push({ el: c, kind: 'cell', start: start + k * bpb, end: start + (k + 1) * bpb }));
        else {
          const groups = [];
          el.querySelectorAll('.w').forEach(w => {
            const g = (groups[+w.dataset.w] ||= { els: [], len: 0 });
            g.els.push(w);
            g.len += w.textContent.length + 1;
          });
          list.push({ el, kind: 'line', start, end: null, words: groups.filter(Boolean) });
        }
      });
      list.sort((a, b) => a.start - b.start);
      list.forEach((u, i) => { if (u.end === null) u.end = list[i + 1]?.start ?? u.start + 2 * bpb; });
    } else if (!words.length) {
      sheet.querySelectorAll('.bars .cell').forEach((c, i) => list.push({ el: c, kind: 'cell', start: i * bpb, end: (i + 1) * bpb }));
    }
    return list;
  }

  // ---- song loading & drawing
  function loadSong(i) {
    idx = i;
    song = store.getSong(ids[idx]);
    parsed = parseChordPro(song.chordpro);
    if (set) history.replaceState(null, '', `#/play/set/${set.id}/${idx}`);
    setPlaying(false);
    player.reset();
    capoPanel.hidden = true;
    voiceRate = 1; target = null;
    drawSheet(false);
    stage.scrollTop = 0; pos = null;
    follower.setCursor(0);
  }

  function drawSheet(keepPlace) {
    const max0 = Math.max(1, stage.scrollHeight - stage.clientHeight);
    const ratio = keepPlace ? stage.scrollTop / max0 : 0;
    const n = song.transpose || 0;
    // The sheet's own {capo} means its chords are already shapes for that fret. Display shift =
    // transpose (changes the sounding key) + sheet capo − chosen capo (changes only the shapes).
    // {key} is the key you hear (UG: "Key: Eb" with capo 3 and C shapes), so the shapes are in key + n − capo.
    const { capo, shift } = capoState();
    const flats = parsed.meta.key ? keyPrefersFlats(parsed.meta.key, n - capo) : null;
    const next = set && idx < ids.length - 1 ? store.getSong(ids[idx + 1]) : null;
    sheet.innerHTML = renderSheet(parsed, { transpose: shift, flats }) + `
      <div class="endcard">${next
        ? `<div class="sub">Up next</div><button class="btn primary big" data-a="next">${esc(next.title)} →</button>`
        : `<div class="sub">${set ? 'End of set' : 'End of song'}</div>`}</div>`;
    sheet.classList.toggle('hide-chords', !S.showChords);
    sheet.style.setProperty('--fs', S.fontScale);

    lineEls = [...sheet.querySelectorAll('.line')];
    words = [];
    sheet.querySelectorAll('.w').forEach(el => {
      const k = +el.dataset.w;
      const g = (words[k] ||= { els: [], text: '', line: +el.closest('.line').dataset.l });
      g.els.push(el);
      g.text += el.textContent;
    });
    follower.setWords(words.map(g => g.text));
    activeLine = -1;
    // Chord charts and tap-synced songs play in tempo instead of scrolling.
    units = buildUnits();
    timed = units.length > 0;
    player.setUnits(units, beatsPerBar());

    const m = parsed.meta;
    $('#pTitle').textContent = song.title;
    $('#pSub').textContent = [song.artist,
      m.key && `Key ${transposeChord(m.key, n, !!keyPrefersFlats(m.key, n))}${n ? ` (${n > 0 ? '+' : ''}${n})` : ''}`,
      capo && `Capo ${capo}`, m.tempo && `${m.tempo} bpm`].filter(Boolean).join(' · ');
    if (!player.running) showPos();
    if (keepPlace) { stage.scrollTop = ratio * Math.max(1, stage.scrollHeight - stage.clientHeight); pos = null; }
    updateControls();
    if (voiceOn) syncCursor();
  }

  // ---- speed: song.speed is px/sec at text scale 1; null means "derive from duration"
  function baseSpeed() {
    if (song.speed) return song.speed;
    const d = parsed.meta.duration;
    const lastLine = lineEls[lineEls.length - 1];
    if (d && lastLine) {
      const travel = lastLine.offsetTop - stage.clientHeight * 0.4;
      return clamp(Math.round(travel / d / S.fontScale), 4, 300);
    }
    return 24;
  }
  const effectiveSpeed = () => baseSpeed() * S.fontScale * (voiceOn && playing ? voiceRate : 1);

  function updateControls() {
    $('#playBtn').textContent = timed ? (player.running ? '⏸ Stop' : '▶ Count in') : playing ? '⏸ Pause' : '▶ Scroll';
    $('#playBtn').title = timed ? 'Count in, then follow the song in tempo (Space). Tap a bar or line to start there.' : 'Start / stop scrolling (Space)';
    $('#speedVal').textContent = timed ? `${bpm()} bpm` : Math.round(baseSpeed());
    $('#speedGrp').title = timed ? 'Tempo (− / +)' : 'Scroll speed (− / +)';
    $('#syncBtn').hidden = !song.sourceChart && !sheet.querySelector('.bars .cell');
    $('#chordsBtn').classList.toggle('on', S.showChords);
    $('#voiceBtn').classList.toggle('on', voiceOn);
    $('#heardBtn').classList.toggle('on', S.showHeard);
    heardEl.hidden = !(voiceOn && S.showHeard);
    const n = song.transpose || 0;
    $('#trVal').textContent = n ? (n > 0 ? `+${n}` : n) : '0';
    const { capo } = capoState();
    $('#capoBtn').textContent = capo ? `Capo ${capo}` : 'Capo';
    $('#capoBtn').classList.toggle('on', capo > 0);
    $('#capoBtn').hidden = !songChords(parsed).size;
  }

  function setPlaying(v) { playing = v; updateControls(); }

  function setVoice(v) {
    voiceOn = v;
    if (v) { syncCursor(); follower.start(S.lang); }
    else {
      follower.stop();
      heardEl.textContent = '';
      lineEls.forEach(el => el.classList.remove('done', 'active'));
      sheet.querySelectorAll('.w.hit').forEach(el => el.classList.remove('hit'));
      activeLine = -1;
    }
    updateControls();
  }

  // ---- karaoke position
  function syncCursor() {
    const y = stage.scrollTop + stage.clientHeight * 0.15;
    const li = lineEls.findIndex(el => el.offsetTop + el.offsetHeight > y);
    const wi = words.findIndex(g => g && g.line >= li);
    follower.setCursor(Math.max(0, wi));
  }

  function onMatch(j) {
    const g = words[j];
    if (!g) return;
    const li = g.line;
    if (li !== activeLine) {
      lineEls.forEach((el, k) => { el.classList.toggle('done', k < li); el.classList.toggle('active', k === li); });
      activeLine = li;
    }
    sheet.querySelectorAll('.w.hit').forEach(el => el.classList.remove('hit'));
    for (let k = j; k >= 0 && words[k]?.line === li; k--) words[k].els.forEach(el => el.classList.add('hit'));

    const el = lineEls[li];
    const desired = clamp(el.offsetTop - stage.clientHeight * 0.3, 0, stage.scrollHeight - stage.clientHeight);
    const err = desired - stage.scrollTop;
    const lh = el.offsetHeight;
    if (playing) {
      if (err < -lh) voiceRate = Math.max(0.4, voiceRate * 0.85);       // we're ahead of the singer
      else if (err > lh * 1.5) voiceRate = Math.min(2.5, voiceRate * 1.12); // we're behind
    }
    if (Math.abs(err) > lh * 0.6) { target = desired; syncAfterTarget = false; }
  }

  // ---- animation loop: steady scroll + eased jumps (voice corrections and paging)
  function tick(t) {
    const dt = last ? Math.min(0.5, (t - last) / 1000) : 0; // real elapsed time, so dropped frames don't slow the scroll
    last = t;
    const max = stage.scrollHeight - stage.clientHeight;
    if (pos === null || Math.abs(stage.scrollTop - pos) > 2) pos = stage.scrollTop;
    player.frame(t);
    if (playing) pos += effectiveSpeed() * dt;
    if (target !== null) {
      const err = target - pos;
      pos += err * Math.min(1, dt * 3);
      if (Math.abs(err) < 1.5) {
        pos = target; target = null;
        if (syncAfterTarget && voiceOn) syncCursor();
      }
    }
    pos = clamp(pos, 0, Math.max(0, max));
    if (Math.abs(stage.scrollTop - pos) >= 0.5) stage.scrollTop = pos;
    if (playing && pos >= max - 0.5) setPlaying(false);
    raf = requestAnimationFrame(tick);
  }

  function page(dir) {
    const max = stage.scrollHeight - stage.clientHeight;
    const from = target ?? stage.scrollTop;
    if (dir > 0 && from >= max - 4) { if (idx < ids.length - 1) loadSong(idx + 1); return; }
    target = clamp(from + dir * stage.clientHeight * 0.7, 0, max);
    syncAfterTarget = true;
  }

  const bumpSpeed = delta => {
    if (timed) {
      song = store.upsertSong({ id: song.id, bpm: clamp(bpm() + delta, 30, 300) });
      player.setBpm(bpm());
    } else {
      song = store.upsertSong({ id: song.id, speed: clamp(Math.round(baseSpeed() + delta), 2, 300) });
    }
    updateControls();
  };
  function capoState() {
    const sheetCapo = parseInt(parsed.meta.capo, 10) || 0;
    const capo = song.capo ?? sheetCapo;
    return { sheetCapo, capo, shift: (song.transpose || 0) + sheetCapo - capo };
  }

  // Capo chooser: every fret, the shapes you'd play there, and how hard they are.
  const capoPanel = $('#capoPanel');
  function openCapo() {
    const { sheetCapo, capo } = capoState();
    const { options, best } = capoOptions(songChords(parsed), (song.transpose || 0) + sheetCapo);
    capoPanel.innerHTML = `
      <div class="capo-head"><b>Capo</b><span class="sub grow">Same key, different shapes. ♭/♯ changes the key you sing in.</span>
        <button class="btn ghost icon" data-capo-close title="Close">✕</button></div>
      <div class="capo-list">${options.map(o => `
        <button class="capo-row${o.capo === capo ? ' on' : ''}" data-capo="${o.capo}">
          <span class="capo-fret">${o.capo ? `Fret ${o.capo}` : 'No capo'}</span>
          <span class="capo-shapes">${o.shapes.map(esc).join('  ')}</span>
          <span class="capo-diff d${Math.min(4, Math.floor(o.score))}">${difficultyLabel(o.score)}${o.barre ? ` · ${o.barre} barre` : ''}</span>
          ${o.capo === options[best].capo ? '<span class="capo-best">Easiest</span>' : ''}
        </button>`).join('')}</div>`;
    capoPanel.hidden = false;
  }
  const closeCapo = () => { capoPanel.hidden = true; };
  capoPanel.addEventListener('click', e => {
    e.stopPropagation();
    if (e.target.closest('[data-capo-close]')) return closeCapo();
    const row = e.target.closest('[data-capo]');
    if (!row) return;
    song = store.upsertSong({ id: song.id, capo: +row.dataset.capo });
    closeCapo();
    drawSheet(true);
  });

  const transpose = d => {
    let n = (song.transpose || 0) + d;
    if (n > 11) n -= 12;
    if (n < -11) n += 12;
    song = store.upsertSong({ id: song.id, transpose: n });
    drawSheet(true);
  };
  const exit = () => go(set ? `#/sets/${set.id}` : '#/');

  const actions = {
    exit, prev: () => idx > 0 && loadSong(idx - 1), next: () => idx < ids.length - 1 && loadSong(idx + 1),
    play: () => (timed ? toggleTimed() : setPlaying(!playing)), slower: () => bumpSpeed(-2), faster: () => bumpSpeed(2),
    voice: () => setVoice(!voiceOn),
    heard: () => { S.showHeard = !S.showHeard; store.save(); updateControls(); },
    smaller: () => { S.fontScale = clamp(+(S.fontScale - 0.1).toFixed(2), 0.6, 2.5); store.save(); drawSheet(true); },
    bigger: () => { S.fontScale = clamp(+(S.fontScale + 0.1).toFixed(2), 0.6, 2.5); store.save(); drawSheet(true); },
    chords: () => { S.showChords = !S.showChords; store.save(); drawSheet(true); },
    down: () => transpose(-1), up: () => transpose(1),
    capo: () => (capoPanel.hidden ? openCapo() : closeCapo()),
    sync: () => go(`#/sync/${song.id}`),
    fs: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()),
  };

  app.querySelector('.perform').addEventListener('click', e => {
    const b = e.target.closest('[data-a]');
    if (b) { b.blur(); actions[b.dataset.a]?.(); return; }
    // In a chord chart, tapping a bar starts (or restarts) playback from that bar.
    // In a timed song, tapping a bar or lyric line starts (or restarts) from there.
    if (timed) {
      const hit = e.target.closest('.bars .cell') || e.target.closest('.line');
      const i = hit ? units.findIndex(u => u.el === hit) : -1;
      if (i >= 0) { toggleTimed(i); return; }
    }
    // Tap zones on the sheet: bottom third pages down, top quarter pages up.
    if (e.target.closest('#stage')) {
      const r = stage.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      if (y > 0.67) page(1); else if (y < 0.25) page(-1);
    }
  });

  // Keyboard + Bluetooth page-turner pedals (they send arrow / PageUp / PageDown keys).
  const onKey = e => {
    if (e.target.matches?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const map = {
      ' ': actions.play, ArrowDown: () => page(1), PageDown: () => page(1), ArrowRight: () => page(1),
      ArrowUp: () => page(-1), PageUp: () => page(-1), ArrowLeft: () => page(-1),
      n: actions.next, N: actions.next, p: actions.prev, P: actions.prev,
      '+': actions.faster, '=': actions.faster, '-': actions.slower, _: actions.slower,
      v: actions.voice, V: actions.voice, Escape: () => (capoPanel.hidden ? exit() : closeCapo()),
    };
    if (map[k]) { e.preventDefault(); map[k](); }
  };

  // Manual scrolling cancels any eased jump and re-anchors voice follow to what's on screen.
  const onManual = () => {
    target = null;
    clearTimeout(manualTimer);
    if (voiceOn) manualTimer = setTimeout(syncCursor, 500);
  };

  // Keep the screen awake while performing.
  let lock = null;
  const getLock = async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } };
  const onVis = () => { if (document.visibilityState === 'visible') getLock(); };

  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVis);
  stage.addEventListener('wheel', onManual, { passive: true });
  stage.addEventListener('touchmove', onManual, { passive: true });
  getLock();
  loadSong(idx);
  raf = requestAnimationFrame(tick);

  cleanup = () => {
    cancelAnimationFrame(raf);
    clearTimeout(manualTimer);
    follower.stop();
    player.dispose();
    delete window.__stagescroll;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    lock?.release?.().catch(() => {});
  };
}

route();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Local persistence (localStorage). Everything lives in this browser; use Export for backups.
import { parseChordPro, plainToChordPro, isChordPro } from './chordpro.js';
import { SAMPLE_CHORDPRO } from './samples.js';

const KEY = 'stagescroll.v1';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

let db = null;
try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
const fresh = !db;
if (fresh) db = { songs: {}, setlists: {}, settings: {} };
db.settings = { fontScale: 1, showChords: true, showHeard: true, lang: 'en-US', ...db.settings };
if (fresh) {
  const ids = SAMPLE_CHORDPRO.map(text => upsertSong({ chordpro: toChordPro(text) }).id);
  upsertSetlist({ name: 'Sample Set', songIds: ids });
}

export const settings = db.settings;

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { alert('Could not save: ' + e.message); }
}

// Normalise any pasted/imported text to ChordPro, adding a title if missing.
export function toChordPro(text, fallbackTitle) {
  let cp = isChordPro(text) ? text : plainToChordPro(text);
  if (!/^\s*\{\s*(title|t)\s*:/im.test(cp)) cp = `{title: ${fallbackTitle || 'Untitled'}}\n` + cp;
  return cp;
}

export const songs = () => Object.values(db.songs).sort((a, b) => a.title.localeCompare(b.title));
export const getSong = id => db.songs[id];

export function upsertSong(fields) {
  const prev = fields.id && db.songs[fields.id];
  const s = prev ? { ...prev, ...fields } : { speed: null, transpose: 0, ...fields, id: uid() };
  const { meta } = parseChordPro(s.chordpro || '');
  s.title = meta.title || 'Untitled';
  s.artist = meta.artist || '';
  s.key = meta.key || '';
  s.updated = Date.now();
  db.songs[s.id] = s;
  save();
  return s;
}

export function deleteSong(id) {
  delete db.songs[id];
  for (const l of Object.values(db.setlists)) l.songIds = l.songIds.filter(x => x !== id);
  save();
}

export const setlists = () => Object.values(db.setlists).sort((a, b) => a.name.localeCompare(b.name));
export const getSetlist = id => db.setlists[id];

export function upsertSetlist(fields) {
  const prev = fields.id && db.setlists[fields.id];
  const s = prev ? { ...prev, ...fields } : { name: 'New Setlist', songIds: [], ...fields, id: uid() };
  s.updated = Date.now();
  db.setlists[s.id] = s;
  save();
  return s;
}

export function deleteSetlist(id) { delete db.setlists[id]; save(); }

export function exportData() {
  return JSON.stringify({ app: 'stagescroll', version: 1, exported: new Date().toISOString(),
    songs: Object.values(db.songs), setlists: Object.values(db.setlists) }, null, 2);
}

export function importData(json) {
  const d = JSON.parse(json);
  if (d.app !== 'stagescroll') throw new Error('Not a StageScroll backup');
  for (const s of d.songs || []) db.songs[s.id] = s;
  for (const l of d.setlists || []) db.setlists[l.id] = l;
  save();
  return { songs: (d.songs || []).length, setlists: (d.setlists || []).length };
}

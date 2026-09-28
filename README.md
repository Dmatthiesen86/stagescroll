# StageScroll

Personal gig app: chord sheets, setlists, auto-scroll, and **voice follow** (karaoke-style
tracking of where you are in the lyrics).

## Run it

```bash
cd StageScroll
python -m http.server 5173
```

Open http://localhost:5173 in **Chrome or Edge** (voice follow needs their speech recognizer).

## Using it

- **Songs**: New song → paste a song. If you pasted Ultimate-Guitar style text (chords on the
  line above the lyrics), press **Convert chords-over-lyrics**. Add `{duration: 3:30}` and the
  default scroll speed is set so the song scrolls over that duration.
- **Import**: `.cho` / `.chordpro` / `.txt` files, or a `.json` backup. **Export** often — songs
  live only in this browser's storage.
- **Setlists**: build, reorder, play. Tapping a song in a set starts from there.

### Perform controls

| Key / pedal | Action |
|---|---|
| Space | start / stop auto-scroll |
| → ↓ PageDown | page down (at the bottom: next song) |
| ← ↑ PageUp | page up |
| N / P | next / previous song |
| + / − | scroll speed |
| V | voice follow on/off |
| Esc | leave |

Tap the bottom third of the sheet to page down, top quarter to page up.
Bluetooth page-turner pedals (AirTurn, PageFlip, etc.) work in their arrow/PageDown mode.

### Voice follow

Turn on **Voice follow** and sing. The app matches what the mic hears against the lyrics near
your current spot, highlights the line/words, and scrolls it to the upper third of the screen.
If auto-scroll is also running, voice matches nudge its speed to stay with you, and the steady
scroll carries you through solos and instrumental breaks.

- 👂 shows what the recognizer is hearing — useful for judging mic placement.
- Chrome's recognizer usually needs internet. Newer Chrome versions can run on-device; the
  app uses that automatically when available (hover the Voice button to see which mode).
- Loud stage = bad recognition. A headset mic or a feed from your vocal mic through an audio
  interface works far better than the laptop/tablet mic.
- Testing without singing: open DevTools console in perform view and run
  `__stagescroll.hear('amazing grace how sweet the sound')`.

## Files

- `js/chordpro.js` — ChordPro parser, chords-over-lyrics converter, transposer
- `js/follow.js` — speech recognition + fuzzy lyric alignment
- `js/app.js` — UI: library, setlists, editor, perform view
- `js/store.js` — localStorage persistence, import/export
- `sw.js` — offline cache (works once hosted over HTTPS or on localhost)

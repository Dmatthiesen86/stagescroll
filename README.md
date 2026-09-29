# StageScroll

Personal gig app: chord sheets, setlists, auto-scroll, and **voice follow** (karaoke-style
tracking of where you are in the lyrics).

## Install on iPhone / iPad / computer (works offline)

Live at **https://dmatthiesen86.github.io/stagescroll/**

- **iPhone / iPad**: open the link in **Safari** → Share → **Add to Home Screen**. Launch it
  from the home-screen icon once while online; after that it runs with no internet.
- **Computer**: open the link in Chrome or Edge → install icon in the address bar → Install.

Each device keeps its **own** song library. To copy songs between devices: Export on one,
send the `.json` file over (AirDrop, email, Files), then Import on the other.

**Publishing changes**: bump `CACHE` in `sw.js`, commit, push. Devices pick up the new
version the next time the app is opened with internet (it applies on the launch after).

## Run it locally

```bash
cd StageScroll
python -m http.server 5173
```

Open http://localhost:5173 in **Chrome or Edge** (voice follow needs their speech recognizer).

## Using it

- **Songs**: New song → paste a song. If you pasted Ultimate-Guitar style text (chords on the
  line above the lyrics), press **Convert chords-over-lyrics**. Add `{duration: 3:30}` and the
  default scroll speed is set so the song scrolls over that duration.
- **Import**: Ultimate Guitar **PDFs**, `.cho` / `.chordpro` / `.txt` files, or a `.json` backup.
  **Export** often — songs live only in this browser's storage.
- **PDF import**: UG's PDFs are pictures of the page, so the app reads them with built-in text
  recognition (OCR, bundled — works offline, ~3 s per page). It picks up title / artist / key,
  skips the chord-diagram page, and repairs common misreads of bold chord names. Guitar tab
  doesn't OCR well, so tab areas are kept as boxed reference blocks. A single PDF opens in the
  editor afterwards — give it a quick look before the gig.
- **Chordify PDFs**: recognised automatically and turned into a bar-by-bar chord chart
  (4 bars per row, `%` = same chord as the bar before, two chords in a bar = split bar), with
  tempo and length filled in so auto-scroll matches the song. F△ is read as Fmaj7.
- **Bar highlight** (chord charts with no lyrics, e.g. Chordify imports): **▶ Count in** clicks
  one bar, then lights up each bar in time with a progress line; split bars light each chord for
  its share of the beats. **− / +** change the tempo (saved per song). Tap any bar to start there.
  Add `{time: 3/4}` for waltzes.
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
- `js/pdfimport.js` — PDF → ChordPro (pdf.js text layer, or Tesseract OCR for image PDFs)
- `js/bars.js` — count-in and tempo-driven bar highlight
- `js/chordify.js` — Chordify lead sheet → bar chart (finds staff and bar lines on the rendered page)
- `js/vendor/` — pdf.js (Apache-2.0) and Tesseract.js (Apache-2.0), bundled for offline use
- `sw.js` — offline cache (works once hosted over HTTPS or on localhost)

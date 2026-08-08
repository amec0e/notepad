// ── NOTEPAD STATS WORKER ──
// Counts chars / words / lines off the main thread so large files never
// block typing or scrolling on the UI thread. A single pass over the string
// with no array allocations keeps memory flat — important on iOS Safari,
// which kills pages that spike memory (e.g. value.split(/\s+/) on a big file).
//
// Receives: { text }
// Posts back: { chars, words, lines }

self.onmessage = function (e) {
  const text = (e.data && e.data.text) || '';
  const len = text.length;

  let lines = 1;
  let words = 0;
  let inWord = false;

  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) lines++;                       // \n
    // whitespace: space, tab, \n, \r, \f, \v, non-breaking space
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; words++; }
  }

  self.postMessage({ chars: len, words: words, lines: lines });
};

// ── NOTEPAD on CodeMirror 6 ──
// The editable surface is a CodeMirror EditorView (window.CM = vendored bundle).
// CM gives us line numbers, viewport virtualization, undo/redo, and selection
// natively — which is why big files stay smooth. Our features (find/replace,
// strip/split, duplicates) keep their logic and talk to CM's document model
// through the small adapter helpers below instead of a textarea.

// Surface any uncaught error in the status bar so failures are never silent.
window.addEventListener('error', ev => {
  const el = document.getElementById('status-text');
  if (el) el.textContent = '⚠ ' + (ev.message || 'script error');
});

// Fail loudly + clearly if the CodeMirror bundle didn't load, and say WHY.
// window.__cmLoad is set by the bundle <script>'s onload/onerror in notepad.html.
if (!window.CM || !CM.EditorView) {
  let why;
  if (window.__cmLoad === 'error') {
    why = 'codemirror.bundle.js failed to load (404 / wrong path). It must be in the SAME folder as notepad.html, named exactly "codemirror.bundle.js" (lowercase — GitHub Pages is case-sensitive).';
  } else if (window.__cmLoad === 'ok') {
    why = 'codemirror.bundle.js loaded but did not initialize — the file is likely truncated or corrupted. Re-download and replace it (it should be ~278 KB / ~285,000 bytes).';
  } else {
    why = 'The <script src="codemirror.bundle.js"> tag never ran — you are probably serving an OLD notepad.html. Deploy the updated notepad.html and hard-refresh (on iOS: close the tab and reopen, or clear website data).';
  }
  const host = document.getElementById('editor-host');
  if (host) { host.style.padding = '16px'; host.style.color = '#cdd3db'; host.style.font = "13px/1.6 'JetBrains Mono', monospace"; host.textContent = 'CodeMirror failed to load.\n\n' + why; }
  const st = document.getElementById('status-text');
  if (st) st.textContent = '⚠ CodeMirror not loaded — see editor area';
  throw new Error('window.CM not found: ' + why);
}

// ── STATE ──
let fileHandle  = null;          // File System Access handle (when supported)
let currentName = 'untitled.txt';
let dirty       = false;
let wrapOn      = true;          // line wrapping on by default
let fontSize    = 13;            // px (bumped to 14 on small screens at init)

let findCase  = false;
let findRegex = false;

let lastMatches     = [];        // [[start,end], ...] char offsets of current matches
let currentMatchIdx = -1;        // index into lastMatches of the "active" match

// ── DUPLICATE-LINES STATE ──
let dupePanelOpen = false;
let dupeCase      = false;
let dupeTrim      = true;
let dupeLineSet   = new Set();
let dupeKeepSet   = new Set();
let dupeNavList   = [];
let dupeNavIdx    = -1;
let lastDupeGroups = [];
let dupeRefreshTimer = null;
let dupeExpanded  = false;

const findPanel    = document.getElementById('find-panel');
const findInput    = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const stripInput   = document.getElementById('strip-input');
const splitInput   = document.getElementById('split-input');
const joinSepInput  = document.getElementById('join-sep-input');
const joinWrapInput = document.getElementById('join-wrap-input');
const upperInput   = document.getElementById('upper-input');
const hasFS        = 'showOpenFilePicker' in window;

function findOpen() { return !findPanel.classList.contains('hidden'); }

// ── CODEMIRROR SETUP ──

const wrapCompartment = new CM.Compartment();

// Find-match highlighting: a decoration StateField driven by an effect. CM only
// renders decorations in the viewport, so we can pass ALL matches with no cap.
const findEffect = CM.StateEffect.define();
const findField = CM.StateField.define({
  create() { return CM.Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(findEffect)) return e.value;
    return deco.map(tr.changes);
  },
  provide: f => CM.EditorView.decorations.from(f)
});

// Duplicate-line tinting: line decorations (cyan = kept first line, orange = removable).
const dupeEffect = CM.StateEffect.define();
const dupeField = CM.StateField.define({
  create() { return CM.Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(dupeEffect)) return e.value;
    return deco.map(tr.changes);
  },
  provide: f => CM.EditorView.decorations.from(f)
});

const cmTheme = CM.EditorView.theme({
  '&': { color: 'var(--text-main)', backgroundColor: 'var(--bg-editor)', height: '100%',
         fontSize: 'var(--editor-font-size)' },
  '.cm-scroller': { fontFamily: "'JetBrains Mono', ui-monospace, monospace", lineHeight: '1.75',
                    overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--accent-cyan)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--bg-gutter, #16191c)', color: 'var(--text-dim)',
                   border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--nav-active)', color: 'var(--text-label)' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.028)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '20px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-cyan)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
      { backgroundColor: 'rgba(62,207,207,0.28)' },
  '.cm-hl-match':   { backgroundColor: 'rgba(255,214,0,0.26)', borderRadius: '2px' },
  '.cm-hl-current': { backgroundColor: 'rgba(255,138,0,0.55)', borderRadius: '2px' },
  '.cm-dupe':       { backgroundColor: 'rgba(255,138,0,0.10)' },
  '.cm-dupe-keep':  { backgroundColor: 'rgba(62,207,207,0.10)' },
}, { dark: true });

// Deferred post-edit refresh: the update listener runs DURING a dispatch, and CM
// forbids dispatching (which our find/dupe decoration updates do) mid-update — so
// we schedule those to the next frame.
let afterEditQueued = false;
function scheduleAfterEdit() {
  if (afterEditQueued) return;
  afterEditQueued = true;
  requestAnimationFrame(() => {
    afterEditQueued = false;
    if (dupePanelOpen) refreshDupes();
    if (findOpen()) refreshFindUI();   // recompute recomputes/clamps currentMatchIdx itself
  });
}

const updateListener = CM.EditorView.updateListener.of(u => {
  if (u.docChanged) { markDirty(); updateStats(); scheduleAfterEdit(); }
  if (u.docChanged || u.selectionSet) updateCursor();
});

const view = new CM.EditorView({
  doc: '',
  parent: document.getElementById('editor-host'),
  extensions: [
    CM.lineNumbers(),
    CM.highlightActiveLine(),
    CM.highlightActiveLineGutter(),
    CM.history(),
    CM.drawSelection(),
    CM.keymap.of([...CM.defaultKeymap, ...CM.historyKeymap, CM.indentWithTab]),
    wrapCompartment.of(wrapOn ? CM.EditorView.lineWrapping : []),
    findField,
    dupeField,
    updateListener,
    CM.EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    CM.placeholder('Start typing, or open / drop a file…'),
    cmTheme
  ]
});

// ── ADAPTER HELPERS (replace the old textarea API) ──
function getText() { return view.state.doc.toString(); }
function docLen()  { return view.state.doc.length; }

// Replace the whole document. Keeps the caret roughly where it was (clamped) and
// does NOT auto-scroll, so wholesale edits don't jump the viewport.
function setDoc(text) {
  const caret = Math.min(view.state.selection.main.head, text.length);
  view.dispatch({ changes: { from: 0, to: docLen(), insert: text },
                  selection: { anchor: caret } });
}
function setSel(a, b) { view.dispatch({ selection: { anchor: a, head: (b == null ? a : b) } }); }
function scrollPosIntoView(pos) { view.dispatch({ effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) }); }
function focusEd() { view.focus(); }

// ── STATS ──  (CM gives chars + lines instantly; words scanned on a debounce)
let statsTimer = null;
function updateStats() {
  const doc = view.state.doc;
  document.getElementById('stat-chars').textContent = doc.length.toLocaleString();
  document.getElementById('stat-lines').textContent = doc.lines.toLocaleString();
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    const t = getText();
    let words = 0, inWord = false;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160;
      if (ws) inWord = false; else if (!inWord) { inWord = true; words++; }
    }
    document.getElementById('stat-words').textContent = words.toLocaleString();
  }, 200);
}

function updateCursor() {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const col = sel.head - line.from + 1;
  document.getElementById('cursor-pos').textContent = `Ln ${line.number}, Col ${col}`;
  const selLen = sel.to - sel.from;
  document.getElementById('sel-indicator').textContent =
    selLen > 0 ? `${selLen.toLocaleString()} selected` : '';
}

// ── DIRTY TRACKING ──
function markDirty() {
  if (!dirty) {
    dirty = true;
    document.getElementById('dirty').classList.add('on');
    document.getElementById('status-dot').classList.add('dirty');
    document.getElementById('status-text').textContent = 'Unsaved changes';
  }
}
function markSaved(msg) {
  dirty = false;
  document.getElementById('dirty').classList.remove('on');
  document.getElementById('status-dot').classList.remove('dirty');
  if (msg) document.getElementById('status-text').textContent = msg;
}
function setFilename(name) {
  currentName = name;
  document.getElementById('fname').firstChild.textContent = name;
}
function setStatus(msg) { document.getElementById('status-text').textContent = msg; }

// ── RENAME ──  (tap filename; sets the downloaded name, detaches any live handle)
function renameFile() {
  const current = currentName || 'untitled.txt';
  const next = window.prompt('File name (include the extension, e.g. notes.txt):', current);
  if (next === null) return;
  const name = next.trim();
  if (!name || name === current) return;
  setFilename(name);
  if (fileHandle) fileHandle = null;
  setStatus(`Renamed to ${name}`);
}

// ── LOADING OVERLAY ──
const LOADING_THRESHOLD = 150000;
function showLoading(msg) {
  const ov = document.getElementById('load-overlay');
  if (!ov) return;
  if (msg) document.getElementById('load-text').textContent = msg;
  ov.classList.add('visible');
}
function hideLoading() {
  const ov = document.getElementById('load-overlay');
  if (ov) ov.classList.remove('visible');
}
function loadContent(text, name) {
  // Load directly — CM handles big docs efficiently, so no deferral needed. Any
  // failure surfaces in the status bar and the spinner is always cleared.
  try { setContent(text, name); }
  catch (err) { setStatus('Load failed: ' + (err && err.message ? err.message : err)); }
  finally { hideLoading(); }
}

// ── OPEN ──
async function openFile() {
  if (hasFS) {
    try {
      const [h] = await window.showOpenFilePicker();
      const file = await h.getFile();
      fileHandle = h;
      if (file.size >= LOADING_THRESHOLD) showLoading('Loading ' + file.name + '…');
      const text = await file.text();
      loadContent(text, file.name);
    } catch (err) {
      hideLoading();
      if (err && err.name !== 'AbortError') fallbackOpen();
    }
  } else {
    fallbackOpen();
  }
}
function fallbackOpen() { document.getElementById('file-input').click(); }

function readFileWithLoading(file, name) {
  if (file.size >= LOADING_THRESHOLD) showLoading('Loading ' + name + '…');
  const reader = new FileReader();
  reader.onload  = ev => loadContent(ev.target.result, name);
  reader.onerror = () => { hideLoading(); setStatus('Could not read ' + name); };
  reader.readAsText(file);
}
function loadFromInput(e) {
  const file = e.target.files[0];
  if (!file) return;
  fileHandle = null;
  readFileWithLoading(file, file.name);
  e.target.value = '';
}
function readDroppedFile(file) { fileHandle = null; readFileWithLoading(file, file.name); }

function setContent(text, name) {
  view.dispatch({
    changes: { from: 0, to: docLen(), insert: text },
    selection: { anchor: 0 },
    effects: CM.EditorView.scrollIntoView(0)
  });
  setFilename(name);
  markSaved(`Opened ${name}`);
  currentMatchIdx = -1; lastMatches = [];
  if (findOpen()) refreshFindUI(); else clearFindHighlights();
  if (dupePanelOpen) refreshDupes(); else clearDupeDeco();
  focusEd();
}

// ── DRAG & DROP ──
function onDragOver(e) { e.preventDefault(); document.getElementById('pane').classList.add('drag-over'); }
function onDragLeave()  { document.getElementById('pane').classList.remove('drag-over'); }
function onDrop(e) {
  e.preventDefault();
  document.getElementById('pane').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) readDroppedFile(file);
}

// ── SAVE ──
async function saveFile() {
  if (fileHandle && fileHandle.createWritable) {
    try {
      const w = await fileHandle.createWritable();
      await w.write(getText());
      await w.close();
      flashBtn('btn-save');
      markSaved(`Saved ${currentName}`);
      return;
    } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  saveFileAs();
}
async function saveFileAs() {
  if (hasFS && window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: currentName || 'untitled.txt',
        types: [{ description: 'Text file', accept: { 'text/plain': ['.txt', '.md', '.js', '.css', '.html', '.json', '.csv', '.log'] } }]
      });
      const w = await h.createWritable();
      await w.write(getText());
      await w.close();
      fileHandle = h;
      setFilename(h.name);
      flashBtn('btn-save');
      markSaved(`Saved ${h.name}`);
    } catch (err) { if (err && err.name !== 'AbortError') downloadFile(); }
  } else {
    downloadFile();
  }
}
function downloadFile() {
  const blob = new Blob([getText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentName || 'untitled.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flashBtn('btn-save');
  markSaved(`Downloaded ${a.download}`);
}

// ── COPY ──
function copyAll() {
  const text = getText();
  if (!text) { setStatus('Nothing to copy'); return; }
  const ok   = () => { flashBtn('btn-copy'); setStatus('Copied to clipboard'); };
  const fail = () => setStatus('Copy failed — select the text and copy manually');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok).catch(() => { fallbackCopy(text) ? ok() : fail(); });
  } else {
    fallbackCopy(text) ? ok() : fail();
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  return ok;
}

// ── CLEAR ──
function clearAll() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  view.dispatch({ changes: { from: 0, to: docLen(), insert: '' }, selection: { anchor: 0 } });
  fileHandle = null;
  setFilename('untitled.txt');
  markSaved('Ready — open a file or start typing');
  currentMatchIdx = -1; lastMatches = []; clearFindHighlights();
  dupeLineSet = new Set(); dupeKeepSet = new Set(); dupeNavList = []; dupeNavIdx = -1; lastDupeGroups = [];
  if (dupePanelOpen) refreshDupes(); else clearDupeDeco();
  focusEd();
}

// ── TOGGLES ──
function toggleWrap() {
  wrapOn = !wrapOn;
  view.dispatch({ effects: wrapCompartment.reconfigure(wrapOn ? CM.EditorView.lineWrapping : []) });
  document.getElementById('btn-wrap').classList.toggle('active', wrapOn);
  setStatus(wrapOn ? 'Word wrap on' : 'Word wrap off');
}
function bumpFont(dir) {
  fontSize = Math.min(22, Math.max(10, fontSize + dir));
  document.documentElement.style.setProperty('--editor-font-size', fontSize + 'px');
  view.requestMeasure();   // re-measure line heights after the font change
}

// ── FIND / REPLACE ──
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function literalFindSource(term) {
  let out = '';
  for (let i = 0; i < term.length; i++) {
    const c = term[i];
    if (c === '\\' && i + 1 < term.length) {
      const nx = term[i + 1];
      if (nx === 'n') { out += '\\n'; i++; continue; }
      if (nx === 't') { out += '\\t'; i++; continue; }
      if (nx === 'r') { out += '\\r'; i++; continue; }
      if (nx === '\\') { out += '\\\\'; i++; continue; }
    }
    out += escapeRegExp(c);
  }
  return out;
}
function buildRegex(global) {
  const term = findInput.value;
  if (!term) return null;
  let flags = global ? 'g' : '';
  if (!findCase) flags += 'i';
  try { return new RegExp(findRegex ? term : literalFindSource(term), flags); }
  catch (e) { return 'error'; }
}
function allMatches() {
  const re = buildRegex(true);
  if (!re || re === 'error') return re;
  const text = getText(), out = [];
  let m; re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length]);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}
function recomputeMatches() {
  const res = allMatches();
  if (res === 'error') { lastMatches = []; return 'error'; }
  lastMatches = res || [];
  if (currentMatchIdx >= lastMatches.length) currentMatchIdx = -1;
  return lastMatches;
}
function setFindCount(text, isError) {
  const el = document.getElementById('find-count');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

// Build + apply the find-match decorations (all matches; current one distinct).
function drawFind(matches, current) {
  const decos = [];
  for (let i = 0; i < matches.length; i++) {
    const [s, e] = matches[i];
    if (s >= e) continue;
    decos.push(CM.Decoration.mark({ class: i === current ? 'cm-hl-current' : 'cm-hl-match' }).range(s, e));
  }
  view.dispatch({ effects: findEffect.of(CM.Decoration.set(decos, true)) });
}
function clearFindHighlights() {
  view.dispatch({ effects: findEffect.of(CM.Decoration.none) });
}

function refreshFindUI() {
  if (!findOpen() || findInput.value === '') {
    lastMatches = []; currentMatchIdx = -1; setFindCount(''); clearFindHighlights(); return;
  }
  const res = recomputeMatches();
  if (res === 'error') { setFindCount('bad regex', true); clearFindHighlights(); return; }
  if (!res.length)     { setFindCount('0'); currentMatchIdx = -1; clearFindHighlights(); return; }
  setFindCount(currentMatchIdx >= 0 ? `${currentMatchIdx + 1}/${res.length}` : String(res.length));
  drawFind(res, currentMatchIdx);
}

// Move the active match to `idx`. Caret is collapsed at the match start (so iOS
// shows no selection callout); the current match is shown by its distinct color.
function gotoMatch(idx, res) {
  currentMatchIdx = idx;
  const s = res[idx][0];
  setSel(s, s);
  scrollPosIntoView(s);
  drawFind(res, idx);
  setFindCount(`${idx + 1}/${res.length}`);
}
function findStep(dir) {
  const res = recomputeMatches();
  if (res === 'error') { setFindCount('bad regex', true); clearFindHighlights(); return; }
  if (!res.length) { setFindCount('0/0'); currentMatchIdx = -1; clearFindHighlights(); return; }
  let idx;
  if (currentMatchIdx >= 0 && currentMatchIdx < res.length) {
    idx = (currentMatchIdx + dir + res.length) % res.length;
  } else {
    const caret = view.state.selection.main.head;
    if (dir > 0) { idx = res.findIndex(p => p[0] >= caret); if (idx === -1) idx = 0; }
    else { idx = -1; for (let i = res.length - 1; i >= 0; i--) { if (res[i][0] < caret) { idx = i; break; } } if (idx === -1) idx = res.length - 1; }
  }
  gotoMatch(idx, res);
}

function replaceOne() {
  const res = recomputeMatches();
  if (res === 'error') { setFindCount('bad regex', true); return; }
  if (!res.length) { setStatus('No matches to replace'); clearFindHighlights(); return; }
  const idx = (currentMatchIdx >= 0 && currentMatchIdx < res.length) ? currentMatchIdx : 0;
  const [s, e] = res[idx];
  let rep = replaceInput.value;
  if (findRegex) {
    const reOne = buildRegex(false);
    if (reOne && reOne !== 'error') rep = getText().slice(s, e).replace(reOne, replaceInput.value);
  }
  view.dispatch({ changes: { from: s, to: e, insert: rep }, selection: { anchor: s + rep.length } });
  const res2 = recomputeMatches();
  if (!res2.length) { currentMatchIdx = -1; clearFindHighlights(); setFindCount('0/0'); setStatus('Replaced 1 match'); return; }
  let ni = res2.findIndex(p => p[0] >= s + rep.length);
  if (ni === -1) ni = 0;
  gotoMatch(ni, res2);
  setStatus('Replaced 1 match');
}
function replaceAll() {
  const re = buildRegex(true);
  if (re === 'error') { setFindCount('bad regex', true); return; }
  if (!re) return;
  const before = getText();
  const matches = before.match(re);
  const count = matches ? matches.length : 0;
  if (!count) { setStatus('No matches to replace'); return; }
  const after = findRegex ? before.replace(re, replaceInput.value)
                          : before.replace(re, () => replaceInput.value);
  setDoc(after);
  currentMatchIdx = -1;
  setStatus(`Replaced ${count} match${count !== 1 ? 'es' : ''}`);
}

// ── STRIP LINES WITH ──
function stripFrom() {
  const marker = stripInput.value;
  if (!marker) { setStatus('Enter a symbol to strip lines with'); return; }
  const lines = getText().split('\n');
  const out = [];
  let cut = 0;
  for (const line of lines) {
    const idx = line.indexOf(marker);
    if (idx === -1) { out.push(line); continue; }
    out.push(line.slice(0, idx).replace(/\s+$/, ''));
    cut++;
  }
  const result = out.join('\n');
  if (result === getText()) { setStatus('Nothing matched that symbol'); return; }
  setDoc(result);
  currentMatchIdx = -1;
  setStatus(`Stripped ${cut} line${cut !== 1 ? 's' : ''}`);
}
function stripWholeLines() {
  const marker = stripInput.value;
  if (!marker) { setStatus('Enter a symbol to remove lines with'); return; }
  const lines = getText().split('\n');
  const out = lines.filter(line => !line.includes(marker));
  const removed = lines.length - out.length;
  if (!removed) { setStatus('Nothing matched that symbol'); return; }
  setDoc(out.join('\n'));
  currentMatchIdx = -1;
  setStatus(`Removed ${removed} line${removed !== 1 ? 's' : ''}`);
}
function stripEmptyLines() {
  const lines = getText().split('\n');
  const out = lines.filter(l => l.trim() !== '');
  const removed = lines.length - out.length;
  if (!removed) { setStatus('No empty lines to strip'); return; }
  setDoc(out.join('\n'));
  currentMatchIdx = -1;
  setStatus(`Stripped ${removed} empty line${removed !== 1 ? 's' : ''}`);
}

// ── SPLIT LINES WITH ──
function splitLines() {
  const delim = splitInput.value;
  if (delim === '') { setStatus('Enter something to split lines with'); return; }
  const before = getText();
  if (!before.includes(delim)) { setStatus('Delimiter not found'); return; }
  const parts = before.split(delim);
  const count = parts.length - 1;
  setDoc(parts.join('\n'));
  currentMatchIdx = -1;
  setStatus(`Split at ${count} point${count !== 1 ? 's' : ''} → ${view.state.doc.lines} lines`);
}

// ── JOIN LINES WITH ──  (inverse of Split)
// Collapses every line into one line. `sep` goes between lines; `wrap` (optional)
// wraps each line on both sides first, so wrap=" sep=, turns a/b/c into "a","b","c".
// A single trailing blank line (the end-of-file newline) is ignored so you don't
// get an empty wrapped item at the end.
function joinLines() {
  const sep  = joinSepInput.value;
  const wrap = joinWrapInput.value;
  if (sep === '' && wrap === '') { setStatus('Enter a separator (and optionally a wrap) to join lines with'); return; }
  const before = getText();
  const lines = before.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();   // drop trailing EOF-newline blank
  if (lines.length < 2 && wrap === '') { setStatus('Need at least two lines to join'); return; }
  const joined = lines.map(l => wrap + l + wrap).join(sep);
  if (joined === before) { setStatus('Nothing changed'); return; }
  setDoc(joined);
  currentMatchIdx = -1;
  setStatus(`Joined ${lines.length} line${lines.length !== 1 ? 's' : ''} → 1 line`);
}

// ── SORT LINES A–Z / Z–A ──  (case-insensitive, natural number order)
function sortLines(dir) {
  const before = getText();
  const lines = before.split('\n');
  if (lines.length < 2) { setStatus('Nothing to sort'); return; }
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const sorted = lines.slice().sort(dir === 'desc' ? (a, b) => cmp(b, a) : cmp);
  const result = sorted.join('\n');
  if (result === before) { setStatus('Already in order'); return; }
  setDoc(result);
  currentMatchIdx = -1;
  setStatus(`Sorted ${lines.length} lines ${dir === 'desc' ? 'Z → A' : 'A → Z'}`);
}

// ── UPPERCASE AFTER DELIMITER ──
// On each line, uppercase everything after the FIRST delimiter; the delimiter and
// the text before it stay as-is. Lines without the delimiter are left untouched.
function uppercaseAfter() {
  const delim = upperInput.value;
  if (delim === '') { setStatus('Enter a delimiter to uppercase after'); return; }
  const before = getText();
  let changed = 0;
  const out = before.split('\n').map(line => {
    const idx = line.indexOf(delim);
    if (idx === -1) return line;
    const head = line.slice(0, idx + delim.length);
    const tail = line.slice(idx + delim.length);
    const upper = tail.toUpperCase();
    if (upper !== tail) changed++;
    return head + upper;
  });
  const result = out.join('\n');
  if (result === before) { setStatus('Nothing to change (delimiter missing or already uppercase)'); return; }
  setDoc(result);
  currentMatchIdx = -1;
  setStatus(`Uppercased after delimiter on ${changed} line${changed !== 1 ? 's' : ''}`);
}

// ── DUPLICATE LINES ──
function normLine(s) {
  let t = dupeTrim ? s.trim() : s;
  if (!dupeCase) t = t.toLowerCase();
  return t;
}
function computeDuplicates() {
  const lines = getText().split('\n');
  const map = new Map();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const key = normLine(raw);
    let entry = map.get(key);
    if (!entry) { entry = { display: raw, indices: [] }; map.set(key, entry); }
    entry.indices.push(i);
  }
  const groups = [], lineSet = new Set();
  let removableCount = 0;
  for (const entry of map.values()) {
    if (entry.indices.length > 1) {
      groups.push({ display: entry.display, indices: entry.indices });
      for (const li of entry.indices) lineSet.add(li);
      removableCount += entry.indices.length - 1;
    }
  }
  groups.sort((a, b) => a.indices[0] - b.indices[0]);
  return { groups, lineSet, removableCount };
}
// Paint the duplicate-line tints as CM line decorations.
function applyDupeDeco() {
  const doc = view.state.doc;
  const items = [...dupeLineSet].sort((a, b) => a - b);
  const decos = [];
  for (const li of items) {
    if (li < 0 || li >= doc.lines) continue;
    const line = doc.line(li + 1);
    decos.push(CM.Decoration.line({ class: dupeKeepSet.has(li) ? 'cm-dupe-keep' : 'cm-dupe' }).range(line.from));
  }
  view.dispatch({ effects: dupeEffect.of(CM.Decoration.set(decos, true)) });
}
function clearDupeDeco() { view.dispatch({ effects: dupeEffect.of(CM.Decoration.none) }); }

function refreshDupes() {
  const data = computeDuplicates();
  dupeLineSet = data.lineSet;
  dupeKeepSet = new Set(data.groups.map(g => g.indices[0]));
  dupeNavList = [];
  for (const g of data.groups) for (let i = 1; i < g.indices.length; i++) dupeNavList.push(g.indices[i]);
  dupeNavList.sort((a, b) => a - b);
  dupeNavIdx = -1;
  renderDupePanel(data);
  applyDupeDeco();
}
function queueDupeRefresh() {
  clearTimeout(dupeRefreshTimer);
  dupeRefreshTimer = setTimeout(refreshDupes, 160);
}
function renderDupePanel(data) {
  lastDupeGroups = data.groups;
  const body = document.getElementById('dupe-body');
  const hint = document.getElementById('dupe-hint');
  body.innerHTML = '';
  if (!data.groups.length) {
    hint.textContent = 'none found';
    const empty = document.createElement('div');
    empty.className = 'dupe-empty';
    empty.textContent = 'No duplicate lines';
    body.appendChild(empty);
    return;
  }
  hint.textContent = `${data.groups.length} group${data.groups.length !== 1 ? 's' : ''} · ${data.removableCount} removable`;
  const frag = document.createDocumentFragment();
  data.groups.forEach((g, gi) => {
    const group = document.createElement('div');
    group.className = 'dupe-group';
    const head = document.createElement('div');
    head.className = 'dupe-group-head';
    const count = document.createElement('span');
    count.className = 'dupe-count';
    count.textContent = '×' + g.indices.length;
    head.appendChild(count);
    const text = document.createElement('span');
    text.className = 'dupe-text';
    text.textContent = g.display;
    head.appendChild(text);
    const rm = document.createElement('button');
    rm.className = 'dupe-act dupe-group-remove';
    rm.textContent = 'Remove ' + (g.indices.length - 1);
    rm.addEventListener('click', () => removeGroupDupes(gi));
    head.appendChild(rm);
    group.appendChild(head);
    const chips = document.createElement('div');
    chips.className = 'dupe-chips';
    g.indices.forEach((li) => {
      const keep = dupeKeepSet.has(li);
      const chip = document.createElement('button');
      chip.className = 'dupe-chip' + (keep ? ' keep' : '');
      chip.dataset.line = li;
      chip.textContent = 'L' + (li + 1) + (keep ? ' · keep' : '');
      chip.title = keep
        ? 'Kept — this line stays. Tap another line to keep that one instead.'
        : 'Tap to keep this line instead (and jump to it)';
      chip.addEventListener('click', () => selectKeep(gi, li, chips));
      chips.appendChild(chip);
    });
    group.appendChild(chips);
    frag.appendChild(group);
  });
  body.appendChild(frag);
}
// Pick which occurrence in a group to KEEP. Each group keeps exactly one line;
// tapping a chip moves the "keep" to that line (and jumps to it). "Remove All"
// and per-group remove then drop every occurrence that ISN'T the kept one.
function selectKeep(gi, li, chipsEl) {
  const g = lastDupeGroups[gi];
  if (!g) return;
  for (const idx of g.indices) dupeKeepSet.delete(idx);
  dupeKeepSet.add(li);
  if (chipsEl) {
    for (const chip of chipsEl.children) {
      const cl = Number(chip.dataset.line);
      const keep = cl === li;
      chip.classList.toggle('keep', keep);
      chip.textContent = 'L' + (cl + 1) + (keep ? ' · keep' : '');
      chip.title = keep
        ? 'Kept — this line stays. Tap another line to keep that one instead.'
        : 'Tap to keep this line instead (and jump to it)';
    }
  }
  applyDupeDeco();
  jumpToLine(li);
}
// Move the caret to line `li` (0-based) and scroll it into view; CM's active-line
// highlight + the dupe tint make it visible without a native selection callout.
function jumpToLine(li) {
  const doc = view.state.doc;
  const n = Math.min(li + 1, doc.lines);
  const line = doc.line(n);
  setSel(line.from, line.from);
  scrollPosIntoView(line.from);
  focusEd();
}
function dupeStep(dir) {
  if (!dupeNavList.length) { setStatus('No duplicates to step through'); return; }
  dupeNavIdx = (dupeNavIdx + dir + dupeNavList.length) % dupeNavList.length;
  jumpToLine(dupeNavList[dupeNavIdx]);
  setStatus(`Duplicate ${dupeNavIdx + 1}/${dupeNavList.length}`);
}
function removeAllDupes() {
  if (!lastDupeGroups.length) { setStatus('No duplicate lines'); return; }
  const remove = new Set();
  for (const g of lastDupeGroups) {
    // Keep the chosen occurrence (falls back to the first if none is selected).
    const chosen = g.indices.find(li => dupeKeepSet.has(li));
    const keeper = chosen === undefined ? g.indices[0] : chosen;
    for (const li of g.indices) if (li !== keeper) remove.add(li);
  }
  if (!remove.size) { setStatus('Nothing to remove'); return; }
  applyLineRemoval(remove);
}
function removeGroupDupes(gi) {
  const g = lastDupeGroups[gi];
  if (!g) return;
  const chosen = g.indices.find(li => dupeKeepSet.has(li));
  const keeper = chosen === undefined ? g.indices[0] : chosen;
  applyLineRemoval(new Set(g.indices.filter(li => li !== keeper)));
}
function applyLineRemoval(removeSet) {
  if (!removeSet.size) return;
  const lines = getText().split('\n');
  const kept = lines.filter((_, i) => !removeSet.has(i));
  setDoc(kept.join('\n'));
  currentMatchIdx = -1;
  setStatus(`Removed ${removeSet.size} duplicate line${removeSet.size !== 1 ? 's' : ''}`);
}

function toggleDupes() { if (dupePanelOpen) closeDupes(); else openDupes(); }
function openDupes() {
  dupePanelOpen = true;
  document.getElementById('dupe-panel').classList.add('visible');
  document.getElementById('btn-dupes').classList.add('active');
  refreshDupes();
}
function closeDupes() {
  dupePanelOpen = false;
  if (dupeExpanded) toggleDupeExpand();
  document.getElementById('dupe-panel').classList.remove('visible');
  document.getElementById('btn-dupes').classList.remove('active');
  dupeLineSet = new Set(); dupeKeepSet = new Set(); dupeNavList = []; dupeNavIdx = -1;
  clearDupeDeco();
}
function toggleDupeOpt(which) {
  if (which === 'case') { dupeCase = !dupeCase; document.getElementById('dupe-case').classList.toggle('active', dupeCase); }
  if (which === 'trim') { dupeTrim = !dupeTrim; document.getElementById('dupe-trim').classList.toggle('active', dupeTrim); }
  refreshDupes();
}
function toggleDupeExpand() {
  dupeExpanded = !dupeExpanded;
  document.getElementById('main').classList.toggle('dupe-expanded', dupeExpanded);
  const btn = document.getElementById('dupe-expand');
  if (btn) {
    btn.classList.toggle('active', dupeExpanded);
    btn.textContent = dupeExpanded ? '⤡' : '⤢';
    btn.title = dupeExpanded ? 'Collapse panel' : 'Expand panel to full size';
  }
}

// ── FIND PANEL SHOW/HIDE ──
function toggleFind() { if (findOpen()) closeFind(); else openFind(); }
function openFind() {
  findPanel.classList.remove('hidden');
  document.getElementById('btn-find').classList.add('active');
  const sel = view.state.selection.main;
  if (sel.to > sel.from && sel.to - sel.from < 200) {
    const s = view.state.sliceDoc(sel.from, sel.to);
    if (!s.includes('\n')) findInput.value = s;
  }
  currentMatchIdx = -1;
  findInput.focus();
  findInput.select();
  refreshFindUI();
}
function closeFind() {
  findPanel.classList.add('hidden');
  document.getElementById('btn-find').classList.remove('active');
  lastMatches = []; currentMatchIdx = -1;
  clearFindHighlights();
  focusEd();
}
function toggleFindOpt(which) {
  if (which === 'case')  { findCase  = !findCase;  document.getElementById('find-case').classList.toggle('active', findCase); }
  if (which === 'regex') { findRegex = !findRegex; document.getElementById('find-regex').classList.toggle('active', findRegex); }
  currentMatchIdx = -1;
  refreshFindUI();
}
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 96) + 'px'; }

findInput.addEventListener('input', () => { currentMatchIdx = -1; refreshFindUI(); });
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
replaceInput.addEventListener('input', () => autoGrow(replaceInput));
replaceInput.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeFind(); } });
splitInput.addEventListener('input', () => autoGrow(splitInput));
splitInput.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeFind(); } });
joinSepInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); joinLines(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
joinWrapInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); joinLines(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
stripInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); stripFrom(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
upperInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); uppercaseAfter(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});

// ── UI HELPERS ──
function flashBtn(id) {
  const btn = document.getElementById(id);
  btn.classList.add('flash-ok');
  setTimeout(() => btn.classList.remove('flash-ok'), 900);
}

// ── KEYBOARD SHORTCUTS ──
document.addEventListener('keydown', e => {
  if (e.key === 'F3') { e.preventDefault(); if (dupePanelOpen) dupeStep(e.shiftKey ? -1 : 1); return; }
  if (e.key === 'Escape') {
    if (findOpen()) { closeFind(); return; }
    if (dupePanelOpen) { closeDupes(); return; }
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'f')                    { e.preventDefault(); openFind(); }
  else if (k === 's' && e.shiftKey) { e.preventDefault(); saveFileAs(); }
  else if (k === 's')               { e.preventDefault(); saveFile(); }
  else if (k === 'o')               { e.preventDefault(); openFile(); }
  else if (k === 'd')               { e.preventDefault(); toggleDupes(); }
});

window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// ── INIT ──
if (window.matchMedia && window.matchMedia('(max-width: 700px)').matches) fontSize = 14;
document.documentElement.style.setProperty('--editor-font-size', fontSize + 'px');
document.getElementById('btn-wrap').classList.toggle('active', wrapOn);
updateStats();
updateCursor();
if (!hasFS) setStatus('Ready — Save downloads a copy in this browser');

// Wave 4b: reconstruct the monthly wall-calendar grid from Vision word boxes and
// turn the handwriting into dated PlanItem candidates. Tuned to the AT-A-GLANCE
// monthly wall calendar: 7 columns (Sun-Sat), a printed day number per cell, a
// Julian day-counter (NNN/NNN) per cell, and a 12-month reference strip across
// the bottom whose mini-cals each carry an "SMTWTFS" header.
//
// All declarations are `function`/`var` (hoisted) so api.gs can reference
// parsePaperCalendar_ at load time across files - GAS does not hoist const arrows.

// Words that are calendar print, not handwriting, so we never emit them as events.
var DOW_WORDS_ = listToMap_(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
// Conservative: only tokens that are clearly pre-printed (holidays / masthead),
// unlikely to ever be a handwritten activity. Bias toward keeping words (the user
// can reject a stray holiday far more easily than recover dropped handwriting).
var PRINT_NOISE_WORDS_ = listToMap_([
  'juneteenth', 'muharram', 'ashura', 'baptiste', 'quebec',
  'glance', 'ataglance', 'nathrop', 'notes', 'sundown',
]);
var MONTH_NAMES_ = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
// Geometry tuning knobs for the grid parser. These are the dials a future
// accuracy pass would turn (see HANDOFF "PRIMITIVE" backlog before retuning).
var HANDWRITING_MIN_RATIO_ = 0.7;       // keep words >= this * day-number height (drops printed holidays)
var CELL_WIDTH_DEFAULT_PX_ = 80;        // fallback cell width when column centers are degenerate
var Y_BAND_RATIO_ = 0.8;                // words within this * text-height share one line-band
var GAP_SPLIT_RATIO_ = 0.55;            // any x-gap over this * cell-width always ends a line
var CROSS_SPLIT_OUTLIER_MULT_ = 2.5;    // a column-crossing gap over this * the line's tightest gap...
var CROSS_SPLIT_MIN_RATIO_ = 0.2;       // ...and over this * cell-width splits two adjacent-cell entries
var ROW_FLOOR_TOL_RATIO_ = 0.5;         // writing within this * text-height above an anchor counts as that row
var STRADDLE_PX_ = 18;                  // a word within this many px of a cell boundary -> "check date"

// Entry point. words: [{t,x,y,w,h}] from extractVisionWords_. opts.month (1-based)
// and opts.year override auto-detection. Returns
// { month, year, range_start, range_end, candidates: [...] }.
function parsePaperCalendar_(words, opts) {
  opts = opts || {};
  words = (words || []).filter((w) => w && w.t !== undefined && w.t !== null && String(w.t).trim() !== '');
  if (!words.length) return emptyParse_();

  // 1. Month + year. The current-month label is the only spot a month name sits
  //    right next to a 4-digit year (the strip mini-cals carry no year), so we
  //    detect BEFORE cutting the strip.
  const my = detectMonthYear_(words, opts);
  const month = my.month; // 1-based
  const year = my.year;
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay(); // 0=Sun

  // 2. Drop the bottom reference strip.
  const gridWords = stripReferenceBand_(words);

  // 3. Day-number anchors: bare ints in [1..daysInMonth] within the grid region.
  const anchors = gridWords.filter((w) => isAnchorToken_(w.t, daysInMonth));
  anchors.forEach((a) => { a.__anchor = true; });
  if (anchors.length < 7) {
    return { month: month, year: year, range_start: '', range_end: '', candidates: [], low_structure: true };
  }

  // 4. Lattice from anchors. We trust each anchor's READ value to place it in the
  //    grid, then take per-column / per-row medians - skew-tolerant and robust to
  //    a few stray ints.
  const lattice = buildLattice_(anchors, firstDow, daysInMonth);

  // 5. Geometry step: filter printed text by size, group words into lines, assign
  //    each line to a DATE cell (with the vertical-overflow fix). This is the part
  //    an LLM cannot do - it needs the 2D image. The printed day-number height is
  //    the reference for the handwriting-vs-print size filter.
  const medAnchorH = median_(anchors.map((a) => a.h || 0)) || 0;
  const grouped = groupLinesByDate_(gridWords, lattice, month, year, daysInMonth, firstDow, medAnchorH);

  // 6. Assembly step (regex fallback). The Gemini path consumes grouped.dateText
  //    instead; run_photo_ocr decides which result to keep.
  const candidates = assembleCandidatesRegex_(grouped.dateLines);

  const dates = candidates.map((c) => c.date).filter(Boolean).sort();
  return {
    month: month,
    year: year,
    range_start: dates.length ? dates[0] : '',
    range_end: dates.length ? dates[dates.length - 1] : '',
    candidates: candidates,
    dateText: grouped.dateText,
    lowDates: grouped.lowDates,
  };
}

function emptyParse_() {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear(), range_start: '', range_end: '', candidates: [] };
}

function listToMap_(list) {
  const m = {};
  list.forEach((x) => { m[x] = true; });
  return m;
}

function alphaKey_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function monthIndexFromName_(s) {
  const m = alphaKey_(s);
  if (!m) return 0;
  for (let i = 0; i < 12; i++) {
    if (m === MONTH_NAMES_[i] || m === MONTH_NAMES_[i].slice(0, 3)) return i + 1;
  }
  return 0;
}

// Pair the month name whose nearest 4-digit-year token is closest (the printed
// "June 2026" current-month label). Falls back to a lone year / biggest-font
// month / today.
function detectMonthYear_(words, opts) {
  const om = parseInt(opts.month, 10);
  const oy = parseInt(opts.year, 10);
  if (om >= 1 && om <= 12 && oy >= 2000) return { month: om, year: oy };

  const months = [];
  const years = [];
  words.forEach((w) => {
    const mi = monthIndexFromName_(w.t);
    if (mi) months.push({ mi: mi, x: w.x, y: w.y, h: w.h || 0 });
    if (/^20\d{2}$/.test(String(w.t).trim())) years.push({ yr: parseInt(w.t, 10), x: w.x, y: w.y });
  });

  let best = null;
  months.forEach((mo) => {
    years.forEach((yr) => {
      const d = Math.sqrt((mo.x - yr.x) * (mo.x - yr.x) + (mo.y - yr.y) * (mo.y - yr.y));
      if (!best || d < best.d) best = { d: d, month: mo.mi, year: yr.yr };
    });
  });
  if (best) return { month: best.month, year: best.year };

  const now = new Date();
  let year = years.length ? years[0].yr : now.getFullYear();
  let month = now.getMonth() + 1;
  if (months.length) {
    months.sort((a, b) => b.h - a.h); // biggest font ~ the title
    month = months[0].mi;
  }
  return { month: month, year: year };
}

// The bottom reference strip is the row of mini-cals, each with a month label
// directly above an "SMTWTFS" header. Cut above the month-label row so neither
// the labels (e.g. "May June July") nor the mini-cal numbers leak into the grid.
function stripReferenceBand_(words) {
  const smtwYs = [];
  words.forEach((w) => {
    if (alphaKey_(w.t).toUpperCase() === 'SMTWTFS') smtwYs.push(w.y);
  });
  if (!smtwYs.length) return words.slice(); // no strip detected; keep all
  const minSmt = Math.min.apply(null, smtwYs);
  const medH = median_(words.map((w) => w.h || 0)) || 12;
  // Month-name labels sit just above the SMTWTFS headers; cut above them.
  const labelYs = [];
  words.forEach((w) => {
    if (monthIndexFromName_(w.t) && w.y < minSmt && w.y > minSmt - medH * 4) labelYs.push(w.y);
  });
  const cut = (labelYs.length ? Math.min.apply(null, labelYs) : minSmt) - medH * 0.5;
  return words.filter((w) => w.y < cut);
}

function isAnchorToken_(t, daysInMonth) {
  const s = String(t).trim();
  if (!/^\d{1,2}$/.test(s)) return false;
  const n = parseInt(s, 10);
  return n >= 1 && n <= daysInMonth;
}

// Place anchors at their known (row,col) from the printed value, then median the
// positions into column/row centers and derive cell boundaries.
function buildLattice_(anchors, firstDow, daysInMonth) {
  const colXs = [[], [], [], [], [], [], []];
  const rowYs = [];
  anchors.forEach((a) => {
    const d = parseInt(a.t, 10);
    const idx = firstDow + d - 1;
    const col = idx % 7;
    const row = Math.floor(idx / 7);
    colXs[col].push(a.x);
    if (!rowYs[row]) rowYs[row] = [];
    rowYs[row].push(a.y);
  });

  const colCenter = colXs.map((xs) => median_(xs));
  fillGaps_(colCenter);

  const numRows = Math.ceil((firstDow + daysInMonth) / 7);
  const rowCenter = [];
  for (let r = 0; r < numRows; r++) rowCenter[r] = median_(rowYs[r] || []);
  fillGaps_(rowCenter);

  return {
    firstDow: firstDow,
    daysInMonth: daysInMonth,
    numRows: numRows,
    colCenter: colCenter,
    rowCenter: rowCenter,
    colBound: boundsFromCenters_(colCenter),
    rowBound: boundsFromCenters_(rowCenter),
  };
}

function median_(arr) {
  const a = (arr || []).filter((v) => typeof v === 'number' && !isNaN(v)).slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Replace NaN centers by linear extrapolation from the known ones (uniform step).
function fillGaps_(centers) {
  const known = [];
  for (let i = 0; i < centers.length; i++) if (!isNaN(centers[i])) known.push(i);
  if (!known.length) return;
  if (known.length === 1) {
    for (let i = 0; i < centers.length; i++) if (isNaN(centers[i])) centers[i] = centers[known[0]];
    return;
  }
  const first = known[0];
  const last = known[known.length - 1];
  const step = (centers[last] - centers[first]) / (last - first);
  for (let i = 0; i < centers.length; i++) {
    if (isNaN(centers[i])) centers[i] = centers[first] + step * (i - first);
  }
}

// Midpoints between adjacent centers. bound[i] separates index i from i+1.
function boundsFromCenters_(centers) {
  const b = [];
  for (let i = 0; i < centers.length - 1; i++) b[i] = (centers[i] + centers[i + 1]) / 2;
  return b;
}

function indexFromBounds_(v, bounds) {
  let i = 0;
  while (i < bounds.length && v >= bounds[i]) i++;
  return i;
}

// Geometry: filter printed-small text, group words into handwriting lines, and
// assign each line to a DATE cell. Returns
//   { dateLines: { 'yyyy-MM-dd': [{text, y, low}] },   // for the regex assembler
//     dateText:  { 'yyyy-MM-dd': ['line', ...] },        // for the Gemini prompt
//     lowDates:  ['yyyy-MM-dd', ...] }                   // ambiguous cell -> check date
function groupLinesByDate_(gridWords, lattice, month, year, daysInMonth, firstDow, medAnchorH) {
  const out = { dateLines: {}, dateText: {}, lowDates: [] };

  // Keep handwriting, drop printed text: printed holidays / masthead are smaller
  // than the day-number anchors; handwriting is as tall or taller.
  const minH = medAnchorH ? medAnchorH * HANDWRITING_MIN_RATIO_ : 0;
  const content = gridWords.filter((w) => !w.__anchor && !isNoiseToken_(w.t) && (w.h || 0) >= minH);
  if (!content.length) return out;

  const medH = median_(content.map((w) => w.h || 0)) || 12;
  const colDiffs = [];
  for (let i = 1; i < lattice.colCenter.length; i++) colDiffs.push(lattice.colCenter[i] - lattice.colCenter[i - 1]);
  const cellWidth = median_(colDiffs) || CELL_WIDTH_DEFAULT_PX_;

  const lines = groupWordsIntoLines_(content, medH, cellWidth, lattice.colBound);
  const tol = medH * ROW_FLOOR_TOL_RATIO_;
  const lowSet = {};
  lines.forEach((ln) => {
    ln.low = lineStraddles_(ln, lattice);
    // Column by the line's LEFT edge (handwriting overflowing rightward stays put).
    const col = indexFromBounds_(ln.xLeft, lattice.colBound);
    // Row = the day-number whose anchor sits directly ABOVE the line. Handwriting
    // fills the cell below its number, so a midpoint boundary wrongly pushes the
    // lower lines of a tall cell into the next week - floor-to-anchor fixes that.
    const row = rowFloorIndex_(ln.y, lattice.rowCenter, tol);
    const day = row * 7 + col - firstDow + 1;
    if (day < 1 || day > daysInMonth) return; // leading/trailing blank cell
    const date = isoYMD_(year, month, day);
    if (!out.dateLines[date]) out.dateLines[date] = [];
    out.dateLines[date].push({ text: ln.text, y: ln.y, low: ln.low });
    if (ln.low) lowSet[date] = true;
  });

  Object.keys(out.dateLines).forEach((date) => {
    out.dateLines[date].sort((a, b) => a.y - b.y);
    out.dateText[date] = out.dateLines[date].map((l) => l.text);
  });
  out.lowDates = Object.keys(lowSet);
  return out;
}

// Largest row index whose anchor center sits at or above the line (within tol, so
// writing level with the day number still counts as that row).
function rowFloorIndex_(y, rowCenter, tol) {
  let r = 0;
  for (let i = 0; i < rowCenter.length; i++) {
    if (rowCenter[i] <= y + tol) r = i; else break;
  }
  return r;
}

// Regex fallback assembler: per date, merge wrapped lines into events (a new event
// begins at each line that leads with a time; untimed continuation lines append),
// peel times, drop printed holidays / trivial fragments.
function assembleCandidatesRegex_(dateLines) {
  const candidates = [];
  Object.keys(dateLines).forEach((date) => {
    const events = [];
    let cur = null;
    dateLines[date].forEach((ln) => {
      const t = matchLeadingTime_(ln.text);
      if (t || !cur) {
        cur = { time: t, lines: [ln], low: ln.low };
        events.push(cur);
      } else {
        cur.lines.push(ln);
        cur.low = cur.low || ln.low;
      }
    });
    events.forEach((ev) => {
      const ass = assembleEvent_(ev);
      if (!ass) return;
      ass.date = date;
      ass.day = parseInt(date.slice(8), 10);
      ass.confidence = ev.low ? 'low' : 'ok';
      candidates.push(ass);
    });
  });
  candidates.sort((a, b) =>
    a.date === b.date ? String(a.start_time).localeCompare(String(b.start_time)) : a.date.localeCompare(b.date));
  return candidates;
}

function isNoiseToken_(t) {
  const s = String(t).trim();
  if (!s) return true;
  if (/^\d{1,3}\/\d{1,3}$/.test(s)) return true; // Julian counter 152/213
  if (/^\d{3}$/.test(s)) return true;            // bare 3-digit (Julian half)
  const key = alphaKey_(s);
  if (DOW_WORDS_[key]) return true;
  if (PRINT_NOISE_WORDS_[key]) return true;
  return false;
}

// Cluster words into handwriting lines. Words share a line when they sit in the
// same y-band (~one text height) AND are horizontally close. A line ends at:
//   (a) any very large x-gap (always a cell jump), or
//   (b) a column-boundary crossing where the gap is an outlier vs the line's
//       tightest word spacing - this separates two adjacent-cell entries whose
//       handwriting nearly touches, WITHOUT splitting a single entry that merely
//       overflows into the next column (its words stay evenly spaced).
function groupWordsIntoLines_(content, medH, cellWidth, colBound) {
  const sorted = content.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const bands = [];
  let band = null;
  sorted.forEach((w) => {
    if (band && Math.abs(w.y - band.y) <= medH * Y_BAND_RATIO_) {
      band.words.push(w);
      band.y = (band.y * (band.words.length - 1) + w.y) / band.words.length;
    } else {
      band = { y: w.y, words: [w] };
      bands.push(band);
    }
  });

  const lines = [];
  bands.forEach((b) => {
    const ws = b.words.slice().sort((a, c) => a.x - c.x);
    const gaps = [];
    for (let i = 1; i < ws.length; i++) gaps.push(ws[i].x - ws[i - 1].x);
    const minGap = gaps.length ? Math.min.apply(null, gaps) : 0;
    let seg = [ws[0]];
    for (let i = 1; i < ws.length; i++) {
      const gap = ws[i].x - ws[i - 1].x;
      const crossCol = indexFromBounds_(ws[i].x, colBound) !== indexFromBounds_(ws[i - 1].x, colBound);
      const bigAbs = gap > cellWidth * GAP_SPLIT_RATIO_;
      const crossOutlier = crossCol && gap > minGap * CROSS_SPLIT_OUTLIER_MULT_ && gap > cellWidth * CROSS_SPLIT_MIN_RATIO_;
      if (bigAbs || crossOutlier) {
        lines.push(makeLine_(seg));
        seg = [ws[i]];
      } else {
        seg.push(ws[i]);
      }
    }
    lines.push(makeLine_(seg));
  });
  return lines.filter((ln) => ln.text.replace(/\s/g, '').length >= 2);
}

function makeLine_(words) {
  const ws = words.slice().sort((a, b) => a.x - b.x);
  return {
    words: ws,
    text: ws.map((w) => w.t).join(' ').replace(/\s+/g, ' ').trim(),
    xLeft: Math.min.apply(null, ws.map((w) => w.x)),
    y: median_(ws.map((w) => w.y)),
    low: false,
  };
}

// True when a line's words sit within a few px of a cell boundary, i.e. the cell
// (and therefore the date) assignment is ambiguous -> surfaced as "check date".
function lineStraddles_(line, lattice) {
  const near = (val, bounds) => bounds.some((b) => Math.abs(val - b) < STRADDLE_PX_);
  return line.words.some((w) => near(w.x, lattice.colBound) || near(w.y, lattice.rowBound));
}

// Merge a cell's grouped lines into one event: peel the leading time off the
// first line, append the rest as the title, split out an "@ location", and drop
// printed holidays / trivial untimed fragments.
function assembleEvent_(ev) {
  const joined = ev.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
  let title = joined;
  let start = '';
  let end = '';
  if (ev.time) {
    start = ev.time.start;
    end = ev.time.end;
    const firstNoTime = (ev.lines[0].text.slice(0, ev.time.index) + ev.lines[0].text.slice(ev.time.index + ev.time.length)).trim();
    const rest = ev.lines.slice(1).map((l) => l.text).join(' ');
    title = (firstNoTime + ' ' + rest).replace(/\s+/g, ' ').trim().replace(/^[\s\-–—:•]+/, '').trim();
  }
  let location = '';
  const at = title.match(/\s@\s*(.+)$/);
  if (at) {
    location = at[1].trim();
    title = title.slice(0, at.index).trim();
  }
  if (!title) title = ev.time ? '(untitled)' : joined;

  if (!start) {
    if (isHolidayPhrase_(title)) return null;
    const ak = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ak.length < 3 || STOPWORD_TITLES_[ak]) return null;
  }
  return { title: title, start_time: start, end_time: end, location: location, raw: joined };
}

// Pre-printed holidays / astro markers that share a cell with handwriting. Phrase
// match (not single words) so we don't nuke handwriting that reuses a common word.
function isHolidayPhrase_(title) {
  const t = title.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/begins at sundown/.test(t)) return true;
  if (/^(full|new) moon$/.test(t)) return true;
  if (/^(first|last) quarter$/.test(t)) return true;
  const phrases = [
    'fathers day', 'father s day', 'flag day', 'juneteenth', 'summer begins',
    'first of muharram', 'muharram', 'ashura', 'st jean baptiste day',
    'jean baptiste', 'memorial day', 'labor day', 'summer solstice',
  ];
  for (let i = 0; i < phrases.length; i++) if (t.indexOf(phrases[i]) !== -1) return true;
  return false;
}

var STOPWORD_TITLES_ = listToMap_(['at', 'the', 'of', 'to', 'in', 'on', 'and', 'a', 'an', 'dd']);

// Vision routinely reads a handwritten "1" as "l"/"I". Repair that ONLY inside
// time-shaped tokens (digits/l/I adjacent to am|pm or a clock separator) so real
// words keep their letters. Length-preserving, so match indices still line up
// with the original text for title slicing.
function normalizeTimeDigits_(text) {
  return text
    .replace(/\b[lI\d]{1,2}\s*(?:-|–|—|to)\s*[lI\d]{1,2}(?=\s*(?:am|pm)\b)/gi, (m) => m.replace(/[lI]/g, '1'))
    .replace(/\b[lI\d]{1,2}(?=\s*(?:am|pm)\b)/gi, (m) => m.replace(/[lI]/g, '1'))
    .replace(/\b[lI\d]{1,2}[:.][lI\d]{2}\b/gi, (m) => m.replace(/[lI]/g, '1'));
}

function matchLeadingTime_(original) {
  const text = normalizeTimeDigits_(original); // same length -> indices stay valid
  const range = text.match(/(1[0-2]|0?[1-9])([:.](\d{2}))?\s*(?:-|–|—|to)\s*(1[0-2]|0?[1-9])([:.](\d{2}))?\s*(am|pm)/i);
  if (range) {
    const ap = range[7].toLowerCase();
    const startAp = inferStartAmPm_(parseInt(range[1], 10), parseInt(range[4], 10), ap);
    return {
      start: to24_(parseInt(range[1], 10), range[3] ? parseInt(range[3], 10) : 0, startAp),
      end: to24_(parseInt(range[4], 10), range[6] ? parseInt(range[6], 10) : 0, ap),
      index: range.index,
      length: range[0].length,
    };
  }
  const single = text.match(/(1[0-2]|0?[1-9])([:.](\d{2}))?\s*(am|pm)/i);
  if (single) {
    const ap = single[4].toLowerCase();
    return {
      start: to24_(parseInt(single[1], 10), single[3] ? parseInt(single[3], 10) : 0, ap),
      end: '',
      index: single.index,
      length: single[0].length,
    };
  }
  return null;
}

// For a range that only states am/pm once (e.g. "9-11am", "1-4pm"), apply it to
// both ends; if that makes start > end, the start must be the other half ("11-1pm").
function inferStartAmPm_(startHour, endHour, endAp) {
  let sh = (startHour % 12) + (endAp === 'pm' ? 12 : 0);
  let eh = (endHour % 12) + (endAp === 'pm' ? 12 : 0);
  if (sh <= eh) return endAp;
  return endAp === 'pm' ? 'am' : 'pm';
}

function to24_(h, m, ap) {
  let hr = h % 12;
  if (ap === 'pm') hr += 12;
  return String(hr).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0');
}

function isoYMD_(y, m, d) {
  return String(y) + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

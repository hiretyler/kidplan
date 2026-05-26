// Sheet access. Single chokepoint via openSheet_ - all reads/writes route through here.
// Shape adapted from ~/vault/Patterns/multi-tenant-apps-script-runtime.md (single-tenant variant).

const getSheetId_ = () => {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID script property not set');
  return id;
};

// The chokepoint. Add caching, validation, or audit logging here.
const openSheet_ = () => SpreadsheetApp.openById(getSheetId_());

// Script timezone for all date formatting. Decision: America/Denver.
const TZ_ = 'America/Denver';

// Header rows per docs/data-model.md. Source of truth for setup + column order.
const SHEET_HEADERS_ = {
  Days: ['date', 'primary_tag', 'tags', 'plan_a_summary', 'plan_b_pointer', 'plan_b_custom_text', 'notes', 'confidence', 'weather_sensitive', 'updated_at'],
  PlanItems: ['id', 'date', 'kid', 'title', 'start_time', 'end_time', 'location', 'gcal_event_id', 'tag', 'source', 'updated_at'],
  Library: ['id', 'name', 'tag', 'description', 'indoor', 'typical_duration_min', 'kid_age_fit', 'notes'],
  Tags: ['tag', 'color', 'display_order', 'is_preset'],
  Photos: ['id', 'drive_file_id', 'uploaded_at', 'covers_date_range_start', 'covers_date_range_end', 'ocr_text', 'parsed_json', 'reconciled'],
  Settings: ['key', 'value'],
};

// Columns that hold a date-only value (yyyy-MM-dd) rather than a full datetime.
const DATE_ONLY_COLUMNS_ = {
  date: true,
  covers_date_range_start: true,
  covers_date_range_end: true,
};

// Columns that should be normalized to real JS booleans on read.
const BOOLEAN_COLUMNS_ = {
  weather_sensitive: true,
  indoor: true,
  is_preset: true,
  reconciled: true,
};

// Open (or fail clearly) a tab by name.
function openTab_(tabName) {
  const sheet = openSheet_().getSheetByName(tabName);
  if (!sheet) throw new Error('tab not found: ' + tabName);
  return sheet;
}

// Coerce one cell value for JSON output. Dates -> ISO strings (TZ drift safe),
// booleans normalized, empty -> ''. header tells us date-only vs full datetime.
function coerceCellForRead_(value, header) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (DATE_ONLY_COLUMNS_[header]) {
      return Utilities.formatDate(value, TZ_, 'yyyy-MM-dd');
    }
    return Utilities.formatDate(value, TZ_, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  if (BOOLEAN_COLUMNS_[header]) return normalizeBoolean_(value);
  return value;
}

// Turn whatever Sheets handed back (bool, 'TRUE'/'FALSE', etc) into a JS boolean.
function normalizeBoolean_(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') return value.trim().toUpperCase() === 'TRUE';
  return Boolean(value);
}

// One getDataRange().getValues() read -> array of header-keyed objects.
function getRows_(tabName) {
  const values = openTab_(tabName).getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const obj = {};
    let hasData = false;
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header) continue;
      const coerced = coerceCellForRead_(row[c], header);
      obj[header] = coerced;
      if (coerced !== '') hasData = true;
    }
    if (hasData) out.push(obj);
  }
  return out;
}

// Single row lookup by key column. Returns object or null.
function getRowByKey_(tabName, keyColumn, keyValue) {
  const rows = getRows_(tabName);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][keyColumn]) === String(keyValue)) return rows[i];
  }
  return null;
}

// Prepare a value for writing into a cell. Booleans -> native bool (Sheets
// renders TRUE/FALSE). Empty -> ''. Everything else passes through.
function coerceCellForWrite_(value, header) {
  if (value === null || value === undefined) return '';
  if (BOOLEAN_COLUMNS_[header]) return normalizeBoolean_(value);
  return value;
}

// Find row by keyColumn match; update in place or append. Sets updated_at when
// the tab has that column. Lock-protected, batched setValues.
function upsertRow_(tabName, keyColumn, rowObj) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = openTab_(tabName);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const keyIdx = headers.indexOf(keyColumn);
    if (keyIdx === -1) throw new Error('key column not found: ' + keyColumn + ' in ' + tabName);

    // Stamp updated_at if the tab tracks it.
    const merged = {};
    for (const k in rowObj) merged[k] = rowObj[k];
    if (headers.indexOf('updated_at') !== -1) {
      merged.updated_at = Utilities.formatDate(new Date(), TZ_, "yyyy-MM-dd'T'HH:mm:ssXXX");
    }

    const rowArr = headers.map((h) => coerceCellForWrite_(merged[h], h));

    // Locate an existing row by key.
    let targetRow = -1;
    const keyStr = String(merged[keyColumn]);
    for (let r = 1; r < values.length; r++) {
      if (String(values[r][keyIdx]) === keyStr) {
        targetRow = r + 1; // 1-based sheet row
        break;
      }
    }

    if (targetRow === -1) {
      sheet.appendRow(rowArr);
    } else {
      sheet.getRange(targetRow, 1, 1, headers.length).setValues([rowArr]);
    }
    SpreadsheetApp.flush();
    return readBackRow_(tabName, keyColumn, keyStr);
  } finally {
    lock.releaseLock();
  }
}

// Re-read a single row post-write so callers get coerced ISO/bool values.
function readBackRow_(tabName, keyColumn, keyValue) {
  return getRowByKey_(tabName, keyColumn, keyValue);
}

// Lock-protected delete by key. Returns true if a row was removed.
function deleteRow_(tabName, keyColumn, keyValue) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = openTab_(tabName);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const keyIdx = headers.indexOf(keyColumn);
    if (keyIdx === -1) throw new Error('key column not found: ' + keyColumn + ' in ' + tabName);
    const keyStr = String(keyValue);
    for (let r = values.length - 1; r >= 1; r--) {
      if (String(values[r][keyIdx]) === keyStr) {
        sheet.deleteRow(r + 1);
        SpreadsheetApp.flush();
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}

// Idempotent setup. Tyler runs once from the editor. Ensures all 6 tabs exist
// with header rows, then seeds Tags/Library/Settings only if empty.
function setup_seedSheet_() {
  const ss = openSheet_();

  // Ensure every tab exists with the correct header row.
  Object.keys(SHEET_HEADERS_).forEach((tabName) => {
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) sheet = ss.insertSheet(tabName);
    const headers = SHEET_HEADERS_[tabName];
    const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    const hasHeaders = firstRow.some((c) => c !== '' && c !== null);
    if (!hasHeaders) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  });

  // Remove the default 'Sheet1' if it is empty and not one of ours.
  const stray = ss.getSheetByName('Sheet1');
  if (stray && !SHEET_HEADERS_['Sheet1'] && stray.getLastRow() === 0) {
    ss.deleteSheet(stray);
  }

  seedTags_(ss);
  seedLibrary_(ss);
  seedSettings_(ss);
  SpreadsheetApp.flush();
  return { ok: true, message: 'sheet setup complete' };
}

// 7 preset tags with hex colors, display_order 1-7, is_preset TRUE.
function seedTags_(ss) {
  const sheet = ss.getSheetByName('Tags');
  if (sheet.getLastRow() > 1) return; // already seeded
  const rows = [
    ['indoor', '#7AA6C2', 1, true],
    ['outdoor', '#8CC084', 2, true],
    ['day-trip', '#E8B25C', 3, true],
    ['mountains', '#4F7A5C', 4, true],
    ['playdate', '#E89B83', 5, true],
    ['chill', '#B8A6D9', 6, true],
    ['errands', '#B8A89A', 7, true],
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

// 8-10 realistic starter fallbacks spanning preschooler + elementary, indoor + outdoor.
function seedLibrary_(ss) {
  const sheet = ss.getSheetByName('Library');
  if (sheet.getLastRow() > 1) return; // already seeded
  // id | name | tag | description | indoor | typical_duration_min | kid_age_fit | notes
  const rows = [
    [libId_(), 'Rainy-day craft kit', 'indoor', 'Pull out the craft bin: glue, construction paper, stickers. Good when stuck inside.', true, 60, 'both', 'Cover the table first. Keep extra paper towels handy.'],
    [libId_(), 'Library story time', 'indoor', 'Drop-in story time at the public library, then browse the kids section.', true, 75, 'young', 'Check the branch schedule - usually weekday mornings.'],
    [libId_(), "Children's museum", 'day-trip', 'Hands-on exhibits, water table, climbing area. Burns a lot of energy.', true, 180, 'both', 'Members skip the line. Bring a change of clothes for water play.'],
    [libId_(), 'Favorite park', 'outdoor', 'The big playground with the shaded structure and the swings both kids like.', false, 90, 'both', 'Sunscreen + water bottles. Restrooms near the parking lot.'],
    [libId_(), 'Backyard water play', 'outdoor', 'Sprinkler, water table, and the little pool. Easy low-prep summer afternoon.', false, 60, 'young', 'Towels by the back door. Watch the toddler near the pool.'],
    [libId_(), 'Movie afternoon', 'chill', 'Pick a family movie, make popcorn, build a blanket fort. Quiet reset day.', true, 120, 'both', 'Good rainy-day or recovering-from-busy-week option.'],
    [libId_(), 'Baking project', 'indoor', 'Bake cookies or muffins together. Older kid measures, younger kid stirs.', true, 90, 'both', 'Check we have eggs and butter before committing.'],
    [libId_(), 'Nature walk', 'outdoor', 'Easy trail walk with a scavenger-hunt list (pinecone, red leaf, smooth rock).', false, 75, 'older', 'Hats + bug spray. Stroller for the little one if needed.'],
    [libId_(), 'Mountain picnic drive', 'mountains', 'Short drive up to the picnic spot, easy walk, lunch with a view.', false, 240, 'both', 'Pack layers - cooler up top. Leave early to beat afternoon storms.'],
    [libId_(), 'Errand adventure', 'errands', 'Combine the grocery + hardware run into a small outing with a treat stop.', true, 90, 'both', 'Snacks in the car. Promise the park after if everyone behaves.'],
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

// Only app-editable config keys (NOT secrets). Secrets live in script properties only.
function seedSettings_(ss) {
  const sheet = ss.getSheetByName('Settings');
  if (sheet.getLastRow() > 1) return; // already seeded
  const rows = [
    ['family_calendar_id', ''],
    ['read_only_calendar_ids', ''],
    ['photo_drive_folder_id', ''],
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

// Short opaque id generator for Library/PlanItems rows.
function genId_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}
function libId_() {
  return genId_();
}

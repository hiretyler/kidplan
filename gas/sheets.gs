// Sheet access. Single chokepoint via openSheet_ - all reads/writes route through here.
// Shape adapted from ~/vault/Patterns/multi-tenant-apps-script-runtime.md (single-tenant variant).

const getSheetId_ = () => {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID script property not set');
  return id;
};

// The chokepoint. Add caching, validation, or audit logging here.
const openSheet_ = () => SpreadsheetApp.openById(getSheetId_());

// Script timezone for datetime formatting (updated_at etc). Decision: America/Denver.
const TZ_ = 'America/Denver';

// The spreadsheet's own timezone, cached per execution. getValues() builds date
// cells into JS Dates using THIS timezone, so date-only cells must be formatted
// back with it (not TZ_) or they shift a day when the two differ. See
// migrateDateColumnsToText / coerceCellForRead_.
let SHEET_TZ_CACHE_ = null;
function sheetTz_() {
  if (!SHEET_TZ_CACHE_) SHEET_TZ_CACHE_ = openSheet_().getSpreadsheetTimeZone();
  return SHEET_TZ_CACHE_;
}

// Header rows per docs/data-model.md. Source of truth for setup + column order.
// Days tab was removed in Wave 3.5: all planning state lives on PlanItems now.
const SHEET_HEADERS_ = {
  PlanItems: ['id', 'date', 'kid', 'title', 'description', 'start_time', 'end_time', 'location', 'tag', 'is_backup', 'backup_for_id', 'gcal_event_id', 'source', 'updated_at'],
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

// Columns that hold a time-of-day value (HH:mm) and must be stored as text. If
// left to Sheets' auto-format these become fractional-day serials -> JS Dates on
// read -> garbage when the calendar writer parses them. Same TZ-stable approach
// as DATE_ONLY: '@' format on write, HH:mm format on read for any legacy cells.
const TIME_ONLY_COLUMNS_ = {
  start_time: true,
  end_time: true,
};

// Union for cells that must be stored as plain text (no auto-parse).
const TEXT_STORED_COLUMNS_ = (function () {
  const out = {};
  Object.keys(DATE_ONLY_COLUMNS_).forEach((k) => { out[k] = true; });
  Object.keys(TIME_ONLY_COLUMNS_).forEach((k) => { out[k] = true; });
  return out;
})();

// Columns that should be normalized to real JS booleans on read.
const BOOLEAN_COLUMNS_ = {
  is_backup: true,
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
      // Reverse the getValues() serial->Date conversion with the SAME timezone
      // it used (the spreadsheet's), so the calendar day is preserved exactly.
      return Utilities.formatDate(value, sheetTz_(), 'yyyy-MM-dd');
    }
    if (TIME_ONLY_COLUMNS_[header]) {
      // Same TZ logic as date-only: the cell is a fractional-day in the sheet's
      // timezone; format back in the sheet's timezone to recover HH:mm exactly.
      return Utilities.formatDate(value, sheetTz_(), 'HH:mm');
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

    // Locate an existing row by key.
    let targetRow = -1;
    const keyStr = String(rowObj[keyColumn]);
    for (let r = 1; r < values.length; r++) {
      if (String(values[r][keyIdx]) === keyStr) {
        targetRow = r + 1; // 1-based sheet row
        break;
      }
    }

    // Seed from the existing row so a partial patch only touches the columns it
    // names. Without this, every upsert blanked unsent columns - notably
    // gcal_event_id, which made each edit CREATE a fresh calendar event (and
    // left deletes unable to find the old one).
    const merged = {};
    if (targetRow !== -1) {
      headers.forEach((h, c) => { merged[h] = values[targetRow - 1][c]; });
    }
    for (const k in rowObj) merged[k] = rowObj[k];
    // Stamp updated_at if the tab tracks it.
    if (headers.indexOf('updated_at') !== -1) {
      merged.updated_at = Utilities.formatDate(new Date(), TZ_, "yyyy-MM-dd'T'HH:mm:ssXXX");
    }

    const rowArr = headers.map((h) => coerceCellForWrite_(merged[h], h));

    if (targetRow === -1) targetRow = values.length + 1;

    const range = sheet.getRange(targetRow, 1, 1, headers.length);
    // Force text-stored columns (dates AND times) to '@' BEFORE writing so the
    // string stays a string instead of being parsed into a TZ-sensitive serial.
    // Keeps round-trip + date-keyed upserts stable, and prevents start_time /
    // end_time from being silently converted into 1899-12-30T... ISO strings.
    headers.forEach((h, c) => {
      if (TEXT_STORED_COLUMNS_[h]) sheet.getRange(targetRow, c + 1).setNumberFormat('@');
    });
    range.setValues([rowArr]);
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

// Editor-run inspector (log only, changes nothing). Lists PlanItems rows with a
// blank start_time - cleanupCalendarOrphans can relink but not re-sync these.
// Decide per row: real activity -> set its time in the app; junk/test row ->
// delete it from the PlanItems tab, then re-run cleanupCalendarOrphans so its
// calendar event is swept as an orphan.
function listPlanItemsMissingStartTime() {
  const broken = getRows_('PlanItems').filter((r) => !r.start_time || String(r.start_time).trim() === '');
  if (!broken.length) {
    Logger.log('no PlanItems rows with blank start_time');
    return;
  }
  broken.forEach((r) => {
    Logger.log('id=%s date=%s title="%s" kid=%s source=%s is_backup=%s gcal_event_id=%s updated_at=%s',
      r.id, r.date, r.title, r.kid, r.source, r.is_backup, r.gcal_event_id, r.updated_at);
  });
}

// Idempotent setup. Tyler runs once from the editor. Ensures all 6 tabs exist
// with header rows, then seeds Tags/Library/Settings only if empty.
// No trailing underscore: trailing-underscore functions are private and do not
// appear in the editor Run dropdown.
function setupSeedSheet() {
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
    // Date-only AND time-only columns are stored as text to stay timezone-stable.
    // Format the whole column so values written later are never parsed into
    // fractional-day serials.
    headers.forEach((h, c) => {
      if (TEXT_STORED_COLUMNS_[h]) sheet.getRange(1, c + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    });
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

// 6 preset tags with hex colors, display_order 1-6, is_preset TRUE.
function seedTags_(ss) {
  const sheet = ss.getSheetByName('Tags');
  if (sheet.getLastRow() > 1) return; // already seeded
  const rows = [
    ['indoor', '#7AA6C2', 1, true],
    ['outdoor', '#8CC084', 2, true],
    ['day-trip', '#E8B25C', 3, true],
    ['mountains', '#4F7A5C', 4, true],
    ['playdate', '#E89B83', 5, true],
    ['errands', '#B8A89A', 6, true],
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
    [libId_(), 'Friend playdate at the park', 'playdate', 'Meet another family at the playground for a relaxed couple of hours.', false, 120, 'both', 'Coordinate snacks. Confirm the time the night before.'],
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

// One-time live migration. Tyler runs once from the editor. Converts every
// text-stored column (date-only AND time-only) from real Date cells to plain
// text ('yyyy-MM-dd' / 'HH:mm'), and sets those columns to text format so
// future writes stay text. Fixes the timezone off-by-one where days/items read
// back a day early AND the related bug where start_time/end_time were auto-
// parsed into fractional-day serials and read back as garbage ISO datetimes
// (breaking the calendar writer entirely). Uses the spreadsheet's own timezone
// to read the stored serial so the visible value is preserved exactly.
// Idempotent: safe to re-run. No trailing underscore so it appears in the Run
// dropdown.
function migrateDateColumnsToText() {
  const ss = openSheet_();
  const tz = ss.getSpreadsheetTimeZone();
  const summary = {};
  Object.keys(SHEET_HEADERS_).forEach((tabName) => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    const headers = SHEET_HEADERS_[tabName];
    let converted = 0;
    headers.forEach((h, c) => {
      if (!TEXT_STORED_COLUMNS_[h]) return;
      const isTime = !!TIME_ONLY_COLUMNS_[h];
      const fmt = isTime ? 'HH:mm' : 'yyyy-MM-dd';
      const col = c + 1;
      // Format the whole column (incl. future rows) as text.
      sheet.getRange(1, col, Math.max(lastRow, 1), 1).setNumberFormat('@');
      if (lastRow < 2) return;
      const range = sheet.getRange(2, col, lastRow - 1, 1);
      const vals = range.getValues();
      const out = vals.map((row) => {
        const v = row[0];
        if (v instanceof Date) {
          converted++;
          return [Utilities.formatDate(v, tz, fmt)];
        }
        return [v === null || v === undefined ? '' : String(v)];
      });
      range.setValues(out);
    });
    summary[tabName] = converted;
  });
  SpreadsheetApp.flush();
  return { ok: true, message: 'date + time columns converted to text', converted: summary };
}

// Wave 3.5 migration. Editor-run, idempotent, gated by Settings.backups_migrated.
// Adds PlanItems columns for the per-activity backup model, backfills defaults,
// synthesizes paired backup PlanItems from any legacy Days plan_b pointers, and
// drops the Days tab. No trailing underscore so it appears in the Run dropdown.
function migrateToBackupsModelV2() {
  const ss = openSheet_();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('backups_migrated') === 'TRUE') {
    return { ok: true, message: 'already migrated', synthesized: 0 };
  }
  const summary = { headers_added: [], rows_backfilled: 0, synthesized: 0, days_tab_deleted: false };

  // 1. Ensure PlanItems has the new headers (description, is_backup, backup_for_id).
  const planItems = ss.getSheetByName('PlanItems');
  if (planItems) {
    const existing = planItems.getRange(1, 1, 1, Math.max(planItems.getLastColumn(), 1)).getValues()[0];
    const want = SHEET_HEADERS_.PlanItems;
    want.forEach((h, idx) => {
      if (existing.indexOf(h) === -1) {
        planItems.insertColumnBefore(idx + 1);
        planItems.getRange(1, idx + 1).setValue(h);
        summary.headers_added.push(h);
        existing.splice(idx, 0, h);
      }
    });
    // Format the new date-only column (none added, but call to be safe / idempotent).
    SpreadsheetApp.flush();
  }

  // 2. Backfill defaults on existing PlanItems rows.
  getRows_('PlanItems').forEach((row) => {
    const patch = { id: row.id };
    let changed = false;
    if (row.is_backup === '' || row.is_backup === null || row.is_backup === undefined) {
      patch.is_backup = false;
      changed = true;
    }
    if (!row.source) { patch.source = 'manual'; changed = true; }
    if (changed) {
      upsertRow_('PlanItems', 'id', patch);
      summary.rows_backfilled++;
    }
  });

  // 3. Synthesize backup PlanItems from legacy Days plan_b pointers. Only when a
  //    primary already exists on that date to anchor the time slot.
  const daysTab = ss.getSheetByName('Days');
  if (daysTab) {
    const dayRows = getRows_('Days');
    const library = {};
    getRows_('Library').forEach((l) => { if (l.id) library[l.id] = l; });
    dayRows.forEach((d) => {
      const hasPointer = d.plan_b_pointer && d.plan_b_pointer !== 'custom';
      const hasCustom = d.plan_b_custom_text && String(d.plan_b_custom_text).trim() !== '';
      if (!hasPointer && !hasCustom) return;
      const dayItems = getRows_('PlanItems').filter((p) => p.date === d.date && !asBool_(p.is_backup));
      if (!dayItems.length) return; // no anchor — skip
      const primary = dayItems[0];
      // Skip if this primary already has a paired backup.
      const already = getRows_('PlanItems').some((p) => asBool_(p.is_backup) && p.backup_for_id === primary.id);
      if (already) return;
      const lib = hasPointer ? library[d.plan_b_pointer] : null;
      const title = lib ? lib.name : d.plan_b_custom_text;
      const tag = lib ? (lib.tag || primary.tag || '') : (primary.tag || '');
      const description = lib ? (lib.description || '') : '';
      const backup = {
        id: genId_(),
        date: primary.date,
        kid: primary.kid || 'shared',
        title: title,
        description: description,
        start_time: primary.start_time || '',
        end_time: primary.end_time || '',
        location: '',
        tag: tag,
        is_backup: true,
        backup_for_id: primary.id,
        gcal_event_id: '',
        source: 'manual',
      };
      const saved = upsertRow_('PlanItems', 'id', backup);
      try {
        const eventId = writePlanItemToCalendar_(saved);
        if (eventId) {
          saved.gcal_event_id = eventId;
          upsertRow_('PlanItems', 'id', saved);
        }
      } catch (e) {
        // Best-effort — row persists even if calendar mirror fails.
      }
      summary.synthesized++;
    });
  }

  // 4. Delete the Days tab. Pre-summer dataset is tiny; favor clean simplification.
  if (daysTab) {
    ss.deleteSheet(daysTab);
    summary.days_tab_deleted = true;
  }

  props.setProperty('backups_migrated', 'TRUE');
  SpreadsheetApp.flush();
  return { ok: true, summary: summary };
}

// Tolerant boolean coercion for migration paths that may see 'TRUE'/'FALSE' text
// alongside real booleans (mirrors normalizeBoolean_ but exposed at module level).
function asBool_(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') return v.trim().toUpperCase() === 'TRUE';
  return Boolean(v);
}

// Short opaque id generator for Library/PlanItems rows.
function genId_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}
function libId_() {
  return genId_();
}

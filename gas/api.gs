// HTTP router. All requests funnel through here.
// GET: action + params in query string. POST: action + params in JSON body.

const VERSION = '0.1.0';

// Unauthenticated. runningAs is the deployer (getEffectiveUser is reliable for
// execute-as-me; getActiveUser is empty on a personal-Gmail web app). tokenOk
// lets the frontend verify its stored token without exposing any data.
const ping = (params) => ({
  ok: true,
  runningAs: Session.getEffectiveUser().getEmail(),
  tokenOk: tokensMatch_(params && params.token, getApiToken_()),
  version: VERSION,
});

// PlanItems by date or inclusive [start,end] range. Returns primaries + backups.
// The frontend pairs them via backup_for_id and renders backups nested.
const list_plan_items = (params) => {
  const date = params && params.date;
  const start = params && params.start;
  const end = params && params.end;
  const rows = getRows_('PlanItems').filter((r) => {
    if (date) return r.date === date;
    if (start && r.date < start) return false;
    if (end && r.date > end) return false;
    return true;
  });
  return { ok: true, data: rows };
};

// Wipe every PlanItem on a date (primaries + their backups + calendar events).
// Requires confirm:true so a stray call cannot blow away a day.
const delete_plan_items_for_date = (params) => {
  if (!params || !params.date) throw new Error('date is required');
  if (params.confirm !== true) throw new Error('confirm:true is required');
  const items = getRows_('PlanItems').filter((it) => it.date === params.date);
  items.forEach((it) => {
    deletePlanItemFromCalendar_(it);
    deleteRow_('PlanItems', 'id', it.id);
  });
  return { ok: true, data: { plan_items_deleted: items.length } };
};

// Upsert a PlanItem, mirror to calendar, store the event id back. For primaries
// editing start_time/date also pulls the paired backup's time forward
// (writePlanItemToCalendar_ handles the calendar side; the backup's row is
// patched here so subsequent reads stay consistent).
const upsert_plan_item = (params) => {
  if (!params || !params.date || !params.title) {
    throw new Error('date and title are required');
  }
  if (!params.start_time) throw new Error('start_time is required');

  const item = {};
  for (const k in params) item[k] = params[k];
  if (!item.id) item.id = genId_();
  if (!item.source) item.source = 'manual';
  // Normalize the backup pairing fields so blanks land in the sheet, not 'undefined'.
  item.is_backup = item.is_backup === true || item.is_backup === 'TRUE' || item.is_backup === 'true';
  if (item.is_backup) {
    if (!item.backup_for_id) throw new Error('backup_for_id is required for a backup');
    const primary = getRowByKey_('PlanItems', 'id', item.backup_for_id);
    if (!primary) throw new Error('backup_for_id does not exist: ' + item.backup_for_id);
    if (asBool_(primary.is_backup)) throw new Error('cannot chain a backup onto another backup');
  } else {
    item.backup_for_id = '';
  }

  // Detect a primary-time change so we can re-sync the paired backup afterward.
  let priorPrimary = null;
  if (!item.is_backup) {
    priorPrimary = getRowByKey_('PlanItems', 'id', item.id);
  }

  let saved = upsertRow_('PlanItems', 'id', item);
  let calendarWarning = '';
  try {
    const eventId = writePlanItemToCalendar_(saved);
    if (eventId && eventId !== saved.gcal_event_id) {
      saved.gcal_event_id = eventId;
      saved = upsertRow_('PlanItems', 'id', saved);
    }
  } catch (err) {
    calendarWarning = err.message;
  }

  // If a primary's date/start/end shifted, drag the paired backup along so the
  // calendar pairing stays meaningful.
  if (priorPrimary && !item.is_backup) {
    const shifted =
      priorPrimary.date !== saved.date ||
      priorPrimary.start_time !== saved.start_time ||
      priorPrimary.end_time !== saved.end_time;
    if (shifted) {
      const backup = getRows_('PlanItems').find((p) => asBool_(p.is_backup) && p.backup_for_id === saved.id);
      if (backup) {
        const patch = {
          id: backup.id,
          date: saved.date,
          start_time: saved.start_time,
          end_time: saved.end_time,
        };
        let savedBackup = upsertRow_('PlanItems', 'id', patch);
        try {
          const eventId = writePlanItemToCalendar_(savedBackup);
          if (eventId && eventId !== savedBackup.gcal_event_id) {
            savedBackup.gcal_event_id = eventId;
            upsertRow_('PlanItems', 'id', savedBackup);
          }
        } catch (err) {
          if (!calendarWarning) calendarWarning = 'backup sync failed: ' + err.message;
        }
      }
    }
  }

  if (calendarWarning) return { ok: true, data: saved, calendar_warning: calendarWarning };
  return { ok: true, data: saved };
};

// Delete a PlanItem. If it is a primary, cascade to its paired backup
// (calendar event + row) first so we never leave an orphan backup.
const delete_plan_item = (params) => {
  if (!params || !params.id) throw new Error('id is required');
  const row = getRowByKey_('PlanItems', 'id', params.id);
  if (!row) return { ok: true, data: { deleted: false } };
  let backupDeleted = false;
  if (!asBool_(row.is_backup)) {
    const backup = getRows_('PlanItems').find((p) => asBool_(p.is_backup) && p.backup_for_id === row.id);
    if (backup) {
      deletePlanItemFromCalendar_(backup);
      deleteRow_('PlanItems', 'id', backup.id);
      backupDeleted = true;
    }
  }
  deletePlanItemFromCalendar_(row);
  const removed = deleteRow_('PlanItems', 'id', params.id);
  return { ok: true, data: { deleted: removed, backup_deleted: backupDeleted } };
};

// Copy the PlanItems on source_date (primaries + their paired backups) to each
// date in the inclusive range. Skips source_date if it falls inside the range.
// New ids are minted; backup_for_id is rewritten to the new primary's id so the
// pairing carries over. Calendar events are fresh.
const duplicate_plan_items_to_range = (params) => {
  if (!params || !params.source_date || !params.range_start || !params.range_end) {
    throw new Error('source_date, range_start, range_end are required');
  }
  const sourceItems = getRows_('PlanItems').filter((it) => it.date === params.source_date);
  if (!sourceItems.length) throw new Error('no plan items on source_date: ' + params.source_date);

  const targets = datesInRange_(params.range_start, params.range_end).filter(
    (d) => d !== params.source_date
  );

  const primaries = sourceItems.filter((it) => !asBool_(it.is_backup));
  const backupsByPrimary = {};
  sourceItems.filter((it) => asBool_(it.is_backup)).forEach((b) => {
    if (b.backup_for_id) backupsByPrimary[b.backup_for_id] = b;
  });

  let created = 0;
  let calendarWarning = '';
  targets.forEach((targetDate) => {
    primaries.forEach((p) => {
      const primaryCopy = copyForDate_(p, targetDate, '');
      const savedPrimary = syncCopy_(primaryCopy, (w) => { if (w && !calendarWarning) calendarWarning = w; });
      created++;
      const backup = backupsByPrimary[p.id];
      if (backup) {
        const backupCopy = copyForDate_(backup, targetDate, savedPrimary.id);
        syncCopy_(backupCopy, (w) => { if (w && !calendarWarning) calendarWarning = w; });
        created++;
      }
    });
  });
  const result = { dates_created: targets.length, plan_items_created: created };
  if (calendarWarning) return { ok: true, data: result, calendar_warning: calendarWarning };
  return { ok: true, data: result };
};

// Helpers shared by duplicate_plan_items_to_range. Kept local to api.gs.
function copyForDate_(src, targetDate, newBackupForId) {
  const copy = {};
  for (const k in src) copy[k] = src[k];
  copy.id = genId_();
  copy.date = targetDate;
  copy.gcal_event_id = '';
  copy.source = 'duplicate';
  if (asBool_(src.is_backup)) {
    copy.is_backup = true;
    copy.backup_for_id = newBackupForId;
  } else {
    copy.is_backup = false;
    copy.backup_for_id = '';
  }
  delete copy.updated_at;
  return copy;
}
function syncCopy_(copy, onWarn) {
  let saved = upsertRow_('PlanItems', 'id', copy);
  try {
    const eventId = writePlanItemToCalendar_(saved);
    if (eventId) {
      saved.gcal_event_id = eventId;
      saved = upsertRow_('PlanItems', 'id', saved);
    }
  } catch (e) {
    onWarn(e.message);
  }
  return saved;
}

const list_library = (_params) => ({ ok: true, data: getRows_('Library') });

const upsert_library = (params) => {
  if (!params || !params.name) throw new Error('name is required');
  const obj = {};
  for (const k in params) obj[k] = params[k];
  if (!obj.id) obj.id = genId_();
  const saved = upsertRow_('Library', 'id', obj);
  return { ok: true, data: saved };
};

const delete_library = (params) => {
  if (!params || !params.id) throw new Error('id is required');
  const removed = deleteRow_('Library', 'id', params.id);
  return { ok: true, data: { deleted: removed } };
};

const list_tags = (_params) => ({ ok: true, data: getRows_('Tags') });

const upsert_tag = (params) => {
  if (!params || !params.tag) throw new Error('tag is required');
  const saved = upsertRow_('Tags', 'tag', params);
  return { ok: true, data: saved };
};

// Calendar awareness: events in [start,end] (inclusive yyyy-MM-dd) across the
// family calendar + each READ_ONLY_CALENDAR_IDS entry. Each event is tagged
// source='kidplan' if its event id matches a known PlanItems.gcal_event_id,
// else 'external'. By default the frontend filters out kidplan-source events
// (we render those from PlanItems directly) but the round-trip is here if a
// view wants both.
const list_calendar_events = (params) => {
  const p = params || {};
  if (!p.start || !p.end) throw new Error('start and end are required (yyyy-MM-dd)');
  const calIds = (p.calendar_ids && p.calendar_ids.length)
    ? p.calendar_ids
    : defaultCalendarIds_();
  const kidplanIds = {};
  getRows_('PlanItems').forEach((r) => { if (r.gcal_event_id) kidplanIds[r.gcal_event_id] = true; });
  return { ok: true, data: listCalendarEvents_(p.start, p.end, calIds, kidplanIds) };
};

// Single-date wrapper retained for compatibility with any older client.
const list_conflicts = (params) => {
  if (!params || !params.date) throw new Error('date is required');
  return list_calendar_events({ start: params.date, end: params.date });
};

function defaultCalendarIds_() {
  const out = getReadOnlyCalendarIds_();
  try { out.push(getFamilyCalendarId_()); } catch (e) { /* family cal not configured */ }
  return out;
}

// Wave 4: photo capture + OCR.
// upload_photo: base64-decode and drop into the family Drive folder, append a
// Photos row, return it. Frontend follows up with run_photo_ocr.
const upload_photo = (params) => {
  if (!params || !params.image_base64) throw new Error('image_base64 is required');
  const mime = params.mime_type || 'image/jpeg';
  const filename = params.name || ('paper-calendar-' + Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd-HHmmss') + '.jpg');
  const driveFileId = uploadPhotoToDrive_(params.image_base64, mime, filename);
  const row = {
    id: genId_(),
    drive_file_id: driveFileId,
    uploaded_at: Utilities.formatDate(new Date(), TZ_, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    covers_date_range_start: params.covers_date_range_start || '',
    covers_date_range_end: params.covers_date_range_end || '',
    ocr_text: '',
    parsed_json: '',
    reconciled: false,
  };
  const saved = upsertRow_('Photos', 'id', row);
  return { ok: true, data: saved };
};

// Run Cloud Vision OCR on the Photos row's Drive file, persist the raw text.
// Phase 4b will add parsing + structured reconciliation on top of this.
const run_photo_ocr = (params) => {
  if (!params || !params.id) throw new Error('id is required');
  const row = getRowByKey_('Photos', 'id', params.id);
  if (!row) throw new Error('photo not found: ' + params.id);
  if (!row.drive_file_id) throw new Error('photo row has no drive_file_id');
  const text = runVisionOcrOnDriveFile_(row.drive_file_id);
  const updated = upsertRow_('Photos', 'id', { id: row.id, ocr_text: text });
  return { ok: true, data: updated };
};

const list_photos = (_params) => ({
  ok: true,
  data: getRows_('Photos').sort((a, b) => String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || ''))),
});

// Phase 4b will own this: convert ocr_text into PlanItem candidates and let
// the user accept/edit/reject each one.
const reconcile_photo = (_params) => { throw new Error('Not implemented until Phase 4b'); };

// Keys the API is allowed to read/write. Secrets are never exposed.
const EDITABLE_SETTING_KEYS_ = ['family_calendar_id', 'read_only_calendar_ids', 'photo_drive_folder_id'];

// Safe script properties surfaced to the frontend (never API_TOKEN / service acct).
const SAFE_SCRIPT_PROPERTY_KEYS_ = {
  FAMILY_CALENDAR_ID: 'family_calendar_id',
  READ_ONLY_CALENDAR_IDS: 'read_only_calendar_ids',
  PHOTO_DRIVE_FOLDER_ID: 'photo_drive_folder_id',
};

// Merge Settings tab + safe script properties. Script properties win when set.
const get_settings = (_params) => {
  const out = {};
  getRows_('Settings').forEach((r) => {
    if (r.key) out[r.key] = r.value;
  });
  const props = PropertiesService.getScriptProperties();
  Object.keys(SAFE_SCRIPT_PROPERTY_KEYS_).forEach((propKey) => {
    const val = props.getProperty(propKey);
    if (val) out[SAFE_SCRIPT_PROPERTY_KEYS_[propKey]] = val;
  });
  return { ok: true, data: out };
};

// Whitelist write only. API_TOKEN / VISION_SERVICE_ACCOUNT_JSON can never be set here.
const update_setting = (params) => {
  if (!params || !params.key) throw new Error('key is required');
  if (EDITABLE_SETTING_KEYS_.indexOf(params.key) === -1) {
    throw new Error('setting not editable via API: ' + params.key);
  }
  const value = (params.value === null || params.value === undefined) ? '' : String(params.value);
  const saved = upsertRow_('Settings', 'key', { key: params.key, value: value });
  return { ok: true, data: saved };
};

// Inclusive list of yyyy-MM-dd dates between start and end.
function datesInRange_(start, end) {
  const out = [];
  const s = start.split('-');
  const e = end.split('-');
  let cur = new Date(parseInt(s[0], 10), parseInt(s[1], 10) - 1, parseInt(s[2], 10));
  const last = new Date(parseInt(e[0], 10), parseInt(e[1], 10) - 1, parseInt(e[2], 10));
  while (cur.getTime() <= last.getTime()) {
    out.push(Utilities.formatDate(cur, TZ_, 'yyyy-MM-dd'));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Action -> handler. ping is unauthenticated; everything else is wrapped.
const ROUTES = {
  ping: ping,
  list_plan_items: withAuth_(list_plan_items),
  upsert_plan_item: withAuth_(upsert_plan_item),
  delete_plan_item: withAuth_(delete_plan_item),
  delete_plan_items_for_date: withAuth_(delete_plan_items_for_date),
  duplicate_plan_items_to_range: withAuth_(duplicate_plan_items_to_range),
  list_library: withAuth_(list_library),
  upsert_library: withAuth_(upsert_library),
  delete_library: withAuth_(delete_library),
  list_tags: withAuth_(list_tags),
  upsert_tag: withAuth_(upsert_tag),
  list_calendar_events: withAuth_(list_calendar_events),
  list_conflicts: withAuth_(list_conflicts),
  upload_photo: withAuth_(upload_photo),
  run_photo_ocr: withAuth_(run_photo_ocr),
  list_photos: withAuth_(list_photos),
  reconcile_photo: withAuth_(reconcile_photo),
  get_settings: withAuth_(get_settings),
  update_setting: withAuth_(update_setting),
};

const jsonOut_ = (obj) =>
  ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);

const dispatch_ = (action, params) => {
  try {
    const handler = ROUTES[action];
    if (!handler) return jsonOut_({ ok: false, error: 'unknown action: ' + action });
    return jsonOut_(handler(params));
  } catch (err) {
    return jsonOut_({ ok: false, error: err.message, stack: err.stack });
  }
};

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const action = params.action;
  return dispatch_(action, params);
}

function doPost(e) {
  let body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'invalid JSON body: ' + err.message });
  }
  const action = body.action;
  return dispatch_(action, body);
}

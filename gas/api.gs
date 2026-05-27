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

// Days are date-keyed. start/end are inclusive yyyy-MM-dd bounds.
const list_days = (params) => {
  const rows = getRows_('Days');
  const start = params && params.start;
  const end = params && params.end;
  const filtered = rows.filter((r) => {
    if (!r.date) return false;
    if (start && r.date < start) return false;
    if (end && r.date > end) return false;
    return true;
  });
  return { ok: true, data: filtered };
};

const upsert_day = (params) => {
  if (!params || !params.date) throw new Error('date is required');
  const saved = upsertRow_('Days', 'date', params);
  return { ok: true, data: saved };
};

// Cascade-delete: remove the Day, then its PlanItems and their calendar events.
const delete_day = (params) => {
  if (!params || !params.date) throw new Error('date is required');
  const date = params.date;
  const items = getRows_('PlanItems').filter((it) => it.date === date);
  items.forEach((it) => {
    deletePlanItemFromCalendar_(it);
    deleteRow_('PlanItems', 'id', it.id);
  });
  const removed = deleteRow_('Days', 'date', date);
  return { ok: true, data: { deleted: removed, plan_items_deleted: items.length } };
};

const list_plan_items = (params) => {
  const date = params && params.date;
  const rows = getRows_('PlanItems').filter((r) => !date || r.date === date);
  return { ok: true, data: rows };
};

// Upsert the row, mirror to calendar, store the event id back, return saved row.
const upsert_plan_item = (params) => {
  if (!params || !params.date || !params.title) {
    throw new Error('date and title are required');
  }
  const item = {};
  for (const k in params) item[k] = params[k];
  if (!item.id) item.id = genId_();
  if (!item.source) item.source = 'manual';

  // First write so the row exists, then sync calendar, then persist event id.
  // The row must always persist; a calendar failure becomes a soft warning.
  let saved = upsertRow_('PlanItems', 'id', item);
  try {
    const eventId = writePlanItemToCalendar_(saved);
    if (eventId && eventId !== saved.gcal_event_id) {
      saved.gcal_event_id = eventId;
      saved = upsertRow_('PlanItems', 'id', saved);
    }
  } catch (err) {
    return { ok: true, data: saved, calendar_warning: err.message };
  }
  return { ok: true, data: saved };
};

const delete_plan_item = (params) => {
  if (!params || !params.id) throw new Error('id is required');
  const row = getRowByKey_('PlanItems', 'id', params.id);
  if (!row) return { ok: true, data: { deleted: false } };
  deletePlanItemFromCalendar_(row);
  const removed = deleteRow_('PlanItems', 'id', params.id);
  return { ok: true, data: { deleted: removed } };
};

// Copy a source Day + its PlanItems to each date in the inclusive range.
// Skips source_date if it falls inside the range. New items get new ids/events.
const duplicate_day_to_range = (params) => {
  if (!params || !params.source_date || !params.range_start || !params.range_end) {
    throw new Error('source_date, range_start, range_end are required');
  }
  const sourceDay = getRowByKey_('Days', 'date', params.source_date);
  if (!sourceDay) throw new Error('source day not found: ' + params.source_date);
  const sourceItems = getRows_('PlanItems').filter((it) => it.date === params.source_date);

  const targets = datesInRange_(params.range_start, params.range_end).filter(
    (d) => d !== params.source_date
  );

  let created = 0;
  let calendarWarning = '';
  targets.forEach((targetDate) => {
    // Copy the Day row (preserve plan fields, retarget the date).
    const dayCopy = {};
    for (const k in sourceDay) dayCopy[k] = sourceDay[k];
    dayCopy.date = targetDate;
    delete dayCopy.updated_at;
    upsertRow_('Days', 'date', dayCopy);

    // Copy each PlanItem with a fresh id + fresh calendar event.
    sourceItems.forEach((it) => {
      const itemCopy = {};
      for (const k in it) itemCopy[k] = it[k];
      itemCopy.id = genId_();
      itemCopy.date = targetDate;
      itemCopy.gcal_event_id = '';
      delete itemCopy.updated_at;
      const saved = upsertRow_('PlanItems', 'id', itemCopy);
      // Best-effort calendar sync; a failure must not lose the row or abort the loop.
      try {
        const eventId = writePlanItemToCalendar_(saved);
        if (eventId) {
          saved.gcal_event_id = eventId;
          upsertRow_('PlanItems', 'id', saved);
        }
      } catch (err) {
        if (!calendarWarning) calendarWarning = err.message;
      }
      created++;
    });
  });
  const result = { days_created: targets.length, plan_items_created: created };
  if (calendarWarning) return { ok: true, data: result, calendar_warning: calendarWarning };
  return { ok: true, data: result };
};

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

// Conflict-awareness: events on a date across read-only + family calendars.
const list_conflicts = (params) => {
  if (!params || !params.date) throw new Error('date is required');
  return { ok: true, data: listConflictingEvents_(params.date) };
};

const request_photo_upload = (_params) => ({ ok: true, data: { upload_url: null, session_id: null } });
const list_photos = (_params) => ({ ok: true, data: [] });
const reconcile_photo = (_params) => { throw new Error('Not implemented in Wave 1'); };

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
  list_days: withAuth_(list_days),
  upsert_day: withAuth_(upsert_day),
  delete_day: withAuth_(delete_day),
  list_plan_items: withAuth_(list_plan_items),
  upsert_plan_item: withAuth_(upsert_plan_item),
  delete_plan_item: withAuth_(delete_plan_item),
  duplicate_day_to_range: withAuth_(duplicate_day_to_range),
  list_library: withAuth_(list_library),
  upsert_library: withAuth_(upsert_library),
  delete_library: withAuth_(delete_library),
  list_tags: withAuth_(list_tags),
  upsert_tag: withAuth_(upsert_tag),
  list_conflicts: withAuth_(list_conflicts),
  request_photo_upload: withAuth_(request_photo_upload),
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

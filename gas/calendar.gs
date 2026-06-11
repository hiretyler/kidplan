// Google Calendar bridge. Family cal is the write target; other cals are read-only inputs.

// Family calendar id from script properties (falls back to Settings tab if blank).
function getFamilyCalendarId_() {
  let id = PropertiesService.getScriptProperties().getProperty('FAMILY_CALENDAR_ID');
  if (!id) {
    const row = getRowByKey_('Settings', 'key', 'family_calendar_id');
    if (row) id = row.value;
  }
  if (!id) throw new Error('FAMILY_CALENDAR_ID not configured');
  return id;
}

function getFamilyCalendar_() {
  const cal = CalendarApp.getCalendarById(getFamilyCalendarId_());
  if (!cal) throw new Error('family calendar not accessible: ' + getFamilyCalendarId_());
  return cal;
}

// Title convention. Kid lane prefix, plus a [Backup] prefix when the item is a
// paired backup so it reads as "not the main thing" at a glance in the GCal grid.
// Eldest plans are paired (is_backup) but are a real plan, not a fallback - they
// read as plain [Elder] events.
function planItemTitle_(item) {
  const prefixes = { shared: '[Shared]', elder: '[Elder]', younger: '[Younger]' };
  const lane = prefixes[item.kid] || '[Shared]';
  const isEldest = String(item.item_type || '') === 'eldest';
  const backup = (!isEldest && (item.is_backup === true || item.is_backup === 'TRUE' || item.is_backup === 'true')) ? '[Backup] ' : '';
  return backup + lane + ' ' + (item.title || '');
}

// Build a Date from a yyyy-MM-dd date + HH:mm time in the family timezone.
function dateTimeFrom_(dateStr, timeStr) {
  // Construct an ISO-ish string and let GAS parse in the script tz via formatDate round trip.
  // Use new Date with explicit components to avoid UTC drift.
  const d = dateStr.split('-');
  const t = timeStr.split(':');
  return new Date(
    parseInt(d[0], 10),
    parseInt(d[1], 10) - 1,
    parseInt(d[2], 10),
    parseInt(t[0], 10),
    parseInt(t[1], 10),
    0
  );
}

// All-day event anchor. Built at NOON local time so timezone conversion never
// rolls the date back to the previous day (the classic GAS all-day off-by-one).
function dateOnly_(dateStr) {
  const d = dateStr.split('-');
  return new Date(parseInt(d[0], 10), parseInt(d[1], 10) - 1, parseInt(d[2], 10), 12, 0, 0);
}

// Creates or updates the GCal event for a PlanItem. Idempotent via gcal_event_id.
// Returns the event id. start_time is required upstream; if end_time is blank we
// default to start + 60 min so events are always timed (never all-day from this
// path). Backups carry a muted Graphite color to read as de-emphasized.
function writePlanItemToCalendar_(item) {
  const cal = getFamilyCalendar_();
  const title = planItemTitle_(item);
  const description = buildDescription_(item);
  const location = item.location || '';

  if (!item.start_time || String(item.start_time).trim() === '') {
    throw new Error('start_time is required to write a calendar event');
  }
  const endTime = (item.end_time && String(item.end_time).trim() !== '')
    ? item.end_time
    : addMinutesToTime_(item.start_time, 60);

  // Update path: fetch existing event and mutate in place. If the row lost its
  // event id (or never saved it), adopt an event already tagged with this
  // item's id rather than minting a duplicate.
  let existing = item.gcal_event_id ? cal.getEventById(item.gcal_event_id) : null;
  if (!existing) existing = findEventsByItemId_(cal, item.date, item.id)[0] || null;
  if (existing) {
    existing.setTitle(title);
    existing.setDescription(description);
    existing.setLocation(location);
    existing.setTime(
      dateTimeFrom_(item.date, item.start_time),
      dateTimeFrom_(item.date, endTime)
    );
    applyEventColor_(existing, item);
    return existing.getId();
  }

  const created = cal.createEvent(
    title,
    dateTimeFrom_(item.date, item.start_time),
    dateTimeFrom_(item.date, endTime),
    { description: description, location: location }
  );
  applyEventColor_(created, item);
  return created.getId();
}

// Events on the item's date whose description carries the 'KidPlan item <id>'
// tag. Recovers rows whose gcal_event_id went missing and lets delete sweep
// stray duplicate copies.
function findEventsByItemId_(cal, dateStr, itemId) {
  if (!dateStr || !itemId) return [];
  const d = String(dateStr).split('-');
  const dayStart = new Date(parseInt(d[0], 10), parseInt(d[1], 10) - 1, parseInt(d[2], 10), 0, 0, 0);
  const dayEnd = new Date(parseInt(d[0], 10), parseInt(d[1], 10) - 1, parseInt(d[2], 10) + 1, 0, 0, 0);
  const tag = 'KidPlan item ' + itemId;
  return cal.getEvents(dayStart, dayEnd).filter((ev) => String(ev.getDescription() || '').indexOf(tag) !== -1);
}

// Event color by item kind, so the GCal grid reads at a glance:
//   backups          -> GRAY (muted, "not the main thing")
//   two-nap-day naps -> PALE_BLUE (lavender)
//   one-nap-day naps -> BLUE (blueberry)
//   eldest plans + normal activities -> calendar default (no setColor call)
function applyEventColor_(event, item) {
  const type = String(item.item_type || '');
  const isBackup = item.is_backup === true || item.is_backup === 'TRUE' || item.is_backup === 'true';
  let color = null;
  if (type === 'nap_two') color = CalendarApp.EventColor.PALE_BLUE;
  else if (type === 'nap_one') color = CalendarApp.EventColor.BLUE;
  else if (isBackup && type !== 'eldest') color = CalendarApp.EventColor.GRAY;
  if (!color) return;
  try {
    event.setColor(color);
  } catch (e) {
    // setColor can throw on older runtimes; failure to color is non-fatal.
  }
}

// Add minutes to an HH:mm string, wrapping at 23:59 (no day rollover for the
// default; the calendar event stays on the same calendar day).
function addMinutesToTime_(timeStr, minutes) {
  const t = String(timeStr).split(':');
  let total = parseInt(t[0], 10) * 60 + parseInt(t[1], 10) + minutes;
  if (total >= 24 * 60) total = 24 * 60 - 1;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return hh + ':' + mm;
}

// Lightweight description so the event traces back to KidPlan.
function buildDescription_(item) {
  const parts = ['KidPlan item ' + (item.id || '')];
  if (item.tag) parts.push('Tag: ' + item.tag);
  if (item.source) parts.push('Source: ' + item.source);
  return parts.join('\n');
}

// Delete by gcal_event_id, then sweep any id-tagged strays on the same date
// (covers rows whose gcal_event_id was lost and duplicate event copies).
function deletePlanItemFromCalendar_(item) {
  if (!item) return false;
  const cal = getFamilyCalendar_();
  let deleted = false;
  if (item.gcal_event_id) {
    const existing = cal.getEventById(item.gcal_event_id);
    if (existing) {
      existing.deleteEvent();
      deleted = true;
    }
  }
  findEventsByItemId_(cal, item.date, item.id).forEach((ev) => {
    try {
      ev.deleteEvent();
      deleted = true;
    } catch (e) {
      // Already deleted via gcal_event_id above; sweep result can include it.
    }
  });
  return deleted;
}

// One-time cleanup - run from the editor (no trailing underscore so it shows in
// the Run dropdown). Reconciles every 'KidPlan item <id>'-tagged event on the
// family calendar in 2026 against PlanItems:
//   - row gone               -> delete the event (orphan)
//   - row lost its event id  -> adopt the event, write the id back, re-sync times
//   - extra copies for a row -> delete them, keep the one the row points at
// Untagged (external/manual) events are never touched. Logs a summary.
function cleanupCalendarOrphans() {
  const cal = getFamilyCalendar_();
  const rowsById = {};
  getRows_('PlanItems').forEach((r) => { rowsById[r.id] = r; });

  const winStart = new Date(2026, 0, 1);
  const winEnd = new Date(2027, 0, 1);
  let kept = 0, relinked = 0, orphans = 0, dupes = 0;
  const skipped = [];

  cal.getEvents(winStart, winEnd).forEach((ev) => {
    const m = String(ev.getDescription() || '').match(/KidPlan item (\S+)/);
    if (!m) return; // not a KidPlan event
    const row = rowsById[m[1]];
    if (!row) {
      ev.deleteEvent();
      orphans++;
      return;
    }
    const evId = ev.getId();
    if (!row.gcal_event_id) {
      // Adopt this copy; partial patch is safe now that upsertRow_ merges.
      row.gcal_event_id = evId;
      upsertRow_('PlanItems', 'id', { id: row.id, gcal_event_id: evId });
      try {
        writePlanItemToCalendar_(row); // force title/times back to the row's truth
      } catch (e) {
        // Broken legacy row (e.g. blank start_time). The relink stuck; just
        // skip the re-sync and report it instead of aborting the whole sweep.
        skipped.push(row.id + ' (' + e.message + ')');
      }
      relinked++;
      kept++;
    } else if (row.gcal_event_id === evId) {
      kept++;
    } else {
      ev.deleteEvent();
      dupes++;
    }
  });

  Logger.log('cleanupCalendarOrphans: kept=%s relinked=%s orphans_deleted=%s dupes_deleted=%s',
    kept, relinked, orphans, dupes);
  if (skipped.length) {
    Logger.log('relinked but could not re-sync %s row(s) - inspect/fix these PlanItems rows manually:\n%s',
      skipped.length, skipped.join('\n'));
  }
}

// Read-only calendar ids (comma-split) from script properties (or Settings tab).
function getReadOnlyCalendarIds_() {
  let raw = PropertiesService.getScriptProperties().getProperty('READ_ONLY_CALENDAR_IDS');
  if (!raw) {
    const row = getRowByKey_('Settings', 'key', 'read_only_calendar_ids');
    if (row) raw = row.value;
  }
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// Events across [start,end] (inclusive yyyy-MM-dd) on the given calendar ids.
// Each event is tagged source='kidplan' if its id matches the kidplanIds set
// (PlanItems.gcal_event_id round-trip), else 'external'. Window is capped at
// 60 days to keep CalendarApp.getEvents cheap.
function listCalendarEvents_(start, end, calendarIds, kidplanIds) {
  const winStart = dateOnly_(start);
  // dateOnly_ anchors at noon; end-day's exclusive boundary is the next midnight.
  const endDay = dateOnly_(end);
  const winEnd = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1, 0, 0, 0);
  const spanDays = Math.round((winEnd.getTime() - winStart.getTime()) / 86400000);
  if (spanDays > 60) throw new Error('range too wide: max 60 days');

  const kidplan = kidplanIds || {};
  const out = [];
  (calendarIds || []).forEach((calId) => {
    const cal = CalendarApp.getCalendarById(calId);
    if (!cal) return;
    const calName = cal.getName();
    cal.getEvents(winStart, winEnd).forEach((ev) => {
      const evId = ev.getId();
      out.push({
        calendar_id: calId,
        calendar_name: calName,
        event_id: evId,
        title: ev.getTitle(),
        all_day: ev.isAllDayEvent(),
        start: ev.isAllDayEvent()
          ? Utilities.formatDate(ev.getAllDayStartDate(), TZ_, 'yyyy-MM-dd')
          : Utilities.formatDate(ev.getStartTime(), TZ_, "yyyy-MM-dd'T'HH:mm:ssXXX"),
        end: ev.isAllDayEvent()
          ? Utilities.formatDate(new Date(ev.getAllDayEndDate().getTime() - 86400000), TZ_, 'yyyy-MM-dd')
          : Utilities.formatDate(ev.getEndTime(), TZ_, "yyyy-MM-dd'T'HH:mm:ssXXX"),
        location: ev.getLocation() || '',
        source: kidplan[evId] ? 'kidplan' : 'external',
      });
    });
  });
  return out;
}

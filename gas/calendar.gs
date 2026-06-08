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
function planItemTitle_(item) {
  const prefixes = { shared: '[Shared]', elder: '[Elder]', younger: '[Younger]' };
  const lane = prefixes[item.kid] || '[Shared]';
  const backup = (item.is_backup === true || item.is_backup === 'TRUE' || item.is_backup === 'true') ? '[Backup] ' : '';
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
  const isBackup = item.is_backup === true || item.is_backup === 'TRUE' || item.is_backup === 'true';

  // Update path: fetch existing event and mutate in place.
  if (item.gcal_event_id) {
    const existing = cal.getEventById(item.gcal_event_id);
    if (existing) {
      existing.setTitle(title);
      existing.setDescription(description);
      existing.setLocation(location);
      existing.setTime(
        dateTimeFrom_(item.date, item.start_time),
        dateTimeFrom_(item.date, endTime)
      );
      applyBackupColor_(existing, isBackup);
      return existing.getId();
    }
    // Event id was set but the event is gone; fall through to recreate.
  }

  const created = cal.createEvent(
    title,
    dateTimeFrom_(item.date, item.start_time),
    dateTimeFrom_(item.date, endTime),
    { description: description, location: location }
  );
  applyBackupColor_(created, isBackup);
  return created.getId();
}

// Graphite (eventColor 8) for backups so they read as muted in the GCal grid.
// Primaries get the calendar's default color (no setColor call).
function applyBackupColor_(event, isBackup) {
  if (!isBackup) return;
  try {
    event.setColor(CalendarApp.EventColor.GRAY);
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

// Delete by gcal_event_id; no-op if missing or already gone.
function deletePlanItemFromCalendar_(item) {
  if (!item || !item.gcal_event_id) return false;
  const cal = getFamilyCalendar_();
  const existing = cal.getEventById(item.gcal_event_id);
  if (existing) {
    existing.deleteEvent();
    return true;
  }
  return false;
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

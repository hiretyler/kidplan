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

// Title convention based on the PlanItem's kid lane.
function planItemTitle_(item) {
  const prefixes = { shared: '[Shared]', elder: '[Elder]', younger: '[Younger]' };
  const prefix = prefixes[item.kid] || '[Shared]';
  return prefix + ' ' + (item.title || '');
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
// Returns the event id.
function writePlanItemToCalendar_(item) {
  const cal = getFamilyCalendar_();
  const title = planItemTitle_(item);
  const description = buildDescription_(item);
  const location = item.location || '';

  const hasStart = item.start_time && String(item.start_time).trim() !== '';
  const hasEnd = item.end_time && String(item.end_time).trim() !== '';
  const timed = hasStart && hasEnd;

  // Update path: fetch existing event and mutate in place.
  if (item.gcal_event_id) {
    const existing = cal.getEventById(item.gcal_event_id);
    if (existing) {
      existing.setTitle(title);
      existing.setDescription(description);
      existing.setLocation(location);
      if (timed) {
        existing.setTime(
          dateTimeFrom_(item.date, item.start_time),
          dateTimeFrom_(item.date, item.end_time)
        );
      } else {
        existing.setAllDayDate(dateOnly_(item.date));
      }
      return existing.getId();
    }
    // Event id was set but the event is gone; fall through to recreate.
  }

  let created;
  if (timed) {
    created = cal.createEvent(
      title,
      dateTimeFrom_(item.date, item.start_time),
      dateTimeFrom_(item.date, item.end_time),
      { description: description, location: location }
    );
  } else {
    created = cal.createAllDayEvent(title, dateOnly_(item.date), {
      description: description,
      location: location,
    });
  }
  return created.getId();
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

// All events on a given date across read-only cals + the family cal.
// Returns [{calendar, title, start, end}] with ISO strings.
function listConflictingEvents_(date) {
  const dayStart = dateOnly_(date);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const calIds = getReadOnlyCalendarIds_();
  // Include the family calendar in the conflict scan.
  try {
    calIds.push(getFamilyCalendarId_());
  } catch (e) {
    // family cal not configured; just scan read-only ones.
  }

  const out = [];
  calIds.forEach((calId) => {
    const cal = CalendarApp.getCalendarById(calId);
    if (!cal) return;
    const calName = cal.getName();
    const events = cal.getEvents(dayStart, dayEnd);
    events.forEach((ev) => {
      out.push({
        calendar: calName,
        title: ev.getTitle(),
        start: ev.isAllDayEvent()
          ? Utilities.formatDate(ev.getAllDayStartDate(), TZ_, 'yyyy-MM-dd')
          : Utilities.formatDate(ev.getStartTime(), TZ_, "yyyy-MM-dd'T'HH:mm:ssXXX"),
        // getAllDayEndDate is exclusive (day after); subtract a day for inclusive end.
        end: ev.isAllDayEvent()
          ? Utilities.formatDate(new Date(ev.getAllDayEndDate().getTime() - 86400000), TZ_, 'yyyy-MM-dd')
          : Utilities.formatDate(ev.getEndTime(), TZ_, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      });
    });
  });
  return out;
}

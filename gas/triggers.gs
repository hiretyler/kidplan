// Programmatic trigger + recurring-event setup.

// Idempotent. Tyler runs once from the editor. Creates a recurring "Sync paper
// calendar" event on the family calendar: weekday mornings 8:00am Mon-Fri plus
// Sunday 7:00pm. Stores the created event id in PHOTO_PROMPT_EVENT_ID and bails
// if already set, to avoid duplicates.
function setup_recurringPhotoPromptEvent_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('PHOTO_PROMPT_EVENT_ID')) {
    return { ok: true, message: 'photo prompt event already created; nothing to do' };
  }

  const cal = getFamilyCalendar_();
  const frontendUrl = props.getProperty('FRONTEND_URL') || 'https://kidplan.pages.dev';
  const description =
    'Time to sync the paper wall calendar.\n' +
    'Snap a photo and upload it here: ' +
    frontendUrl +
    '#photos';

  const title = 'Sync paper calendar';
  const createdIds = [];

  // Weekday mornings 8:00-8:15am, recurring Mon-Fri (no end date).
  const weekdayStart = nextOccurrenceAt_(8, 0);
  const weekdayRecurrence = CalendarApp.newRecurrence().addWeeklyRule().onlyOnWeekdays([
    CalendarApp.Weekday.MONDAY,
    CalendarApp.Weekday.TUESDAY,
    CalendarApp.Weekday.WEDNESDAY,
    CalendarApp.Weekday.THURSDAY,
    CalendarApp.Weekday.FRIDAY,
  ]);
  const weekdaySeries = cal.createEventSeries(
    title,
    weekdayStart,
    new Date(weekdayStart.getTime() + 15 * 60 * 1000),
    weekdayRecurrence,
    { description: description }
  );
  createdIds.push(weekdaySeries.getId());

  // Sunday evening 7:00-7:15pm, recurring weekly.
  const sundayStart = nextOccurrenceAt_(19, 0, CalendarApp.Weekday.SUNDAY);
  const sundayRecurrence = CalendarApp.newRecurrence().addWeeklyRule().onlyOnWeekday(
    CalendarApp.Weekday.SUNDAY
  );
  const sundaySeries = cal.createEventSeries(
    title,
    sundayStart,
    new Date(sundayStart.getTime() + 15 * 60 * 1000),
    sundayRecurrence,
    { description: description }
  );
  createdIds.push(sundaySeries.getId());

  // Store both ids (comma-joined) so we can detect/clean up later.
  props.setProperty('PHOTO_PROMPT_EVENT_ID', createdIds.join(','));
  return { ok: true, message: 'photo prompt events created', event_ids: createdIds };
}

// Next future Date at hour:minute (today if still upcoming, else tomorrow).
// If weekday is supplied, advance to the next matching weekday at hour:minute.
function nextOccurrenceAt_(hour, minute, weekday) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);

  if (weekday) {
    // CalendarApp.Weekday maps to getDay() 0=Sun..6=Sat via this lookup.
    const targetDow = weekdayToDow_(weekday);
    let delta = (targetDow - d.getDay() + 7) % 7;
    if (delta === 0 && d.getTime() <= now.getTime()) delta = 7;
    d.setDate(d.getDate() + delta);
    return d;
  }

  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

// Map a CalendarApp.Weekday enum to a JS getDay() index.
function weekdayToDow_(weekday) {
  const map = {};
  map[CalendarApp.Weekday.SUNDAY] = 0;
  map[CalendarApp.Weekday.MONDAY] = 1;
  map[CalendarApp.Weekday.TUESDAY] = 2;
  map[CalendarApp.Weekday.WEDNESDAY] = 3;
  map[CalendarApp.Weekday.THURSDAY] = 4;
  map[CalendarApp.Weekday.FRIDAY] = 5;
  map[CalendarApp.Weekday.SATURDAY] = 6;
  return map[weekday];
}

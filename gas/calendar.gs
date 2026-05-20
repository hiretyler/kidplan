// Google Calendar bridge. Family cal is the write target; other cals are read-only inputs.

// Creates or updates the GCal event for a PlanItem. Idempotent via item.id -> gcal_event_id mapping.
const writePlanItemToCalendar_ = (_item) => { throw new Error('Not implemented in Wave 1'); };

const deletePlanItemFromCalendar_ = (_item) => { throw new Error('Not implemented in Wave 1'); };

const listConflictingEvents_ = (_date, _calendarIds) => { throw new Error('Not implemented in Wave 1'); };

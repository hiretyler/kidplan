# KidPlan Roadmap

## Change Log

- 2026-05-20 — Project scaffolded (Wave 1: docs, GAS stub, frontend skeleton).

## Now

Wave 1 scaffold complete; awaiting Tyler's Google setup before Wave 2.

## Next

- Wave 2 — Backend wiring: real `openSheet_` and CRUD in `gas/sheets.gs` (with `LockService` and seed data), `gas/calendar.gs` read/write with idempotent updates, `gas/triggers.gs` recurring "Sync paper calendar" event.
- Wave 3 — Frontend live integration: swap mocked API for real GAS calls, wire Today and Week views with optimistic updates, add "duplicate plan to date range" action, wire Library and Settings views.
- Wave 4 — Photo and OCR loop: `gas/drive.gs` resumable photo upload, `gas/vision.gs` Cloud Vision call, rules-based text-to-events parser, photo upload UI plus reconciliation diff view.
- Wave 5 — Verify and polish: end-to-end manual test on both phones, `simplify` pass on GAS code.

## Backlog — Features

- Weather-triggered Plan B auto-suggest
- RRULE recurring events
- Per-user Google login + attribution
- Caregiver read-only view
- Kid-facing read-only view
- Offline support
- Year-round / school-year affordances
- Meal planning
- Chore tracking
- Allowance tracking
- Cross-family playdate coordination

## Backlog — Tech Debt & Bugs

_None yet._

## Open Questions

- Kids' specific ages — currently "one preschooler, one elementary" — to tune library defaults (kid_age_fit values, typical_duration_min).
- Whether to keep shared-account auth on `soleilandtyler@gmail.com` or move to personal Google accounts once the app stabilizes.
- Whether to add a photos-only retention policy after summer ends (auto-archive or delete `/KidPlan/calendar-photos/` contents past N months).

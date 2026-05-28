# KidPlan Roadmap

## Change Log

- 2026-05-27 — Fixed all-day calendar off-by-one (noon anchor in `calendar.gs`) and Today hiding activities when no Days row exists (`viewToday`). Deploy @5. See `docs/HANDOFF.md`.
- 2026-05-27 — Wave 3.3: library-first activity picker (instant-add, inline lane/time, "+ New activity" saves to library, Plan B from picker). Added PWA icons (coral K).
- 2026-05-27 — Wave 3.2: palette C (buttercream + warm coral), two-section Library, unified tag picker.
- 2026-05-26 — Wave 3.1: hardened plan-item save, merged chill into indoor (6 tags), fallback per tag. Wave 3: frontend wired to live GAS API (token auth). Wave 2: backend (Sheets CRUD, calendar bridge, triggers).
- 2026-05-20 — Project scaffolded (Wave 1: docs, GAS stub, frontend skeleton).

## Now

Waves 1-3.3 complete; app is functional end-to-end (token-gated GAS API, day/week/library/settings, library-first activity flow). Just fixed the calendar off-by-one + Today display bugs (deploy @5) - needs a verification pass. Not yet hosted (planned: tgeddes.com/kidplan). Full status in `docs/HANDOFF.md`.

## Next

- Verify the calendar fix end-to-end, clean up the 5 duplicate test activities, then host the frontend on tgeddes.com/kidplan.
- Wave 4 — Photo and OCR loop: `gas/drive.gs` resumable photo upload, `gas/vision.gs` Cloud Vision call, rules-based text-to-events parser, photo upload UI plus reconciliation diff view. Prereq: switch GCP project off "Default", enable Vision API, set `VISION_SERVICE_ACCOUNT_JSON`.
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

- Cleanup: 5 duplicate "[Shared] Rainy-day craft kit" test activities (PlanItems rows + stray calendar events on the wrong day) created during the off-by-one debugging. Delete via the x button once they surface on Today, and remove the orphaned calendar events.
- `duplicate_day_to_range` writes each plan item via `upsertRow_` in a loop (per-row read+write); fine for now, batch if it gets slow.

## Open Questions

- Kids' specific ages — currently "one preschooler, one elementary" — to tune library defaults (kid_age_fit values, typical_duration_min).
- Whether to keep shared-account auth on `soleilandtyler@gmail.com` or move to personal Google accounts once the app stabilizes.
- Whether to add a photos-only retention policy after summer ends (auto-archive or delete `/KidPlan/calendar-photos/` contents past N months).
